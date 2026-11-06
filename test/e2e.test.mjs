import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { BridgeClient } from '../src/bridge.mjs';
import { makeProject, pct, startFakeEditor, startMcp } from './helpers.mjs';

const proj = makeProject();
let editor;
let claude;
let codex;

before(async () => {
  editor = await startFakeEditor(proj, { fps: 120 });
  claude = startMcp(proj, { client: 'claude-code' });
  codex = startMcp(proj, { client: 'codex-mcp-client' });
});

after(async () => {
  await claude?.close();
  await codex?.close();
  await editor?.stop();
  fs.rmSync(proj.root, { recursive: true, force: true });
});

describe('MCP protocol', () => {
  it('initializes with instructions and negotiates the protocol version', async () => {
    const r = await claude.init();
    assert.equal(r.protocolVersion, '2025-06-18');
    assert.equal(r.serverInfo.name, 'unreal');
    assert.match(r.instructions, /ue_status/);
    await codex.init();
  });

  it('lists tools with schemas both Claude Code and Codex accept', async () => {
    const r = (await claude.request('tools/list')).result;
    assert.ok(r.tools.length >= 18);
    const walk = (schema, where) => {
      assert.ok(schema.type, `${where} has no type`);
      assert.ok(!Array.isArray(schema.type), `${where} uses a union type (Codex-unsafe)`);
      for (const [k, v] of Object.entries(schema.properties || {})) walk(v, `${where}.${k}`);
      if (schema.items) walk(schema.items, `${where}[]`);
    };
    for (const t of r.tools) {
      assert.match(t.name, /^ue_[a-z_]+$/);
      assert.ok(t.description.length > 40, t.name);
      walk(t.inputSchema, t.name);
    }
  });

  it('answers ping and rejects unknown methods', async () => {
    assert.deepEqual((await claude.request('ping')).result, {});
    assert.equal((await claude.request('bogus/method')).error.code, -32601);
  });
});

