// Ticket 05 benchmark (scenarios 1 and 2): presenter → relay 1 → relay 2 → viewer, each node in
// its own Edge (same engine as WebView2), all media through a local TURN behind an impairing
// UDP proxy (same setup as e2e/netsim.js). Measures latency at every node, so the cost of each
// hop shows, plus the private memory and CPU of each browser.
//   BENCH_MODE=decode   today's relay: forwards the received track (decode + re-encode)
//   BENCH_MODE=encoded  scenario 2: forwards encoded frames (RTCRtpScriptTransform)
//   BENCH_MODE=native   scenario 3: relays 1 and 2 are the Rust relay (bench/native), RTP forward
//   BENCH_MODE=native-full  scenario 3 complete: the presenter is also native (bench/native presenter:
//                       window capture + hardware H.264). It captures a visible Edge window that paints
//                       the clock (the "game"), which is left out of the presenter's RAM and CPU.
//   BENCH_LEAN=1        scenario 2 also launches Edge with memory-saving flags
// Writes e2e/bench/results/<mode>.json.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import dgram from 'node:dgram';
import puppeteer from 'puppeteer-core';
import readline from 'node:readline';

const MODE = process.env.BENCH_MODE ?? 'decode';
const LEAN = Boolean(process.env.BENCH_LEAN);
const LABEL = process.env.BENCH_LABEL ?? `${MODE}${LEAN ? '-lean' : ''}`;
const SETTLE_MS = Number(process.env.BENCH_SETTLE_MS) || 20_000;
const MEASURE_MS = Number(process.env.BENCH_MEASURE_MS) || 15_000;
const HTTP_PORT = 3996, TURN_PORT = 3479, PROXY_PORT = 3480;
const EDGE = process.env.CHROME_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const TURN_BIN = process.env.NETSIM_TURN_BIN ?? path.join(homedir(), 'go', 'bin', 'simple.exe');
const ICE = process.env.BENCH_DIRECT ? [] : [{ urls: `turn:127.0.0.1:${PROXY_PORT}?transport=udp`, username: 'sp2p', credential: 'bench' }];
// Per hop. 'ruim' needs the TURN path (BENCH_DIRECT unset), and the local TURN + proxy cannot
// carry three 8 Mbps hops: even today's relay degrades there on a clean network (2026-11-05).
const ALL_NETWORKS = { boa: {}, ruim: { delay: 20, jitter: 5, loss: 0.01 } };
const NETWORKS = Object.fromEntries((process.env.BENCH_NETS ?? 'boa').split(',').map((n) => [n, ALL_NETWORKS[n]]));
// BENCH_NORELAY=1: presenter straight to the viewer, the baseline that gives the cost of each hop.
const NODES = process.env.BENCH_NORELAY ? ['transmissor', 'espectador'] : ['transmissor', 'relay 1', 'relay 2', 'espectador'];
const FULL = MODE === 'native-full';
const isNative = (i) => (MODE === 'native' || FULL) && i > 0 && i < NODES.length - 1;
const SOURCE_TITLE = 'sp2p-bench-source';
// BENCH_SCREEN=1: the Edge presenter captures the same source window with getDisplayMedia (like the app).
const SCREEN = process.env.BENCH_SCREEN === '1';
const HEADFUL = process.env.BENCH_HEADFUL === '1';
// Captura real exige janela visível; não substituir por captura oculta inválida.
if ((FULL || SCREEN || HEADFUL) && process.env.BENCH_ALLOW_VISIBLE !== '1') {
  throw new Error('Teste com janela visível bloqueado. BENCH_ALLOW_VISIBLE=1 autoriza interferência no desktop.');
}
// BENCH_CODEC=h264: Edge nodes prefer H.264 (hardware encoder when available) instead of VP8.
const CODEC = FULL ? 'h264' : process.env.BENCH_CODEC ?? 'vp8';
const H264_PROFILE = CODEC === 'h264' ? '42e01f' : CODEC === 'h264any' && MODE === 'native' && NODES.length > 2 ? (process.env.BENCH_H264_PROFILE ?? '42001f') : null;
const DEG = process.env.BENCH_DEG ?? 'balanced';
if (!['balanced', 'maintain-framerate', 'maintain-resolution'].includes(DEG)) {
  throw new Error(`BENCH_DEG inválido: ${JSON.stringify(DEG)}`);
}
// maxBitrate dos remetentes Edge; o presenter Rust (native-full) fixa 8000 próprio.
const KBPS = Number(process.env.BENCH_KBPS ?? 8000);
if (!Number.isInteger(KBPS) || KBPS < 100 || KBPS > 100_000 || (FULL && process.env.BENCH_KBPS !== undefined)) {
  throw new Error(`BENCH_KBPS inválido: ${JSON.stringify(process.env.BENCH_KBPS)} (inteiro 100–100000; não se aplica a native-full)`);
}
const NATIVE_DIR =path.join(import.meta.dirname, 'bench', 'native', 'target', 'release');
const NATIVE_BIN = path.join(NATIVE_DIR, 'sp2p-native-bench.exe');
const PRESENTER_BIN = path.join(NATIVE_DIR, 'presenter.exe');

