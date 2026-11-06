import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { makeProject } from './helpers.mjs';

it('respects explicit projects and refuses ambiguous or missing targets', (t) => {
  const a = makeProject('GameA');
  const b = makeProject('GameB', a.root);
  t.after(() => fs.rmSync(a.root, { recursive: true, force: true }));
  const script = `import { findProject } from ${JSON.stringify(new URL('../src/discovery.mjs', import.meta.url).href)};
    try { console.log(JSON.stringify({ project: findProject(JSON.parse(process.argv[1])) })); }
    catch (e) { console.log(JSON.stringify({ code: e.code, message: e.message })); }`;
  const resolve = (args) => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(args)], {
      env: { ...process.env, HOME: a.home, UE_AGENT_PROJECT: '' }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.equal(resolve({ cwd: a.root }).code, 'ambiguous_project');
  assert.equal(resolve({ cwd: a.root, explicit: a.project }).project, a.project);
  assert.equal(resolve({ cwd: a.root, explicit: b.dir }).project, b.project);
  assert.equal(resolve({ cwd: a.dir, explicit: 'Missing.uproject' }).code, 'project_not_found');
  fs.writeFileSync(path.join(a.dir, 'Other.uproject'), '{}');
  assert.equal(resolve({ cwd: a.dir }).code, 'ambiguous_project');
});