describe('editor tools', () => {
  it('ue_status returns live editor context', async () => {
    await codex.tool('ue_find_actors', { limit: 1 }); // codex connects in the background; make sure it has
    const r = await claude.tool('ue_status');
    assert.equal(r.isError, undefined);
    assert.equal(r.json.editor, 'connected');
    assert.equal(r.json.level, '/Game/Maps/Main.Main');
    assert.ok(r.json.agents.includes('claude-code'));
    assert.ok(r.json.agents.includes('codex'));
  });

  it('spawns and edits actors in one verified batch with $refs', async () => {
    const r = await claude.tool('ue_edit_actors', {
      ops: [
        { op: 'spawn', mesh: 'cube', label: 'Crate', location: [100, 200, 50], rotation: [0, 45, 0], scale: 2 },
        { op: 'spawn', class: 'PointLight', label: 'CrateLight', location: [100, 200, 300], properties: { 'LightComponent.intensity': 8000, 'LightComponent.light_color': [1, 0.5, 0.2] } },
        { op: 'attach', target: '$1', parent: '$0' },
        { op: 'set', target: 'Crate', offset: [0, 0, 10], properties: { 'StaticMeshComponent.cast_shadow': false, mobility: 'Movable' } },
      ],
    });
    assert.equal(r.isError, undefined, r.text.join('\n'));
    const [spawn, light, attach, set] = r.json.results;
    assert.deepEqual(spawn.actor.location, [100, 200, 50]);
    assert.deepEqual(spawn.actor.rotation, [0, 45, 0]);
    assert.deepEqual(spawn.actor.scale, [2, 2, 2]);
    assert.equal(light.actor.class, 'PointLight');
    assert.equal(attach.parent, 'Crate');
    assert.deepEqual(set.actors[0].location, [100, 200, 60]);
    assert.equal(set.actors[0].properties['StaticMeshComponent.cast_shadow'], false);
    assert.equal(set.actors[0].properties.mobility, 'MOVABLE');
    const found = await claude.tool('ue_find_actors', { name: 'Crate*', detail: true });
    assert.equal(found.json.total, 2);
    assert.equal(found.json.actors.find((a) => a.label === 'CrateLight').attached_to, 'Crate');
  });

  it('rolls back the whole batch when an op fails', async () => {
    const r = await claude.tool('ue_edit_actors', {
      ops: [
        { op: 'spawn', mesh: 'sphere', label: 'Ghost' },
        { op: 'set', target: 'DoesNotExist', location: [0, 0, 0] },
      ],
    });
    assert.equal(r.isError, true);
    assert.match(r.text[0], /not_found/);
    assert.match(r.text[0], /rolled_back/);
    const found = await claude.tool('ue_find_actors', { name: 'Ghost' });
    assert.equal(found.json.total, 0);
  });

  it('suggests close matches and reports typo\'d arguments', async () => {
    const r = await claude.tool('ue_edit_actors', { ops: [{ op: 'set', target: 'Crat', location: [0, 0, 0] }] });
    assert.match(r.text[0], /"suggestions":\["Crate"/);
    const w = await claude.tool('ue_find_actors', { name: 'Cube', limt: 3 });
    assert.match(w.text[0], /unknown argument 'limt'/);
  });

  it('runs Python with REPL semantics, persistent state and readable errors', async () => {
    let r = await claude.tool('ue_python', { code: 'n = len(actors())\nprint("count", n)\nn * 2' });
    assert.match(r.json.stdout, /count \d+/);
    assert.equal(typeof r.json.result, 'number');
    r = await claude.tool('ue_python', { code: 'n + 1' });
    assert.equal(typeof r.json.result, 'number');
    r = await claude.tool('ue_python', { code: 'x = 1\n1/0' });
    assert.equal(r.isError, true);
    assert.match(r.text[0], /ZeroDivisionError/);
    assert.match(r.text[0], /line 2/);
    r = await claude.tool('ue_python', { code: 'def f(): return 1\nwhile True: f()', timeout_s: 1 });
    assert.equal(r.isError, true);
    assert.match(r.text[0], /TimeoutError/);
    r = await claude.tool('ue_python', { code: 'actor("Cube").get_actor_location()' });
    assert.deepEqual(r.json.result, [0, 0, 50]);
  });

  it('undoes an agent transaction', async () => {
    await claude.tool('ue_edit_actors', { ops: [{ op: 'spawn', mesh: 'cone', label: 'Temp' }] });
    assert.equal((await claude.tool('ue_find_actors', { name: 'Temp' })).json.total, 1);
    const u = await claude.tool('ue_undo', {});
    assert.equal(u.json.done, 'undo');
    assert.equal((await claude.tool('ue_find_actors', { name: 'Temp' })).json.total, 0);
  });

  it('returns a viewport screenshot as an image', async () => {
    const out = path.join(proj.root, 'shot.png');
    const r = await claude.tool('ue_screenshot', { width: 320, height: 180, target: 'Crate', save_to: out });
    assert.equal(r.isError, undefined, r.text.join('\n'));
    assert.equal(r.images.length, 1);
    assert.equal(r.images[0].mimeType, 'image/png');
    assert.equal(Buffer.from(r.images[0].data, 'base64').subarray(1, 4).toString(), 'PNG');
    assert.ok(fs.existsSync(out));
    assert.ok(r.json.camera.location);
    assert.ok(Math.abs(r.json.camera.rotation[1]) <= 180, 'yaw normalised');
  });

  it('creates materials, instances and guards deletes of referenced assets', async () => {
    const r = await claude.tool('ue_edit_assets', {
      ops: [
        { op: 'pbr_material', path: '/Game/Materials/M_Rust', base_color: [0.6, 0.25, 0.1], roughness: 0.8, metallic: 0.3 },
        { op: 'create', type: 'MaterialInstance', path: '/Game/Materials/MI_Rust', parent: '/Game/Materials/M_Rust', parameters: { scalar: { Roughness: 0.5 } } },
        { op: 'create', type: 'Folder', path: '/Game/Props' },
      ],
    });
    assert.equal(r.isError, undefined, r.text.join('\n'));
    assert.equal(r.json.results[0].expressions, 3);
    assert.ok(fs.existsSync(path.join(proj.dir, 'Content', 'Materials', 'M_Rust.uasset')), 'saved to disk');
    const del = await claude.tool('ue_edit_assets', { ops: [{ op: 'delete', path: '/Game/Materials/M_Rust' }] });
    assert.equal(del.isError, true);
    assert.match(del.text[0], /referenced/);
    const find = await claude.tool('ue_find_assets', { path: '/Game/Materials', class: 'MaterialInterface', include: ['dependencies'] });
    assert.equal(find.json.total, 2);
    assert.deepEqual(find.json.assets.find((a) => a.path.endsWith('MI_Rust')).dependencies, ['/Game/Materials/M_Rust']);
    const apply = await claude.tool('ue_edit_actors', { ops: [{ op: 'set', target: 'Crate', material: '/Game/Materials/MI_Rust' }] });
    assert.equal(apply.isError, undefined, apply.text.join('\n'));
  });

  it('creates a blueprint with components and variables', async () => {
    const r = await claude.tool('ue_blueprint', {
      path: '/Game/Blueprints/BP_Door',
      create: { parent: 'Actor' },
      ops: [
        { op: 'add_component', class: 'StaticMeshComponent', name: 'DoorMesh', properties: { static_mesh: '/Engine/BasicShapes/Cube' } },
        { op: 'add_variable', name: 'OpenAngle', type: 'float' },
      ],
    });
    assert.equal(r.isError, undefined, r.text.join('\n'));
    assert.equal(r.json.created, true);
    assert.ok(r.json.components.some((c) => c.name === 'DoorMesh'));
    const spawn = await claude.tool('ue_edit_actors', { ops: [{ op: 'spawn', class: '/Game/Blueprints/BP_Door', label: 'Door1' }] });
    assert.equal(spawn.json.results[0].actor.class, 'BP_Door_C');
    const byClass = await claude.tool('ue_find_actors', { class: '/Game/Blueprints/BP_Door' });
    assert.equal(byClass.isError, undefined, byClass.text.join('\n'));
    assert.deepEqual(byClass.json.actors.map((a) => a.label), ['Door1']);
  });

  it('imports files and raw .uasset files into Content', async () => {
    const src = path.join(proj.root, 'incoming');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'T_Bricks.png'), 'png');
    fs.writeFileSync(path.join(src, 'SM_Rock.uasset'), 'uasset');
    const r = await claude.tool('ue_import', { files: [src], destination: '/Game/Imported' });
    assert.equal(r.isError, undefined, r.text.join('\n'));
    assert.equal(r.json.imported, 2);
    const assets = r.json.results.flatMap((x) => x.assets);
    assert.ok(assets.includes('/Game/Imported/T_Bricks'));
    assert.ok(assets.includes('/Game/Imported/SM_Rock'));
    const exp = await claude.tool('ue_export', { assets: ['/Game/Imported/T_Bricks'], directory: path.join(proj.root, 'out') });
    assert.ok(fs.existsSync(path.join(proj.root, 'out', 'T_Bricks.png')));
    assert.equal(exp.json.results[0].ok, true);
  });

  it('inspects actors and components', async () => {
    const r = await claude.tool('ue_inspect', { target: 'KeyLight', filter: 'intens', component: 'LightComponent' });
    assert.equal(r.json.properties[0].name, 'intensity');
    const one = await claude.tool('ue_inspect', { target: 'KeyLight', property: 'LightComponent.intensity' });
    assert.equal(one.json.value, 5000);
  });

  it('plays in editor and reports log errors from the run', async () => {
    const r = await claude.tool('ue_play', { action: 'start', duration_s: 0.3 });
    assert.equal(r.isError, undefined, r.text.join('\n'));
    assert.equal(r.json.state, 'stopped');
    assert.ok(r.json.log_during_play.lines.some((l) => /Accessed None/.test(l)));
    assert.ok(!r.json.log_during_play.lines.some((l) => /currently in a play mode/.test(l)), 'bridge must not spam PIE errors');
  });

  it('reads the game world during play and refuses level edits until it stops', async () => {
    await claude.tool('ue_play', { action: 'start' });
    const found = await claude.tool('ue_find_actors', { name: 'Cube' });
    assert.equal(found.json.total, 1, found.text.join('\n'));
    const edit = await claude.tool('ue_edit_actors', { ops: [{ op: 'spawn', mesh: 'cube' }] });
    assert.match(edit.text[0], /pie_active/);
    const st = await claude.tool('ue_status');
    assert.match(JSON.stringify(st.json.selection), /unavailable during play/);
    await claude.tool('ue_play', { action: 'stop' });
  });

  it('reads filtered logs incrementally', async () => {
    await claude.tool('ue_logs', { severity: 'error', since: 'last' });
    await editor.user('error Blueprint BP_Door has a broken node');
    const r = await claude.tool('ue_logs', { severity: 'error', since: 'last' });
    assert.equal(r.json.matched, 1);
    assert.match(r.json.lines[0], /\[error\] LogBlueprint: Blueprint BP_Door/);
  });

  it('saves everything and reports what was saved', async () => {
    const r = await claude.tool('ue_save', {});
    assert.ok(r.json.saved.includes('/Game/Maps/Main'));
    assert.equal(r.json.still_unsaved.length, 0);
  });
});