if (process.platform === 'win32') {
  const { default: koffi } = await import('koffi');
  koffi.load('winmm.dll').func('uint32 __stdcall timeBeginPeriod(uint32)')(1);
}

let secondaryMonitor = null;
if (FULL || SCREEN || HEADFUL) {
  const screens = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public class BenchDpi { [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value); }\';'
    + '[BenchDpi]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null;'
    + 'Add-Type -AssemblyName System.Windows.Forms; ConvertTo-Json -Compress -InputObject @([System.Windows.Forms.Screen]::AllScreens | Where-Object { -not $_.Primary } | ForEach-Object { @{ left=$_.WorkingArea.X; top=$_.WorkingArea.Y; width=$_.WorkingArea.Width; height=$_.WorkingArea.Height } })'],
  { encoding: 'utf8', windowsHide: true }));
  secondaryMonitor = (Array.isArray(screens) ? screens : [screens])[0];
  if (!secondaryMonitor || !['left', 'top', 'width', 'height'].every((k) => Number.isInteger(secondaryMonitor[k]))
      || secondaryMonitor.width <= 0 || secondaryMonitor.height <= 0) {
    throw new Error('Monitor secundário indisponível; nenhuma janela será aberta.');
  }
}

async function backgroundPage(browser) {
  const session = await browser.target().createCDPSession();
  try {
    const { targetId } = await session.send('Target.createTarget', {
      url: 'about:blank', newWindow: true, background: true, focus: false,
      ...secondaryMonitor,
    });
    const { bounds } = await session.send('Browser.getWindowForTarget', { targetId });
    const m = secondaryMonitor;
    if (!(bounds.left >= m.left && bounds.top >= m.top && bounds.width > 0 && bounds.height > 0
        && bounds.left + bounds.width <= m.left + m.width && bounds.top + bounds.height <= m.top + m.height)) {
      throw new Error('Janela fora do monitor secundário; bancada interrompida.');
    }
    const target = await browser.waitForTarget((t) => t.type() === 'page');
    return await target.page();
  } finally { await session.detach(); }
}

// ── static files ──
const dir = path.join(import.meta.dirname, 'bench');
const http = createServer((req, res) => {
  const f = path.join(dir, new URL(req.url, 'http://x').pathname);
  if (!f.startsWith(dir) || !existsSync(f)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : 'text/html' }).end(readFileSync(f));
}).listen(HTTP_PORT, '127.0.0.1');

// ── TURN + impairing proxy on the TURN→browser leg (one degradation per hop) ──
const impair = { delay: 0, jitter: 0, loss: 0 };
const front = dgram.createSocket('udp4');
const backs = new Map();
front.on('message', (msg, from) => {
  const key = `${from.address}:${from.port}`;
  let back = backs.get(key);
  if (!back) {
    back = dgram.createSocket('udp4');
    back.on('message', (m) => {
      if (Math.random() < impair.loss) return;
      const ms = Math.max(0, impair.delay + (Math.random() * 2 - 1) * impair.jitter);
      ms ? setTimeout(() => front.send(m, from.port, from.address), ms) : front.send(m, from.port, from.address);
    });
    backs.set(key, back);
  }
  back.send(msg, TURN_PORT, '127.0.0.1');
});
front.bind(PROXY_PORT, '127.0.0.1');
const turn = spawn(TURN_BIN, ['-public-ip', '127.0.0.1', '-port', String(TURN_PORT), '-users', 'sp2p=bench'], { stdio: 'ignore', windowsHide: true });

