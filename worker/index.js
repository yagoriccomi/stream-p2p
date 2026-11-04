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
// It also sits in front of the site itself (SITE_HOST, a route on the domain): everything is passed
// to Render as is, WebSockets included, except a page load that Render does not answer within a few
// seconds, which gets a "acordando" page that reloads itself once the server is up.
//
// Env: ORIGIN (Render's own address, e.g. https://stream-p2p-k72t.onrender.com), SITE_HOST
// (e.g. stream.yagoriccomi.com.br) and DISCORD_PUBLIC_KEY.
const PING = 1;
const PONG = 1;
const MESSAGE = 4;
const EPHEMERAL = 64;
const FAST_MS = 2500; // what is left of Discord's 3 s after the round trip
const ATTEMPT_MS = 70_000; // one wake-up of the server
const GIVE_UP_MS = 3 * 60_000; // then the note says to try again (the interaction token itself lasts 15 min)
const RETRY_MS = 3000;
const PAGE_MS = 4000; // a page load waits this long before the "acordando" page shows
const WAKE_CHECK_MS = 8000;

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

export const WAKING_PAGE = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Acordando o servidor · Stream P2P</title>
<meta name="color-scheme" content="dark"><noscript><meta http-equiv="refresh" content="10"></noscript>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0a0a0b;color:#f2f2f4;font:16px/1.5 Inter,system-ui,sans-serif;padding:16px;box-sizing:border-box}
main{max-width:420px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:16px}
h1{margin:0;font:900 32px/1.05 Archivo,'Arial Narrow',system-ui,sans-serif;text-transform:uppercase}
p{margin:0;color:#a1a1aa}
.bar{width:220px;height:4px;border-radius:4px;background:#1c1c20;overflow:hidden}
.bar i{display:block;width:40%;height:100%;background:#7f00ff;border-radius:4px;animation:go 1.4s ease-in-out infinite}
@keyframes go{0%{transform:translateX(-100%)}100%{transform:translateX(250%)}}
@media (prefers-reduced-motion:reduce){.bar i{animation:none;width:100%}}
</style></head><body><main>
<svg width="72" height="62" viewBox="0 0 120 104" aria-hidden="true"><rect x="7" y="7" width="106" height="70" rx="12" fill="none" stroke="#7F00FF" stroke-width="12"/><path d="M60 80v12M42 96h36" stroke="#7F00FF" stroke-width="10" stroke-linecap="round"/><path d="M46 22L82 42L46 62Z" fill="#fff"/></svg>
<h1>Acordando o servidor</h1>
<p>Ele dorme quando fica um tempo sem ninguém. Leva até 1 minuto, e a página abre sozinha.</p>
<div class="bar" role="progressbar" aria-label="Acordando o servidor"><i></i></div>
<p id="t" aria-live="polite"></p>
</main><script>
const t0 = Date.now(), out = document.getElementById('t');
(async function check() {
  out.textContent = Math.round((Date.now() - t0) / 1000) + ' s';
  try { if ((await fetch('/__wake', { cache: 'no-store' })).ok) return location.reload(); } catch {}
  setTimeout(check, 2000);
})();
</script></body></html>`;

// The site, through the Worker: a page load Render does not answer in PAGE_MS gets WAKING_PAGE (503,
// so the app's service worker does not cache it); everything else goes through untouched.
async function site(req, env, deps) {
  const { fetch: fetchImpl = fetch, pageMs = PAGE_MS } = deps;
  const url = new URL(req.url);
  if (url.pathname === '/__wake') {
    let up = false;
    try {
      up = (await fetchImpl(new URL('/health', env.ORIGIN), { signal: AbortSignal.timeout(WAKE_CHECK_MS) })).ok;
    } catch {}
    return new Response(up ? 'ok' : 'acordando', { status: up ? 200 : 503, headers: { 'cache-control': 'no-store' } });
  }
  // redirect: 'manual' so a redirect (e.g. /discord/install) reaches the browser instead of being followed here.
  const upstream = new Request(new Request(new URL(url.pathname + url.search, env.ORIGIN), req), { redirect: 'manual' });
  const page = req.method === 'GET' && !req.headers.get('upgrade') && (req.headers.get('accept') ?? '').includes('text/html');
  if (!page) return fetchImpl(upstream);
  try {
    const res = await fetchImpl(upstream, { signal: AbortSignal.timeout(pageMs) });
    if (res.status < 502) return res;
  } catch {}
  return new Response(WAKING_PAGE, { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '5' } });
}

export async function handle(req, env, ctx, deps = {}) {
  const { fetch: fetchImpl = fetch, fastMs = FAST_MS } = deps;
  const url = new URL(req.url);
  const isInteraction = req.method === 'POST' && url.pathname === '/discord/interactions';
  if (!isInteraction && env.SITE_HOST && url.hostname === env.SITE_HOST) return site(req, env, deps);
  if (!isInteraction) {
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
