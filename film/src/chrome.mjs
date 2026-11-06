// Find, launch and drive a local Chrome/Chromium/Edge over the DevTools protocol.
// Zero dependencies: uses Node's built-in WebSocket (Node >= 22).
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { supervise } from './process.mjs';

const CANDIDATES = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  ],
  linux: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'],
  win32: [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ],
};

export function findChrome() {
  if (process.env.HFILM_CHROME) {
    if (fs.existsSync(process.env.HFILM_CHROME)) return process.env.HFILM_CHROME;
    throw new Error(`HFILM_CHROME=${process.env.HFILM_CHROME} does not exist`);
  }
  for (const c of CANDIDATES[process.platform] || []) {
    if (path.isAbsolute(c)) {
      if (fs.existsSync(c)) return c;
    } else {
      try {
        const p = execFileSync(process.platform === 'win32' ? 'where' : 'which', [c], { encoding: 'utf8' }).split('\n')[0].trim();
        if (p) return p;
      } catch { /* not on PATH */ }
    }
  }
  return null;
}

export async function launchChrome({ headless = true, width = 1280, height = 720, onLog = null, memoryGB = 4, timeoutMs = 3600000 } = {}) {
  if (!Number.isFinite(memoryGB) || memoryGB <= 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Positive memory and timeout limits required');
  const exe = findChrome();
  if (!exe) throw new Error('No Chrome/Chromium/Edge found. Install Chrome or set HFILM_CHROME.');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hfilm-chrome-'));
  const args = [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--disable-extensions', '--mute-audio', '--hide-scrollbars', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', `--window-size=${width},${height}`];
  if (headless) args.push('--headless=new');
  if (process.platform === 'darwin') args.push('--use-angle=metal');
  const proc = spawn(exe, [...args, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const guard = supervise(proc, { memoryGB, timeoutMs, onStop: (reason) => onLog?.('error', reason) });
  let cdp, closing;
  const close = () => closing ||= (async () => {
    if (cdp) { try { await cdp.send('Browser.close', {}, undefined, 1000); } catch {} cdp.ws.close(); }
    if (proc.exitCode === null && proc.signalCode === null && proc.pid) {
      proc.kill('SIGTERM');
      await Promise.race([new Promise((r) => proc.once('exit', r)), new Promise((r) => setTimeout(r, 1000))]);
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill('SIGKILL');
        await new Promise((r) => proc.once('exit', r));
      }
    }
    guard.dispose();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  })();
  try {
    const wsUrl = await new Promise((resolve, reject) => {
      let buf = '';
      const done = (err, value) => { clearTimeout(timer); proc.off('error', error); proc.off('exit', exit); if (err) reject(err); else resolve(value); };
      const error = (e) => done(e), exit = (code) => done(new Error(guard.stopped || `Chrome exited (${code}): ${buf.slice(-800)}`));
      const timer = setTimeout(() => done(new Error(`Chrome did not expose DevTools within 20 s: ${buf.slice(-800)}`)), 20000);
      proc.on('error', error); proc.once('exit', exit);
      proc.stderr.on('data', (d) => {
        buf = (buf + d).slice(-16384);
        const match = buf.match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) done(null, match[1]);
      });
    });
    cdp = await connect(wsUrl, onLog);
    return { cdp, proc, close, exe, guard };
  } catch (e) { await close(); throw e; }
}

export async function connect(wsUrl, onLog, { WebSocketClass = WebSocket, timeoutMs = 120000 } = {}) {
  const ws = new WebSocketClass(wsUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error('DevTools connection timed out')); }, 10000);
    ws.onopen = () => { clearTimeout(timer); resolve(); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('DevTools connection failed')); };
    ws.onclose = () => { clearTimeout(timer); reject(new Error('DevTools closed during connection')); };
  });
  let id = 0, closed = false;
  const pending = new Map(), listeners = new Set();
  const failAll = () => {
    closed = true;
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error('Chrome DevTools disconnected; render outcome must be checked before retrying')); }
    pending.clear();
  };
  ws.onclose = failAll; ws.onerror = failAll;
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (pending.has(msg.id)) {
      const { resolve, reject, method, timer } = pending.get(msg.id); clearTimeout(timer); pending.delete(msg.id);
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}`)); else resolve(msg.result);
      return;
    }
    if (onLog && msg.method === 'Runtime.consoleAPICalled') onLog(msg.params.type, msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    if (onLog && msg.method === 'Runtime.exceptionThrown') onLog('error', msg.params.exceptionDetails?.exception?.description || 'Page exception');
    for (const listener of listeners) listener(msg);
  };
  const send = (method, params = {}, sessionId, deadline = timeoutMs) => new Promise((resolve, reject) => {
    if (closed) return reject(new Error('Chrome DevTools is closed'));
    const msg = { id: ++id, method, params, ...(sessionId ? { sessionId } : {}) };
    const timer = setTimeout(() => { pending.delete(msg.id); reject(new Error(`${method}: timed out after ${deadline} ms`)); }, deadline);
    pending.set(msg.id, { resolve, reject, method, timer });
    try { ws.send(JSON.stringify(msg)); } catch (e) { clearTimeout(timer); pending.delete(msg.id); reject(e); }
  });
  return { ws, send, on: (fn) => listeners.add(fn), off: (fn) => listeners.delete(fn) };
}

export async function openPage(cdp, url, { width = 1280, height = 720 } = {}) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (m, p) => cdp.send(m, p, sessionId);
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  let listener, timer;
  const loaded = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Render page load timed out')), 15000);
    listener = (msg) => { if (msg.sessionId === sessionId && msg.method === 'Page.loadEventFired') resolve(); };
    cdp.on(listener);
  });
  // Attach a handler immediately: navigation can fail before the load wait.
  loaded.catch(() => {});
  try { await send('Page.navigate', { url }); await loaded; }
  finally { clearTimeout(timer); cdp.off(listener); }
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  return { sessionId, send, evaluate, close: () => cdp.send('Target.closeTarget', { targetId }) };
}
