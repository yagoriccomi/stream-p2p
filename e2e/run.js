// E2E: Ana creates a session; Bruno, Caio and Dani join through the invite link.
// Covers: unique nickname (409), chat, streaming with relay (1440p60 @ 20 Mbps → 1 direct),
// live source swap, moderator limits (403), passing the turn, and re-parent when a relay leaves.
// getDisplayMedia is replaced by an animated canvas (+ an oscillator as system audio).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';

const PORT = 3999;
// Glass-to-glass spread between viewers. One machine encodes for everyone, so allow noise;
// the old model (relay buffer stacked on its children) measured ~100 ms here.
const MAX_SPREAD_MS = 60;
const BASE = `http://localhost:${PORT}`;
const CHROME = process.env.CHROME_PATH ?? [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/opt/pw-browsers/chromium',
].find(existsSync);
assert.ok(CHROME, 'Chrome não encontrado; defina CHROME_PATH');

const FAKE_CAPTURE = () => {
  let n = 0;
  navigator.mediaDevices.getDisplayMedia = async ({ video }) => {
    const hue = 120 * n++;
    const c = Object.assign(document.createElement('canvas'), { width: video.width, height: video.height });
    const g = c.getContext('2d');
    let t = 0;
    setInterval(() => {
      g.fillStyle = `hsl(${(hue + t++) % 360} 70% 40%)`;
      g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = '#fff';
      g.font = '120px sans-serif';
      g.fillText(String(t), 100 + (t * 7) % (c.width - 400), c.height / 2);
      // clock in the picture: 24 black/white blocks on top → viewers measure glass-to-glass latency
      const stamp = Date.now() & 0xffffff;
      const bw = c.width / 32;
      for (let i = 0; i < 24; i++) {
        g.fillStyle = (stamp >> i) & 1 ? '#fff' : '#000';
        g.fillRect(i * bw, 0, bw, c.height / 8);
      }
    }, 1000 / video.frameRate);
    const stream = c.captureStream(video.frameRate);
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const dest = ctx.createMediaStreamDestination();
    osc.connect(dest);
    osc.start();
    stream.addTrack(dest.stream.getAudioTracks()[0]);
    return stream;
  };
};

const server = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT }, stdio: 'inherit' });
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: process.env.HEADFUL ? false : 'new',
  args: [
    ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
    '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--mute-audio',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  ],
});

