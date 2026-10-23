// Publishes the built installer as a GitHub release the app's updater can see.
// Run after `npm run build` with TAURI_SIGNING_PRIVATE_KEY set: node release.mjs ["notes"]
// The updater reads releases/latest/download/latest.json (tauri.conf.json → plugins.updater).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const REPO = 'yagoriccomi/stream-p2p';
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const conf = JSON.parse(readFileSync(path.join(here, 'src-tauri/tauri.conf.json'), 'utf8'));
const { version, productName } = conf;
const dir = path.join(here, 'src-tauri/target/release/bundle/nsis');
const exe = path.join(dir, `${productName}_${version}_x64-setup.exe`);
const sig = `${exe}.sig`;
for (const f of [exe, sig]) if (!existsSync(f)) throw new Error(`não achei ${f}: rode npm run build com TAURI_SIGNING_PRIVATE_KEY`);

// GitHub turns spaces in asset names into dots; the URL must match what it serves.
const asset = path.basename(exe).replaceAll(' ', '.');
const notes = process.argv[2] ?? `Stream P2P ${version}`;
const manifest = path.join(dir, 'latest.json');
writeFileSync(manifest, JSON.stringify({
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': { signature: readFileSync(sig, 'utf8').trim(), url: `https://github.com/${REPO}/releases/download/v${version}/${asset}` },
  },
}, null, 2));

execFileSync('gh', ['release', 'create', `v${version}`, exe, sig, manifest, '--repo', REPO, '--title', `${productName} ${version}`, '--notes', notes, '--latest'], { stdio: 'inherit' });
console.log(`publicado: https://github.com/${REPO}/releases/tag/v${version}`);
