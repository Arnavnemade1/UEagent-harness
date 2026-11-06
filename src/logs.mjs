import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bridgeFile } from './discovery.mjs';
import { readJson } from './util.mjs';

// [2026.11.05-17.22.33:123][ 45]LogBlueprint: Error: message
const LINE = /^\[(\d{4}\.\d{2}\.\d{2}-\d{2}\.\d{2}\.\d{2}:\d{3})\]\[\s*(\d+)\](\w+):\s(?:(Fatal|Error|Warning|Display|Log|Verbose|VeryVerbose):\s)?(.*)$/;
const BARE = /^(Log\w+|\w+):\s(?:(Fatal|Error|Warning|Display|Verbose):\s)?(.*)$/;
const SEV_RANK = { fatal: 0, error: 1, warning: 2, display: 3, log: 4, verbose: 5, veryverbose: 6 };

/**
 * The editor's log file. The bridge reports its real log folder; otherwise try
 * <Project>/Saved/Logs (Windows/Linux) and ~/Library/Logs/Unreal Engine/<Name>Editor (macOS).
 */
export function logFile(projectFile) {
  const name = path.basename(projectFile, path.extname(projectFile));
  const cands = [];
  const reported = readJson(bridgeFile(projectFile))?.log_dir;
  if (reported) cands.push(path.join(reported, `${name}.log`));
  cands.push(path.join(path.dirname(projectFile), 'Saved', 'Logs', `${name}.log`));
  if (process.platform === 'darwin') cands.push(path.join(os.homedir(), 'Library', 'Logs', 'Unreal Engine', `${name}Editor`, `${name}.log`));
  return cands.find((f) => fs.existsSync(f)) || cands[0];
}

export function parseLine(line) {
  let m = LINE.exec(line);
  if (m) return { time: m[1], frame: Number(m[2]), cat: m[3], sev: (m[4] || 'Log').toLowerCase(), msg: m[5] };
  m = BARE.exec(line);
  if (m && /^Log|^Py|^LogPython/.test(m[1])) return { time: null, frame: null, cat: m[1], sev: (m[2] || 'Log').toLowerCase(), msg: m[3] };
  return null;
}

function readRange(file, start, end) {
  const fd = fs.openSync(file, 'r');
  try {
    const len = Math.max(0, end - start);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    return buf.toString('utf8');
  } finally { fs.closeSync(fd); }
}

/**
 * Read and filter the editor log.
 * since: byte cursor from a previous call (only newer lines), or undefined for the tail.
 */
export function readLog(projectFile, { since, severity = 'all', category, contains, lines = 60, maxBytes = 1 << 20 } = {}) {
  const file = logFile(projectFile);
  let size;
  try { size = fs.statSync(file).size; } catch {
    return { file, cursor: 0, lines: [], matched: 0, note: 'no log file yet (editor not started for this project?)' };
  }
  const hasCursor = typeof since === 'number' && since >= 0;
  const rotated = hasCursor && since > size;
  let start = rotated ? 0 : hasCursor ? since : Math.max(0, size - maxBytes);
  let midLine = !hasCursor && start > 0;
  if (size - start > maxBytes) { start = size - maxBytes; midLine = true; }
  let text = readRange(file, start, size);
  if (midLine) text = text.slice(text.indexOf('\n') + 1);
  const maxRank = severity === 'error' ? SEV_RANK.error : severity === 'warning' ? SEV_RANK.warning : 99;
  const cat = category ? String(category).toLowerCase() : null;
  const needle = contains ? String(contains).toLowerCase() : null;
  const entries = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw) continue;
    const p = parseLine(raw);
    if (p) entries.push(p);
    else if (entries.length) entries[entries.length - 1].msg += `\n${raw}`;
  }
  const hits = entries.filter((e) => (SEV_RANK[e.sev] ?? 4) <= maxRank
    && (!cat || e.cat.toLowerCase().includes(cat))
    && (!needle || e.msg.toLowerCase().includes(needle) || e.cat.toLowerCase().includes(needle)));
  const tail = hits.slice(-Math.max(1, lines));
  return {
    file,
    cursor: size,
    matched: hits.length,
    lines: tail.map((e) => `${e.sev === 'log' || e.sev === 'display' ? '' : `[${e.sev}] `}${e.cat}: ${e.msg.length > 2000 ? `${e.msg.slice(0, 2000)}…` : e.msg}`),
    ...(rotated ? { note: 'log was rotated (editor restarted); showing from the start of the new log' } : {}),
  };
}

export function logSize(projectFile) {
  try { return fs.statSync(logFile(projectFile)).size; } catch { return 0; }
}
