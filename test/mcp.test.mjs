import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { CLI, makeProject } from './helpers.mjs';

function mcpInput(t, messages) {
  const proj = makeProject('ProtocolGame');
  t.after(() => fs.rmSync(proj.root, { recursive: true, force: true }));
  const run = spawnSync(process.execPath, [CLI, 'mcp'], {
    env: { ...process.env, HOME: proj.home, UE_AGENT_PROJECT: proj.project },
    input: messages.map((message) => JSON.stringify(message)).join('\n') + '\n',
    encoding: 'utf8', timeout: 5000,
  });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

const request = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });

describe('MCP input resilience', () => {
  it('survives malformed envelopes and still answers the next request', (t) => {
    const output = mcpInput(t, [null, 42, 'bad', {}, [], request('alive', 'ping')]);
    assert.equal(output.filter((message) => message.error?.code === -32600).length, 5);
    assert.deepEqual(output.find((message) => message.id === 'alive').result, {});
  });

  it('rejects invalid parameter shapes before starting a tool or session', (t) => {
    const output = mcpInput(t, [
      request(1, 'initialize', null),
      request(2, 'tools/call', []),
      request(3, 'tools/call', { name: 'ue_status', arguments: 'invalid' }),
      request(4, 'tools/call', { arguments: {} }),
      request(5, 'tools/call', { name: 'ue_status', _meta: { progressToken: {} } }),
      request(6, 'ping'),
    ]);
    assert.deepEqual(output.filter((message) => message.error).map((message) => [message.id, message.error.code]), [[1, -32602], [2, -32602], [3, -32602], [4, -32602], [5, -32602]]);
    assert.deepEqual(output.find((message) => message.id === 6).result, {});
  });

  it('does not respond to or execute request methods sent as notifications', (t) => {
    const output = mcpInput(t, [
      { jsonrpc: '2.0', method: 'ping' },
      { jsonrpc: '2.0', method: 'tools/list' },
      { jsonrpc: '2.0', method: 'tools/call', params: { name: 'ue_status' } },
      { jsonrpc: '2.0', method: 'notifications/initialized', params: null },
      request(1, 'ping'),
    ]);
    assert.deepEqual(output, [{ jsonrpc: '2.0', id: 1, result: {} }]);
  });
});
