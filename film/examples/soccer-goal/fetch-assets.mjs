#!/usr/bin/env node
// Downloads the CC0 "Universal Animation Library [Standard]" by Quaternius (rigged mannequin + 45 clips)
// and extracts the glTF binary to assets/ual_mannequin.glb. Needs `unzip` (macOS/Linux) or `tar` (Windows 10+).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dest = path.join(here, 'assets', 'ual_mannequin.glb');
if (fs.existsSync(dest)) { console.log(`already present: ${dest}`); process.exit(0); }
const url = 'https://opengameart.org/sites/default/files/universal_animation_librarystandard.zip';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hfilm-ual-'));
const zip = path.join(tmp, 'ual.zip');
console.log(`downloading ${url}`);
const res = await fetch(url, { headers: { 'user-agent': 'hybrid-film-example' } });
if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
if (process.platform === 'win32') execFileSync('tar', ['-xf', zip, '-C', tmp]);
else execFileSync('unzip', ['-q', '-o', zip, '-d', tmp]);
const find = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? find(path.join(d, e.name)) : e.name.endsWith('.glb') ? [path.join(d, e.name)] : []));
const glb = find(tmp)[0];
if (!glb) throw new Error('no .glb found in the archive');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.copyFileSync(glb, dest);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`✓ ${dest} (CC0, Quaternius)`);
