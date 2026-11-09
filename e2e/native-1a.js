// E2E slice 1a: the native presenter (native/) creates a session on a local server and a headless
// web viewer (Edge/Chrome, or Firefox) joins through the printed invite. Measures resolution, fps,
// glass-to-glass latency (clock blocks drawn by --synth), audio received, the presenter's RAM,
// a live bitrate change and an encoder failure (recreate), each as the viewer's longest frame gap.
//
//   node e2e/native-1a.js [--rounds N] [--label s1a] [--viewer edge|firefox] [--profile 4d001f]
//                         [--no-hw] [--screen] [--measure-ms 10000]
// --viewer firefox needs FIREFOX_PATH; --profile 4d001f with it checks the fallback to 42e01f [r19].
// --screen captures the real monitor instead of --synth (no clock: latency not measured; a still
// desktop is repeated at 10 fps, so fps and freeze checks are skipped).
// Results: e2e/bench/results/<label>-<n>.json. Exit 1 when a done-criterion fails.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import puppeteer from 'puppeteer-core';

const { values: opt } = parseArgs({ options: {
  rounds: { type: 'string', default: '1' }, label: { type: 'string', default: 's1a' },
  viewer: { type: 'string', default: 'edge' }, profile: { type: 'string', default: '42e01f' },
  'no-hw': { type: 'boolean', default: false }, screen: { type: 'boolean', default: false },
  'measure-ms': { type: 'string', default: '10000' },
} });
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const BIN = path.join(ROOT, 'native/target/release/native.exe');
const PORT = 3990 + Math.floor(Math.random() * 9);
const BASE = `http://localhost:${PORT}`;
const MEASURE_MS = Number(opt['measure-ms']);
const LIMITS = { latencyMs: 100, workingSetMB: 200, freezeMs: 100 };
const BROWSER = opt.viewer === 'firefox' ? process.env.FIREFOX_PATH : process.env.CHROME_PATH ?? [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find(existsSync);
if (!existsSync(BIN)) throw new Error(`falta ${BIN}: rode cd native && cargo build --release`);
if (!BROWSER || !existsSync(BROWSER)) throw new Error(opt.viewer === 'firefox' ? 'defina FIREFOX_PATH' : 'Edge/Chrome não encontrado; defina CHROME_PATH');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, what) => Promise.race([p, sleep(ms).then(() => { throw new Error(`timeout: ${what}`); })]);

