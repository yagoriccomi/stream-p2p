// Discord bot over the Interactions HTTP endpoint (no gateway, no dependency).
// /stream criar → public embed with an "Entrar na sessão" button; each click answers that person
// privately with a link carrying their own server nickname, so nobody types a name or logs in.
import { createPublicKey, verify } from 'node:crypto';

const PING = 1, COMMAND = 2, COMPONENT = 3;
const PONG = 1, MESSAGE = 4;
const EPHEMERAL = 1 << 6;
const VIOLET = 0x7f00ff;

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
export const serverName = (interaction) => {
  const m = interaction.member;
  const u = m?.user ?? interaction.user ?? {};
  return [...String(m?.nick || u.global_name || u.username || '')].slice(0, 24).join('');
};

export function inviteUrl(baseUrl, code, name) {
  const url = new URL('/', baseUrl);
  url.searchParams.set('code', code);
  if (name) url.searchParams.set('name', name);
  return url.href;
}

const reply = (data) => ({ status: 200, body: { type: MESSAGE, data } });
const privately = (content, components) => reply({ content, flags: EPHEMERAL, ...(components && { components }) });

// Pure: (headers, raw body, deps) → { status, body }. deps.createSession() returns { code }.
export function handleInteraction(headers, rawBody, { publicKey: key, baseUrl, createSession }) {
  if (!verifySignature(headers, rawBody, key)) return { status: 401, body: { error: 'assinatura inválida' } };
  let i;
  try {
    i = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: 'JSON inválido' } };
  }

  if (i.type === PING) return { status: 200, body: { type: PONG } };

  if (i.type === COMMAND && i.data?.name === 'stream') {
    const sub = i.data.options?.[0]?.name;
    if (sub !== 'criar') return privately('Use `/stream criar` para abrir uma sessão.');
    const { code } = createSession();
    const who = serverName(i);
    return reply({
      embeds: [{
        title: `${who} abriu uma sessão`,
        description: 'Clique em **Entrar na sessão**. O link chega só para você, com o seu nome deste servidor. Sem login, sem conta.',
        color: VIOLET,
        footer: { text: 'Stream P2P · código oculto · a primeira pessoa a entrar vira dona da sessão' },
      }],
      components: [{ type: 1, components: [{ type: 2, style: 1, label: 'Entrar na sessão', custom_id: `join:${code}` }] }],
    });
  }

  if (i.type === COMPONENT && i.data?.custom_id?.startsWith('join:')) {
    const code = i.data.custom_id.slice(5);
    const url = inviteUrl(baseUrl, code, serverName(i));
    return privately('Seu convite pessoal:', [{ type: 1, components: [{ type: 2, style: 5, label: 'Abrir Stream P2P', url }] }]);
  }

  return privately('Comando desconhecido.');
}
