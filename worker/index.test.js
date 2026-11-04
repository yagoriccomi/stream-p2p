import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { handle, WAKING, FAILED } from './index.js';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const env = { ORIGIN: 'https://origin.example', DISCORD_PUBLIC_KEY: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex') };

function request(body, { tamper = false } = {}) {
  const raw = JSON.stringify(body);
  const ts = '1700000000';
  let sig = sign(null, Buffer.from(ts + raw), privateKey).toString('hex');
  if (tamper) sig = sig.replace(/^./, (c) => (c === 'a' ? 'b' : 'a'));
  return new Request('https://worker.example/discord/interactions', { method: 'POST', headers: { 'x-signature-ed25519': sig, 'x-signature-timestamp': ts }, body: raw });
}

// The server: `sleepCalls` first calls hang until aborted (Render waking), then it answers.
function world(answer, sleepCalls = 0) {
  const origin = [], discord = [];
  let n = 0;
  const fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith(env.ORIGIN)) {
      origin.push({ sig: init.headers['x-signature-ed25519'], body: init.body });
      if (n++ < sleepCalls) {
        return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
      }
      return new Response(JSON.stringify(answer), { headers: { 'content-type': 'application/json' } });
    }
    discord.push({ url: u.replace(/^https:\/\/discord\.com\/api\/v10\/webhooks\/app\/tok/, ''), method: init.method, body: init.body && JSON.parse(init.body) });
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  };
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };
  return { origin, discord, ctx, done: () => Promise.all(waits), deps: { fetch, fastMs: 30, attemptMs: 30, sleep: async () => {} } };
}

const cmd = { type: 2, application_id: 'app', token: 'tok', data: { name: 'stream' } };

test('PING responde PONG sem chamar o servidor (Discord checa o endpoint)', async () => {
  const w = world({});
  const res = await handle(request({ type: 1 }), env, w.ctx, w.deps);
  assert.deepEqual(await res.json(), { type: 1 });
  assert.equal(w.origin.length, 0);
});

test('assinatura inválida: 401 e nada repassado', async () => {
  const w = world({});
  const res = await handle(request(cmd, { tamper: true }), env, w.ctx, w.deps);
  assert.equal(res.status, 401);
  assert.equal(w.origin.length, 0);
});

test('servidor acordado: resposta repassada intacta, com a assinatura original', async () => {
  const answer = { type: 4, data: { content: 'oi', flags: 64 } };
  const w = world(answer);
  const req = request(cmd);
  const sig = req.headers.get('x-signature-ed25519');
  const res = await handle(req, env, w.ctx, w.deps);
  assert.deepEqual(await res.json(), answer);
  assert.equal(w.origin[0].sig, sig);
  assert.equal(w.origin[0].body, JSON.stringify(cmd));
  await w.done();
  assert.equal(w.discord.length, 0);
});

test('servidor dormindo, resposta privada: aviso na hora, depois o aviso vira a resposta', async () => {
  const w = world({ type: 4, data: { content: 'Seu convite pessoal:', components: [{ type: 1 }], flags: 64 } }, 2);
  const res = await handle(request(cmd), env, w.ctx, w.deps);
  assert.deepEqual(await res.json(), { type: 4, data: { content: WAKING, flags: 64 } });
  await w.done();
  assert.equal(w.origin.length, 3); // the quick try, one more that hung, the one that answered
  assert.deepEqual(w.discord, [{ url: '/messages/@original', method: 'PATCH', body: { content: 'Seu convite pessoal:', embeds: [], components: [{ type: 1 }] } }]);
});

test('servidor dormindo, resposta pública: vai para o canal e o aviso some', async () => {
  const w = world({ type: 4, data: { embeds: [{ title: 'Ana abriu uma sessão' }], components: [{ type: 1 }] } }, 1);
  await handle(request(cmd), env, w.ctx, w.deps);
  await w.done();
  assert.deepEqual(w.discord, [
    { url: '?wait=true', method: 'POST', body: { embeds: [{ title: 'Ana abriu uma sessão' }], components: [{ type: 1 }] } },
    { url: '/messages/@original', method: 'DELETE', body: undefined },
  ]);
});

test('servidor nunca responde: depois do limite, o aviso diz para tentar de novo', async () => {
  const w = world({}, Infinity);
  let t = 0;
  w.deps.now = () => (t += 5 * 60_000);
  w.deps.fetch = ((inner) => (url, init) => (String(url).startsWith(env.ORIGIN) ? Promise.resolve(new Response('acordando', { status: 503 })) : inner(url, init)))(w.deps.fetch);
  await handle(request(cmd), env, w.ctx, w.deps);
  await w.done();
  assert.deepEqual(w.discord, [{ url: '/messages/@original', method: 'PATCH', body: { content: FAILED } }]);
});

test('outras rotas não repassam nada', async () => {
  const w = world({});
  assert.equal((await handle(new Request('https://worker.example/'), env, w.ctx, w.deps)).status, 200);
  assert.equal((await handle(new Request('https://worker.example/x', { method: 'POST' }), env, w.ctx, w.deps)).status, 404);
  assert.equal(w.origin.length, 0);
});
