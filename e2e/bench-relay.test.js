import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

function nativeProcess(t, code, bin = process.execPath, env = {}, deliver = () => {}) {
  let proc, exited;
  const failures = [];
  const spawnNative = runInNewContext(harness.slice(harness.indexOf('    const spawnNative ='), harness.indexOf('    if (isNative(i))')) + '\nspawnNative', {
    spawn: (...args) => {
      assert.equal(args[2].windowsHide, true);
      proc = spawn(...args);
      exited = new Promise((resolve) => proc.once('close', resolve));
      return proc;
    },
    process, readline, performance, console, name: 'test', i: 0,
    deliver, failBench: (err) => failures.push(err),
  });
  const node = spawnNative(bin, bin === process.execPath ? ['-e', code] : [], env);
  t.after(async () => { await node.close(); await exited; });
  return { node, proc, exited, failures };
}

async function promptly(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('pending after process failure')), 1500);
    })]);
  } finally { clearTimeout(timer); }
}

test('native: exit rejeita ready e stats; chamadas após exit falham', async (t) => {
  const { node, exited, failures } = nativeProcess(t, 'process.exit(7)');
  const ready = assert.rejects(promptly(node.isReady), /exited.*7/);
  const stats = assert.rejects(promptly(node.stats()), /exited.*7/);
  await exited;
  await Promise.all([ready, stats]);
  await assert.rejects(promptly(node.stats()), /exited.*7/);
  assert.throws(() => node.onSig(1, {}), /exited.*7/);
  assert.throws(() => node.child(1), /exited.*7/);
  assert.equal(failures.length, 1);
});

test('native: exit depois de ready rejeita todos os stats pendentes', async (t) => {
  const { node, failures } = nativeProcess(t, `console.log(JSON.stringify({ready: 'ok'})); process.stdin.once('data', () => process.exit(8));`);
  assert.equal(await promptly(node.isReady), 'ok');
  await Promise.all([1, 2].map(() => assert.rejects(promptly(node.stats()), /exited.*8/)));
  assert.equal(failures.length, 1);
});

test('native: spawn inexistente rejeita sem unhandled error', async (t) => {
  const { node, exited, failures } = nativeProcess(t, '', path.join(import.meta.dirname, 'missing-native-executable.exe'));
  await Promise.all([
    assert.rejects(promptly(node.isReady), /ENOENT/),
    assert.rejects(promptly(node.stats()), /ENOENT/),
  ]);
  await exited;
  await assert.rejects(node.stats(), /ENOENT/);
  assert.equal(failures.length, 1);
});

test('native: close intencional é idempotente; rejeita esperas sem falhar bancada', async (t) => {
  const { node, exited, failures } = nativeProcess(t, 'process.stdin.resume()');
  const pending = Promise.all([
    assert.rejects(promptly(node.isReady), /closed/),
    assert.rejects(promptly(node.stats()), /closed/),
  ]);
  await node.close();
  await node.close();
  await exited;
  await pending;
  await assert.rejects(node.stats(), /closed/);
  assert.equal(failures.length, 0);
});

test('native: erro no stdin rejeita stats e propaga falha uma vez', async (t) => {
  const { node, proc, failures } = nativeProcess(t, `console.log(JSON.stringify({ready: 'ok'})); process.stdin.resume();`);
  await promptly(node.isReady);
  const pending = assert.rejects(promptly(node.stats()), /stdin broken/);
  proc.stdin.destroy(new Error('stdin broken'));
  await pending;
  assert.throws(() => node.child(1), /stdin broken/);
  assert.equal(failures.length, 1);
});

