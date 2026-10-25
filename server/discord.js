// Discord bot over the Interactions HTTP endpoint (no gateway, no dependency).
// /stream criar → public embed with an "Entrar na sessão" button; each click answers that person
// privately with a link carrying their own server nickname, so nobody types a name or logs in.
import { createPublicKey, verify } from 'node:crypto';

const PING = 1, COMMAND = 2, COMPONENT = 3;
const PONG = 1, MESSAGE = 4;
const USER_COMMAND = 2;
const EPHEMERAL = 1 << 6;
const VIOLET = 0x7f00ff;
export const CALL_COMMAND = 'Chamar para stream';
export const MODE_CHOICES = ['720p30', '1080p60', '1440p60'];

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const keyCache = new Map();
function publicKey(hex) {
  if (!keyCache.has(hex)) {
    keyCache.set(hex, createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(hex, 'hex')]), format: 'der', type: 'spki' }));
  }
  return keyCache.get(hex);
}

export function verifySignature(headers, rawBody, publicKeyHex) {
  const sig = headers['x-signature-ed25519'];
  const ts = headers['x-signature-timestamp'];
  if (!publicKeyHex || !sig || !ts || !/^[0-9a-f]{128}$/i.test(sig)) return false;
  try {
    return verify(null, Buffer.concat([Buffer.from(ts), rawBody]), publicKey(publicKeyHex), Buffer.from(sig, 'hex'));
  } catch {
    return false;
  }
}

// Nickname in this server, else display name, else username.
export const serverName = (interaction) => nameOf(interaction.member, interaction.user);
const nameOf = (member, user) => {
  const u = member?.user ?? user ?? {};
  return [...String(member?.nick || u.global_name || u.username || '')].slice(0, 24).join('');
};
const userId = (i) => i.member?.user?.id ?? i.user?.id;
// Sessions belong to the server they were opened in (or the DM channel, outside a server).
const scopeOf = (i) => i.guild_id ?? i.channel_id;

export function inviteUrl(baseUrl, code, name, ownerToken) {
  const url = new URL('/', baseUrl);
  url.searchParams.set('code', code);
  if (name) url.searchParams.set('name', name);
  if (ownerToken) url.searchParams.set('owner', ownerToken);
  return url.href;
}

const help = (baseUrl) => [
  '**Stream P2P** — transmissão de tela entre amigos, sem login.',
  '',
  '**Comandos**',
  '• `/stream criar` — abre uma sessão e posta o botão **Entrar na sessão**. Cada clique gera um link só seu, já com seu apelido deste servidor. Quem cria vira dono(a); com `dono: False`, a primeira pessoa a entrar vira. `qualidade` sugere 720p30, 1080p60 ou 1440p60 para quem transmitir.',
  '• `/stream status` — as sessões abertas neste servidor: quem transmite e quantas pessoas estão em cada uma.',
  '• `/stream convite` — posta de novo o botão da última sessão, para quem chegou depois.',
  '• `/stream encerrar` — encerra a última sessão que você criou aqui.',
  '• `/stream app` — link do app para Windows.',
  `• Clique direito numa pessoa › Apps › **${CALL_COMMAND}** — chama a pessoa para a última sessão.`,
  '• `/stream help` — esta ajuda.',
  '',
  '**Na sessão**',
  '• O dono modera, nomeia moderadores e passa a vez.',
  '• Só uma pessoa transmite por vez; as outras clicam **Pedir a vez**.',
  '• Qualidade de 720p30 a 1440p60, com o som da tela ou de uma janela.',
  '• Voz em tempo real, volume por pessoa e aperte-para-falar (**V**).',
  '• **Métricas**, sobre o vídeo, mostram resolução, fps, perda e por onde a conexão passa.',
  '• Todos assistem com o mesmo atraso, ajustado sozinho à rede de cada um.',
  '',
  '**Dicas**',
  `• Para transmitir com mais qualidade, use o app para Windows: ${new URL('/download', baseUrl).href}`,
  '• No celular dá para assistir e falar; transmitir só pelo computador.',
  '• Até 50 pessoas por sessão. O código fica oculto; compartilhe pelo botão.',
].join('\n');

const reply = (data) => ({ status: 200, body: { type: MESSAGE, data } });
const privately = (content, components) => reply({ content, flags: EPHEMERAL, ...(components && { components }) });
export const joinButton = (code, label = 'Entrar na sessão') => ({ type: 1, components: [{ type: 2, style: 1, label, custom_id: `join:${code}` }] });

export const sessionEmbed = (title, s) => ({
  title,
  description: 'Clique em **Entrar na sessão**. O link chega só para você, com o seu nome deste servidor. Sem login, sem conta.'
    + (s.mode ? `\nQualidade sugerida: **${s.mode}**.` : ''),
  color: VIOLET,
  footer: { text: `Stream P2P · código oculto · ${s.ownerName ? `${s.ownerName} é dono(a) da sessão` : 'a primeira pessoa a entrar vira dona da sessão'}` },
});

