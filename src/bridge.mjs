import { EventEmitter } from 'node:events';
import net from 'node:net';
import { findBridge, findProject } from './discovery.mjs';
import { log, sleep } from './util.mjs';

export class BridgeError extends Error {
  constructor(code, message, data = {}) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export const NOT_RUNNING_HINT =
  'Start Unreal Editor with this project (the UEAgentBridge plugin starts automatically), or call ue_launch. ' +
  'If it is running, check that the plugin is enabled and run `ue-agent doctor`.';

/**
 * Persistent, pipelined connection to the in-editor bridge.
 * - lazy connect + automatic re-discovery when the editor restarts (new port/token)
 * - optional background reconnect so change events keep flowing
 */
export class BridgeClient extends EventEmitter {
  constructor({ project, clientName = 'agent', subscribe = true, keepAlive = false } = {}) {
    super();
    this.project = project || null;
    this.clientName = clientName;
    this.subscribe = subscribe;
    this.keepAlive = keepAlive;
    this.sock = null;
    this.info = null;
    this.rev = 0;
    this.pending = new Map();
    this.nextId = 1;
    this.buf = '';
    this.connecting = null;
    this.connectingSock = null;
    this.closed = false;
    this.lastIdentity = null;
    this.retryTimer = null;
    this.retryDelay = 1000;
  }

  get connected() { return !!(this.sock && this.info); }

  resolveProject() {
    if (!this.project) this.project = findProject();
    return this.project;
  }

  async connect() {
    if (this.closed) throw new BridgeError('closed', 'bridge client is closed');
    if (this.connected) return this.info;
    if (!this.connecting) {
      this.connecting = this._connect().finally(() => { this.connecting = null; });
    }
    return this.connecting;
  }

  async _connect() {
    const project = this.resolveProject();
    const disc = findBridge(project);
    if (!disc) {
      throw new BridgeError('editor_not_running',
        `Unreal Editor bridge not found${project ? ` for ${project}` : ''}. ${NOT_RUNNING_HINT}`);
    }
    if (!this.project && disc.project) this.project = disc.project;
    const sock = await new Promise((resolve, reject) => {
      const s = net.createConnection({ host: disc.host || '127.0.0.1', port: disc.port });
      this.connectingSock = s;
      const cleanup = () => {
        clearTimeout(t);
        s.off('connect', onConnect);
        s.off('error', onError);
        s.off('close', onClose);
        if (this.connectingSock === s) this.connectingSock = null;
      };
      const onConnect = () => { cleanup(); resolve(s); };
      const onError = (e) => {
        cleanup();
        s.destroy();
        reject(new BridgeError('connect_failed', `cannot reach the editor bridge on port ${disc.port} (${e.code || e.message}). The editor may still be starting. ${NOT_RUNNING_HINT}`));
      };
      const onClose = () => {
        cleanup();
        reject(new BridgeError(this.closed ? 'closed' : 'disconnected', this.closed ? 'bridge client is closed' : 'connection to the editor closed before connecting'));
      };
      const t = setTimeout(() => {
        cleanup();
        s.destroy();
        reject(new BridgeError('connect_timeout', `bridge at port ${disc.port} did not accept the connection`));
      }, 3000);
      s.once('connect', onConnect);
      s.once('error', onError);
      s.once('close', onClose);
    });
    if (this.closed) {
      sock.destroy();
      throw new BridgeError('closed', 'bridge client is closed');
    }
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 15000);
    sock.setEncoding('utf8');
    this.sock = sock;
    this.buf = '';
    sock.on('data', (chunk) => { if (this.sock === sock) this._onData(chunk); });
    sock.on('close', () => this._onClose(sock));
    sock.on('error', () => { /* close follows */ });
    let hello;
    try {
      hello = (await this._request('hello', { token: disc.token, client: this.clientName, subscribe: this.subscribe }, 10000)).result;
    } catch (e) {
      this._onClose(sock);
      sock.destroy();
      throw e;
    }
    if (this.closed || this.sock !== sock) {
      throw new BridgeError(this.closed ? 'closed' : 'disconnected', 'connection to the editor closed during the handshake');
    }
    this.info = hello;
    this.rev = hello.rev || 0;
    this.retryDelay = 1000;
    const identity = `${hello.pid}:${hello.started}`;
    if (this.lastIdentity && this.lastIdentity !== identity) this.emit('restart', hello);
    this.lastIdentity = identity;
    this.emit('connect', hello);
    return hello;
  }

