import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { bakeFilm, FilmError, platePath } from '../src/spec.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hfilm-spec-'));
const film = (over = {}) => ({ film: { frames: [0, 4], camera: { position: [0, 2, 10], target: [0, 0, 0], focalLength: 50 }, ...over }, dir });

test('bakes per-frame camera tracks with fov from focal length', () => {
  const { baked } = bakeFilm(film());
  assert.equal(baked.camera.position.length, 4);
  // 36 mm sensor, 16:9 -> sensor height 20.25 mm; vertical fov = 2 atan(10.125 / 50)
  assert.ok(Math.abs(baked.camera.fov[0] - (2 * Math.atan(10.125 / 50) * 180) / Math.PI) < 1e-3);
  assert.equal(baked.camera.fstop, undefined);
});

test('function tracks are evaluated every frame', () => {
  const { baked } = bakeFilm(film({ actors: [{ id: 'a', transform: (f) => ({ position: [f, 0, 0], yaw: 90 }) }] }));
  assert.deepEqual(baked.actors[0].position.map((p) => p[0]), [0, 1, 2, 3]);
});

test('helpful validation errors', () => {
  assert.throws(() => bakeFilm({ film: { frames: [0, 2] }, dir }), (e) => e instanceof FilmError && /camera: required/.test(e.message));
  assert.throws(() => bakeFilm(film({ actors: [{ transform: { position: [0, 0] } }] })), /position.*expected \[n,n,n\]/);
  assert.throws(() => bakeFilm(film({ size: [1281, 720] })), /must be even/);
  assert.throws(() => bakeFilm(film({ actors: [{ model: 'missing.glb' }] })), /file not found/);
  assert.throws(() => bakeFilm(film({ plate: { frames: 'p.jpg' } })), /\{frame\}/);
});

test('plate patterns pad and offset frame numbers', () => {
  assert.equal(platePath({ pattern: '/x/Shot.{frame:4}.jpeg', offset: -1120 }, 1125), '/x/Shot.0005.jpeg');
  assert.equal(platePath({ pattern: '/x/{frame}.png', offset: 0 }, 7), '/x/7.png');
});

test('holdouts from position/rotation/scale become matrices; grid is kept', () => {
  const { baked } = bakeFilm(film({ holdouts: [{ shape: 'box', position: [1, 2, 3], scale: 2, grid: { cell: 0.1, line: 0.06 } }] }));
  const m = baked.holdouts[0].matrix;
  assert.deepEqual([m[0], m[5], m[10], m[12], m[13], m[14]], [2, 2, 2, 1, 2, 3]);
  assert.deepEqual(baked.holdouts[0].grid, { cell: 0.1, line: 0.06 });
});

test('cuts outside the range are dropped', () => {
  const { baked } = bakeFilm(film({ cuts: [0, 2, 9] }));
  assert.deepEqual(baked.cuts, [2]);
});