// ── memory and CPU of one browser: its whole process tree ──
function processTable() {
  const out = execFileSync('powershell', ['-NoProfile', '-Command',
    'Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Select-Object IDProcess,WorkingSetPrivate | ConvertTo-Csv -NoTypeInformation;'
    + '"---";Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,KernelModeTime,UserModeTime | ConvertTo-Csv -NoTypeInformation'], { encoding: 'utf8', windowsHide: true });
  const [perf, procs] = out.split('---');
  const rows = (csv) => csv.trim().split(/\r?\n/).slice(1).map((l) => l.replaceAll('"', '').split(','));
  const priv = new Map(rows(perf).map(([id, ws]) => [Number(id), Number(ws)]));
  const tree = rows(procs).map(([id, parent, k, u]) => ({ id: Number(id), parent: Number(parent), cpu: (Number(k) + Number(u)) / 1e7 }));
  return { priv, tree };
}
function usage(table, rootPid) {
  const ids = new Set([rootPid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of table.tree) if (ids.has(p.parent) && !ids.has(p.id)) { ids.add(p.id); grew = true; }
  }
  let mb = 0, cpu = 0;
  for (const p of table.tree) if (ids.has(p.id)) { mb += (table.priv.get(p.id) ?? 0) / 2 ** 20; cpu += p.cpu; }
  return { mb, cpu, processes: ids.size };
}

const LEAN_FLAGS = [ // what an optimized WebView2 host can pass in AdditionalBrowserArguments
  '--renderer-process-limit=1', '--disable-extensions', '--disable-component-update', '--disable-background-networking',
  '--disable-features=Translate,OptimizationHints,MediaRouter,BackForwardCache,SpareRendererForSitePerProcess,CalculateNativeWinOcclusion',
  '--disable-site-isolation-trials', '--js-flags=--max-lazy',
];
let benchError, rejectBench;
const benchFailed = new Promise((_, reject) => { rejectBench = reject; });
benchFailed.catch(() => {}); // Native nodes can fail before the next await.
const failBench = (err) => { if (!benchError) { benchError = err; rejectBench(err); } };
const waitFor = (promise) => Promise.race([benchFailed, promise]);
const sleep = async (ms) => {
  let timer;
  try { await waitFor(new Promise((resolve) => { timer = setTimeout(resolve, ms); })); }
  finally { clearTimeout(timer); }
};
const browsers = [], nodes = [];
let sourceBrowser = null, presenterReady = null;
const profiles = path.join(tmpdir(), 'sp2p-bench');
rmSync(profiles, { recursive: true, force: true });