describe('sync between the editor and agents', () => {
  it('tells an agent what the user did in the editor', async () => {
    await claude.tool('ue_status');
    await editor.user('select Cube,KeyLight');
    await editor.user('move Cube 10 20 30');
    await new Promise((r) => setTimeout(r, 1300));
    const r = await claude.tool('ue_find_actors', { name: 'Floor' });
    const digest = r.text.find((t) => t.startsWith('[engine sync'));
    assert.ok(digest, `no digest in ${r.text.join('\n')}`);
    assert.match(digest, /user selection → Cube \(StaticMeshActor\), KeyLight \(PointLight\)/);
    assert.match(digest, /edited in editor \(unsaved\): \/Game\/Maps\/Main/);
  });

  it('tells one agent what another agent changed (and not its own changes)', async () => {
    await claude.tool('ue_status');
    await codex.tool('ue_edit_actors', { ops: [{ op: 'spawn', class: 'CameraActor', label: 'ShotCam' }] });
    const r = await claude.tool('ue_find_actors', { name: 'ShotCam' });
    const digest = r.text.find((t) => t.startsWith('[engine sync')) || '';
    assert.match(digest, /codex: spawn x1/);
    const own = await codex.tool('ue_find_actors', { name: 'ShotCam' });
    assert.ok(!own.text.some((t) => /codex: spawn/.test(t)), 'agent should not be told about its own change');
  });

  it('long-polls for the next user change with ue_sync', async () => {
    const base = await claude.tool('ue_sync', {});
    const waiting = claude.tool('ue_sync', { since: base.json.rev, wait_s: 10 });
    await new Promise((r) => setTimeout(r, 200));
    await editor.user('select Floor');
    const r = await waiting;
    assert.ok(r.json.changes.some((c) => c.kind === 'selection' && c.actors[0].startsWith('Floor')));
  });

  it('reports disk changes to C++ sources', async () => {
    fs.mkdirSync(path.join(proj.dir, 'Source', 'FakeGame'), { recursive: true });
    await new Promise((r) => setTimeout(r, 300));
    await claude.tool('ue_status');
    fs.writeFileSync(path.join(proj.dir, 'Source', 'FakeGame', 'Door.cpp'), '// door');
    await new Promise((r) => setTimeout(r, 1200));
    const st = await claude.tool('ue_status');
    assert.equal(st.json.cpp?.needs_build, true, JSON.stringify(st.json.cpp));
  });
});

