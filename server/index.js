import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { createRoom, addViewer, removeViewer, jitterTargets, setHopRtt, JITTER_STEP_MS, MODES } from './topology.js';
import * as S from './session.js';
import { handleInteraction } from './discord.js';
import { iceServers } from './ice.js';

const PORT = Number(process.env.PORT) || 3000;
const MAX_MSG_BYTES = 64 * 1024; // SDP + ICE fit easily; blocks memory abuse [#65]
const RATE_PER_SEC = 20; // ICE bursts stay well under this
const MAX_RTT_MS = 5000; // a hop RTT above this is a broken report, not a network
const SPEEDTEST_MAX_BYTES = 32 * 1024 * 1024; // [#65]
const SPEEDTEST_WINDOW_MS = 10_000;
const SPEEDTEST_PER_WINDOW = 2; // one measurement = a small probe + the real upload [#58]
const ENDED_TTL_MS = 60 * 60_000; // remember ended codes for 1 h → 410 instead of 404
const JS = 'text/javascript; charset=utf-8';
const STATIC = {
  // whitelist: no path traversal possible [#51]
  '/': ['web/index.html', 'text/html; charset=utf-8'],
  '/download': ['web/download.html', 'text/html; charset=utf-8'],
  '/app.js': ['web/app.js', JS],
  '/ui.js': ['web/ui.js', JS],
  '/stream.js': ['web/stream.js', JS],
  '/voice.js': ['web/voice.js', JS],
  '/sw.js': ['web/sw.js', JS],
  '/session.js': ['server/session.js', JS], // shared CAN matrix: UI and server can't drift
  '/styles.css': ['web/styles.css', 'text/css; charset=utf-8'],
  '/manifest.webmanifest': ['web/manifest.webmanifest', 'application/manifest+json'],
  '/icon.svg': ['web/icon.svg', 'image/svg+xml'],
  '/icon-maskable.svg': ['web/icon-maskable.svg', 'image/svg+xml'],
  '/icon-192.png': ['web/icon-192.png', 'image/png'],
  '/icon-512.png': ['web/icon-512.png', 'image/png'],
};

// ponytail: in-memory state, single process. Move to Redis when horizontal scaling is needed [#27].
const sessions = new Map(); // code -> session (+ .room: video topology of the current stream)
const ended = new Map(); // code -> ended at
const clients = new Map(); // clientId -> { ws, code, tokens, at }
const speedtests = new Map(); // ip -> recent request times

function createSessionFor(id, name, device) {
  let code;
  do code = S.newCode(); while (sessions.has(code) || ended.has(code));
  const s = S.createSession(code, id, name, device);
  s.room = null;
  sessions.set(code, s);
  return s;
}

// T02 upload test: the browser sends a blob here and we time it on arrival (no connection setup).
// The signaling server sits on the internet, so this measures the sender's last-mile upload.
async function speedtest(req, res) {
  const reply = (status, body) => res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
  const now = Date.now();
  for (const [ip, times] of speedtests) {
    const recent = times.filter((t) => now - t < SPEEDTEST_WINDOW_MS);
    if (recent.length) speedtests.set(ip, recent);
    else speedtests.delete(ip);
  }
  const ip = req.socket.remoteAddress;
  const times = speedtests.get(ip) ?? [];
  if (times.length >= SPEEDTEST_PER_WINDOW) {
    req.resume();
    return reply(429, { code: 429, reason: 'Medição repetida rápido demais. Espere 10 segundos e meça de novo.' });
  }
  speedtests.set(ip, [...times, now]);
  let bytes = 0;
  let first = 0;
  for await (const chunk of req) {
    first ||= performance.now();
    bytes += chunk.length;
    if (bytes > SPEEDTEST_MAX_BYTES) {
      reply(413, { code: 413, reason: 'O teste enviou mais dados que o permitido (32 MB).' });
      return req.destroy();
    }
  }
  return reply(200, { bytes, ms: first ? performance.now() - first : 0 });
}

