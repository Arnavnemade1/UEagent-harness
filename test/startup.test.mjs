import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { it } from 'node:test';
import { ROOT } from './helpers.mjs';

it('does not start editor callbacks in standalone renders, servers or commandlets', () => {
  const script = `import os
import unreal
import ue_agent_bridge as bridge
for cmd in ['Project.uproject -game -MoviePipelineConfig=/Game/Preset', '-GAME', '-server', '-run=pythonscript', '-nullrhi -unattended']:
    unreal.SystemLibrary.get_command_line = lambda: cmd
    assert bridge._is_commandlet(), cmd
    assert bridge.start() is None, cmd
for cmd in ['Project.uproject', '"/Projects/my-game/Test.uproject" -log', '-gameplaydebugger', '-nullrhi']:
    unreal.SystemLibrary.get_command_line = lambda: cmd
    assert not bridge._is_commandlet(), cmd
os.environ['UE_AGENT_BRIDGE_DISABLE'] = 'TRUE'
assert bridge.start() is None
`;
  const result = spawnSync('python3', ['-c', script], {
    env: { ...process.env, PYTHONPATH: [path.join(ROOT, 'test/fake'), path.join(ROOT, 'plugin/UEAgentBridge/Content/Python')].join(path.delimiter) },
    encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
});