const NO_SESSION = 'Nenhuma sessão aberta neste servidor. Use `/stream criar`.';

/**
 * Pure: (headers, raw body, deps) → { status, body }.
 * deps.createSession({ scope, channel, author, authorName, owner, mode }) → { code }
 * deps.sessionsIn(scope) → open sessions, newest first: [{ code, author, authorName, ownerName, ownerToken, mode, members, presenter }]
 * deps.endSession(code, byName)
 * deps.dm(userId, message) — optional side effect (needs the bot token); fire and forget.
 */
export function handleInteraction(headers, rawBody, deps) {
  const { publicKey: key, baseUrl } = deps;
  if (!verifySignature(headers, rawBody, key)) return { status: 401, body: { error: 'assinatura inválida' } };
  let i;
  try {
    i = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: 'JSON inválido' } };
  }

  if (i.type === PING) return { status: 200, body: { type: PONG } };

  if (i.type === COMMAND && i.data?.type === USER_COMMAND && i.data.name === CALL_COMMAND) {
    const [s] = deps.sessionsIn(scopeOf(i));
    if (!s) return privately(NO_SESSION);
    const target = i.data.target_id;
    const tName = nameOf(i.data.resolved?.members?.[target] && { ...i.data.resolved.members[target], user: i.data.resolved.users?.[target] }, i.data.resolved?.users?.[target]);
    deps.dm?.(target, {
      content: `${serverName(i)} te chamou para uma sessão do Stream P2P:`,
      components: [{ type: 1, components: [{ type: 2, style: 5, label: 'Abrir Stream P2P', url: inviteUrl(baseUrl, s.code, tName) }] }],
    });
    return reply({ content: `<@${target}>, ${serverName(i)} te chamou para a sessão.`, allowed_mentions: { users: [target] }, components: [joinButton(s.code)] });
  }

  if (i.type === COMMAND && i.data?.name === 'stream') {
    const sub = i.data.options?.[0];
    const opt = (name) => sub?.options?.find((o) => o.name === name)?.value;
    const who = serverName(i);
    switch (sub?.name) {
      case 'help':
        return privately(help(baseUrl));
      case 'app':
        return privately(`App para Windows (melhor qualidade para transmitir): ${new URL('/download', baseUrl).href}`);
      case 'criar': {
        const owner = opt('dono') !== false;
        const mode = MODE_CHOICES.includes(opt('qualidade')) ? opt('qualidade') : null;
        const { code } = deps.createSession({ scope: scopeOf(i), channel: i.channel_id, author: userId(i), authorName: who, owner, mode });
        return reply({ embeds: [sessionEmbed(`${who} abriu uma sessão`, { mode, ownerName: owner && who })], components: [joinButton(code)] });
      }
      case 'status': {
        const list = deps.sessionsIn(scopeOf(i));
        if (!list.length) return privately(NO_SESSION);
        const lines = list.slice(0, 5).map((s, n) => `**${n + 1}.** de ${s.authorName} · ${s.members} ${s.members === 1 ? 'pessoa' : 'pessoas'} · ${s.presenter ? `${s.presenter} transmitindo` : 'ninguém transmitindo'}`);
        return privately(lines.join('\n'), list.slice(0, 5).map((s, n) => joinButton(s.code, `Entrar na ${n + 1}`)));
      }
      case 'convite': {
        const [s] = deps.sessionsIn(scopeOf(i));
        if (!s) return privately(NO_SESSION);
        return reply({ embeds: [sessionEmbed(`Sessão de ${s.authorName}`, s)], components: [joinButton(s.code)] });
      }
      case 'encerrar': {
        const s = deps.sessionsIn(scopeOf(i)).find((x) => x.author === userId(i));
        if (!s) return privately('Você não tem sessão aberta neste servidor. Só quem criou pode encerrar pelo Discord.');
        deps.endSession(s.code, who);
        return reply({ content: `${who} encerrou a sessão.` });
      }
      default:
        return privately('Use `/stream criar` para abrir uma sessão, ou `/stream help`.');
    }
  }

  if (i.type === COMPONENT && i.data?.custom_id?.startsWith('join:')) {
    const code = i.data.custom_id.slice(5);
    const s = deps.sessionsIn(scopeOf(i)).find((x) => x.code === code);
    // Only the author's link carries the owner token: that click is what makes them owner.
    const token = s && s.author === userId(i) ? s.ownerToken : null;
    const url = inviteUrl(baseUrl, code, serverName(i), token);
    return privately(token ? 'Seu convite pessoal (você entra como dono):' : 'Seu convite pessoal:', [{ type: 1, components: [{ type: 2, style: 5, label: 'Abrir Stream P2P', url }] }]);
  }

  return privately('Comando desconhecido.');
}