const http = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path === '/health') return res.end('ok'); // [#82]
  if (path === '/speedtest' && req.method === 'POST') return speedtest(req, res);
  if (path === '/ice.json') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ iceServers: iceServers() }));
  }
  if (path === '/discord/interactions' && req.method === 'POST') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const base = process.env.PUBLIC_URL ?? `http://${req.headers.host}`;
    const out = handleInteraction(req.headers, Buffer.concat(chunks), {
      publicKey: process.env.DISCORD_PUBLIC_KEY,
      baseUrl: base,
      // The bot "holds" the session until the first real person arrives; nobody sees this placeholder.
      createSession: () => Object.assign(createSessionFor(`discord:${randomUUID()}`, 'Stream P2P (bot)', null), { botPending: true }),
    });
    res.writeHead(out.status, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(out.body ?? {}));
  }
  const entry = STATIC[path];
  if (!entry) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': entry[1], 'cache-control': 'no-cache' });
  res.end(await readFile(new URL(`../${entry[0]}`, import.meta.url)));
});

const send = (id, msg) => {
  const ws = clients.get(id)?.ws;
  if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
};
const fail = (id, op, code, reason) => send(id, { type: 'error', op, code, reason });
const broadcast = (s, msg, except) => {
  for (const id of s.members.keys()) if (id !== except) send(id, msg);
};
const publish = (s) => broadcast(s, { type: 'session', session: S.snapshot(s) });

// ── video topology: rebuilt with the presenter as root on every turn ──
function notifyAssigned(s, id, parent) {
  const jitterMs = jitterTargets(s.room).get(id);
  s.room.nodes.get(id).sentJitter = jitterMs;
  send(id, { type: 'assigned', parent, mode: s.room.mode, jitterMs });
  send(parent, { type: 'child', id });
}

// Any change in the tree or in a measured hop can move everyone's buffer; send only real changes.
function pushJitter(s) {
  for (const [id, jitterMs] of jitterTargets(s.room)) {
    const node = s.room.nodes.get(id);
    if (node.sentJitter !== undefined && Math.abs(jitterMs - node.sentJitter) < JITTER_STEP_MS) continue;
    node.sentJitter = jitterMs;
    send(id, { type: 'jitter', jitterMs });
  }
}

function attachViewer(s, id) {
  const parent = addViewer(s.room, id);
  if (!parent) return send(id, { type: 'notice', code: 503, reason: 'A transmissão chegou ao limite de espectadores para o upload de quem transmite. Você continua na voz e no chat.' });
  notifyAssigned(s, id, parent);
  pushJitter(s);
}

function beginTopology(s, presenterId, mode, uploadKbps) {
  s.room = createRoom(presenterId, mode, uploadKbps);
  for (const id of s.members.keys()) if (id !== presenterId) attachViewer(s, id);
}

function endTopology(s) {
  if (!s.room) return;
  s.room = null;
  broadcast(s, { type: 'streamEnded' });
}

function detachViewer(s, id) {
  if (!s.room || !s.room.nodes.has(id) || id === s.room.hostId) return;
  const parent = s.room.nodes.get(id).parent;
  for (const { id: childId, parent: newParent } of removeViewer(s.room, id)) {
    if (newParent) notifyAssigned(s, childId, newParent);
    else send(childId, { type: 'notice', code: 503, reason: 'Sem vaga na árvore depois que um retransmissor saiu.' });
  }
  if (parent) send(parent, { type: 'childGone', id });
  pushJitter(s);
}

function grantNotice(s, targetId) {
  if (targetId) send(targetId, { type: 'yourTurn', until: s.grant.until });
}

function endSession(s, reason) {
  broadcast(s, { type: 'ended', code: 410, reason });
  for (const id of s.members.keys()) clients.get(id) && (clients.get(id).code = null);
  sessions.delete(s.code);
  ended.set(s.code, Date.now());
}

function leave(id) {
  const client = clients.get(id);
  const s = client?.code && sessions.get(client.code);
  if (!s) return;
  client.code = null;
  const wasPresenter = s.presenterId === id;
  if (wasPresenter) endTopology(s);
  else detachViewer(s, id);
  S.removeMember(s, id);
  broadcast(s, { type: 'peerLeft', id });
  if (!s.members.size) {
    sessions.delete(s.code);
    ended.set(s.code, Date.now());
    return;
  }
  publish(s);
}