describe('bridge robustness and speed', () => {
  it('rejects clients without the token', async () => {
    const s = net.createConnection({ port: editor.port, host: '127.0.0.1' });
    await new Promise((r) => s.once('connect', r));
    s.write(JSON.stringify({ id: 1, method: 'hello', params: { token: 'nope' } }) + '\n');
    const reply = await new Promise((r) => s.once('data', (d) => r(JSON.parse(String(d).split('\n')[0]))));
    assert.equal(reply.error.code, 'unauthorized');
    await new Promise((r) => s.once('close', r));
  });

  it('keeps round trips within about one editor frame and pipelines bursts', async () => {
    const c = new BridgeClient({ project: proj.project, clientName: 'bench', subscribe: false });
    const prevHome = process.env.HOME;
    process.env.HOME = proj.home;
    try {
      await c.connect();
      const lat = [];
      for (let i = 0; i < 100; i++) lat.push(await c.ping());
      const t = performance.now();
      await Promise.all(Array.from({ length: 200 }, () => c.call('find_actors', { limit: 5 })));
      const burst = performance.now() - t;
      console.log(`    latency @120fps: p50 ${pct(lat, 0.5).toFixed(2)} ms, p95 ${pct(lat, 0.95).toFixed(2)} ms; 200 pipelined calls in ${burst.toFixed(0)} ms`);
      assert.ok(pct(lat, 0.5) < 20, 'p50 should be about one 120fps frame');
      assert.ok(burst < 2000);
    } finally {
      c.close();
      process.env.HOME = prevHome;
    }
  });

  it('unthrottles the editor while agents are active (class hidden from Python, as in UE 5.8)', async () => {
    const r = await claude.tool('ue_python', { code: 'unreal.get_default_object(unreal.load_class(None, "/Script/UnrealEd.EditorPerformanceSettings")).get_editor_property("bThrottleCPUWhenNotForeground")' });
    assert.equal(r.json.result, false);
    const st = await claude.tool('ue_status');
    assert.deepEqual(st.json.background_throttle, { controlled: true, disabled_for_agents: true });
  });

  it('hot-reloads the plugin code and agents reconnect on their own', async () => {
    const r = await codex.tool('ue_python', { code: 'import ue_agent_bridge; ue_agent_bridge.restart()' });
    assert.equal(r.isError, undefined, r.text.join('\n'));
    await new Promise((res) => setTimeout(res, 600));
    const after = await claude.tool('ue_find_actors', { name: 'Cube' });
    assert.equal(after.json.total, 1, after.text.join('\n'));
    assert.equal((await codex.tool('ue_status')).json.editor, 'connected');
  });

  it('reconnects transparently after the editor restarts', async () => {
    await editor.stop();
    const down = await claude.tool('ue_status');
    assert.equal(down.json.editor, 'not running');
    editor = await startFakeEditor(proj, { fps: 120 });
    const up = await claude.tool('ue_status');
    assert.equal(up.json.editor, 'connected', up.text.join('\n'));
    const r = await claude.tool('ue_find_actors', { name: 'Cube' });
    assert.equal(r.json.total, 1);
  });
});

describe('journal hygiene', () => {
  it('does not report failed read-only Python as an engine change', async () => {
    await codex.tool('ue_status');
    const bad = await claude.tool('ue_python', { code: 'actor("Cube").no_such_method()' });
    assert.equal(bad.isError, true);
    const r = await codex.tool('ue_find_actors', { name: 'Cube' });
    assert.ok(!r.text.some((t) => /claude-code: Python/.test(t)), r.text.join('\n'));
  });
});
