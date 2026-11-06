// End-to-end: headless Chrome renders a plate composite; checks holdout, actor and shadow-catcher pixels.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { findChrome } from '../src/chrome.mjs';
import { render } from '../src/render.mjs';

function png(w, h, rgb) {  // minimal solid-colour PNG encoder
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3).map((_, i) => rgb[i % 3])]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('plate compositing: holdouts reveal the plate, actors draw on top, only new shadows darken', { skip: !findChrome() && 'Chrome not installed', timeout: 120000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hfilm-render-'));
  for (let f = 0; f < 3; f++) fs.writeFileSync(path.join(dir, `plate.${f}.png`), png(32, 18, [120, 160, 90]));
  // camera looks straight down (screen right = +X, ~15.6 px per metre at the ground); a red 2 m box at x=-3,
  // a holdout over x=3.5..6.5, sun from +X so the box's shadow falls on x=-5.2..-4
  fs.writeFileSync(path.join(dir, 'film.mjs'), `export default {
    size: [320, 180], frames: [0, 3], render: { samples: 4, toneMapping: 'none' },
    plate: { frames: 'plate.{frame}.png' },
    camera: { position: [0, 10, 0], target: [0, 0, 0], up: [0, 0, -1], fov: 60 },
    sun: { direction: [0.6, 1, 0], intensity: 3, softness: 0 },
    ambient: { intensity: 0 },
    shadowCatcher: { y: 0, opacity: 0.8, tint: '#000000' },
    holdouts: [{ shape: 'box', position: [5, 1, 0], scale: [3, 2, 20] }],
    actors: [{ id: 'box', model: { primitive: 'box', size: [2, 2, 2], material: { color: '#ff0000', roughness: 1 } }, transform: { position: [-3, 1, 0] } }],
  };`);
  const probe = { frames: [1], points: [[113, 90], [238, 90], [160, 165], [86, 90]], results: {} };
  const res = await render(path.join(dir, 'film.mjs'), { out: path.join(dir, 'out.mp4'), probe });
  assert.ok(res.ok && fs.statSync(path.join(dir, 'out.mp4')).size > 1000, 'mp4 written');
  const [box, holdout, plain, shadow] = probe.results[1];
  assert.ok(box[0] > 120 && box[1] < 80, `box should be red, got ${box}`);
  assert.ok(Math.abs(holdout[0] - 120) < 12 && Math.abs(holdout[1] - 160) < 12, `holdout area shows the plate, got ${holdout}`);
  assert.ok(Math.abs(plain[1] - 160) < 12, `untouched plate stays the same, got ${plain}`);
  assert.ok(shadow[1] < plain[1] - 30, `box casts a shadow onto the plate (shadow ${shadow} vs plate ${plain})`);
});