// Working set of a process, in MB (current and peak), from the OS.
function memory(pid) {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$p = Get-Process -Id ${pid}; "$($p.WorkingSet64) $($p.PeakWorkingSet64) $($p.TotalProcessorTime.TotalMilliseconds)"`], { encoding: 'utf8', windowsHide: true }).trim().split(' ').map(Number);
  return { workingSetMB: +(out[0] / 2 ** 20).toFixed(1), peakWorkingSetMB: +(out[1] / 2 ** 20).toFixed(1), cpuMs: out[2] };
}

// Runs in the viewer page: frame times (requestVideoFrameCallback) and the bench clock reader
// (same encoding as e2e/bench/relay.html: 32 blocks on the top 1/8, 24-bit ms stamp + 0xa5).
const PAGE_HOOKS = () => {
  window.__frames = [];
  const watch = () => {
    const v = document.getElementById('video');
    if (!v?.requestVideoFrameCallback) return setTimeout(watch, 100);
    const tick = (now, meta) => { window.__frames.push({ t: Date.now(), w: meta.width, h: meta.height }); if (window.__frames.length > 20000) window.__frames.splice(0, 10000); v.requestVideoFrameCallback(tick); };
    v.requestVideoFrameCallback(tick);
  };
  addEventListener('DOMContentLoaded', watch);
  window.__readClock = () => {
    const v = document.getElementById('video');
    if (!v || v.readyState < 2) return null;
    const c = Object.assign(document.createElement('canvas'), { width: 320, height: 180 });
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(v, 0, 0, c.width, c.height);
    const now = Date.now();
    const { data, width } = g.getImageData(0, 0, c.width, c.height / 8);
    for (let y = 4; y < c.height / 8 - 2; y += 3) {
      let bits = 0, ok = true;
      for (let i = 0; i < 32 && ok; i++) {
        const p = (y * width + Math.floor((i + 0.5) * width / 32)) * 4;
        const rgb = [data[p], data[p + 1], data[p + 2]];
        if (rgb.every((x) => x >= 200)) bits |= 1 << i;
        else if (!rgb.every((x) => x <= 55)) ok = false;
      }
      if (ok && (bits >>> 24) === 0xa5) return ((now & 0xffffff) - (bits & 0xffffff) + 0x1000000) % 0x1000000;
    }
    return null;
  };
};

async function rtpStats(page) {
  return page.evaluate(async () => {
    const pc = window.__app?.video?.upstream;
    if (!pc) return null;
    const r = { video: null, audio: null };
    (await pc.getStats()).forEach((s) => {
      if (s.type !== 'inbound-rtp') return;
      if (s.kind === 'video') r.video = { frames: s.framesDecoded, fps: s.framesPerSecond, w: s.frameWidth, h: s.frameHeight, freezes: s.freezeCount ?? 0, lost: s.packetsLost, bytes: s.bytesReceived, codec: s.codecId, keys: s.keyFramesDecoded };
      if (s.kind === 'audio') r.audio = { bytes: s.bytesReceived, packets: s.packetsReceived, samples: s.totalSamplesReceived ?? null, level: s.audioLevel ?? null, energy: s.totalAudioEnergy ?? null };
    });
    if (r.video?.codec) { const c = (await pc.getStats()).get(r.video.codec); r.video.codec = `${c?.mimeType} ${c?.sdpFmtpLine ?? ''}`.trim(); }
    return r;
  });
}

// Longest gap between presented frames in [from, to] (ms since epoch).
const maxGap = (frames, from, to) => {
  const ts = frames.map((f) => f.t).filter((t) => t >= from && t <= to);
  let gap = 0;
  for (let i = 1; i < ts.length; i++) gap = Math.max(gap, ts[i] - ts[i - 1]);
  return { maxGapMs: gap, frames: ts.length };
};

async function round(n) {
  const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, PORT }, stdio: ['ignore', 'pipe', 'pipe'] });
  await withTimeout(new Promise((r) => server.stdout.on('data', (d) => String(d).includes('stream-p2p em') && r())), 10_000, 'servidor');
  const args = ['--server', BASE, '--name', 'Nativo', '--audio', 'tone', '--profile', opt.profile, ...(opt.screen ? [] : ['--synth'])];
  const env = { ...process.env, ...(opt['no-hw'] ? { SP2P_TEST_NO_HW: '1' } : {}) };
  const nat = spawn(BIN, args, { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const log = [];
  nat.stderr.on('data', (d) => log.push(...String(d).split(/\r?\n/).filter(Boolean)));
  let invite = null;
  const waiting = [];
  nat.stdout.on('data', (d) => {
    for (const line of String(d).split(/\r?\n/).filter(Boolean)) {
      const m = line.match(/^Convite: (\S+)/);
      if (m) invite = m[1];
      else if (line.startsWith('{')) waiting.shift()?.(JSON.parse(line).stats);
    }
  });
  const natStats = () => withTimeout(new Promise((r) => { waiting.push(r); nat.stdin.write('{"cmd":"stats"}\n'); }), 5000, 'stats do nativo');
  const profileDir = mkdtempSync(path.join(tmpdir(), 'sp2p-1a-'));
  let browser = null;
  try {
    await withTimeout((async () => { while (!invite) await sleep(50); })(), 15_000, 'convite');
    browser = await puppeteer.launch(opt.viewer === 'firefox' ? {
      browser: 'firefox', executablePath: BROWSER, headless: true, userDataDir: profileDir,
      extraPrefsFirefox: { 'media.peerconnection.ice.loopback': true, 'media.peerconnection.ice.obfuscate_host_addresses': false, 'media.autoplay.default': 0, 'media.autoplay.blocking_policy': 0 },
    } : {
      executablePath: BROWSER, headless: true, userDataDir: profileDir,
      args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
    });
    const page = (await browser.pages())[0] ?? await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.evaluateOnNewDocument(PAGE_HOOKS);
    const browserVersion = await browser.version();
    const t0 = Date.now();
    await page.goto(`${invite}&name=Espectador&auto=1`);
    await withTimeout((async () => { while (!(await rtpStats(page))?.video?.frames) await sleep(200); })(), 30_000, 'primeiro quadro no espectador');
    const firstFrameMs = Date.now() - t0;
    await sleep(5000); // settle: bandwidth estimate and jitter buffer

    // ── steady state ──
    const a = await rtpStats(page);
    const tA = Date.now();
    const mA = memory(nat.pid);
    const lat = [];
    const until = Date.now() + MEASURE_MS;
    while (Date.now() < until) {
      const v = opt.screen ? null : await page.evaluate(() => window.__readClock());
      if (v !== null) lat.push(v);
      await sleep(100);
    }
    const b = await rtpStats(page);
    const secs = (Date.now() - tA) / 1000;
    const mB = memory(nat.pid);
    lat.sort((x, y) => x - y);
    const steady = {
      resolution: `${b.video.w}x${b.video.h}`,
      fps: +((b.video.frames - a.video.frames) / secs).toFixed(1),
      kbps: Math.round(((b.video.bytes - a.video.bytes) * 8) / 1000 / secs),
      freezes: b.video.freezes - a.video.freezes,
      lost: b.video.lost - a.video.lost,
      codec: b.video.codec,
      latencyMs: lat.length ? { median: lat[lat.length >> 1], p95: lat[Math.floor(lat.length * 0.95)], samples: lat.length } : 'não medido',
      audio: { kbps: Math.round(((b.audio?.bytes - a.audio?.bytes) * 8) / 1000 / secs), packetsPerS: +((b.audio?.packets - a.audio?.packets) / secs).toFixed(1), samplesPerS: b.audio?.samples !== null && a.audio?.samples !== null ? Math.round((b.audio.samples - a.audio.samples) / secs) : 'não medido', level: b.audio?.level ?? 'não medido' },
      presenter: { ...mB, cpuPctOfOneCore: +(((mB.cpuMs - mA.cpuMs) / (secs * 1000)) * 100).toFixed(1) },
      // The web viewer holds frames for the show time the server dictates (latency 'auto').
      viewerBuffer: await page.evaluate(() => ({ jitterBufferTargetMs: window.__app.video.jitterMs, showTimeMs: window.__app.latency?.targetMs ?? null })),
      maxFrameGap: maxGap(await page.evaluate(() => window.__frames), Date.now() - MEASURE_MS, Date.now()),
    };

    // ── live bitrate change: 8000 → 4000 → 8000 kbps ──
    const live = [];
    for (const kbps of [4000, 8000]) {
      const at = Date.now();
      nat.stdin.write(`${JSON.stringify({ cmd: 'bitrate', kbps })}\n`);
      await sleep(3000);
      const frames = await page.evaluate(() => window.__frames);
      live.push({ kbps, viewer: maxGap(frames, at - 200, at + 2000) });
    }

    // ── encoder failure: 1 error (frame dropped) then 2 in a row (encoder recreated) ──
    const faults = [];
    for (const nFaults of [1, 2]) {
      const at = Date.now();
      nat.stdin.write(`${JSON.stringify({ cmd: 'fault', n: nFaults })}\n`);
      await sleep(3000);
      faults.push({ injected: nFaults, viewer: maxGap(await page.evaluate(() => window.__frames), at - 200, at + 2500) });
    }
    const after = await rtpStats(page);
    const ns = await natStats();
    const result = {
      label: `${opt.label}-${n}`, at: new Date().toISOString(), viewer: `${opt.viewer} ${browserVersion}`,
      source: opt.screen ? 'monitor (WGC)' : 'synth 1080p60 + relógio', offeredProfile: opt.profile, noHw: opt['no-hw'],
      measureMs: MEASURE_MS, firstFrameMs, steady, liveBitrate: live, encoderFaults: faults,
      afterFaults: { resolution: `${after.video.w}x${after.video.h}`, framesSinceSteady: after.video.frames - b.video.frames },
      presenterStats: ns, presenterLog: log,
    };
    const fail = [];
    if (steady.resolution !== '1920x1080') fail.push(`resolução ${steady.resolution}`);
    if (!opt.screen && steady.fps < 55) fail.push(`fps ${steady.fps}`);
    if (typeof steady.latencyMs === 'object' && steady.latencyMs.median >= LIMITS.latencyMs) fail.push(`latência ${steady.latencyMs.median} ms`);
    if (steady.presenter.peakWorkingSetMB >= LIMITS.workingSetMB) fail.push(`RAM ${steady.presenter.peakWorkingSetMB} MB`);
    if (!(steady.audio.packetsPerS > 40)) fail.push(`áudio ${steady.audio.packetsPerS} pacotes/s`);
    // A still monitor only sends a repeat every 100 ms (capture.rs REPEAT): gaps say nothing there.
    if (!opt.screen) for (const l of live) if (l.viewer.maxGapMs > LIMITS.freezeMs) fail.push(`bitrate ${l.kbps}: congelou ${l.viewer.maxGapMs} ms`);
    if (!(ns.recreates >= 1)) fail.push('falha repetida não recriou o encoder');
    if (!(result.afterFaults.framesSinceSteady > 0)) fail.push('vídeo parou depois das falhas');
    if (opt.profile !== '42e01f' && opt.viewer === 'firefox' && !ns.live.some((e) => e.event === 'fallback')) fail.push('sem fallback para 42e01f');
    if (opt['no-hw'] && !ns.software) fail.push('sem GPU não caiu para o MFT de software');
    result.failures = fail;
    mkdirSync(path.join(ROOT, 'e2e/bench/results'), { recursive: true });
    const file = path.join(ROOT, `e2e/bench/results/${opt.label}-${n}.json`);
    writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`[${result.label}] ${steady.resolution} ${steady.fps} fps, ${steady.kbps} kbps, latência ${JSON.stringify(steady.latencyMs)}, buffer ${steady.viewerBuffer.jitterBufferTargetMs} ms, RAM ${steady.presenter.workingSetMB}/${steady.presenter.peakWorkingSetMB} MB, CPU ${steady.presenter.cpuPctOfOneCore}%, áudio ${steady.audio.packetsPerS} pct/s; bitrate gaps ${live.map((l) => l.viewer.maxGapMs).join('/')} ms; falhas gaps ${faults.map((f) => f.viewer.maxGapMs).join('/')} ms; recreates ${ns.recreates}${fail.length ? `\n  FALHOU: ${fail.join('; ')}` : ''}`);
    return fail.length === 0;
  } finally {
    await browser?.close().catch(() => {});
    nat.stdin.end();
    nat.kill();
    server.kill();
    await sleep(500);
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 5 });
  }
}

let ok = true;
for (let i = 1; i <= Number(opt.rounds); i++) ok = (await round(i)) && ok;
process.exit(ok ? 0 : 1);
