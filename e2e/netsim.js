// Network fault simulation: Ana streams to Bruno with all media forced through a local TURN,
// and a UDP proxy in front of it degrades what the TURN delivers (loss, delay, jitter, outage).
// TURN: Pion's reference server (go install github.com/pion/turn/v4/examples/turn-server/simple@latest),
// path in NETSIM_TURN_BIN. node-turn was tried first: Chrome rejects its ChannelBind replies and
// drops every relayed connection ~30 s in, with or without faults.
// Bruno's signaling goes through a TCP proxy that can drop the WebSocket or play "server down".
// Prints one row per scenario: what the viewer actually got (fps, kbps, freezes, latency).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import dgram from 'node:dgram';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import net from 'node:net';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';

const PORT = 3998; // signaling server
const WS_PROXY_PORT = 3997; // Bruno's way to the server
const TURN_PORT = 3479;
const TURN_PROXY_PORT = 3480; // what the browsers are told the TURN is
const TURN_USER = 'sp2p';
const TURN_PASS = 'netsim'; // local throwaway credential, only valid for this run
const MODE = process.env.NETSIM_MODE ?? '720p30';
const SETTLE_MS = 4000; // let the encoder and the congestion control react before measuring
const MEASURE_MS = Number(process.env.NETSIM_MEASURE_MS) || 10_000; // longer windows for rare events (freezes)
const BASE = `http://localhost:${PORT}`;
const CHROME = process.env.CHROME_PATH ?? [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
].find(existsSync);
assert.ok(CHROME, 'Chrome não encontrado; defina CHROME_PATH');
const TURN_BIN = process.env.NETSIM_TURN_BIN ?? path.join(homedir(), 'go', 'bin', process.platform === 'win32' ? 'simple.exe' : 'simple');
assert.ok(existsSync(TURN_BIN), `TURN não encontrado em ${TURN_BIN}; instale com go install github.com/pion/turn/v4/examples/turn-server/simple@latest ou defina NETSIM_TURN_BIN`);

// ── UDP proxy: every packet the TURN sends to a browser passes `impair` once ──
// (applied on the TURN→browser leg only, so one media packet is degraded exactly once
// and a round trip crosses it twice: once to the viewer, once back to the presenter).
const impair = { loss: 0, delay: 0, jitter: 0, queue: false, down: false };
// The proxy is this process: if the machine is busy, its event loop lags and adds delay and
// jitter of its own. Measured per window, so a contaminated measurement says so.
const loopLag = monitorEventLoopDelay({ resolution: 10 });
loopLag.enable();
// Windows timers tick every ~15.6 ms by default: every delay would be rounded up to a tick and
// the packets released in bursts. Ask for 1 ms, as Chrome does for itself.
if (process.platform === 'win32') {
  const { default: koffi } = await import('koffi');
  koffi.load('winmm.dll').func('uint32 __stdcall timeBeginPeriod(uint32)')(1);
}
const median = (xs) => (xs.length ? [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)] : null);
const TIMER_MAX_MS = 5; // setTimeout(1) slower than this: delays and jitter come out coarser than asked
const timerMs = await new Promise((done) => {
  const out = [];
  const tick = () => {
    const t = performance.now();
    setTimeout(() => (out.push(performance.now() - t) < 50 ? tick() : done(median(out))), 1);
  };
  tick();
});
const PROXY_LAG_MAX_MS = 20; // p99 above this: the numbers measure the machine, not the scenario
const udp = { delivered: 0, dropped: 0 };
// Two jitter models. Default: each packet draws its own delay, so packets ±50 ms apart swap
// places (reordering, which real paths rarely do). `queue`: the delay drifts between random
// points 200 ms apart, like a queue filling and draining; the drift is slower than time itself,
// so order is kept.
const SMOOTH_SEGMENT_MS = 200;
const wander = { from: 0, to: 0, at: 0 };
function drift(now) {
  if (now - wander.at >= SMOOTH_SEGMENT_MS) Object.assign(wander, { from: wander.to, to: Math.random() * 2 - 1, at: now });
  return wander.from + ((wander.to - wander.from) * (now - wander.at)) / SMOOTH_SEGMENT_MS;
}
function deliver(fn) {
  if (impair.down || Math.random() < impair.loss) return udp.dropped++;
  udp.delivered++;
  const spread = impair.queue ? drift(performance.now()) : Math.random() * 2 - 1;
  const ms = Math.max(0, impair.delay + spread * impair.jitter);
  ms ? setTimeout(fn, ms) : fn();
}
const front = dgram.createSocket('udp4');
const backs = new Map(); // one upstream socket per browser socket, so the TURN sees distinct clients
front.on('message', (msg, from) => {
  const key = `${from.address}:${from.port}`;
  let back = backs.get(key);
  if (!back) {
    back = dgram.createSocket('udp4');
    back.on('message', (m) => deliver(() => front.send(m, from.port, from.address)));
    backs.set(key, back);
  }
  back.send(msg, TURN_PORT, '127.0.0.1');
});
front.bind(TURN_PROXY_PORT, '127.0.0.1');

