// Supervise only processes started by this job. Never kill a user's editor/browser.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
const exec = promisify(execFile);
const active = new Set();

export function treeBytes(output, pid, bytesPerUnit = 1024) {
  const rows = output.trim().split('\n').map((line) => line.trim().split(/\s+/).map(Number));
  if (!rows.some(([id]) => id === pid)) throw new Error(`Process ${pid} disappeared during memory sampling`);
  const ids = new Set([pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const [id, parent] of rows) if (ids.has(parent) && !ids.has(id)) { ids.add(id); changed = true; }
  }
  return rows.filter(([id]) => ids.has(id)).reduce((sum, [, , rss]) => {
    if (!Number.isFinite(rss) || rss < 0) throw new Error('Invalid process-memory reading');
    return sum + rss * bytesPerUnit;
  }, 0);
}

export function footprintBytes(output) {
  const match = output.match(/^\s*\d+\s+([\d.]+)([KMGT]?)\+?\s*$/m);
  if (!match) throw new Error('macOS did not report process footprint');
  return +match[1] * 1024 ** ({ '': 0, K: 1, M: 2, G: 3, T: 4 }[match[2]]);
}

export async function processMemory(pid, { footprint = false } = {}) {
  const opts = { encoding: 'utf8', timeout: 3000, maxBuffer: 4 * 1024 ** 2 };
  let bytes, pressure = 1;
  let metric = footprint && process.platform === 'darwin' ? 'physical_footprint' : 'process_tree_rss';
  if (process.platform === 'darwin' && footprint) {
    // `top` can take several seconds while a renderer saturates the machine; fall back to the
    // process-tree RSS rather than going blind
    try { bytes = footprintBytes((await exec('top', ['-l', '1', '-pid', String(pid), '-stats', 'pid,mem', '-ncols', '80'], { ...opts, timeout: 8000 })).stdout); }
    catch { bytes = treeBytes((await exec('ps', ['-axo', 'pid=,ppid=,rss='], opts)).stdout, pid); metric = 'process_tree_rss (top unavailable)'; }
  } else if (process.platform === 'win32') {
    const script = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.WorkingSetSize)" }';
    bytes = treeBytes((await exec('powershell.exe', ['-NoProfile', '-Command', script], opts)).stdout, pid, 1);
  } else bytes = treeBytes((await exec('ps', ['-axo', 'pid=,ppid=,rss='], opts)).stdout, pid);
  if (process.platform === 'darwin') {
    pressure = Number((await exec('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], opts)).stdout.trim());
    if (![1, 2, 4].includes(pressure)) throw new Error('Unknown macOS memory pressure reading');
  }
  return { bytes, pressure, metric };
}

export function supervise(proc, { memoryGB = 4, timeoutMs = 120 * 60000, footprint = false, onTick = () => {}, onStop = () => {}, sample = processMemory, intervalMs = 3000, maxFailures = 2 } = {}) {
  if (!Number.isFinite(memoryGB) || memoryGB <= 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Positive memory and timeout limits required');
  active.add(proc);
  let stopped = null, peakBytes = 0, checking = false, ended = false, killTimer, failures = 0;
  const alive = () => !ended && proc.exitCode === null && proc.signalCode === null;
  const stop = (reason) => {
    if (stopped || !alive()) return;
    stopped = reason;
    try { onStop(reason); } catch { /* logging must not prevent termination */ }
    proc.kill('SIGTERM');
    killTimer = setTimeout(() => { if (alive()) proc.kill('SIGKILL'); }, 3000);
    killTimer.unref();
  };
  const timeout = setTimeout(() => stop(`timeout after ${Math.round(timeoutMs / 1000)} seconds`), timeoutMs);
  const check = async () => {
    if (checking || !alive() || !proc.pid) return;
    checking = true;
    try {
      const reading = await sample(proc.pid, { footprint });
      failures = 0;
      if (!alive()) return;
      peakBytes = Math.max(peakBytes, reading.bytes);
      onTick({ ...reading, peakBytes });
      if (reading.pressure >= 4) stop('critical system memory pressure');
      else if (reading.bytes > memoryGB * 1024 ** 3) stop(`memory cap ${memoryGB} GiB exceeded (${reading.metric})`);
    } catch (e) {
      // a single failed sample (e.g. `top` busy under load) is not a reason to kill an hour-long render;
      // keep going, but stop if the monitor stays blind for several intervals in a row
      if (alive() && ++failures >= maxFailures) stop(`memory monitor failed ${failures}x: ${e.message}`);
    }
    finally { checking = false; }
  };
  const timer = setInterval(check, intervalMs);
  const dispose = () => { ended = true; clearInterval(timer); clearTimeout(timeout); clearTimeout(killTimer); active.delete(proc); };
  proc.once('exit', dispose); proc.once('error', dispose);
  return { stop, check, dispose, get stopped() { return stopped; }, get peakBytes() { return peakBytes; } };
}

export async function stopChildren() {
  const children = [...active];
  for (const proc of children) if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM');
  await Promise.race([Promise.all(children.map((proc) => new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) resolve(); else { proc.once('exit', resolve); proc.once('error', resolve); }
  }))), new Promise((resolve) => setTimeout(resolve, 2000))]);
  for (const proc of children) if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
}

export async function runProcess(exe, args, { logFile, env, memoryGB = 7, timeoutMin = 120, onTick } = {}) {
  if (!Number.isFinite(memoryGB) || memoryGB <= 0 || !Number.isFinite(timeoutMin) || timeoutMin <= 0) throw new Error('Positive memory and timeout limits required');
  const fd = fs.openSync(logFile, 'w');
  const proc = spawn(exe, args, { stdio: ['ignore', fd, fd], env: { ...process.env, ...env, UE_AGENT_BRIDGE_DISABLE: '1' } });
  const guard = supervise(proc, { memoryGB, timeoutMs: timeoutMin * 60000, footprint: true, onTick });
  try {
    return await new Promise((resolve, reject) => {
      proc.once('error', reject);
      proc.once('exit', (code, signal) => resolve({ code, signal, stopped: guard.stopped, peakBytes: guard.peakBytes }));
    });
  } finally { guard.dispose(); fs.closeSync(fd); }
}
