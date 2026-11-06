#!/usr/bin/env node
// Rebuilds the athlete bodies and hairstyles in this folder from Quaternius' CC0
// "Universal Base Characters [Standard]" pack (https://quaternius.com/packs/universalbasecharacters.html).
// The built files are committed, so you only need this to change sizes or add pieces.
//
//   node build.mjs [--zip path/to/Universal_Base_Characters_Standard.zip]
//
// Without --zip it downloads the free pack from itch.io (no account needed) and checks its SHA-256.
// Needs `unzip`, plus Python 3 with Pillow (or macOS `sips`) to resize textures.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packGlb } from '../../src/glb.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHA256 = 'fdbf1804c90dfc1ea03e992bff7da2dfd1a79318e13270a660180f9308455f40';
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };

async function download(dest) {
  const page = 'https://quaternius.itch.io/universal-base-characters';
  const r1 = await fetch(`${page}/download_url`, { method: 'POST' });
  const { url } = await r1.json();
  const html = await (await fetch(url)).text();
  const id = html.match(/data-upload_id="(\d+)"/)?.[1];
  if (!id) throw new Error('could not find the download on itch.io; download the Standard zip by hand and pass --zip');
  const r2 = await fetch(`${page}/file/${id}?source=game_download`, { method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
  const file = (await r2.json()).url;
  const res = await fetch(file);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hfilm-athletes-'));
try {
  let zip = arg('--zip');
  if (!zip) { zip = path.join(tmp, 'ubc.zip'); console.log('downloading Universal Base Characters [Standard] from itch.io…'); await download(zip); }
  const sum = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
  if (sum !== SHA256) console.warn(`warning: SHA-256 ${sum} differs from the pinned ${SHA256} (the pack may have been updated)`);
  execFileSync('unzip', ['-q', '-o', zip, '-d', tmp]);
  const root = fs.readdirSync(tmp).map((d) => path.join(tmp, d)).find((d) => fs.statSync(d).isDirectory() && /Universal Base Characters/.test(d));
  const bc = path.join(root, 'Base Characters'), tex = path.join(bc, 'Textures');

  // image helpers (Pillow, else sips)
  const py = (code, ...a) => execFileSync('python3', ['-c', code, ...a]);
  const hasPIL = (() => { try { py('import PIL'); return true; } catch { return false; } })();
  function convert(src, dst, size, { gray = false, quality = 88 } = {}) {
    if (hasPIL) {
      py(`import sys
from PIL import Image, ImageOps
im=Image.open(sys.argv[1]); im=im.convert('RGBA' if sys.argv[2].endswith('.png') else 'RGB')
im.thumbnail((int(sys.argv[3]),int(sys.argv[3])), Image.LANCZOS)
if sys.argv[4]=='1':
    g=ImageOps.grayscale(im.convert('RGB')); import statistics
    m=statistics.mean(g.getdata()) or 1; g=g.point(lambda v: min(255,int(v*230/m))); im=g.convert('RGB')
im.save(sys.argv[2], quality=int(sys.argv[5]))`, src, dst, String(size), gray ? '1' : '0', String(quality));
    } else {
      if (gray) throw new Error('grayscale hair textures need Python Pillow');
      execFileSync('sips', ['-Z', String(size), src, '--setProperty', 'format', dst.endsWith('.png') ? 'png' : 'jpeg', '--out', dst]);
    }
    return fs.readFileSync(dst);
  }
  const jpg = (src, size, o) => ({ data: convert(src, path.join(tmp, `${path.basename(src)}.${size}.jpg`), size, o), mimeType: 'image/jpeg' });

  for (const [sex, key] of [['m', 'Male'], ['f', 'Female']]) {
    const gltf = path.join(bc, 'Godot - UE', `Superhero_${key}_FullBody.gltf`);
    const doc = JSON.parse(fs.readFileSync(gltf, 'utf8'));
    for (const img of doc.images) {   // the glTF expects textures beside it; point at the real files
      const base = img.name.replace(/\.png$/, '');
      const cands = [path.join(tex, 'Normals Unity - Godot', `${base}.png`), path.join(tex, `${base}.png`), path.join(tex, img.uri)];
      const hit = cands.find((c) => /Normal/.test(base) ? c.includes('Unity - Godot') && fs.existsSync(c) : fs.existsSync(c)) || cands.find((c) => fs.existsSync(c));
      fs.copyFileSync(hit, path.join(path.dirname(gltf), img.uri));
    }
    const light = fs.readdirSync(tex).find((f) => new RegExp(`Superhero_${key}_.*Ligh`).test(f));
    const dark = fs.readdirSync(tex).find((f) => new RegExp(`Superhero_${key}_.*Dark`).test(f));
    const glb = packGlb(gltf, {
      dropAttributes: ['COLOR_0', 'COLOR_1', 'TEXCOORD_1', 'TEXCOORD_2', 'TEXCOORD_3'],
      image: (img) => {
        const n = img.name || img.uri;
        if (/Superhero.*(Dark|Ligh)/.test(n)) return jpg(path.join(tex, light), 1024);     // light skin embedded; tones blend in the renderer
        if (/Normal/.test(n)) return jpg(path.join(path.dirname(gltf), img.uri), 1024, { quality: 92 });
        if (/Roughness/.test(n)) return jpg(path.join(path.dirname(gltf), img.uri), 512);
        if (/Hair/.test(n)) return jpg(path.join(path.dirname(gltf), img.uri), 512, { gray: true });
        return { data: fs.readFileSync(path.join(path.dirname(gltf), img.uri)), mimeType: 'image/png' };
      },
    });
    fs.writeFileSync(path.join(HERE, `athlete_${sex}.glb`), glb);
    fs.writeFileSync(path.join(HERE, `skin_${sex}_light.jpg`), jpg(path.join(tex, light), 1024).data);
    fs.writeFileSync(path.join(HERE, `skin_${sex}_dark.jpg`), jpg(path.join(tex, dark), 1024).data);
    console.log(`✓ athlete_${sex}.glb (${(glb.length / 1e6).toFixed(2)} MB)`);
  }

  const hairDir = path.join(root, 'Hairstyles', 'Rigged to Head Bone', 'glTF (Godot -Unreal)'), hairTex = path.join(root, 'Hairstyles', 'Textures');
  for (const f of fs.readdirSync(hairDir).filter((f) => f.endsWith('.gltf'))) {
    const gltf = path.join(hairDir, f), doc = JSON.parse(fs.readFileSync(gltf, 'utf8'));
    for (const img of doc.images) fs.copyFileSync(path.join(hairTex, img.uri), path.join(hairDir, img.uri));
    const glb = packGlb(gltf, {
      image: (img) => (/Normal/.test(img.uri) ? jpg(path.join(hairDir, img.uri), 512, { quality: 92 }) : jpg(path.join(hairDir, img.uri), 512, { gray: true })),
    });
    const out = f.replace(/\.gltf$/, '').replace(/^Hair_/, 'hair_').replace(/^Eyebrows_/, 'eyebrows_').toLowerCase() + '.glb';
    fs.writeFileSync(path.join(HERE, out), glb);
    console.log(`✓ ${out} (${(glb.length / 1e3).toFixed(0)} kB)`);
  }
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