  _onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) continue;
      if (msg.event) {
        if (typeof msg.rev === 'number' && msg.rev > this.rev) this.rev = msg.rev;
        this.emit('change', msg);
        continue;
      }
      if (typeof msg.rev === 'number' && msg.rev > this.rev) this.rev = msg.rev;
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve({ result: msg.result, warnings: msg.warnings, ms: msg.ms, rev: msg.rev });
      else {
        const err = msg.error || {};
        const { code, message, ...data } = err;
        p.reject(new BridgeError(code || 'error', message || 'bridge error', { ...data, warnings: msg.warnings }));
      }
    }
  }

  _onClose(sock) {
    if (this.sock !== sock) return;
    this.sock = null;
    this.info = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new BridgeError('disconnected', 'connection to the editor was lost (editor closed, crashed or restarted the bridge)'));
    }
    this.pending.clear();
    this.emit('disconnect');
    if (this.keepAlive && !this.closed) this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this.retryTimer || this.closed) return;
    this.retryTimer = setTimeout(async () => {
      this.retryTimer = null;
      try { await this.connect(); } catch {
        this.retryDelay = Math.min(this.retryDelay * 2, 15000);
        this._scheduleReconnect();
      }
    }, this.retryDelay);
    this.retryTimer.unref?.();
  }

  /** Start background (re)connection without failing if the editor is down. */
  startBackground() {
    this.keepAlive = true;
    this.connect().catch(() => this._scheduleReconnect());
  }

  _request(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!this.sock) return reject(new BridgeError('disconnected', 'not connected'));
      const id = this.nextId++;
      // Serialization can fail (e.g. circular Python arguments). Do it before
      // allocating a timer or registering work that can never be sent.
      const line = JSON.stringify({ id, method, params }) + '\n';
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError('timeout', `${method === 'call' ? params.fn : method} timed out after ${Math.round(timeoutMs / 1000)}s (the editor may be busy, e.g. compiling shaders; it will still finish in the background)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.sock.write(line); } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  /** Call a bridge op. Returns {result, warnings, ms, rev}. */
  async call(fn, args = {}, { timeout = 60000 } = {}) {
    await this.connect();
    return this._request('call', { fn, args, timeout: Math.ceil(timeout / 1000) }, timeout + 2000);
  }

  async ping(timeout = 5000) {
    await this.connect();
    const t = process.hrtime.bigint();
    await this._request('ping', {}, timeout);
    return Number(process.hrtime.bigint() - t) / 1e6;
  }

  /** Wait until the editor bridge answers (used after launching/restarting the editor). */
  async waitForEditor(timeoutMs, { onTick } = {}) {
    const end = Date.now() + timeoutMs;
    let lastErr;
    while (Date.now() < end) {
      try { return await this.connect(); } catch (e) { lastErr = e; }
      onTick?.();
      await sleep(1000);
    }
    throw lastErr || new BridgeError('timeout', 'editor did not come up');
  }

  close() {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.connectingSock?.destroy();
    if (this.sock) {
      const sock = this.sock;
      try { sock.end(JSON.stringify({ id: 0, method: 'bye' }) + '\n'); } catch { /* ignore */ }
      // Reject pending work before clearing the socket identity; its later close
      // event otherwise cannot distinguish this connection from an obsolete one.
      this._onClose(sock);
      sock.destroy();
    }
    this.sock = null;
    this.info = null;
  }
}

export function debugLog(...a) { if (process.env.UE_AGENT_DEBUG) log(...a); }
