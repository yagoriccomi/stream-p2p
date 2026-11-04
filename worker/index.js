// Always-on front door for the Discord bot (Cloudflare Worker). Render's free plan sleeps after
// 15 min without traffic and takes about a minute to wake, while Discord waits only 3 s for an
// answer: the first /stream after a quiet stretch failed with "o aplicativo não respondeu".
//
// Awake server: the interaction is passed through and its answer goes back untouched.
// Sleeping server: the person gets, within the 3 s, a private "acordando, até 1 minuto" note;
// the Worker keeps calling the server until it answers, then swaps the note for the real answer
// (or, when the answer is meant for the whole channel, posts it there and removes the note).
// The server still checks Discord's signature itself: the original headers and body go along.
//
// Env: ORIGIN (the server, e.g. https://stream.yagoriccomi.com.br) and DISCORD_PUBLIC_KEY.
const PING = 1;
const PONG = 1;
const MESSAGE = 4;
const EPHEMERAL = 64;
const FAST_MS = 2500; // what is left of Discord's 3 s after the round trip
const ATTEMPT_MS = 70_000; // one wake-up of the server
const GIVE_UP_MS = 3 * 60_000; // then the note says to try again (the interaction token itself lasts 15 min)
const RETRY_MS = 3000;

export const WAKING = '⏳ O servidor estava dormindo e está acordando. A resposta chega aqui em até 1 minuto.';
export const FAILED = 'O servidor não respondeu. Tente de novo em instantes.';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const hex = (s) => Uint8Array.from(s.match(/../g) ?? [], (b) => parseInt(b, 16));

export async function verify(publicKeyHex, signature, timestamp, body) {
  if (!publicKeyHex || !signature || !timestamp) return false;
  try {
    const key = await crypto.subtle.importKey('raw', hex(publicKeyHex), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, hex(signature), new TextEncoder().encode(timestamp + body));
  } catch {
    return false;
  }
}

// One call to the server; null when it does not answer in time or answers with an error page
// (Render shows one while waking).
async function forward(origin, headers, body, ms, fetchImpl) {
  try {
    const res = await fetchImpl(new URL('/discord/interactions', origin), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-signature-ed25519': headers.get('x-signature-ed25519'), 'x-signature-timestamp': headers.get('x-signature-timestamp') },
      body,
      signal: AbortSignal.timeout(ms),
    });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Keeps calling the server, then puts its answer where it belongs.
async function finish(env, req, body, interaction, deps) {
  const { fetch: fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, attemptMs = ATTEMPT_MS } = deps;
  const hook = `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}`;
  const call = (path, method, payload) => fetchImpl(hook + path, { method, headers: { 'content-type': 'application/json' }, body: payload && JSON.stringify(payload) });
  const end = now() + GIVE_UP_MS;
  let answer = null;
  while (!answer && now() < end) {
    answer = await forward(env.ORIGIN, req.headers, body, attemptMs, fetchImpl);
    if (!answer) await sleep(RETRY_MS);
  }
  if (answer?.type !== MESSAGE || !answer.data) {
    await call('/messages/@original', 'PATCH', { content: answer ? 'Pronto.' : FAILED });
    return;
  }
  const { flags = 0, ...data } = answer.data;
  if (flags & EPHEMERAL) {
    // The note is already private: it simply becomes the answer.
    await call('/messages/@original', 'PATCH', { content: '', embeds: [], components: [], ...data });
  } else {
    // A private note cannot turn public: post the answer to the channel and drop the note.
    await call('?wait=true', 'POST', data);
    await call('/messages/@original', 'DELETE');
  }
}

export async function handle(req, env, ctx, deps = {}) {
  const { fetch: fetchImpl = fetch, fastMs = FAST_MS } = deps;
  const url = new URL(req.url);
  if (req.method !== 'POST' || url.pathname !== '/discord/interactions') {
    return new Response('Stream P2P: porta de entrada do bot do Discord.', { status: url.pathname === '/' ? 200 : 404 });
  }
  const body = await req.text();
  if (!(await verify(env.DISCORD_PUBLIC_KEY, req.headers.get('x-signature-ed25519'), req.headers.get('x-signature-timestamp'), body))) {
    return json({ error: 'assinatura inválida' }, 401);
  }
  let interaction;
  try {
    interaction = JSON.parse(body);
  } catch {
    return json({ error: 'JSON inválido' }, 400);
  }
  if (interaction.type === PING) return json({ type: PONG }); // Discord's endpoint check, also while the server sleeps

  const quick = await forward(env.ORIGIN, req.headers, body, fastMs, fetchImpl);
  if (quick) return json(quick);
  ctx.waitUntil(finish(env, req, body, interaction, deps));
  return json({ type: MESSAGE, data: { content: WAKING, flags: EPHEMERAL } });
}

export default { fetch: (req, env, ctx) => handle(req, env, ctx) };