const turn = spawn(TURN_BIN, ['-public-ip', '127.0.0.1', '-port', String(TURN_PORT), '-users', `${TURN_USER}=${TURN_PASS}`], { stdio: 'ignore' });

// ── TCP proxy for Bruno's HTTP + WebSocket ──
const wsLink = { down: false, sockets: new Set() };
net.createServer((c) => {
  if (wsLink.down) return c.destroy();
  const u = net.connect(PORT, '127.0.0.1');
  const end = () => { c.destroy(); u.destroy(); wsLink.sockets.delete(c); };
  wsLink.sockets.add(c);
  c.pipe(u).pipe(c);
  for (const s of [c, u]) s.on('error', end).on('close', end);
}).listen(WS_PROXY_PORT, '127.0.0.1');
const cutSignaling = () => { wsLink.down = true; for (const s of wsLink.sockets) s.destroy(); };
const restoreSignaling = () => { wsLink.down = false; };

const server = spawn(process.execPath, ['server/index.js'], {
  env: { ...process.env, PORT, TURN_URLS: `turn:127.0.0.1:${TURN_PROXY_PORT}?transport=udp`, TURN_USERNAME: TURN_USER, TURN_CREDENTIAL: TURN_PASS },
  stdio: ['ignore', 'ignore', 'inherit'],
});