const harness = readFileSync(new URL('./bench-relay.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('./bench/relay.html', import.meta.url), 'utf8');
const rustBin = path.join(import.meta.dirname, 'bench/native/target/release/sp2p-native-bench.exe');

test('Rust real: perfil inválido rejeita ready e stats antes/depois de exit', { skip: !existsSync(rustBin) }, async (t) => {
  const { node, exited, proc, failures } = nativeProcess(t, '', rustBin, { SP2P_CODEC: 'h264', SP2P_H264_PROFILE: 'invalid' });
  await Promise.all([
    assert.rejects(promptly(node.isReady), /exited.*1/),
    assert.rejects(promptly(node.stats()), /exited.*1/),
  ]);
  await exited;
  assert.equal(proc.exitCode, 1);
  await assert.rejects(promptly(node.stats()), /exited.*1/);
  assert.equal(failures.length, 1);
});

for (const asyncFailure of [false, true]) {
  test(`signaling ${asyncFailure ? 'assíncrono' : 'síncrono'} interrompe espera e alcança cleanup`, async (t) => {
    const error = new Error('signal failed');
    const nodes = [{ onSig: () => {
      if (asyncFailure) return Promise.reject(error);
      throw error;
    } }];
    const ctx = { nodes, setTimeout, clearTimeout };
    const failureCode = harness.slice(harness.indexOf('let benchError,'), harness.indexOf('const browsers ='));
    const deliveryCode = harness.slice(harness.indexOf('  const deliver ='), harness.indexOf('  for (const [i, name]'));
    const { deliver, sleep, waitFor } = runInNewContext(`${failureCode}\n${deliveryCode}\n({deliver, sleep, waitFor})`, ctx);
    const { node, exited } = nativeProcess(t, `console.log(JSON.stringify({to: 0, offer: 'test'})); process.stdin.resume();`, process.execPath, {}, deliver);
    nodes.push(node); // isReady intentionally never awaited, as with a relay.
    let cleaned = false;
    const main = (async () => {
      try { await sleep(60_000); }
      finally { await node.close(); cleaned = true; }
    })();
    await assert.rejects(promptly(main), (err) => err === error);
    await exited;
    assert.equal(cleaned, true);
    await assert.rejects(waitFor(Promise.all([new Promise(() => {})])), (err) => err === error);
    await deliver(0, 1, {}); // Late delivery remains handled after failure.
  });
}

test('presenter registrado antes de esperar ready permite cleanup', async () => {
  const nodes = [];
  let closed = false;
  const error = new Error('presenter failed');
  const fragment = harness.slice(harness.indexOf('      if (FULL) {'), harness.indexOf('    const b = await puppeteer.launch(')).trimEnd().slice(0, -1);
  try {
    await assert.rejects(runInNewContext(`(async () => { for (const i of [0]) { ${fragment} } })()`, {
      FULL: true, PRESENTER_BIN: '', SOURCE_TITLE: 'sp2p-bench-source', nodes,
      src: { process: () => ({ pid: 123 }) },
      execFileSync: (bin, args, options) => {
        assert.equal(options.windowsHide, true);
        assert.match(args.at(-1), /UTF8Encoding/);
        assert.match(args.at(-1), /Get-Process -Id 123/);
        return 'sp2p-bench-source - Perfil 1 - Microsoft® Edge\r\n';
      },
      spawnNative: (bin, args) => {
        assert.equal(args[0], 'sp2p-bench-source - Perfil 1 - Microsoft® Edge');
        return { isReady: Promise.reject(error), close: async () => { closed = true; } };
      },
      waitFor: (p) => p,
    }), (err) => err === error);
  } finally { for (const n of nodes) await n.close(); }
  assert.equal(closed, true);
});
// Executa os trechos reais, sem importar a bancada que abre processos e sockets.
const config = harness.slice(harness.indexOf('const MODE ='), harness.indexOf("if (process.platform"));
function context(env = {}) {
  const ctx = { process: { env }, path, homedir: () => '', encodeURIComponent, waitFor: (p) => p };
  runInNewContext(config.replaceAll('import.meta.dirname', '"/bench"'), ctx);
  return ctx;
}
const effective = (ctx) => JSON.parse(runInNewContext('JSON.stringify({ CODEC, H264_PROFILE, DEG })', ctx));

test('janelas visíveis exigem autorização explícita antes dos efeitos colaterais', () => {
  for (const env of [{ BENCH_SCREEN: '1' }, { BENCH_HEADFUL: '1' }, { BENCH_MODE: 'native-full' }]) {
    for (const allow of [undefined, '0', 'true']) {
      assert.throws(() => context({ ...env, BENCH_ALLOW_VISIBLE: allow }), /janela visível bloqueado/);
    }
    assert.doesNotThrow(() => context({ ...env, BENCH_ALLOW_VISIBLE: '1' }));
  }
  for (const env of [{}, { BENCH_SCREEN: '0', BENCH_HEADFUL: '0' }]) {
    assert.equal(runInNewContext('SCREEN || HEADFUL', context(env)), false);
  }
});

test('navegador padrão permanece headless e coleta latência sem tomar foco', async () => {
  const ctx = context();
  ctx.HEADFUL = false;
  ctx.i = 0;
  ctx.profiles = '/test';
  ctx.LEAN_FLAGS = [];
  ctx.puppeteer = { launch: async (options) => {
    assert.equal(options.headless, 'new');
  } };
  const launch = harness.slice(harness.indexOf('    const b = await puppeteer.launch('), harness.indexOf('    browsers.push(b)'));
  await runInNewContext(`(async () => { ${launch} })()`, ctx);
  ctx.p = {
    bringToFront: () => assert.fail('não deve tomar foco'),
    evaluate: async () => 42,
  };
  const latency = harness.match(/^      latency: (async \(\) =>[^\n]+),/m)[1];
  assert.equal(await runInNewContext(`(${latency})()`, ctx), 42);
});

test('monitor secundário obrigatório; headless não consulta monitores', () => {
  const code = harness.slice(harness.indexOf('let secondaryMonitor ='), harness.indexOf('async function backgroundPage'));
  const monitor = { left: -1920, top: 475, width: 1920, height: 1080 };
  for (const screens of [[], [null], [{ ...monitor, width: 0 }], [{ ...monitor, left: '0' }]]) {
    assert.throws(() => runInNewContext(code, {
      FULL: true, SCREEN: false, HEADFUL: false, execFileSync: () => JSON.stringify(screens),
    }), /Monitor secundário indisponível/);
  }
  const ctx = { FULL: false, SCREEN: true, HEADFUL: false, execFileSync: (bin, args, options) => {
    assert.equal(options.windowsHide, true);
    assert.match(args.at(-1), /-not \$_\.Primary/);
    return JSON.stringify([monitor]);
  } };
  runInNewContext(code, ctx);
  assert.equal(runInNewContext('JSON.stringify(secondaryMonitor)', ctx), JSON.stringify(monitor));
  runInNewContext(code, { FULL: false, SCREEN: false, HEADFUL: false, execFileSync: () => assert.fail('headless não precisa consultar desktop') });
});

test('janela criada em background no segundo monitor; posição inválida interrompe', async () => {
  const code = harness.slice(harness.indexOf('async function backgroundPage'), harness.indexOf('// ── static files'));
  const monitor = { left: 2560, top: 475, width: 1920, height: 1080 };
  for (const invalid of [false, true]) {
    let detached = false;
    const page = {};
    const browser = {
      target: () => ({ createCDPSession: async () => ({
        send: async (method, args) => {
          if (method === 'Target.createTarget') {
            assert.equal(args.background, true);
            assert.equal(args.focus, false);
            assert.equal(args.newWindow, true);
            for (const k of Object.keys(monitor)) assert.equal(args[k], monitor[k]);
            return { targetId: 'test' };
          }
          assert.equal(method, 'Browser.getWindowForTarget');
          assert.equal(args.targetId, 'test');
          return { bounds: { ...monitor, left: invalid ? 0 : monitor.left } };
        },
        detach: async () => { detached = true; },
      }) }),
      waitForTarget: async () => ({ page: async () => page }),
    };
    const open = runInNewContext(`${code}\nbackgroundPage`, { secondaryMonitor: monitor });
    if (invalid) await assert.rejects(open(browser), /fora do monitor secundário/);
    else assert.equal(await open(browser), page);
    assert.equal(detached, true);
  }
  assert.doesNotMatch(harness, /bringToFront|--pin|--app=/);
  const presenter = readFileSync(new URL('./bench/native/src/bin/presenter.rs', import.meta.url), 'utf8');
  assert.doesNotMatch(presenter, /SetWindowPos|HWND_TOPMOST|SetForegroundWindow/);
});

test('native-full fixa codec e perfil, inclusive com h264any', () => {
  for (const codec of [undefined, 'vp8', 'h264', 'h264any']) {
    assert.deepEqual(effective(context({ BENCH_ALLOW_VISIBLE: '1', BENCH_MODE: 'native-full', BENCH_CODEC: codec, BENCH_H264_PROFILE: '64001f' })), {
      CODEC: 'h264', H264_PROFILE: '42e01f', DEG: 'balanced',
    });
  }
  assert.equal(effective(context({ BENCH_MODE: 'native', BENCH_CODEC: 'h264any' })).H264_PROFILE, '42001f');
  assert.equal(effective(context({ BENCH_MODE: 'native', BENCH_CODEC: 'h264any', BENCH_H264_PROFILE: '64001f' })).H264_PROFILE, '64001f');
  assert.equal(effective(context({ BENCH_CODEC: 'h264any' })).H264_PROFILE, null);
  assert.equal(effective(context()).H264_PROFILE, null);
});

test('BENCH_DEG inválido falha antes de qualquer processo; URL codifica valores', async () => {
  for (const value of ['', 'invalid', 'balanced&screen=1']) {
    assert.throws(() => context({ BENCH_DEG: value }), /BENCH_DEG inválido/);
  }
  for (const deg of ['balanced', 'maintain-framerate', 'maintain-resolution']) {
    const ctx = context({ BENCH_DEG: deg, BENCH_CODEC: 'h264&screen=1' });
    let url;
    ctx.p = { goto: (value) => { url = new URL(value); } };
    ctx.pageMode = 'decode';
    await runInNewContext(`(async () => { ${harness.match(/await waitFor\(p\.goto\([^\n]+/)[0]} })()`, ctx);
    assert.equal(url.searchParams.get('deg'), deg);
    assert.equal(url.searchParams.get('codec'), 'h264&screen=1');
    assert.equal(url.searchParams.has('screen'), false);
  }
});

test('BENCH_KBPS: padrão 8000, inválido ou em native-full falha; vai na URL', async () => {
  for (const value of ['', 'abc', '99', '100001', '8000.5', '8000&screen=1']) {
    assert.throws(() => context({ BENCH_KBPS: value }), /BENCH_KBPS inválido/);
  }
  assert.throws(() => context({ BENCH_ALLOW_VISIBLE: '1', BENCH_MODE: 'native-full', BENCH_KBPS: '20000' }), /BENCH_KBPS inválido/);
  assert.equal(runInNewContext('KBPS', context()), 8000);
  const ctx = context({ BENCH_KBPS: '20000' });
  let url;
  ctx.p = { goto: (value) => { url = new URL(value); } };
  ctx.pageMode = 'decode';
  await runInNewContext(`(async () => { ${harness.match(/await waitFor\(p\.goto\([^\n]+/)[0]} })()`, ctx);
  assert.equal(url.searchParams.get('kbps'), '20000');
});

test('JSON preserva configuração e dimensões reais do ready', async () => {
  const ctx = context({ BENCH_ALLOW_VISIBLE: '1', BENCH_MODE: 'native-full', BENCH_CODEC: 'h264any', BENCH_DIRECT: '1', BENCH_NORELAY: '1', BENCH_SETTLE_MS: '123', BENCH_MEASURE_MS: '456' });
  ctx.browsers = [{ version: async () => 'test' }];
  ctx.presenterReady = { w: 1918, h: 1048, encoder: 'test' };
  ctx.secondaryMonitor = { left: 2560, top: 475, width: 1920, height: 1080 };
  const resultCode = harness.slice(harness.indexOf('  const results ='), harness.indexOf('  for (const [net, cfg]'));
  const result = await runInNewContext(`(async () => { ${resultCode} return JSON.stringify(results); })()`, ctx);
  const data = JSON.parse(result);
  assert.equal(data.codec, 'h264');
  assert.equal(data.profile, '42e01f');
  assert.equal(data.degradationPreference, 'balanced');
  assert.equal(data.kbps, 8000);
  assert.equal(data.screen, true);
  assert.equal(data.direct, true);
  assert.equal(data.norelay, true);
  assert.equal(data.settleMs, 123);
  assert.equal(data.measureMs, 456);
  assert.deepEqual(data.presenterReady, ctx.presenterReady);
});

test('estatísticas mantêm degradação efetiva, sem fps outbound ou discarded source', async () => {
  const ctx = { URLSearchParams, location: { search: '?mode=decode&ice=[]' }, window: {}, performance: { now: () => 1 } };
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], ctx);
  runInNewContext(`
    pcs.set(1, {
      getStats: async () => new Map([
        [1, { type: 'outbound-rtp', kind: 'video', framesPerSecond: 60, frameWidth: 1906, frameHeight: 1072, codecId: 'h264' }],
        [2, { type: 'inbound-rtp', kind: 'video', frameWidth: 1906, frameHeight: 1072, codecId: 'h264' }],
        ['h264', { type: 'codec', mimeType: 'video/H264', sdpFmtpLine: 'profile-level-id=42001f;packetization-mode=1' }],
      ]),
      getSenders: () => [{ getParameters: () => ({ degradationPreference: 'maintain-resolution' }) }],
    });
    stream = { getVideoTracks: () => [{ getSettings: () => ({ width: 1918, height: 1048 }), stats: { deliveredFrames: 10, discardedFrames: 2 } }] };
  `, ctx);
  const stats = await ctx.window.bench.stats();
  assert.equal(stats.out[0].degradationPreference, 'maintain-resolution');
  assert.equal('fps' in stats.out[0], false);
  for (const media of [stats.in, stats.out[0]]) {
    assert.equal(media.w, 1906);
    assert.equal(media.h, 1072);
    assert.equal(media.codec.mimeType, 'video/H264');
    assert.equal(media.codec.sdpFmtpLine, 'profile-level-id=42001f;packetization-mode=1');
  }
  assert.equal(stats.source.delivered, 10);
  assert.equal('discarded' in stats.source, false);
});

