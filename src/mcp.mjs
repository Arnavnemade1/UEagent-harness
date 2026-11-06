import readline from 'node:readline';
import { callTool, INSTRUCTIONS, listTools, Session } from './tools.mjs';
import { log, VERSION } from './util.mjs';

const SUPPORTED = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isId = (value) => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));

function normalizeClient(name) {
  if (process.env.UE_AGENT_CLIENT) return process.env.UE_AGENT_CLIENT;
  const n = String(name || '').toLowerCase();
  if (n.includes('claude')) return 'claude-code';
  if (n.includes('codex')) return 'codex';
  return name || 'agent';
}

/**
 * Minimal, dependency-free MCP server over stdio (newline-delimited JSON-RPC 2.0).
 * Requests are handled concurrently; responses can arrive out of order.
 */
export function runMcpServer({ project, input = process.stdin, output = process.stdout } = {}) {
  const session = new Session({ project, clientName: normalizeClient(process.env.UE_AGENT_CLIENT) });
  const inflight = new Map();
  let started = false;

  const send = (msg) => output.write(JSON.stringify(msg) + '\n');
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
  const error = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

  async function handle(msg) {
    const { id, method, params = {} } = msg;
    const isRequest = id !== undefined && id !== null;
    // Request methods without an id are notifications: never run an edit that
    // the client cannot receive or correlate a result for.
    if (!isRequest && !method.startsWith('notifications/')) return;
    if (!isObject(params)) {
      if (isRequest) error(id, -32602, 'params must be an object');
      return;
    }
    switch (method) {
      case 'initialize': {
        const requested = params.protocolVersion;
        session.setClientName(normalizeClient(params.clientInfo?.name));
        reply(id, {
          protocolVersion: SUPPORTED.includes(requested) ? requested : SUPPORTED[0],
          capabilities: { tools: { listChanged: false }, logging: {} },
          serverInfo: { name: 'unreal', title: 'Unreal Engine Agent Bridge', version: VERSION },
          instructions: INSTRUCTIONS,
        });
        return;
      }
      case 'notifications/initialized':
        if (!started) { started = true; session.start(); }
        return;
      case 'notifications/cancelled': {
        const c = inflight.get(params.requestId);
        if (c) { c.cancelled = true; c.abort.abort(); }
        return;
      }
      case 'ping': reply(id, {}); return;
      case 'tools/list': reply(id, { tools: listTools() }); return;
      case 'resources/list': reply(id, { resources: [] }); return;
      case 'resources/templates/list': reply(id, { resourceTemplates: [] }); return;
      case 'prompts/list': reply(id, { prompts: [] }); return;
      case 'logging/setLevel': reply(id, {}); return;
      case 'tools/call': {
        if (typeof params.name !== 'string' || !params.name.trim()
          || (params.arguments !== undefined && !isObject(params.arguments))
          || (params._meta !== undefined && !isObject(params._meta))
          || (params._meta?.progressToken !== undefined && !isId(params._meta.progressToken))) {
          error(id, -32602, 'tools/call requires a tool name, object arguments and a string or number progressToken when provided');
          return;
        }
        if (!started) { started = true; session.start(); }
        const token = params._meta?.progressToken;
        const abort = new AbortController();
        const entry = { cancelled: false, abort };
        inflight.set(id, entry);
        let n = 0;
        const progress = token === undefined ? undefined : (message) => {
          send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: ++n, message: String(message).slice(0, 300) } });
        };
        try {
          const result = await callTool(session, params.name, params.arguments || {}, { progress, signal: abort.signal });
          if (!entry.cancelled) reply(id, result);
        } finally {
          inflight.delete(id);
        }
        return;
      }
      default:
        if (isRequest) error(id, -32601, `method not found: ${method}`);
    }
  }

  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      return;
    }
    const msgs = Array.isArray(msg) ? msg : [msg];
    if (!msgs.length) { error(null, -32600, 'invalid request'); return; }
    for (const m of msgs) {
      if (!isObject(m) || m.jsonrpc !== '2.0' || typeof m.method !== 'string'
        || !m.method || (m.id !== undefined && !isId(m.id))) {
        error(isObject(m) && isId(m.id) ? m.id : null, -32600, 'invalid request');
        continue;
      }
      handle(m).catch((e) => {
        log('handler error:', e.stack || e.message);
        if (m.id !== undefined && m.id !== null) error(m.id, -32603, e.message);
      });
    }
  });
  const shutdown = () => { session.close(); process.exit(0); };
  rl.on('close', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return session;
}