// Same fake screen as e2e/run.js: an animated canvas with a 24-bit clock on top. It is easy to
// compress (~1.2 Mbps in 720p30). NETSIM_CONTENT=game draws a detailed texture panning like a
// game camera, with lighting changes and particles, so the encoder needs every bit it gets.
const CONTENT = process.env.NETSIM_CONTENT ?? 'simple';
const FAKE_CAPTURE = (content) => {
  navigator.mediaDevices.getDisplayMedia = async ({ video }) => {
    const c = Object.assign(document.createElement('canvas'), { width: video.width, height: video.height });
    const g = c.getContext('2d');
    const TILE = 512;
    const tex = Object.assign(document.createElement('canvas'), { width: TILE, height: TILE });
    if (content === 'game') {
      const small = Object.assign(document.createElement('canvas'), { width: TILE / 4, height: TILE / 4 });
      const sg = small.getContext('2d');
      const img = sg.createImageData(small.width, small.height);
      for (let i = 0; i < img.data.length; i += 4) img.data.set([Math.random() * 256, Math.random() * 256, Math.random() * 256, 255], i);
      sg.putImageData(img, 0, 0);
      tex.getContext('2d').drawImage(small, 0, 0, TILE, TILE); // smoothed 4x: detail, not pure noise
    }
    let t = 0;
    setInterval(() => {
      t++;
      if (content === 'game') {
        const [ox, oy] = [(t * 7) % TILE, (t * 3) % TILE];
        for (let x = -ox; x < c.width; x += TILE) for (let y = -oy; y < c.height; y += TILE) g.drawImage(tex, x, y);
        g.fillStyle = `hsl(${(t * 3) % 360} 80% 50% / 0.25)`; // lighting changes every frame
        g.fillRect(0, 0, c.width, c.height);
        for (let i = 0; i < 40; i++) { // particles: nothing to predict them from
          g.fillStyle = `hsl(${Math.random() * 360} 90% 60%)`;
          g.fillRect(Math.random() * c.width, Math.random() * c.height, 24, 24);
        }
      } else {
        g.fillStyle = `hsl(${t % 360} 70% 40%)`;
        g.fillRect(0, 0, c.width, c.height);
      }
      g.fillStyle = '#fff';
      g.font = '120px sans-serif';
      g.fillText(String(t), 100 + (t * 7) % (c.width - 400), c.height / 2);
      const stamp = Date.now() & 0xffffff;
      const bw = c.width / 32;
      for (let i = 0; i < 24; i++) {
        g.fillStyle = (stamp >> i) & 1 ? '#fff' : '#000';
        g.fillRect(i * bw, 0, bw, c.height / 8);
      }
    }, 1000 / video.frameRate);
    return c.captureStream(video.frameRate);
  };
};
// NETSIM_DEGRADATION=maintain-framerate|balanced|maintain-resolution overrides the app's choice on
// every video setParameters, so the three can be compared on the same network.
const FORCE_DEGRADATION = (pref) => {
  const set = RTCRtpSender.prototype.setParameters;
  RTCRtpSender.prototype.setParameters = function (p, ...rest) {
    if (this.track?.kind === 'video') p.degradationPreference = pref;
    return set.call(this, p, ...rest);
  };
};
// NETSIM_START_BITRATE=<kbps> replaces the app's x-google-start-bitrate (0 strips it: Chrome's default).
const SET_START_BITRATE = (kbps) => {
  const set = RTCPeerConnection.prototype.setRemoteDescription;
  RTCPeerConnection.prototype.setRemoteDescription = function (d, ...rest) {
    const sdp = kbps
      ? d?.sdp?.replace(/x-google-start-bitrate=\d+/g, `x-google-start-bitrate=${kbps}`)
      : d?.sdp?.replace(/;?x-google-start-bitrate=\d+/g, '').replace(/a=fmtp:\d+ \r\n/g, '');
    return set.call(this, sdp ? { type: d.type, sdp } : d, ...rest);
  };
};
// Only relay candidates: every byte crosses the TURN, so the proxy degrades all of it.
const FORCE_RELAY = () => {
  const Native = window.RTCPeerConnection;
  window.__pcs = [];
  window.RTCPeerConnection = class extends Native {
    constructor(cfg = {}, ...rest) {
      super({ ...cfg, iceTransportPolicy: 'relay' }, ...rest);
      window.__pcs.push(this);
    }
  };
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: process.env.HEADFUL ? false : 'new',
  args: [
    '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--allow-loopback-in-peer-connection',
  ],
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = (page, fn, what, arg, timeout = 30_000) =>
  page.waitForFunction(fn, { timeout, polling: 100 }, arg).catch(() => { throw new Error(`timeout: ${what}`); });
const hasVideo = () => document.getElementById('video').videoWidth > 0 && window.__stats?.kbps > 0;

async function open(url) {
  const p = await browser.newPage();
  await p.setViewport({ width: 1280, height: 800 });
  await p.evaluateOnNewDocument(FAKE_CAPTURE, CONTENT);
  await p.evaluateOnNewDocument(FORCE_RELAY);
  if (process.env.NETSIM_START_BITRATE) await p.evaluateOnNewDocument(SET_START_BITRATE, Number(process.env.NETSIM_START_BITRATE));
  if (process.env.NETSIM_DEGRADATION) await p.evaluateOnNewDocument(FORCE_DEGRADATION, process.env.NETSIM_DEGRADATION);
  p.on('pageerror', (e) => console.error('pageerror:', e.message));
  if (process.env.NETSIM_DEBUG) p.on('console', (m) => console.log(`  [${new URL(url).port}] ${m.text()}`));
  await p.goto(url);
  return p;
}

// Cumulative counters of the viewer's incoming video plus the presenter-side view of the path.
const VIDEO_IN = async () => {
  for (const pc of window.__pcs) {
    if (pc.connectionState === 'closed') continue;
    const r = [...(await pc.getStats()).values()];
    const v = r.find((s) => s.type === 'inbound-rtp' && s.kind === 'video');
    if (!v) continue;
    const transport = r.find((s) => s.type === 'transport');
    const pair = r.find((s) => s.id === transport?.selectedCandidatePairId);
    const local = pair && r.find((s) => s.id === pair.localCandidateId);
    return {
      frames: v.framesDecoded ?? 0, bytes: v.bytesReceived ?? 0, lost: v.packetsLost ?? 0, recv: v.packetsReceived ?? 0,
      freezes: v.freezeCount ?? 0, freezeS: v.totalFreezesDuration ?? 0, nacks: v.nackCount ?? 0,
      bufS: v.jitterBufferDelay ?? 0, bufN: v.jitterBufferEmittedCount ?? 0, height: v.frameHeight ?? 0,
      rttMs: pair?.currentRoundTripTime != null ? pair.currentRoundTripTime * 1000 : null,
      jitterMs: (v.jitter ?? 0) * 1000, targetMs: window.__stats?.jitterMs ?? null,
      relay: local?.candidateType === 'relay', state: pc.connectionState, at: performance.now(),
    };
  }
  return null;
};
// The presenter's side of the same video: what the congestion control allows (BWE), what the
// encoder aims for, what actually left, and why quality is limited. Sampled every second.
const VIDEO_OUT = async () => {
  for (const pc of window.__pcs) {
    if (pc.connectionState === 'closed') continue;
    const r = [...(await pc.getStats()).values()];
    const v = r.find((s) => s.type === 'outbound-rtp' && s.kind === 'video');
    if (!v) continue;
    const transport = r.find((s) => s.type === 'transport');
    const pair = r.find((s) => s.id === transport?.selectedCandidatePairId);
    return {
      bweKbps: (pair?.availableOutgoingBitrate ?? 0) / 1000, targetKbps: (v.targetBitrate ?? 0) / 1000,
      bytes: v.bytesSent ?? 0, rtxBytes: v.retransmittedBytesSent ?? 0, height: v.frameHeight ?? 0,
      fps: v.framesPerSecond ?? 0, limit: v.qualityLimitationReason, limitS: v.qualityLimitationDurations ?? {},
      qpSum: v.qpSum ?? 0, encoded: v.framesEncoded ?? 0, codec: r.find((x) => x.id === v.codecId)?.mimeType,
      at: performance.now(),
    };
  }
  return null;
};
const SAMPLE_MS = 1000;
// Window summary of the presenter samples; NETSIM_TRACE=1 also prints them second by second.
function senderSummary(trace) {
  const t = trace.filter(Boolean);
  if (t.length < 2) return {};
  const [o0, o1] = [t[0], t.at(-1)];
  const s = (o1.at - o0.at) / 1000;
  const sent = o1.bytes - o0.bytes;
  const limited = (why) => Math.round((100 * ((o1.limitS[why] ?? 0) - (o0.limitS[why] ?? 0))) / s);
  if (process.env.NETSIM_TRACE) {
    for (let i = 1; i < t.length; i++) {
      const kbps = Math.round(((t[i].bytes - t[i - 1].bytes) * 8) / (t[i].at - t[i - 1].at));
      console.log(`    ${i}s BWE ${Math.round(t[i].bweKbps)} alvo ${Math.round(t[i].targetKbps)} enviado ${kbps} kbps, ${t[i].height}p ${Math.round(t[i].fps)} fps, ${t[i].limit}`);
    }
  }
  return {
    'BWE kbps': Math.round(median(t.map((x) => x.bweKbps))),
    'BWE mín kbps': Math.round(Math.min(...t.map((x) => x.bweKbps))),
    'alvo do encoder kbps': Math.round(median(t.map((x) => x.targetKbps))),
    'enviado kbps': Math.round((sent * 8) / s / 1000),
    'reenvio %': sent ? +((100 * (o1.rtxBytes - o0.rtxBytes)) / sent).toFixed(1) : 0,
    'altura enviada': median(t.map((x) => x.height)),
    // Average quantizer: how hard each frame is compressed (VP8 0–127; higher is blurrier).
    'QP médio': o1.encoded > o0.encoded ? Math.round((o1.qpSum - o0.qpSum) / (o1.encoded - o0.encoded)) : null,
    'limitado por banda %': limited('bandwidth'),
    'limitado por CPU %': limited('cpu'),
  };
}
// Median glass-to-glass latency from the clock blocks (same probe as e2e/run.js).
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

const rows = [];
// Stream start, on a clean network: the encoder starts from the initial bandwidth estimate and
// climbs to the full resolution step by step. Measured on its own, so `base` does not get the ramp.
const FULL_HEIGHT = Number(MODE.match(/^(\d+)p/)[1]);
const STARTUP_MS = 30_000;
// NETSIM_START_IN=bad|badQueue starts the stream on that network instead of a clean one.
const START_IN = { bad: { delay: 150, jitter: 50, loss: 0.02 }, badQueue: { delay: 150, jitter: 50, loss: 0.02, queue: true } }[process.env.NETSIM_START_IN];
async function startup(viewer, presenter) {
  const a = await viewer.evaluate(VIDEO_IN);
  const trace = [await presenter.evaluate(VIDEO_OUT)];
  for (const end = Date.now() + STARTUP_MS; Date.now() < end;) {
    await sleep(Math.min(SAMPLE_MS, end - Date.now()));
    trace.push(await presenter.evaluate(VIDEO_OUT));
  }
  const b = await viewer.evaluate(VIDEO_IN);
  const pref = await presenter.evaluate(() => window.__pcs.flatMap((pc) => pc.getSenders())
    .find((s) => s.track?.kind === 'video')?.getParameters().degradationPreference ?? '-');
  const startKbps = await presenter.evaluate(() => Number(window.__pcs.map((pc) => pc.remoteDescription?.sdp ?? '')
    .join('').match(/x-google-start-bitrate=(\d+)/)?.[1] ?? 0));
  const t = trace.filter(Boolean);
  const full = t.findIndex((x) => x.height >= FULL_HEIGHT);
  rows.push({
    cenário: 'início da transmissão',
    'rede no início': process.env.NETSIM_START_IN || 'limpa',
    degradationPreference: pref,
    'start bitrate kbps': startKbps || 'padrão do Chrome',
    codec: t.at(-1)?.codec ?? '-',
    'altura inicial': t[0]?.height,
    'resolução cheia em s': full >= 0 ? Math.round((t[full].at - t[0].at) / 1000) : 'não chegou',
    'altura no fim': t.at(-1)?.height,
    fps: Math.round((b.frames - a.frames) / ((b.at - a.at) / 1000)),
    'fps mín no host': Math.round(Math.min(...t.map((x) => x.fps))),
    congelamentos: b.freezes - a.freezes,
    'congelado s': +(b.freezeS - a.freezeS).toFixed(1),
  });
  const r = rows.at(-1);
  const climb = full >= 0 ? `resolução cheia em ${r['resolução cheia em s']} s` : `não chegou a ${FULL_HEIGHT}p (ficou em ${r['altura no fim']}p)`;
  console.log(`· início (${r.codec}, ${pref}, start ${startKbps ? `${startKbps} kbps` : 'padrão'}${START_IN ? `, rede ${process.env.NETSIM_START_IN}` : ''}): ${r['altura inicial']}p, ${climb}, ${r.fps} fps (mín ${r['fps mín no host']} no host), ${r.congelamentos} congelamento(s)`);
}

async function measure(name, set, viewer, presenter) {
  Object.assign(impair, { loss: 0, delay: 0, jitter: 0, queue: false, down: false }, set);
  await sleep(SETTLE_MS);
  const a = await viewer.evaluate(VIDEO_IN);
  const trace = [await presenter.evaluate(VIDEO_OUT)];
  const u0 = { ...udp };
  loopLag.reset();
  for (const end = Date.now() + MEASURE_MS; Date.now() < end;) {
    await sleep(Math.min(SAMPLE_MS, end - Date.now()));
    trace.push(await presenter.evaluate(VIDEO_OUT));
  }
  const lagMs = Math.round(loopLag.percentile(99) / 1e6);
  const b = await viewer.evaluate(VIDEO_IN);
  const sender = senderSummary(trace);
  const lat = await latency(viewer);
  const s = (b.at - a.at) / 1000;
  const pkts = b.recv - a.recv + (b.lost - a.lost);
  rows.push({
    cenário: name,
    fps: Math.round((b.frames - a.frames) / s),
    kbps: Math.round(((b.bytes - a.bytes) * 8) / s / 1000),
    altura: b.height,
    'perda RTP %': pkts ? +((100 * (b.lost - a.lost)) / pkts).toFixed(1) : 0,
    nacks: b.nacks - a.nacks,
    congelamentos: b.freezes - a.freezes,
    'congelado s': +(b.freezeS - a.freezeS).toFixed(1),
    'buffer ms': b.bufN > a.bufN ? Math.round((1000 * (b.bufS - a.bufS)) / (b.bufN - a.bufN)) : null,
    'rtt ms': b.rttMs != null ? Math.round(b.rttMs) : null,
    'jitter RTP ms': Math.round(b.jitterMs),
    'alvo ms': b.targetMs,
    'latência ms': lat,
    ...sender,
    'descartados proxy': udp.dropped - u0.dropped,
    'atraso do proxy p99 ms': lagMs,
  });
  assert.ok(b.relay, 'a mídia precisa passar pelo TURN');
  const r = rows.at(-1);
  const busy = lagMs > PROXY_LAG_MAX_MS ? ` ⚠ proxy atrasou ${lagMs} ms (máquina ocupada): não confiável` : '';
  console.log(`· ${name}: ${r.fps} fps, ${r.kbps} kbps, latência ${lat} ms, buffer ${r['buffer ms']} ms (alvo ${r['alvo ms']}), ${r.congelamentos} congelamento(s); `
    + `BWE ${r['BWE kbps']} kbps (mín ${r['BWE mín kbps']}), ${r['altura enviada']}p enviado, QP ${r['QP médio']}, limitado por banda ${r['limitado por banda %']}%${busy}`);
}

// Time until the viewer decodes frames again after a total outage of `ms`.
async function outage(name, ms, viewer) {
  Object.assign(impair, { loss: 0, delay: 0, jitter: 0, queue: false, down: true });
  await sleep(ms);
  // Frames decoded so far per pc: the app may already have replaced a failed pc with a new
  // one (counters from 0), so progress is measured against each pc's own count.
  await viewer.evaluate(async () => {
    window.__framesAt = new Map();
    for (const pc of window.__pcs) {
      const v = [...(await pc.getStats()).values()].find((s) => s.type === 'inbound-rtp' && s.kind === 'video');
      window.__framesAt.set(pc, v?.framesDecoded ?? 0);
    }
  });
  impair.down = false;
  const t0 = Date.now();
  const since = (p) => p.then(() => Date.now() - t0, () => 'não recuperou');
  const [video, voice] = await Promise.all([
    since(viewer.waitForFunction(async () => {
      for (const pc of window.__pcs) {
        const v = [...(await pc.getStats()).values()].find((s) => s.type === 'inbound-rtp' && s.kind === 'video');
        if (v && pc.connectionState !== 'closed' && v.framesDecoded > (window.__framesAt.get(pc) ?? 0) + 10) return true;
      }
      return false;
    }, { timeout: 40_000, polling: 100 })),
    // Voice pcs are the sendrecv ones (video is sendonly/recvonly).
    since(viewer.waitForFunction(() => window.__pcs.some((pc) => pc.connectionState === 'connected'
      && pc.getTransceivers().some((t) => t.direction === 'sendrecv')), { timeout: 40_000, polling: 100 })),
  ]);
  const after = await viewer.evaluate(VIDEO_IN);
  rows.push({ cenário: name, 'vídeo de volta ms': video, 'voz de volta ms': voice, estado: after?.state ?? '-' });
  console.log(`· ${name}: vídeo ${video} ms, voz ${voice} ms`);
}

// Bruno's signaling drops for `ms`; time until he is back in the session and has video again.
async function signalingDrop(name, ms, viewer) {
  cutSignaling();
  await sleep(ms);
  const t0 = Date.now();
  restoreSignaling();
  await waitFor(viewer, () => window.__app.session?.members.length === 2, `${name}: voltou à sessão`, undefined, 60_000);
  const back = Date.now() - t0;
  await waitFor(viewer, hasVideo, `${name}: vídeo de volta`, undefined, 60_000);
  rows.push({ cenário: name, 'voltou à sessão ms': back, 'vídeo de volta ms': Date.now() - t0 });
  console.log(`· ${name}: sessão ${back} ms, vídeo ${Date.now() - t0} ms`);
}

try {
  await sleep(500);
  const ana = await open(BASE);
  await waitFor(ana, () => !document.querySelector('[data-screen=home]').hidden && document.getElementById('conn').hidden, 'home pronta');
  await ana.type('#create-name', 'Ana');
  await ana.click('#create-form button[type=submit]');
  await waitFor(ana, () => window.__app.session?.members.length === 1, 'sessão criada');
  const code = await ana.evaluate(() => window.__app.code);

  const bruno = await open(`http://localhost:${WS_PROXY_PORT}/?code=${code}&name=Bruno`);
  await waitFor(bruno, () => !document.querySelector('[data-screen=join]').hidden && document.getElementById('conn').hidden, 'join pronto');
  await bruno.click('#join-form button[type=submit]');
  await waitFor(ana, () => window.__app.session.members.length === 2, 'Bruno entrou');

  await ana.bringToFront();
  await ana.click('#ov-stream');
  await ana.evaluate((m) => [...document.querySelectorAll('#q-modes button')].find((b) => b.textContent === m).click(), MODE);
  await ana.$eval('#q-upload', (i) => { i.value = '50'; i.dispatchEvent(new Event('input')); });
  Object.assign(impair, START_IN);
  await ana.click('#q-start');
  await waitFor(bruno, hasVideo, 'vídeo no Bruno');
  const coarse = timerMs > TIMER_MAX_MS ? ' ⚠ timers grossos: atrasos e variação saem arredondados' : '';
  console.log(`transmitindo ${MODE} (conteúdo ${CONTENT}) só por TURN; medindo ${MEASURE_MS / 1000} s por cenário; timer do proxy ${timerMs.toFixed(1)} ms${coarse}\n`);
  await startup(bruno, ana);
  Object.assign(impair, { loss: 0, delay: 0, jitter: 0, queue: false });

  const SCENARIOS = {
    base: () => measure('base (só TURN)', {}, bruno, ana),
    loss1: () => measure('perda 1%', { loss: 0.01 }, bruno, ana),
    loss5: () => measure('perda 5%', { loss: 0.05 }, bruno, ana),
    loss10: () => measure('perda 10%', { loss: 0.10 }, bruno, ana),
    delay50: () => measure('atraso 50 ms', { delay: 50 }, bruno, ana),
    jitter20: () => measure('atraso 50 ± 20 ms', { delay: 50, jitter: 20 }, bruno, ana),
    bad: () => measure('atraso 150 ± 50 ms + perda 2%', { delay: 150, jitter: 50, loss: 0.02 }, bruno, ana),
    jitter50: () => measure('atraso 150 ± 50 ms', { delay: 150, jitter: 50 }, bruno, ana), // bad without loss
    badQueue: () => measure('atraso 150 ± 50 ms (fila) + perda 2%', { delay: 150, jitter: 50, loss: 0.02, queue: true }, bruno, ana), // bad, in order
    loss2rtt300: () => measure('atraso 150 ms + perda 2%', { delay: 150, loss: 0.02 }, bruno, ana), // bad without jitter
    clean: () => measure('recuperado (sem falha)', {}, bruno, ana),
    cut3: () => outage('mídia cortada 3 s', 3000, bruno),
    cut10: () => outage('mídia cortada 10 s', 10_000, bruno),
    cut40: () => outage('mídia cortada 40 s', 40_000, bruno), // past ICE consent (30 s): connection fails
    cut90: () => outage('mídia cortada 90 s', 90_000, bruno), // re-offers fail too while it is down (backoff)
    ws2: () => signalingDrop('WebSocket caiu 2 s', 2000, bruno),
    ws15: () => signalingDrop('servidor fora 15 s', 15_000, bruno),
  };
  // NETSIM_ONLY=base,loss5 runs a subset (names above), in that order.
  for (const name of process.env.NETSIM_ONLY?.split(',') ?? Object.keys(SCENARIOS)) await SCENARIOS[name.trim()]();

  // /speedtest unavailable: T02 must say so with the code, not hang.
  await ana.evaluate(() => window.__app.send({ type: 'stopStream' }));
  await waitFor(ana, () => !window.__app.session.presenterId, 'parou de transmitir');
  await ana.setRequestInterception(true);
  ana.on('request', (r) => (r.url().endsWith('/speedtest') ? r.respond({ status: 503, body: '' }) : r.continue()));
  await ana.bringToFront();
  await ana.click('#ov-stream');
  await ana.click('#q-measure');
  await waitFor(ana, () => !document.getElementById('q-upload-err').hidden && document.getElementById('q-upload-err').textContent.includes('503'), '503 na medição');
  rows.push({ cenário: '/speedtest 503', resultado: await ana.$eval('#q-upload-err', (e) => [...e.children].map((c) => c.textContent).join(' · ')) });

  console.log('\nResultados');
  for (const r of rows) console.log(JSON.stringify(r));
  console.log('\nNETSIM OK');
} catch (e) {
  console.error(e);
  for (const r of rows) console.log(JSON.stringify(r));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill();
  turn.kill();
  front.close();
  for (const b of backs.values()) b.close();
  process.exit(process.exitCode ?? 0);
}