const dump = (page) => page.evaluate(() => JSON.stringify({ toasts: [...document.querySelectorAll('.err')].map((e) => e.textContent), stats: window.__stats, s: window.__app?.session && { presenter: window.__app.session.presenterId, n: window.__app.session.members.length } }));
const waitFor = (page, fn, what, arg, timeout = 20000) =>
  page.waitForFunction(fn, { timeout, polling: 250 }, arg).catch(async (e) => {
    throw new Error(`timeout: ${what}\n${await dump(page).catch(() => e.message)}`);
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hasVideo = () => document.getElementById('video').videoWidth > 0 && window.__stats?.kbps > 0;
const presenterVideo = () => !!window.__app.session.presenterState && document.getElementById('video').videoWidth > 0 && window.__stats?.kbps > 0;
// Median latency (ms) of the frames this viewer presents, decoded from the clock blocks.
const latency = async (page) => { await page.bringToFront(); return page.evaluate(() => new Promise((done) => {
  const v = document.getElementById('video');
  const c = Object.assign(document.createElement('canvas'), { width: 320, height: 180 });
  const g = c.getContext('2d', { willReadFrequently: true });
  const out = [];
  const sample = () => {
    g.drawImage(v, 0, 0, c.width, c.height);
    const now = Date.now();
    let stamp = 0;
    for (let i = 0; i < 24; i++) {
      const [r, gg, b] = g.getImageData(Math.floor((i + 0.5) * (c.width / 32)), Math.floor(c.height / 16), 1, 1).data;
      if (r + gg + b > 384) stamp |= 1 << i;
    }
    out.push(((now & 0xffffff) - stamp + 0x1000000) % 0x1000000);
    if (out.length < 30) setTimeout(sample, 50);
    else done(out.sort((x, y) => x - y)[15]);
  };
  sample();
})); };
const toastWith = (text) => [...document.querySelectorAll('.err')].some((e) => e.textContent.includes(text));

async function open(url) {
  const p = await browser.newPage();
  await p.setViewport({ width: 1280, height: 800 }); // desktop layout: people + chat side by side
  await p.evaluateOnNewDocument(FAKE_CAPTURE);
  p.on('pageerror', (e) => console.error('pageerror:', e.message));
  p.on('console', (m) => /erro|error/i.test(m.text()) && console.error('console:', m.text()));
  await p.goto(url);
  return p;
}

async function menuAction(page, person, label) {
  await page.bringToFront();
  await page.click(`button[aria-label="Ações para ${person}"]`);
  await page.evaluate((l) => [...document.querySelectorAll('#menu button')].find((b) => b.textContent.includes(l)).click(), label);
}

async function startStream(page, mode, { firstTime = false } = {}) {
  await page.bringToFront(); // background tabs don't get real clicks
  await page.click('#ov-stream');
  await page.evaluate((m) => [...document.querySelectorAll('#q-modes button')].find((b) => b.textContent === m).click(), mode);
  await page.$eval('#q-upload', (i) => { i.value = '20'; i.dispatchEvent(new Event('input')); });
  if (firstTime) {
    // T02 measures the upload by itself the first time; what the person typed still wins.
    await waitFor(page, () => document.getElementById('q-measured').textContent.includes('Medido agora'), 'upload medido');
    const shown = await page.$eval('#q-measured', (e) => e.textContent);
    assert.equal(await page.$eval('#q-upload', (i) => i.value), '20', 'a medição não sobrescreve o valor digitado');
    // Measure again after typing (past the 10 s rate window): the result is only offered.
    await sleep(10_500);
    await page.click('#q-measure');
    await waitFor(page, () => document.querySelector('#q-measured button')?.textContent === 'Usar este valor', 'oferta de usar o valor medido');
    assert.equal(await page.$eval('#q-upload', (i) => i.value), '20', 'a medição não sobrescreve o valor digitado');
    console.log(`upload ok (${shown})`);
  }
  await page.click('#q-start');
}

try {
  await sleep(500);
  // T01 · create
  const ana = await open(BASE);
  await waitFor(ana, () => !document.querySelector('[data-screen=home]').hidden && document.getElementById('conn').hidden, 'home pronta');
  await ana.type('#create-name', 'Ana');
  await ana.click('#create-form button[type=submit]');
  await waitFor(ana, () => window.__app.session?.members.length === 1, 'sessão criada');
  const code = await ana.evaluate(() => window.__app.code);
  assert.match(code, /^[a-z2-9]{4}-[a-z2-9]{2}$/);
  assert.equal(await ana.$eval('#s-code', (e) => e.textContent), '•'.repeat(7), 'código deve vir oculto');
  console.log('sessão:', code);

  // T09 · join through the invite (name prefilled like the Discord link)
  const people = {};
  for (const name of ['Bruno', 'Caio', 'Dani']) {
    const p = await open(`${BASE}/?code=${code}&name=${name}`);
    await waitFor(p, () => !document.querySelector('[data-screen=join]').hidden && document.getElementById('conn').hidden, `join ${name}`);
    assert.equal(await p.$eval('#join-name', (i) => i.value), name);
    await p.click('#join-form button[type=submit]');
    await waitFor(p, () => window.__app.session?.members.length > 1, `${name} entrou`);
    people[name] = p;
  }
  await waitFor(ana, () => window.__app.session.members.length === 4, '4 na sessão');

  // 409: same nickname, different case/accent
  const dup = await open(`${BASE}/?code=${code}&name=bRúno`);
  await waitFor(dup, () => document.getElementById('conn').hidden, 'dup conectado');
  await dup.click('#join-form button[type=submit]');
  await waitFor(dup, () => !document.getElementById('join-name-err').hidden && document.getElementById('join-name-err').textContent.includes('409'), '409 no apelido');
  await dup.close();
  console.log('409 ok');

  // chat
  await people.Bruno.bringToFront();
  await people.Bruno.type('#chat-input', 'oi gente');
  await people.Bruno.keyboard.press('Enter');
  await waitFor(ana, () => document.getElementById('messages').textContent.includes('oi gente'), 'chat chegou');
  console.log('chat ok');

  // T02 · Ana streams 1440p60 with 20 Mbps → quota 1: one direct, two relayed
  assert.equal(await ana.evaluate(() => window.__app.voice.peers.size), 3, 'voz em malha com os 3');
  // Connected is not heard: every member must receive sound from every other one (both ends of each pair).
  for (const [n, p] of Object.entries({ Ana: ana, ...people })) {
    const silent = await p.evaluate(async () => {
      const energy = async (pc) => { let e = 0; for (const s of (await pc.getStats()).values()) if (s.type === 'inbound-rtp' && s.kind === 'audio') e += s.totalAudioEnergy ?? 0; return e; };
      const peers = [...window.__app.voice.peers.entries()];
      const before = await Promise.all(peers.map(([, { pc }]) => energy(pc)));
      await new Promise((r) => setTimeout(r, 2500));
      const after = await Promise.all(peers.map(([, { pc }]) => energy(pc)));
      return peers.filter((_, i) => after[i] - before[i] < 0.01).map(([id]) => id.slice(0, 6));
    });
    assert.deepEqual(silent, [], `${n} não ouve a voz de: ${silent.join(', ')}`);
  }
  console.log('voz ok: todos ouvem todos');
  await startStream(ana, '1440p60', { firstTime: true });
  for (const [n, p] of Object.entries(people)) await waitFor(p, hasVideo, `vídeo em ${n}`);
  await sleep(4000);
  // Quota 1: one direct (the relay) and two below it. The relay forwards after its own buffer,
  // so it buffers more and its children ~0; the clock in the picture checks they end up in sync.
  const anaId = await ana.evaluate(() => window.__app.me);
  const lat = {};
  for (const [n, p] of Object.entries(people)) {
    lat[n] = { ...(await p.evaluate(() => ({ direct: window.__stats.parent, buffer: window.__stats.jitterMs, rtt: window.__stats.rttMs }))), ms: await latency(p) };
    lat[n].direct = lat[n].direct === anaId;
  }
  console.log('latência ponta a ponta:', JSON.stringify(lat));
  const direct = Object.values(lat).filter((x) => x.direct);
  const relayed = Object.values(lat).filter((x) => !x.direct);
  assert.equal(direct.length, 1, '1 direto e 2 via relay');
  assert.ok(relayed.every((x) => x.buffer < direct[0].buffer), 'o relay segura o buffer, os filhos não somam outro');
  assert.ok(Object.values(lat).every((x) => x.rtt !== null), 'todos mediram o RTT do salto');
  const spread = Math.max(...Object.values(lat).map((x) => x.ms)) - Math.min(...Object.values(lat).map((x) => x.ms));
  assert.ok(spread <= MAX_SPREAD_MS, `diferença de atraso entre espectadores ${spread} ms > ${MAX_SPREAD_MS} ms`);

  // T04 · swap source live: same connections, video keeps flowing
  const pcsBefore = await ana.evaluate(() => [...window.__app.video.downstream.values()].length);
  await ana.bringToFront();
  await ana.click('#p-source');
  await sleep(3000);
  for (const [n, p] of Object.entries(people)) await waitFor(p, hasVideo, `vídeo após trocar fonte em ${n}`);
  assert.equal(await ana.evaluate(() => [...window.__app.video.downstream.values()].length), pcsBefore);
  console.log('trocar fonte ok');

  // T10 · Ana makes Caio a moderator; Caio can't ban (403) but can lock
  await menuAction(ana, 'Caio', 'Tornar moderador');
  await waitFor(people.Caio, () => window.__app.session.members.find((m) => m.name === 'Caio').role === 'mod', 'Caio moderador');
  assert.equal(await people.Caio.evaluate(() => !!document.querySelector('button[aria-label="Ações para Dani"]')), true);
  await people.Caio.bringToFront();
  await people.Caio.click('button[aria-label="Ações para Dani"]');
  const caioMenu = await people.Caio.$$eval('#menu button', (bs) => bs.map((b) => b.textContent));
  assert.ok(!caioMenu.some((t) => t.includes('Bloquear')), 'moderador não vê Bloquear');
  await people.Caio.keyboard.press('Escape');
  await people.Caio.evaluate(() => {
    const dani = window.__app.session.members.find((m) => m.name === 'Dani');
    window.__app.send({ type: 'mod', action: 'ban', id: dani.id });
  });
  await waitFor(people.Caio, toastWith, '403 ao bloquear', 'Só o dono pode bloquear');
  console.log('moderador 403 ok');

  // Dani asks for the turn; Ana (presenter) passes it from the banner
  await people.Dani.bringToFront();
  await people.Dani.click('#f-stream');
  await waitFor(ana, () => !document.getElementById('req-banner').hidden, 'pedido de vez');
  await ana.bringToFront();
  await ana.click('#req-yes');
  await waitFor(people.Dani, toastWith, 'sua vez', 'Sua vez de transmitir');
  await startStream(people.Dani, '1440p60');
  for (const n of ['Bruno', 'Caio']) await waitFor(people[n], presenterVideo, `vídeo da Dani em ${n}`);
  await waitFor(ana, hasVideo, 'Ana assiste a Dani');
  console.log('passar a vez ok');

  // relay leaves → its child re-hangs and gets video again
  await sleep(3000);
  const daniId = await people.Dani.evaluate(() => window.__app.me);
  const parents = await Promise.all([ana, people.Bruno, people.Caio].map((p) => p.evaluate(() => window.__stats.parent)));
  const all = { Ana: [ana, parents[0]], Bruno: [people.Bruno, parents[1]], Caio: [people.Caio, parents[2]] };
  const [directName] = Object.entries(all).find(([, [, parent]]) => parent === daniId);
  const rest = Object.entries(all).filter(([n]) => n !== directName);
  await all[directName][0].close();
  await sleep(5000); // stats refresh every 2 s; kbps > 0 afterwards means the re-hung path is flowing
  for (const [n, [p]] of rest) await waitFor(p, hasVideo, `re-parent ${n}`);
  console.log(`re-parent ok (${directName} saiu)`);
  console.log('E2E OK');
} finally {
  await browser.close();
  server.kill();
}
