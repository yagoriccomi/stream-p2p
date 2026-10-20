// E2E: 1 host (1440p60, 20 Mbps → quota 1) + 3 viewers → v1 direct, v2/v3 relayed via v1.
// getDisplayMedia is replaced by an animated canvas so no OS picker is needed.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';

const PORT = 3999;
const BASE = `http://localhost:${PORT}`;
const CHROME = process.env.CHROME_PATH ?? [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
].find(existsSync);
assert.ok(CHROME, 'Chrome não encontrado; defina CHROME_PATH');

const FAKE_CAPTURE = () => {
  navigator.mediaDevices.getDisplayMedia = async ({ video }) => {
    const c = Object.assign(document.createElement('canvas'), { width: video.width, height: video.height });
    const g = c.getContext('2d');
    let t = 0;
    setInterval(() => {
      g.fillStyle = `hsl(${t++ % 360} 70% 40%)`;
      g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = '#fff';
      g.font = '120px sans-serif';
      g.fillText(String(t), 100 + (t * 7) % (c.width - 400), c.height / 2);
    }, 1000 / video.frameRate);
    return c.captureStream(video.frameRate);
  };
};

const server = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT }, stdio: 'inherit' });
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: process.env.HEADFUL ? false : 'new',
  args: ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
});

const waitFor = (page, fn, what, timeout = 20000) =>
  page.waitForFunction(fn, { timeout, polling: 250 }).catch(async () => {
    const dump = await page.evaluate(() => `${document.getElementById('status').textContent}\n${document.getElementById('log').textContent}`);
    throw new Error(`timeout: ${what}\n${dump}`);
  });

try {
  await new Promise((r) => setTimeout(r, 500));
  const host = await browser.newPage();
  await host.evaluateOnNewDocument(FAKE_CAPTURE);
  await host.goto(BASE);
  await waitFor(host, () => document.getElementById('status').textContent === 'Pronto.', 'host hello');
  await host.select('#mode', '1440p60');
  await host.click('#host');
  await waitFor(host, () => !document.getElementById('invite').hidden, 'sala criada');
  const invite = await host.$eval('#invite-link', (a) => a.href);
  console.log('convite:', invite);

  const viewers = [];
  for (let i = 0; i < 3; i++) {
    const p = await browser.newPage();
    await p.goto(invite);
    await waitFor(p, () => document.getElementById('video').videoWidth > 0, `vídeo no viewer ${i + 1}`);
    viewers.push(p);
  }

  await new Promise((r) => setTimeout(r, 6000)); // let bitrate ramp up and stats tick
  for (const [i, p] of viewers.entries()) {
    const s = await p.evaluate(() => ({ ...window.__stats, status: document.getElementById('status').textContent }));
    console.log(`viewer ${i + 1}:`, s);
    assert.ok(s.w > 0 && s.kbps > 0, `viewer ${i + 1} sem vídeo fluindo`);
  }
  const via = await Promise.all(viewers.map((p) => p.$eval('#status', (e) => e.textContent)));
  assert.match(via[0], /buffer 120 ms/, 'viewer 1 deveria ser direto');
  assert.match(via[1], /buffer 90 ms/, 'viewer 2 deveria ser relay');
  assert.match(via[2], /buffer 90 ms/, 'viewer 3 deveria ser relay');
  console.log('host:', await host.evaluate(() => window.__stats));

  // Relay leaves → v2 is promoted to host, v3 re-hangs and must get video again.
  await viewers[0].close();
  await waitFor(viewers[2], () => document.getElementById('video').videoWidth > 0 && window.__stats?.kbps > 0, 're-parent v3');
  console.log('re-parent ok:', await viewers[2].$eval('#status', (e) => e.textContent));
  console.log('E2E OK');
} finally {
  await browser.close();
  server.kill();
}
