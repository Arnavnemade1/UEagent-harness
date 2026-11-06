import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
export const CLI = path.join(ROOT, 'bin', 'ue-agent.mjs');
const FAKE = path.join(HERE, 'fake', 'fake_editor.py');

export function makeProject(name = 'FakeGame', root = fs.mkdtempSync(path.join(os.tmpdir(), 'ueah-'))) {
  const home = path.join(root, 'home');
  const dir = path.join(root, name);
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  const project = path.join(dir, `${name}.uproject`);
  fs.writeFileSync(project, JSON.stringify({ FileVersion: 3, EngineAssociation: '5.6', Category: '', Description: '', Plugins: [{ Name: 'ModelingToolsEditorMode', Enabled: true }] }, null, '\t'));
  return { root, home, dir, project, name };
}

/** Run the real bridge plugin against the fake `unreal` module, ticking at `fps`. */
export async function startFakeEditor(proj, { fps = 120, env = {} } = {}) {
  const child = spawn('python3', [FAKE, proj.dir, '--fps', String(fps), '--name', proj.name], {
    env: { ...process.env, HOME: proj.home, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  const acks = [];
  child.stderr.on('data', (d) => { err += d; });
  const ready = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`fake editor did not start: ${err}`)), 10000);
    child.stdout.on('data', (d) => {
      out += d;
      let i;
      while ((i = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, i);
        out = out.slice(i + 1);
        if (line.startsWith('READY')) { clearTimeout(t); const [, port, pid] = line.split(' '); resolve({ port: +port, pid: +pid }); }
        if (line.startsWith('ACK')) acks.shift()?.();
      }
    });
    child.once('exit', (c) => { clearTimeout(t); reject(new Error(`fake editor exited ${c}: ${err}`)); });
  });
  return {
    ...ready,
    child,
    stderr: () => err,
    /** Simulate the user doing something in the editor. */
    user: (cmd) => new Promise((resolve) => { acks.push(resolve); child.stdin.write(`${cmd}\n`); }),
    stop: () => new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      child.stdin.end('quit\n');
      setTimeout(() => child.kill('SIGKILL'), 3000).unref();
    }),
  };
}

/** Spawn `ue-agent mcp` and speak JSON-RPC to it like Claude Code / Codex do. */
export function startMcp(proj, { client = 'claude-code', env = {} } = {}) {
  const child = spawn(process.execPath, [CLI, 'mcp'], {
    env: { ...process.env, HOME: proj.home, UE_AGENT_PROJECT: proj.project, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '';
  let id = 0;
  const pending = new Map();
  const notes = [];
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } else notes.push(msg);
    }
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const request = (method, params = {}) => new Promise((resolve) => {
    const myId = ++id;
    pending.set(myId, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
  });
  const notify = (method, params = {}) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  return {
    child,
    notes,
    stderr: () => stderr,
    request,
    notify,
    async init() {
      const r = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: client, version: '1' } });
      notify('notifications/initialized');
      return r.result;
    },
    async tool(name, args = {}, meta) {
      const r = await request('tools/call', { name, arguments: args, ...(meta ? { _meta: meta } : {}) });
      if (r.error) throw new Error(JSON.stringify(r.error));
      const text = r.result.content.filter((c) => c.type === 'text').map((c) => c.text);
      let json = null;
      try { json = JSON.parse(text[0].split('\nwarnings:')[0]); } catch { /* error text */ }
      return { ...r.result, text, json, images: r.result.content.filter((c) => c.type === 'image') };
    },
    close: () => new Promise((resolve) => { child.once('exit', resolve); child.stdin.end(); setTimeout(() => child.kill(), 2000).unref(); }),
  };
}

export const pct = (arr, p) => arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))];