function lookup(code) {
  const c = S.normalizeCode(code);
  if (!/^[a-z0-9]{4}-[a-z0-9]{2}$/.test(c)) throw new S.HttpError(400, 'O código tem o formato xxxx-xx. Confira se copiou inteiro.');
  if (ended.has(c)) throw new S.HttpError(410, 'Essa sessão já foi encerrada. Peça um convite novo.');
  const s = sessions.get(c);
  if (!s) throw new S.HttpError(404, 'Não existe sessão com esse código. Confira o código ou peça um convite novo.');
  return s;
}

function handle(id, msg) {
  const client = clients.get(id);
  const s = client.code ? sessions.get(client.code) : null;
  const inSession = () => {
    if (!s) throw new S.HttpError(400, 'Entre em uma sessão primeiro.');
    return s;
  };
  switch (msg.type) {
    case 'create': {
      if (s) throw new S.HttpError(409, 'Você já está em uma sessão. Saia dela para criar outra.');
      const created = createSessionFor(id, msg.name, msg.device);
      client.code = created.code;
      return publish(created);
    }
    case 'join': {
      if (s) throw new S.HttpError(409, 'Você já está em uma sessão.');
      const target = lookup(msg.code);
      S.addMember(target, id, msg.name, msg.device);
      // First real person through a bot invite takes the placeholder's crown (removeMember passes it on).
      if (target.botPending) {
        S.removeMember(target, target.ownerId);
        target.botPending = false;
      }
      client.code = target.code;
      if (target.room) attachViewer(target, id);
      return publish(target);
    }
    case 'leave':
      leave(id);
      return send(id, { type: 'left' });
    case 'rename':
      S.rename(inSession(), id, msg.name);
      return publish(s);
    case 'chat': {
      const text = String(msg.text ?? '').trim().slice(0, S.MAX_CHAT);
      if (!text) throw new S.HttpError(400, 'Mensagem vazia.');
      const from = inSession().members.get(id);
      return broadcast(s, { type: 'chat', from: id, name: from.name, text, at: Date.now() });
    }
    case 'mic':
      inSession().members.get(id).mic = Boolean(msg.on);
      return publish(s);
    case 'startStream': {
      if (!MODES[msg.mode]) throw new S.HttpError(400, `Modo de qualidade desconhecido: ${msg.mode}.`);
      const upload = Number(msg.uploadKbps);
      if (!(upload > 0)) throw new S.HttpError(400, 'Informe o upload em Mbps (maior que zero).');
      S.startStream(inSession(), id, { mode: msg.mode, audio: msg.audio !== false, source: msg.source ?? 'monitor' });
      beginTopology(s, id, msg.mode, upload);
      return publish(s);
    }
    case 'streamState': {
      if (inSession().presenterId !== id) throw new S.HttpError(403, 'Só quem transmite muda o estado da transmissão.');
      const { paused, audio, mode, source } = msg;
      if (mode !== undefined && !MODES[mode]) throw new S.HttpError(400, `Modo de qualidade desconhecido: ${mode}.`);
      const patch = Object.fromEntries(Object.entries({ paused, audio, mode, source }).filter(([, v]) => v !== undefined));
      Object.assign(s.presenterState, patch);
      return publish(s);
    }
    case 'stopStream': {
      const granted = S.stopStream(inSession(), id);
      endTopology(s);
      grantNotice(s, granted);
      return publish(s);
    }
    case 'requestTurn': {
      const position = S.requestTurn(inSession(), id);
      const who = s.members.get(id).name;
      for (const m of s.members.values()) {
        if (m.id !== id && S.CAN.approveRequest(s, m)) send(m.id, { type: 'turnRequest', id, name: who, position });
      }
      return publish(s);
    }
    case 'cancelRequest':
      S.cancelRequest(inSession(), id);
      return publish(s);
    case 'declineRequest':
      S.declineRequest(inSession(), id, msg.id);
      send(msg.id, { type: 'notice', code: 409, reason: `${s.members.get(id).name} recusou o pedido por agora. Você pode pedir de novo.` });
      return publish(s);
    case 'passTurn': {
      const hadStream = Boolean(inSession().presenterId);
      S.passTurn(s, id, msg.id);
      if (hadStream) endTopology(s);
      grantNotice(s, msg.id);
      return publish(s);
    }
    case 'mod': {
      inSession();
      const wasPresenter = s.presenterId === msg.id;
      const by = s.members.get(id)?.name;
      const { effect } = S.moderate(s, id, msg.action, msg.id); // throws 403 before any side effect
      if (effect === 'mute') send(msg.id, { type: 'forceMute', by });
      if (effect === 'kick' || effect === 'ban') {
        if (wasPresenter) endTopology(s);
        else detachViewer(s, msg.id);
        const reason = effect === 'ban'
          ? `${by} bloqueou você nesta sessão. Com o bloqueio, este navegador não entra de novo.`
          : `${by} removeu você da sessão. Você pode entrar de novo com o código.`;
        send(msg.id, { type: 'ended', code: 403, reason });
        const c = clients.get(msg.id);
        if (c) c.code = null;
        broadcast(s, { type: 'peerLeft', id: msg.id });
      }
      return publish(s);
    }
    case 'settings':
      S.updateSettings(inSession(), id, msg.patch);
      return publish(s);
    case 'end':
      if (!S.CAN.end(inSession(), s.members.get(id))) throw new S.HttpError(403, 'Só o dono pode encerrar a sessão para todos.');
      return endSession(s, `${s.members.get(id).name} encerrou a sessão para todos.`);
    case 'hopRtt': {
      const ms = Number(msg.ms);
      if (!Number.isFinite(ms) || ms < 0 || ms > MAX_RTT_MS) throw new S.HttpError(400, `RTT inválido: ${msg.ms}.`);
      if (s?.room && setHopRtt(s.room, id, ms)) pushJitter(s); // a late report after the stream ended is harmless
      return;
    }
    case 'signal':
    case 'vsignal': {
      // only relay between members of the same session
      if (!s || clients.get(msg.to)?.code !== client.code) return;
      return send(msg.to, { type: msg.type, from: id, data: msg.data });
    }
    default:
      throw new S.HttpError(400, `Mensagem desconhecida: ${msg.type}.`);
  }
}