test('captura: política sem foco precede pedido; sem suporte ou falha não há fallback', async () => {
  for (const scenario of ['ok', 'missing', 'method-missing', 'policy-error', 'capture-error']) {
    const calls = [], track = {}, video = {};
    const media = { getVideoTracks: () => [track] };
    const error = new Error('captura recusada');
    class Controller {
      setFocusBehavior(value) {
        assert.equal(value, 'no-focus-change');
        calls.push('policy');
        if (scenario === 'policy-error') throw error;
      }
    }
    const ctx = {
      URLSearchParams, location: { search: '?screen=1&ice=[]' }, window: {},
      document: { getElementById: () => video },
      navigator: { mediaDevices: { getDisplayMedia: async (options) => {
        assert.deepEqual(calls, ['policy']);
        assert.ok(options.controller instanceof Controller);
        assert.equal(JSON.stringify(options.video), JSON.stringify({ width: 1920, height: 1080, frameRate: 60 }));
        assert.equal(options.audio, false);
        calls.push('capture');
        if (scenario === 'capture-error') throw error;
        return media;
      } } },
    };
    if (scenario !== 'missing') ctx.CaptureController = scenario === 'method-missing' ? class {} : Controller;
    runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], ctx);
    if (scenario === 'ok') {
      await ctx.window.bench.present();
      assert.equal(video.srcObject, media);
      assert.equal(track.contentHint, 'motion');
    } else {
      await assert.rejects(ctx.window.bench.present(), scenario.endsWith('error') ? (e) => e === error : /controle de foco indisponível/);
      assert.equal(video.srcObject, undefined);
    }
    assert.deepEqual(calls, ['ok', 'capture-error'].includes(scenario) ? ['policy', 'capture'] : scenario === 'policy-error' ? ['policy'] : []);
  }
});

