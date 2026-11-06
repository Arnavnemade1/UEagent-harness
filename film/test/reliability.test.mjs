import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { ingest } from '../src/ingest.mjs';
import { imageInfo, modelInfo, validateImages } from '../src/media.mjs';
import { qualityPlan } from '../src/quality.mjs';
import { bakeFilm } from '../src/spec.mjs';
import { VideoOutput, validateMp4 } from '../src/output.mjs';
import { treeBytes, footprintBytes, supervise, runProcess } from '../src/process.mjs';
import { connect } from '../src/chrome.mjs';
import { acquireLease } from '../src/lease.mjs';
import { startServer } from '../src/server.mjs';

const temp = (t) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hfilm-reliability-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
// Header-level fixture; intentionally not a decoded image. Real render tests use valid pixels.
function headerPng(width = 32, height = 18) {
  const b = Buffer.alloc(45); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(b); b.write('IHDR', 12); b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20); b.write('IEND', b.length - 8); return b;
}
function box(type, data = Buffer.alloc(0)) { const b = Buffer.alloc(8); b.writeUInt32BE(data.length + 8); b.write(type, 4); return Buffer.concat([b, data]); }
function mp4(frames = 3) { const samples = Buffer.alloc(12); samples.writeUInt32BE(frames, 8); return Buffer.concat([box('ftyp', Buffer.from('isom0000')), box('mdat', Buffer.from('test')), box('moov', box('trak', box('mdia', box('minf', box('stbl', box('stsz', samples))))))]); }
const film = { frames: [0, 3], size: [320, 180], camera: { position: [0, 2, 10], target: [0, 0, 0], focalLength: 50 } };

test('external transfers enforce checksums and byte limits, preserve existing files, and record provenance', async (t) => {
  const dir = temp(t), bytes = headerPng();
  const server = http.createServer((req, res) => { res.writeHead(200); res.end(bytes); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise((r) => server.close(r)));
  const url = `http://127.0.0.1:${server.address().port}/asset?secret=hidden`;
  const out = path.join(dir, 'asset.png'), sha256 = createHash('sha256').update(bytes).digest('hex');
  const result = await ingest(url, { out, sha256 });
  assert.equal(result.sha256, sha256); assert.deepEqual(fs.readFileSync(out), bytes);
  assert.ok(!JSON.stringify(result).includes('secret'));
  assert.ok(fs.existsSync(out + '.source.json'));
  await assert.rejects(ingest(url, { out }), /already exists/);
  await assert.rejects(ingest(url, { out: path.join(dir, 'bad.png'), sha256: '0'.repeat(64) }), /checksum mismatch/);
  await assert.rejects(ingest(url, { out: path.join(dir, 'large.png'), maxMB: 0.00001 }), /maximum transfer size/);
  await assert.rejects(ingest(url, { out: path.join(dir, 'script.mjs') }), /executable/);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['asset.png', 'asset.png.source.json']);
});

test('all external frames and glTF dependencies are checked before GPU startup', (t) => {
  const dir = temp(t);
  for (const i of [0, 2]) fs.writeFileSync(path.join(dir, `plate.${i}.png`), headerPng());
  assert.throws(() => bakeFilm({ film: { ...film, plate: { frames: 'plate.{frame}.png' } }, dir }), /frame 1/);
  fs.writeFileSync(path.join(dir, 'plate.1.png'), Buffer.from('truncated'));
  assert.throws(() => bakeFilm({ film: { ...film, plate: { frames: 'plate.{frame}.png' } }, dir }), /malformed image/);
  assert.throws(() => validateImages([path.join(dir, 'plate.0.png')], { width: 320, height: 180 }), /dimensions differ/);
  const model = path.join(dir, 'scene.gltf');
  fs.writeFileSync(model, JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: 'missing.bin', byteLength: 4 }] }));
  assert.throws(() => modelInfo(model), /missing dependency/);
  fs.writeFileSync(model, JSON.stringify({ asset: { version: '2.0' }, images: [{ uri: 'https://example.com/texture.png' }] }));
  assert.throws(() => modelInfo(model), /stage external dependency locally/);
  fs.writeFileSync(model, JSON.stringify({ asset: { version: '2.0' }, extensionsRequired: ['KHR_draco_mesh_compression'] }));
  assert.throws(() => modelInfo(model), /decoder not configured/);
});

