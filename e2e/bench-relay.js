// Ticket 05 benchmark (scenarios 1 and 2): presenter → relay 1 → relay 2 → viewer, each node in
// its own Edge (same engine as WebView2), all media through a local TURN behind an impairing
// UDP proxy (same setup as e2e/netsim.js). Measures latency at every node, so the cost of each
// hop shows, plus the private memory and CPU of each browser.
//   BENCH_MODE=decode   today's relay: forwards the received track (decode + re-encode)
//   BENCH_MODE=encoded  scenario 2: forwards encoded frames (RTCRtpScriptTransform)
//   BENCH_LEAN=1        scenario 2 also launches Edge with memory-saving flags
// Writes e2e/bench/results/<mode>.json.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import dgram from 'node:dgram';
import puppeteer from 'puppeteer-core';

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
const NODES = ['transmissor', 'relay 1', 'relay 2', 'espectador'];

if (process.platform === 'win32') {
  const { default: koffi } = await import('koffi');
  koffi.load('winmm.dll').func('uint32 __stdcall timeBeginPeriod(uint32)')(1);
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
const turn = spawn(TURN_BIN, ['-public-ip', '127.0.0.1', '-port', String(TURN_PORT), '-users', 'sp2p=bench'], { stdio: 'ignore' });

// ── memory and CPU of one browser: its whole process tree ──
function processTable() {
  const out = execFileSync('powershell', ['-NoProfile', '-Command',
    'Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Select-Object IDProcess,WorkingSetPrivate | ConvertTo-Csv -NoTypeInformation;'
    + '"---";Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,KernelModeTime,UserModeTime | ConvertTo-Csv -NoTypeInformation'], { encoding: 'utf8' });
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browsers = [], pages = [];
const profiles = path.join(tmpdir(), 'sp2p-bench');
rmSync(profiles, { recursive: true, force: true });

try {
  await sleep(500);
  for (const [i, name] of NODES.entries()) {
    const b = await puppeteer.launch({
      executablePath: EDGE, headless: 'new', userDataDir: path.join(profiles, String(i)),
      args: ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows', '--allow-loopback-in-peer-connection', ...(process.env.BENCH_FIELDTRIALS ? [`--force-fieldtrials=${process.env.BENCH_FIELDTRIALS}`] : []), ...(LEAN ? LEAN_FLAGS : [])],
    });
    const p = (await b.pages())[0] ?? await b.newPage();
    p.on('pageerror', (e) => console.error(`[${name}] pageerror:`, e.message));
    if (process.env.BENCH_DEBUG) p.on('console', (m) => console.log(`[${name}] ${m.text()}`));
    await p.exposeFunction('sig', (to, msg) => pages[to].evaluate((from, m) => window.bench.onSig(from, m), i, msg));
    await p.goto(`http://127.0.0.1:${HTTP_PORT}/relay.html?mode=${MODE}&ph=${process.env.BENCH_PH ?? 2}&phfps=${process.env.BENCH_PHFPS ?? 1000}&minkbps=${process.env.BENCH_MINKBPS ?? 0}&ice=${encodeURIComponent(JSON.stringify(ICE))}`);
    browsers.push(b); pages.push(p);
  }
  await pages[0].evaluate(() => window.bench.present());
  for (let i = 0; i < NODES.length - 1; i++) await pages[i].evaluate((c) => window.bench.child(c), i + 1);

  const results = { label: LABEL, mode: MODE, lean: LEAN, edge: await browsers[0].version(), at: new Date().toISOString(), networks: {} };
  for (const [net, cfg] of Object.entries(NETWORKS)) {
    Object.assign(impair, { delay: 0, jitter: 0, loss: 0 }, cfg);
    await sleep(SETTLE_MS);
    const s0 = await Promise.all(pages.map((p) => p.evaluate(() => window.bench.stats())));
    const t0 = processTable();
    await sleep(MEASURE_MS);
    const s1 = await Promise.all(pages.map((p) => p.evaluate(() => window.bench.stats())));
    const t1 = processTable();
    const lat = [];
    for (const p of pages) { await p.bringToFront(); lat.push(await p.evaluate(() => window.bench.latency())); }
    const nodes = NODES.map((name, i) => {
      const [a, b] = [s0[i], s1[i]];
      const sec = (b.at - a.at) / 1000;
      const u0 = usage(t0, browsers[i].process().pid), u1 = usage(t1, browsers[i].process().pid);
      const enc = (x) => x.out.reduce((n, o) => n + o.encoded, 0), encS = (x) => x.out.reduce((n, o) => n + o.encodeS, 0);
      const inn = b.in && a.in && {
        fps: Math.round((b.in.frames - a.in.frames) / sec),
        kbps: Math.round(((b.in.bytes - a.in.bytes) * 8) / sec / 1000),
        altura: b.in.h,
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
        encoder: b.out[0]?.encoder ?? null,
        'altura enviada': b.out[0]?.h ?? null,
        'enviado kbps': Math.round((b.out.reduce((n, o) => n + o.bytes, 0) - a.out.reduce((n, o) => n + o.bytes, 0)) * 8 / sec / 1000),
        plis: b.out.reduce((n, o) => n + o.plis, 0),
        repasse: b.worker ?? null,
        'fachada/s': Math.round((b.phWrites - a.phWrites) / sec),
        'RAM MB': Math.round(u1.mb),
        'CPU %': Math.round((100 * (u1.cpu - u0.cpu)) / sec),
        processos: u1.processes,
      };
    });
    results.networks[net] = { rede: cfg, nodes };
    console.log(`\n${LABEL} · rede ${net}`);
    console.table(nodes.map((n) => ({ nó: n.nó, 'lat ms': n['latência ms'], fps: n.recebe?.fps, kbps: n.recebe?.kbps, altura: n.recebe?.altura, cong: n.recebe?.congelamentos, 'cod/s': n['quadros codificados/s'], 'RAM MB': n['RAM MB'], 'CPU %': n['CPU %'] })));
  }
  mkdirSync(path.join(dir, 'results'), { recursive: true });
  writeFileSync(path.join(dir, 'results', `${LABEL}.json`), JSON.stringify(results, null, 2));
  console.log(`\nBENCH OK → e2e/bench/results/${LABEL}.json`);
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  for (const b of browsers) await b.close().catch(() => {});
  turn.kill(); front.close(); http.close();
  for (const b of backs.values()) b.close();
  process.exit(process.exitCode ?? 0);
}
