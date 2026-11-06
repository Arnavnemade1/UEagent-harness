import assert from 'node:assert/strict';
import fs from 'node:fs';
import { it } from 'node:test';
import { cameraAxes, framing, ObservationStore } from '../src/scene-intelligence.mjs';
import { makeProject, startFakeEditor, startMcp } from './helpers.mjs';

const camera = { location: [0, 0, 0], rotation: [0, 0, 0], projection: 'perspective', hfov: 90, aspect: 1 };
const actor = (center, extent = [10, 10, 10]) => ({ bounds: { center, extent } });

it('classifies camera framing conservatively, including behind-camera and near-plane crossings', () => {
  for (const [center, expected] of [[[1000, 0, 0], 'inside'], [[-1000, 0, 0], 'outside'], [[1000, 2000, 0], 'outside'], [[1000, 0, 2000], 'outside'], [[1000, 1000, 0], 'intersects'], [[0, 0, 0], 'intersects']]) {
    const result = framing(actor(center), camera);
    assert.equal(result.state, expected, JSON.stringify(center));
    assert.equal(result.occlusion, 'unknown');
  }
  assert.deepEqual(framing(actor([1000, 0, 0]), camera).center_uv, [0.5, 0.5]);
  assert.equal(framing(actor([1000, 1000, 0], [0, 0, 0]), camera).state, 'inside', 'frustum boundary tolerates floating-point roundoff');
  assert.equal(framing(actor([0, 1000, 0]), { ...camera, rotation: [0, 90, 0] }).state, 'inside');
  assert.equal(framing(actor([0, 0, 1000]), { ...camera, rotation: [90, 0, 0] }).state, 'inside');
  assert.equal(framing(actor([1000, 0, 0]), { ...camera, hfov: null }).state, 'unknown');
  assert.equal(framing(actor([1000, 0, 0]), { ...camera, projection: 'orthographic' }).state, 'unknown');
  assert.equal(framing(actor([1000, 0, 0], [-10, 10, 10]), camera).state, 'unknown');
  const axes = cameraAxes([35, 121, 67]);
  for (const a of axes) assert.ok(Math.abs(Math.hypot(...a) - 1) < 1e-12);
  assert.ok(Math.abs(axes[0].reduce((s, n, i) => s + n * axes[1][i], 0)) < 1e-12);
  // A 90-degree camera roll moves a world-up subject toward screen-left.
  const rolled = framing(actor([1000, 0, 300]), { ...camera, rotation: [0, 0, 90] });
  assert.ok(rolled.center_uv[0] < 0.5);
  assert.ok(Math.abs(rolled.center_uv[1] - 0.5) < 1e-12);
});

it('bounds the snapshot cache by bytes and count and isolates stored evidence from mutation', () => {
  const store = new ObservationStore({ maxCount: 2, maxBytes: 2000 });
  const raw = { actors: [], coverage: { returned: 0, complete: true } };
  const first = store.add(raw), second = store.add(raw);
  first.coverage.complete = false;
  assert.equal(store.get(first.id).coverage.complete, true);
  store.add(raw);
  assert.throws(() => store.get(first.id), { code: 'snapshot_unavailable' });
  assert.ok(store.get(second.id));
  store.add({ ...raw, metadata: 'x'.repeat(1300) });
  assert.ok(store.bytes <= 2000);
  assert.ok(store.entries.size <= 2);
  store.clear();
  assert.equal(store.bytes, 0);
  assert.throws(() => store.get(second.id), { code: 'snapshot_unavailable' });
});

it('keeps large Unicode observations valid JSON and explicitly marks partial coverage', () => {
  const store = new ObservationStore();
  const actors = Array.from({ length: 64 }, () => ({ ...actor([100, 0, 0]), label: '球'.repeat(400) }));
  const snapshot = store.add({ camera, actors, coverage: { returned: 64, matched: 64, complete: true } });
  assert.ok(snapshot.actors.length < 64);
  assert.equal(snapshot.coverage.complete, false);
  assert.equal(snapshot.coverage.returned, snapshot.actors.length);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= 56000);
});

it('captures selective, read-only observations through the real MCP and bridge transport', async (t) => {
  const proj = makeProject('ObserveGame');
  let editor, mcp;
  t.after(async () => { await mcp?.close(); await editor?.stop(); fs.rmSync(proj.root, { recursive: true, force: true }); });
  editor = await startFakeEditor(proj);
  mcp = startMcp(proj);
  await mcp.init();
  const observed = await mcp.tool('ue_observe', { targets: ['Cube', 'KeyLight', 'Missing'], components: true });
  assert.equal(observed.isError, undefined, observed.text.join('\n'));
  const snapshot = observed.json;
  assert.equal(snapshot.actors.length, 2);
  assert.equal(snapshot.coverage.complete, true);
  assert.deepEqual(snapshot.missing_targets, ['Missing']);
  const cube = snapshot.actors.find((a) => a.label === 'Cube');
  assert.match(cube.path, /PersistentLevel/);
  assert.equal(cube.components[0].mesh, '/Engine/BasicShapes/Cube.Cube');
  assert.equal(cube.framing.state, 'unknown');
  assert.equal(snapshot.actors.find((a) => a.label === 'KeyLight').components[0].light.intensity, 5000);
  const again = await mcp.tool('ue_observe', { targets: [cube.path], projection: { hfov: 90, aspect: 16 / 9 } });
  assert.equal(again.json.revision, snapshot.revision, 'observation must not mutate editor revision');
  assert.notEqual(again.json.actors[0].framing.state, 'unknown');
  const limited = await mcp.tool('ue_observe', { limit: 1 });
  assert.equal(limited.json.coverage.complete, false);
  assert.equal(limited.json.coverage.matched, 4);
  for (const args of [{ limit: 1000 }, { limit: 1.5 }, { targets: ['Cube*'] }, { filter: { selected: 'yes' } }, { projection: { hfov: 0, aspect: 1 } }]) {
    const invalid = await mcp.tool('ue_observe', args);
    assert.equal(invalid.isError, true, JSON.stringify(args));
    assert.match(invalid.text[0], /bad_args/);
  }
});
