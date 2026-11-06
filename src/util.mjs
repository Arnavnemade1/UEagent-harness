import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERSION = '1.0.0';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CLI_PATH = path.join(ROOT, 'bin', 'ue-agent.mjs');
export const PLUGIN_DIR = path.join(ROOT, 'plugin', 'UEAgentBridge');
export const HOME_DIR = path.join(os.homedir(), '.ue-agent-harness');
export const CONFIG_PATH = path.join(HOME_DIR, 'config.json');

let quiet = false;
export function setQuiet(v) { quiet = v; }
/** Diagnostics go to stderr so stdout stays clean for MCP JSON-RPC. */
export function log(...args) {
  if (!quiet) process.stderr.write(`[ue-agent] ${args.join(' ')}\n`);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function writeJsonAtomic(file, data, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

export function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) => {
    let r = path.resolve(p);
    try { r = fs.realpathSync(r); } catch { /* keep */ }
    return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

export function truncate(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} chars; narrow the query or pass a smaller limit]`;
}

export function loadConfig() { return readJson(CONFIG_PATH, {}) || {}; }

export function saveConfig(patch) {
  const cfg = { ...loadConfig(), ...patch };
  writeJsonAtomic(CONFIG_PATH, cfg);
  return cfg;
}

/** Locate an executable on PATH plus common install dirs (GUI apps get a minimal PATH). */
export function which(cmd) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  dirs.push(path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin',
    path.join(os.homedir(), '.superset', 'bin'), path.join(os.homedir(), '.claude', 'local'));
  for (const d of dirs) {
    for (const e of exts) {
      const p = path.join(d, cmd + e);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
    }
  }
  return null;
}

const BOOLEAN_FLAGS = new Set(['continue', 'copy', 'restart-editor', 'help', 'version', 'json', 'trust-python']);

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out._.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (key.startsWith('no-')) { out[key.slice(3)] = false; continue; }
      if (!BOOLEAN_FLAGS.has(key) && next !== undefined && !next.startsWith('--')) { out[key] = next; i++; } else out[key] = true;
    } else out._.push(a);
  }
  return out;
}
