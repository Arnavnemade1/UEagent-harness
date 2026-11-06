import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { it } from 'node:test';
import { callTool } from '../src/tools.mjs';
import { makeProject, ROOT } from './helpers.mjs';

it('captures exact request-time actor paths and avoids editor selection during PIE', (t) => {
  const proj = makeProject('ContextGame');
  t.after(() => fs.rmSync(proj.root, { recursive: true, force: true }));
  const script = `import json, sys
from types import SimpleNamespace
import unreal
unreal._fake_init(sys.argv[1], "ContextGame")
from fake_editor import seed
seed()
from ue_agent_bridge.menu import AskRunner
from ue_agent_bridge import compat
actor = unreal._S["world"].actors[1]
unreal._S["selected"] = [actor]
runner = AskRunner(SimpleNamespace(paths={"project_file": sys.argv[2]}, rev=42))
context = json.loads(runner._context().splitlines()[1])
assert context["revision"] == 42
assert context["selected_actors"][0]["path"] == actor.get_path_name()
assert context["selected_actor_count"] == 1
compat.is_pie = lambda: True
def forbidden():
    raise AssertionError("selection queried during PIE")
compat.selected_actors = forbidden
context = json.loads(runner._context().splitlines()[1])
assert "context_error" not in context, context
assert "selection_note" in context
assert "selected_actors" not in context
`;
  const result = spawnSync('python3', ['-c', script, proj.dir, proj.project], {
    env: { ...process.env, HOME: proj.home, PYTHONPATH: [path.join(ROOT, 'test/fake'), path.join(ROOT, 'plugin/UEAgentBridge/Content/Python')].join(path.delimiter) },
    encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
});

it('rejects inherited object properties as unknown tool names', async () => {
  for (const name of ['constructor', 'toString', '__proto__']) {
    const result = await callTool(null, name);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /unknown_tool/);
  }
});
