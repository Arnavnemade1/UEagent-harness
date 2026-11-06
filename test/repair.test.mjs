import assert from 'node:assert/strict';
import fs from 'node:fs';
import { it } from 'node:test';
import { makeProject, startFakeEditor, startMcp } from './helpers.mjs';

it('closes the observe–verify–repair loop through MCP and refuses stale or coupled repairs', async (t) => {
  const proj = makeProject('RepairGame');
  let editor, mcp;
  t.after(async () => { await mcp?.close(); await editor?.stop(); fs.rmSync(proj.root, { recursive: true, force: true }); });
  editor = await startFakeEditor(proj);
  mcp = startMcp(proj);
  await mcp.init();
  const capture = async () => {
    const r = await mcp.tool('ue_observe', { targets: ['Cube'] });
    assert.equal(r.isError, undefined, r.text.join('\n'));
    return r.json;
  };
  const spec = { request: 'Place the cube at [100,200,50] cm.', criteria: [
    { id: 'place-cube', type: 'location', actor: 'Cube', expected: [100, 200, 50], tolerance_cm: 0.01, reason: 'Exact user-requested placement.' },
  ] };
  const before = await capture();
  const failed = await mcp.tool('ue_verify', { snapshot: before.id, ...spec });
  assert.equal(failed.json.status, 'fail');
  assert.equal(failed.json.checks[0].repair.target, before.actors[0].path);
  const repaired = await mcp.tool('ue_repair', { snapshot: before.id, ...spec });
  assert.equal(repaired.isError, undefined, repaired.text.join('\n'));
  assert.deepEqual(repaired.json.repaired[0].location, [100, 200, 50]);
  const after = await capture();
  const passed = await mcp.tool('ue_verify', { snapshot: after.id, ...spec });
  assert.equal(passed.json.status, 'pass');
  const replay = await mcp.tool('ue_repair', { snapshot: before.id, ...spec });
  assert.equal(replay.isError, true);
  assert.match(replay.text[0], /stale_observation/);
  await mcp.tool('ue_undo', { count: 1 });
  assert.deepEqual((await capture()).actors[0].location, [0, 0, 50], 'one undo restores the repair');

  const old = await capture();
  await editor.user('move Cube 90 0 50');
  const stale = await mcp.tool('ue_repair', { snapshot: old.id, ...spec });
  assert.equal(stale.isError, true);
  assert.match(stale.text[0], /stale_observation/);
  assert.deepEqual((await capture()).actors[0].location, [90, 0, 50], 'user edit is preserved');

  await mcp.tool('ue_edit_actors', { ops: [{ op: 'attach', target: 'KeyLight', parent: 'Cube' }] });
  const parent = await capture();
  const coupled = await mcp.tool('ue_repair', { snapshot: parent.id, ...spec });
  assert.equal(coupled.isError, true);
  assert.match(coupled.text[0], /coupled_actors/);
  assert.deepEqual((await capture()).actors[0].location, [90, 0, 50]);

  // Direct bridge guard rejects a restarted instance even if revision/scene
  // happen to match. Exercise via Python to avoid needing a second editor.
  const guard = await mcp.tool('ue_python', { code: `from ue_agent_bridge import get_server\nfrom ue_agent_bridge.registry import CallContext, Args, BridgeError\nfrom ue_agent_bridge.ops_repair import repair_locations\nsrv = get_server()\ntry:\n    repair_locations(CallContext(srv, None, 'repair_locations'), Args({'bridge_instance': {'pid': 0, 'started': 0}}))\nexcept BridgeError as exc:\n    print(exc.code)` });
  assert.match(guard.text.join('\n'), /stale_observation/);
});

it('validates all targets before editing and rolls back engine failures without partial changes', async (t) => {
  const proj = makeProject('RollbackGame');
  let editor, mcp;
  t.after(async () => { await mcp?.close(); await editor?.stop(); fs.rmSync(proj.root, { recursive: true, force: true }); });
  editor = await startFakeEditor(proj); mcp = startMcp(proj); await mcp.init();
  // Simulate the engine refusing the second set_actor_location. This tests the
  // actual transaction/undo bridge path, not a JS copy of the repair logic.
  const inject = await mcp.tool('ue_python', { code: `light = actor('KeyLight')\nlight.set_actor_location = lambda *args: False\n'fault injected'` });
  assert.equal(inject.isError, undefined, inject.text.join('\n'));
  const observed = await mcp.tool('ue_observe', { targets: ['Cube', 'KeyLight'] });
  const spec = { snapshot: observed.json.id, request: 'Place two props.', criteria: ['Cube', 'KeyLight'].map((name) => ({
    id: name, type: 'location', actor: name, expected: [400, 400, 400], tolerance_cm: 0, reason: 'Requested prop position.',
  })) };
  const result = await mcp.tool('ue_repair', spec);
  assert.equal(result.isError, true);
  assert.match(result.text.join('\n'), /repair_failed/);
  assert.match(result.text.join('\n'), /rolled_back/);
  const restored = await mcp.tool('ue_observe', { targets: ['Cube', 'KeyLight'] });
  assert.deepEqual(restored.json.actors.map((a) => a.location), observed.json.actors.map((a) => a.location));
});