test('quality planning keeps timing and bounds allocations before baking large tracks', () => {
  const authored = { ...film, size: [3840, 2160], render: { samples: 64 } };
  const plan = qualityPlan(authored, { quality: 'preview', memoryGB: 2 }, 16 * 1024 ** 3);
  assert.deepEqual(plan.size, [960, 540]); assert.equal(plan.samples, 4); assert.deepEqual(plan.film.frames, film.frames);
  assert.equal(plan.film.sun.shadowMapSize, 1024); assert.deepEqual(authored.size, [3840, 2160]);
  assert.throws(() => qualityPlan(authored, { samples: -1 }), /samples/);
  assert.throws(() => qualityPlan(authored, { memoryGB: 0.5 }), /buffers exceed/);
  for (const bad of [{ fps: 0 }, { frames: [0, Infinity] }, { frames: [0, 100001] }, { render: { samples: 0 } }, { size: [0, 0] }]) assert.throws(() => bakeFilm({ film: { ...film, ...bad }, dir: '.' }));
});

test('PBR texture channels are registered as external media with explicit normal scale', (t) => {
  const dir = temp(t); fs.writeFileSync(path.join(dir, 'texture.png'), headerPng());
  const material = { normalScale: [1, -1], normalMap: 'texture.png', roughnessMap: 'texture.png', metalnessMap: 'texture.png', aoMap: 'texture.png', emissiveMap: 'texture.png', alphaMap: 'texture.png' };
  const result = bakeFilm({ film: { ...film, actors: [{ model: { primitive: 'sphere', material } }] }, dir });
  assert.equal(result.media.length, 1);
  assert.match(result.baked.actors[0].model.material.normalMap, /^\/asset\//);
  assert.deepEqual(result.baked.actors[0].model.material.normalScale, [1, -1]);
});

test('video sink writes bounded chunks, validates sample count, and publishes atomically', (t) => {
  const dir = temp(t), file = path.join(dir, 'out.mp4'), data = mp4();
  fs.writeFileSync(file, 'existing');
  const bad = new VideoOutput(file, { frames: 4 }); bad.start(); bad.write(data, 0);
  assert.throws(() => bad.finish(data.length), /frame count mismatch/); bad.close();
  assert.equal(fs.readFileSync(file, 'utf8'), 'existing');
  const good = new VideoOutput(file, { frames: 3, maxBytes: 1024 }); good.start();
  good.write(data.subarray(0, 20), 0); good.write(data.subarray(20), 20);
  assert.throws(() => good.write(data, 10000), /write range/);
  assert.equal(good.finish(data.length).frames, 3); good.close();
  assert.equal(validateMp4(file, 3).bytes, data.length);
  assert.deepEqual(fs.readdirSync(dir), ['out.mp4']);
});

test('memory guards include descendants, enforce pressure/caps, and fail closed on monitor errors', async () => {
  assert.equal(treeBytes('10 1 100\n11 10 200\n12 11 300\n99 1 900', 10), 600 * 1024);
  assert.equal(footprintBytes('PID MEM\n10 1.5G+\n'), 1.5 * 1024 ** 3);
  for (const sample of [async () => ({ bytes: 2 * 1024 ** 3, pressure: 1 }), async () => ({ bytes: 10, pressure: 4 }), async () => { throw new Error('unavailable'); }]) {
    const proc = new EventEmitter(); Object.assign(proc, { pid: 10, exitCode: null, signalCode: null });
    const signals = []; proc.kill = (s) => { signals.push(s); };
    const guard = supervise(proc, { memoryGB: 1, sample });
    await guard.check(); await guard.check();
    assert.deepEqual(signals, ['SIGTERM']); assert.ok(guard.stopped); guard.dispose();
  }
});

test('worker spawn errors return promptly and close log handles', async (t) => {
  const dir = temp(t);
  await assert.rejects(runProcess('/not-a-real-worker', [], { logFile: path.join(dir, 'worker.log') }), /ENOENT/);
});

test('CDP rejects disconnects and timed-out commands without hanging render cleanup', async () => {
  let socket;
  class FakeSocket {
    constructor() { socket = this; queueMicrotask(() => this.onopen()); }
    send() {}
    close() { this.onclose?.(); }
  }
  const cdp = await connect('ws://test', null, { WebSocketClass: FakeSocket, timeoutMs: 20 });
  await assert.rejects(cdp.send('NeverReplies'), /timed out/);
  const pending = cdp.send('Rendering'); socket.close();
  await assert.rejects(pending, /disconnected/);
  await assert.rejects(cdp.send('AfterClose'), /closed/);
});

test('render ownership prevents competing workers and output endpoint rejects invalid frames', async (t) => {
  const dir = temp(t), lock = path.join(dir, 'render.lock');
  const release = acquireLease(lock); assert.throws(() => acquireLease(lock), /Another render/); release();
  const server = await startServer({ baked: { start: 0, end: 3, width: 32, height: 18 }, assets: { dirs: [] }, framesDir: dir });
  t.after(() => server.close());
  const invalid = await fetch(server.url + '/frame/1x', { method: 'POST', body: headerPng() });
  assert.equal(invalid.status, 400);
  const outside = await fetch(server.url + '/frame/3', { method: 'POST', body: headerPng() });
  assert.equal(outside.status, 400);
  const good = await fetch(server.url + '/frame/1', { method: 'POST', body: headerPng() });
  assert.equal(good.status, 200); assert.equal(imageInfo(path.join(dir, 'frame.00001.jpg')).width, 32);
});

test('plate resume identity tracks real source changes but excludes only this job generated assets', async (t) => {
  const { sourceState } = await import('../src/ue.mjs');
  const dir = temp(t), project = path.join(dir, 'Game.uproject'); fs.writeFileSync(project, '{}');
  const generated = path.join(dir, 'Content', 'HFilm'); fs.mkdirSync(generated, { recursive: true });
  const signature = () => sourceState(project, '/Game/HFilm', 'shot', '/Game/Main');
  const initial = signature();
  fs.writeFileSync(path.join(generated, 'LS_HFilm_shot.uasset'), 'generated');
  assert.equal(signature(), initial);
  fs.writeFileSync(path.join(generated, 'UserMaterial.uasset'), 'real input');
  assert.notEqual(signature(), initial, 'user assets in the generated folder still invalidate resume');
  const beforeConfig = signature(); fs.mkdirSync(path.join(dir, 'Config'));
  fs.writeFileSync(path.join(dir, 'Config', 'DefaultEngine.ini'), 'renderer setting');
  assert.notEqual(signature(), beforeConfig);
});

test('compressed WebP and embedded GLB textures expose decoded dimensions before allocation', (t) => {
  const dir = temp(t), webp = Buffer.alloc(30);
  webp.write('RIFF'); webp.writeUInt32LE(22, 4); webp.write('WEBP', 8); webp.write('VP8X', 12); webp.writeUInt32LE(10, 16);
  webp.writeUIntLE(16383, 24, 3); webp.writeUIntLE(8191, 27, 3);
  const image = path.join(dir, 'large.webp'); fs.writeFileSync(image, webp);
  assert.deepEqual([imageInfo(image).width, imageInfo(image).height], [16384, 8192]);
  const png = headerPng(8192, 8192), bin = Buffer.concat([png, Buffer.alloc((4 - png.length % 4) % 4)]);
  const doc = JSON.stringify({ asset: { version: '2.0' }, buffers: [{ byteLength: bin.length }], bufferViews: [{ buffer: 0, byteLength: png.length }], images: [{ bufferView: 0, mimeType: 'image/png' }] });
  const json = Buffer.from(doc.padEnd(Math.ceil(doc.length / 4) * 4));
  const head = Buffer.alloc(20); head.write('glTF'); head.writeUInt32LE(2, 4); head.writeUInt32LE(28 + json.length + bin.length, 8); head.writeUInt32LE(json.length, 12); head.writeUInt32LE(0x4e4f534a, 16);
  const binHeader = Buffer.alloc(8); binHeader.writeUInt32LE(bin.length); binHeader.writeUInt32LE(0x004e4942, 4);
  const model = path.join(dir, 'model.glb'); fs.writeFileSync(model, Buffer.concat([head, json, binHeader, bin]));
  assert.equal(modelInfo(model).embeddedImages[0].width, 8192);
});
