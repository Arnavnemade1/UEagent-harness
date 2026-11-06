import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { describe, it } from 'node:test';
import { BridgeClient } from '../src/bridge.mjs';
import { makeProject } from './helpers.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

async function within(promise, ms = 1000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('operation did not settle promptly')), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

/** A private TCP peer: these tests never discover or contact a real editor. */
async function transport(t, onMessage) {
  const proj = makeProject('TransportGame');
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (message.method === 'hello') {
          socket.write(JSON.stringify({ id: message.id, ok: true, result: { pid: process.pid, started: 1, rev: 0, client_id: 1 } }) + '\n');
        } else onMessage?.(socket, message);
      }
    });
  });
  const client = new BridgeClient({ project: proj.project, subscribe: false });
  t.after(async () => {
    client.close();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(proj.root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const dir = path.join(proj.dir, 'Saved', 'UEAgentBridge');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'bridge.json'), JSON.stringify({ pid: process.pid, host: '127.0.0.1', port: server.address().port, token: 'test-token' }));
  return client;
}

describe('bridge connection lifecycle', () => {
  it('settles pending calls immediately when explicitly closed', async (t) => {
    const seen = deferred();
    const client = await transport(t, (_socket, message) => { if (message.method === 'call') seen.resolve(); });
    const pending = client.call('slow_op');
    const rejected = assert.rejects(pending, { code: 'disconnected' });
    await within(seen.promise);
    client.close();
    await within(rejected);
    assert.equal(client.pending.size, 0);
    assert.equal(client.connected, false);
  });

  it('cannot reconnect after being closed', async (t) => {
    const client = await transport(t);
    client.close();
    await assert.rejects(client.connect(), { code: 'closed' });
    assert.equal(client.connected, false);
  });

  it('does not resurrect a connection closed while TCP was connecting', async (t) => {
    const client = await transport(t);
    let connects = 0;
    client.on('connect', () => { connects++; });
    const connecting = client.connect();
    const rejected = assert.rejects(connecting, { code: 'closed' });
    client.close();
    await within(rejected);
    assert.equal(connects, 0);
    assert.equal(client.connected, false);
    assert.equal(client.pending.size, 0);
  });

  it('rejects a lost operation without replaying it, then reconnects for the next call', async (t) => {
    let calls = 0;
    const client = await transport(t, (socket, message) => {
      if (message.method !== 'call') return;
      calls++;
      if (calls === 1) socket.destroy();
      else socket.write(JSON.stringify({ id: message.id, ok: true, result: { recovered: true } }) + '\n');
    });
    await assert.rejects(client.call('edit_actors'), { code: 'disconnected' });
    const result = await client.call('status');
    assert.deepEqual(result.result, { recovered: true });
    assert.equal(calls, 2);
  });
});