try {
  await sleep(500);
  const deliver = async (to, from, msg) => {
    try { if (!benchError) await nodes[to].onSig(from, msg); }
    catch (err) { failBench(err); }
  };
  for (const [i, name] of NODES.entries()) {
    const spawnNative = (bin, args, env) => {
      const proc = spawn(bin, args, { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true, env: { ...process.env, ...env } });
      const waiting = [];
      let ready, rejectReady, failure, closing = false;
      const isReady = new Promise((resolve, reject) => { ready = resolve; rejectReady = reject; });
      isReady.catch(() => {}); // Relays do not emit ready; their errors still fail the bench.
      const fail = (err) => {
        if (failure) return;
        failure = err;
        rejectReady(err);
        for (const request of waiting.splice(0)) request.reject(err);
        if (!closing) failBench(err);
      };
      proc.on('error', fail);
      proc.on('exit', (code, signal) => fail(new Error(`[${name}] exited (${signal ?? code})`)));
      proc.stdin.on('error', fail);
      readline.createInterface({ input: proc.stdout }).on('line', (l) => {
        if (failure) return;
        try {
          const m = JSON.parse(l);
          if (m.stats) return waiting.shift()?.resolve({ native: m.stats, out: [], at: performance.now() });
          if (m.ready) { console.log(`[${name}]`, m.ready); return ready(m.ready); }
          const { to, ...msg } = m;
          deliver(to, i, msg);
        } catch (err) { fail(err); }
      });
      const send = (o) => {
        if (failure) throw failure;
        try { proc.stdin.write(JSON.stringify(o) + '\n'); }
        catch (err) { fail(err); throw err; }
      };
      return {
        name, pid: proc.pid, native: true, isReady,
        onSig: (from, msg) => send({ from, ...msg }),
        child: (c) => send({ cmd: 'child', id: c }),
        stats: () => new Promise((resolve, reject) => {
          if (failure) return reject(failure);
          waiting.push({ resolve, reject });
          send({ cmd: 'stats' });
        }),
        latency: async () => null, // no screen
        present: async () => {},
        close: async () => {
          if (closing) return;
          closing = true;
          fail(new Error(`[${name}] closed`));
          proc.kill();
        },
      };
    };
    if (isNative(i)) {
      // h264any permite negociar o perfil do relay; não determina o encoder usado pelo Edge.
      nodes.push(spawnNative(NATIVE_BIN, [], { SP2P_CODEC: CODEC.startsWith('h264') ? 'h264' : CODEC, SP2P_H264_PROFILE: H264_PROFILE ?? '42e01f' }));
      continue;
    }
    if ((FULL || SCREEN) && i === 0) {
      const src = await puppeteer.launch({
        executablePath: EDGE, headless: false, userDataDir: path.join(profiles, 'source'), defaultViewport: null, waitForInitialPage: false,
        args: ['--no-startup-window', '--force-device-scale-factor=1', '--disable-features=CalculateNativeWinOcclusion', '--disable-background-timer-throttling',
          '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--autoplay-policy=no-user-gesture-required'],
      });
      sourceBrowser = src;
      const sp = await waitFor(backgroundPage(src));
      await waitFor(sp.goto(`http://127.0.0.1:${HTTP_PORT}/relay.html?source=1&ice=[]`));
      await waitFor(sp.waitForFunction((t) => document.title === t, {}, SOURCE_TITLE));
      await sleep(1500);
      if (FULL) {
        const windowTitle = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); (Get-Process -Id ${src.process().pid}).MainWindowTitle`], { encoding: 'utf8', windowsHide: true }).trim();
        if (!windowTitle.includes(SOURCE_TITLE)) throw new Error('Janela-fonte não encontrada no processo Edge.');
        const n = spawnNative(PRESENTER_BIN, [windowTitle], {});
        nodes.push(n);
        presenterReady = await waitFor(n.isReady);
        continue;
      }
    }
    const b = await puppeteer.launch({
      executablePath: EDGE, headless: HEADFUL ? false : 'new', userDataDir: path.join(profiles, String(i)),
      ...(HEADFUL ? { waitForInitialPage: false, defaultViewport: null } : {}),
      args: [...(HEADFUL ? ['--no-startup-window', '--force-device-scale-factor=1'] : []), ...(SCREEN && i === 0 ? [`--auto-select-desktop-capture-source=${SOURCE_TITLE}`] : []), '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows', '--allow-loopback-in-peer-connection', ...(process.env.BENCH_FIELDTRIALS ? [`--force-fieldtrials=${process.env.BENCH_FIELDTRIALS}`] : []), ...(LEAN ? LEAN_FLAGS : []), ...(process.env.BENCH_EDGEARGS?.split(' ').filter(Boolean) ?? [])],
    });
    browsers.push(b); // Register before page setup can fail.
    const p = HEADFUL ? await waitFor(backgroundPage(b)) : (await waitFor(b.pages()))[0] ?? await waitFor(b.newPage());
    p.on('pageerror', (e) => console.error(`[${name}] pageerror:`, e.message));
    if (process.env.BENCH_DEBUG) p.on('console', (m) => console.log(`[${name}] ${m.text()}`));
    await waitFor(p.exposeFunction('sig', (to, msg) => deliver(to, i, msg)));
    const pageMode = MODE.startsWith('native') ? 'decode' : MODE;
    await waitFor(p.goto(`http://127.0.0.1:${HTTP_PORT}/relay.html?mode=${pageMode}&ph=${process.env.BENCH_PH ?? 2}&phfps=${process.env.BENCH_PHFPS ?? 1000}&minkbps=${process.env.BENCH_MINKBPS ?? 0}${SCREEN ? '&screen=1' : ''}&codec=${encodeURIComponent(CODEC)}&deg=${encodeURIComponent(DEG)}&kbps=${KBPS}&ice=${encodeURIComponent(JSON.stringify(ICE))}`));
    nodes.push({
      name, pid: b.process().pid, browser: b,
      onSig: (from, msg) => p.evaluate((f, m) => window.bench.onSig(f, m), from, msg),
      child: (c) => p.evaluate((x) => window.bench.child(x), c),
      stats: () => p.evaluate(() => window.bench.stats()),
      latency: async () => p.evaluate(() => window.bench.latency()),
      present: () => p.evaluate(() => window.bench.present()),
      evalPage: (fn) => p.evaluate(fn),
      close: () => b.close(),
    });
  }
  await waitFor(nodes[0].present());
  for (let i = 0; i < NODES.length - 1; i++) await waitFor(nodes[i].child(i + 1));

  const results = { label: LABEL, mode: MODE, lean: LEAN, codec: CODEC, profile: H264_PROFILE,
    degradationPreference: DEG, kbps: KBPS, screen: FULL || SCREEN, direct: Boolean(process.env.BENCH_DIRECT), norelay: NODES.length === 2,
    settleMs: SETTLE_MS, measureMs: MEASURE_MS, presenterReady, secondaryMonitor,
    edge: await waitFor(browsers[0].version()), native: MODE.startsWith('native') ? NATIVE_BIN : null, at: new Date().toISOString(), networks: {} };
  for (const [net, cfg] of Object.entries(NETWORKS)) {
    Object.assign(impair, { delay: 0, jitter: 0, loss: 0 }, cfg);
    await sleep(SETTLE_MS);
    const s0 = await waitFor(Promise.all(nodes.map((n) => n.stats())));
    const t0 = processTable();
    await sleep(MEASURE_MS);
    const s1 = await waitFor(Promise.all(nodes.map((n) => n.stats())));
    const t1 = processTable();
    if (process.env.BENCH_SNAPSHOT) { // debug: what the viewer shows
      const url = await waitFor(nodes.at(-1).evalPage?.(() => { const v = document.getElementById('video'); const c = Object.assign(document.createElement('canvas'), { width: v.videoWidth, height: v.videoHeight }); c.getContext('2d').drawImage(v, 0, 0); return c.toDataURL('image/png'); }));
      if (url) writeFileSync(path.join(dir, 'results', 'snapshot.png'), Buffer.from(url.split(',')[1], 'base64'));
    }
    const lat = [];
    for (const n of nodes) lat.push(await waitFor(n.latency()));
    const rows = NODES.map((name, i) => {
      const [a, b] = [s0[i], s1[i]];
      const sec = (b.at - a.at) / 1000;
      const u0 = usage(t0, nodes[i].pid), u1 = usage(t1, nodes[i].pid);
      const enc = (x) => x.out.reduce((n, o) => n + o.encoded, 0), encS = (x) => x.out.reduce((n, o) => n + o.encodeS, 0);
      const inn = b.in && a.in && {
        fps: Math.round((b.in.frames - a.in.frames) / sec),
        kbps: Math.round(((b.in.bytes - a.in.bytes) * 8) / sec / 1000),
        altura: b.in.h,
        largura: b.in.w,
        codec: b.in.codec,
        congelamentos: b.in.freezes - a.in.freezes,
        'perda %': +((100 * (b.in.lost - a.in.lost)) / Math.max(1, b.in.recv - a.in.recv + b.in.lost - a.in.lost)).toFixed(1),
        'buffer ms': b.in.bufN > a.in.bufN ? Math.round((1000 * (b.in.bufS - a.in.bufS)) / (b.in.bufN - a.in.bufN)) : null,
      };
      return {
        nó: name,
        'latência ms': i === 0 ? 0 : lat[i],
        recebe: inn,
        'quadros codificados/s': Math.round((enc(b) - enc(a)) / sec),
        'ms de codificação/s': Math.round((1000 * (encS(b) - encS(a))) / sec),
        encoder: b.out[0]?.encoder ?? (b.native && { ...b.native, 'quadros/s': Math.round((b.native.encoded - a.native.encoded) / sec), 'kbps out': Math.round(((b.native.bytes - a.native.bytes) * 8) / sec / 1000) }) ?? null,
        'altura enviada': b.out[0]?.h ?? null,
        'largura enviada': b.out[0]?.w ?? null,
        codecsEnviados: b.out.map((o) => o.codec),
        degradationPreference: b.out[0]?.degradationPreference ?? null,
        // Distingue a captura da adaptação do encoder por CPU ou banda.
        captura: b.source && { largura: b.source.width, altura: b.source.height, fps: b.source.frameRate, 'entregues/s': b.source.delivered != null ? Math.round((b.source.delivered - a.source.delivered) / sec) : null },
        limitação: b.out[0]?.limit != null ? { motivo: b.out[0].limit, segundos: Object.fromEntries(Object.entries(b.out[0].limitS ?? {}).map(([k, v]) => [k, +(v - (a.out[0]?.limitS?.[k] ?? 0)).toFixed(1)])) } : null,
        'enviado kbps': Math.round((b.out.reduce((n, o) => n + o.bytes, 0) - a.out.reduce((n, o) => n + o.bytes, 0)) * 8 / sec / 1000),
        plis: b.out.reduce((n, o) => n + o.plis, 0),
        repasse: b.worker ?? (b.native?.bytesIn != null ? { ...b.native, 'kbps in': Math.round(((b.native.bytesIn - a.native.bytesIn) * 8) / sec / 1000), 'pacotes/s': Math.round((b.native.pktsIn - a.native.pktsIn) / sec), 'kbps out': Math.round(((b.native.bytesOut - a.native.bytesOut) * 8) / sec / 1000) } : null) ?? (b.native ? { ...b.native, 'quadros/s': Math.round((b.native.encoded - a.native.encoded) / sec), 'capturados/s': Math.round((b.native.captured - a.native.captured) / sec), 'kbps out': Math.round(((b.native.bytes - a.native.bytes) * 8) / sec / 1000) } : null),
        'fachada/s': Math.round(((b.phWrites ?? 0) - (a.phWrites ?? 0)) / sec),
        'RAM MB': Math.round(u1.mb),
        'CPU %': Math.round((100 * (u1.cpu - u0.cpu)) / sec),
        processos: u1.processes,
      };
    });
    results.networks[net] = { rede: cfg, nodes: rows };
    console.log(`\n${LABEL} · rede ${net}`);
    console.table(rows.map((n) => ({ nó: n.nó, 'lat ms': n['latência ms'], fps: n.recebe?.fps, kbps: n.recebe?.kbps, altura: n.recebe?.altura, cong: n.recebe?.congelamentos, 'cod/s': n['quadros codificados/s'], 'RAM MB': n['RAM MB'], 'CPU %': n['CPU %'] })));
  }
  mkdirSync(path.join(dir, 'results'), { recursive: true });
  writeFileSync(path.join(dir, 'results', `${LABEL}.json`), JSON.stringify(results, null, 2));
  console.log(`\nBENCH OK → e2e/bench/results/${LABEL}.json`);
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  for (const n of nodes) if (n.native) await n.close().catch(() => {});
  for (const b of browsers) await b.close().catch(() => {});
  await sourceBrowser?.close().catch(() => {});
  turn.kill(); front.close(); http.close();
  for (const b of backs.values()) b.close();
  process.exit(process.exitCode ?? 0);
}