// Token bucket per client → 429 instead of letting one tab flood the session.
function allow(client) {
  const now = Date.now();
  client.tokens = Math.min(RATE_PER_SEC, client.tokens + ((now - client.at) / 1000) * RATE_PER_SEC);
  client.at = now;
  if (client.tokens < 1) return false;
  client.tokens -= 1;
  return true;
}

new WebSocketServer({ server: http, maxPayload: MAX_MSG_BYTES }).on('connection', (ws) => {
  const id = randomUUID();
  clients.set(id, { ws, code: null, tokens: RATE_PER_SEC, at: Date.now() });
  ws.send(JSON.stringify({ type: 'hello', id, modes: MODES }));
  ws.on('message', (raw) => {
    const client = clients.get(id);
    let msg = {};
    try {
      msg = JSON.parse(raw);
      if (!allow(client)) throw new S.HttpError(429, 'Muitas ações em pouco tempo. Espere um segundo e tente de novo.');
      handle(id, msg);
    } catch (err) {
      fail(id, msg.type, err.code ?? 400, err instanceof S.HttpError ? err.message : `Mensagem inválida: ${err.message}`);
    }
  });
  ws.on('close', () => {
    leave(id);
    clients.delete(id);
  });
});

setInterval(() => {
  const cutoff = Date.now() - ENDED_TTL_MS;
  for (const [code, at] of ended) if (at < cutoff) ended.delete(code);
  for (const s of sessions.values()) if (s.botPending && s.createdAt < cutoff) sessions.delete(s.code); // invite never used
}, 60_000).unref();

http.listen(PORT, () => console.log(`stream-p2p em http://localhost:${PORT}`));