function clockImage(width, height, bands) {
  const data = new Uint8ClampedArray(width * height * 4).fill(128);
  for (const { top, rows, stamp, marker = 0xa5 } of bands) {
    for (let y = top; y < top + rows; y++) for (let x = 0; x < width; x++) {
      const i = Math.floor(x * 32 / width);
      const bit = (i < 24 ? stamp >> i : marker >> (i - 24)) & 1;
      data.set([bit ? 240 : 15, bit ? 240 : 15, bit ? 240 : 15, 255], (y * width + x) * 4);
    }
  }
  return { data, width, height };
}

const readClock = runInNewContext(html.slice(html.indexOf('function readClock('), html.indexOf('window.bench =')) + '\nreadClock');

test('relógio: decoração, escala, zero e faixa ausente ou ambígua', () => {
  for (const [width, height, top, rows] of [[320, 180, 0, 22], [320, 180, 14, 20], [160, 90, 8, 10], [477, 268, 20, 30]]) {
    for (const stamp of [0, 0xffffff, 478122]) {
      assert.equal(readClock(clockImage(width, height, [{ top, rows, stamp }])), stamp);
    }
  }
  assert.equal(readClock(clockImage(320, 180, [])), null);
  assert.equal(readClock(clockImage(320, 180, [{ top: 10, rows: 20, stamp: 42, marker: 0 }])), null);
  assert.equal(readClock(clockImage(320, 180, [{ top: 10, rows: 2, stamp: 42 }])), null);
  assert.equal(readClock(clockImage(320, 180, [
    { top: 10, rows: 20, stamp: 42 }, { top: 50, rows: 20, stamp: 43 },
  ])), null);
});

test('latência: wrap, leitura inválida e vídeo indisponível retornam sem bloquear', async () => {
  for (const scenario of ['wrap', 'invalid', 'unavailable']) {
    const image = clockImage(320, 180, scenario === 'invalid' ? [] : [{ top: 14, rows: 20, stamp: 0xfffff0 }]);
    let draws = 0;
    const ctx = {
      URLSearchParams, location: { search: '?mode=decode&ice=[]' }, window: {},
      Date: { now: () => 0x1000020 }, setTimeout: (fn) => queueMicrotask(fn),
      document: {
        getElementById: () => ({ readyState: scenario === 'unavailable' ? 0 : 2 }),
        createElement: () => ({ getContext: () => ({ drawImage: () => { draws++; }, getImageData: () => image }) }),
      },
    };
    runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], ctx);
    assert.equal(await promptly(ctx.window.bench.latency(3)), scenario === 'wrap' ? 48 : null);
    assert.equal(draws, scenario === 'unavailable' ? 0 : 3);
  }
});
