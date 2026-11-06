// Find, launch and drive a local Chrome/Chromium/Edge over the DevTools protocol.
// Zero dependencies: uses Node's built-in WebSocket (Node >= 22).
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

export async function launchChrome({ headless = true, width = 1280, height = 720, onLog = null } = {}) {
  const exe = findChrome();
  if (!exe) throw new Error('No Chrome/Chromium/Edge found. Install Google Chrome or set HFILM_CHROME to a Chromium-based browser binary.');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hfilm-chrome-'));
  const args = [
    `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--disable-extensions', '--mute-audio', '--hide-scrollbars', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
    `--window-size=${width},${height}`,
  ];
  if (headless) args.push('--headless=new');
  if (process.platform === 'darwin') args.push('--use-angle=metal');
  const proc = spawn(exe, [...args, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error(`Chrome did not expose DevTools within 20 s. stderr:\n${buf.slice(-800)}`)), 20000);
    proc.stderr.on('data', (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(t); resolve(m[1]); }
    });
    proc.on('exit', (code) => { clearTimeout(t); reject(new Error(`Chrome exited (${code}) before DevTools was ready:\n${buf.slice(-800)}`)); });
  });
  const cdp = await connect(wsUrl, onLog);
  const close = async () => {
    try { await cdp.send('Browser.close'); } catch { /* already gone */ }
    cdp.ws.close();
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* exited */ } }, 1500).unref();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
  };
  return { cdp, proc, close, exe };
}

async function connect(wsUrl, onLog) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error(`cannot connect to ${wsUrl}`)); });
  let id = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject, method } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
      else resolve(msg.result);
      return;
    }
    if (onLog && msg.method === 'Runtime.consoleAPICalled') {
      onLog(msg.params.type, msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    }
    if (onLog && msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      onLog('error', `${d.exception?.description || d.text} (${d.url || ''}:${d.lineNumber})`);
    }
    for (const l of listeners) l(msg);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const msg = { id: ++id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    pending.set(msg.id, { resolve, reject, method });
    ws.send(JSON.stringify(msg));
  });
  return { ws, send, on: (fn) => listeners.add(fn), off: (fn) => listeners.delete(fn) };
}

/** Open a page and return helpers bound to its session. */
export async function openPage(cdp, url, { width = 1280, height = 720 } = {}) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p) => cdp.send(m, p, sessionId);
  await s('Runtime.enable');
  await s('Page.enable');
  await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  const loaded = new Promise((resolve) => {
    const fn = (msg) => { if (msg.sessionId === sessionId && msg.method === 'Page.loadEventFired') { cdp.off(fn); resolve(); } };
    cdp.on(fn);
  });
  await s('Page.navigate', { url });
  await loaded;
  const evaluate = async (expression) => {
    const r = await s('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(d.exception?.description || d.text);
    }
    return r.result.value;
  };
  return { sessionId, send: s, evaluate, close: () => cdp.send('Target.closeTarget', { targetId }) };
}
