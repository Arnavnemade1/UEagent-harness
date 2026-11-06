import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectInfo } from './discovery.mjs';
import { logSize, readLog } from './logs.mjs';
import { pidAlive, readJson, sleep, writeJsonAtomic } from './util.mjs';

const PLATFORM = { darwin: 'Mac', win32: 'Win64', linux: 'Linux' }[process.platform] || 'Linux';

// ---------------------------------------------------------------- engine discovery

function launcherInstalls() {
  const files = process.platform === 'win32'
    ? [path.join(process.env.ProgramData || 'C:\\ProgramData', 'Epic', 'UnrealEngineLauncher', 'LauncherInstalled.dat')]
    : ['/Users/Shared/Epic Games/UnrealEngineLauncher/LauncherInstalled.dat',
      path.join(os.homedir(), 'Library', 'Application Support', 'Epic', 'UnrealEngineLauncher', 'LauncherInstalled.dat')];
  const out = [];
  for (const f of files) {
    const j = readJson(f);
    for (const it of j?.InstallationList || []) {
      if (/^UE_\d/.test(it.AppName || '')) out.push({ version: it.AppName.slice(3), dir: it.InstallLocation });
    }
  }
  return out;
}

function sourceBuilds() {
  const out = {};
  const ini = process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'Epic', 'UnrealEngine', 'Install.ini')
    : path.join(os.homedir(), '.config', 'Epic', 'UnrealEngine', 'Install.ini');
  try {
    let inSection = false;
    for (const line of fs.readFileSync(ini, 'utf8').split(/\r?\n/)) {
      if (/^\[.*\]$/.test(line.trim())) { inSection = line.trim() === '[Installations]'; continue; }
      const m = inSection && /^([^=]+)=(.*)$/.exec(line.trim());
      if (m) out[m[1].trim()] = m[2].trim();
    }
  } catch { /* none */ }
  if (process.platform === 'win32') {
    try {
      const txt = execFileSync('reg', ['query', 'HKCU\\Software\\Epic Games\\Unreal Engine\\Builds'], { encoding: 'utf8' });
      for (const m of txt.matchAll(/^\s+(\S+)\s+REG_SZ\s+(.+)$/gm)) out[m[1]] = m[2].trim();
    } catch { /* none */ }
  }
  return out;
}

const isEngineDir = (d) => d && fs.existsSync(path.join(d, 'Build', 'BatchFiles'));

/** Resolve the Engine/ directory for a project. `hint` is the editor-reported engine dir. */
export function findEngine(projectFile, hint) {
  const cands = [];
  if (hint) cands.push(hint);
  if (process.env.UE_ENGINE_DIR) cands.push(process.env.UE_ENGINE_DIR, path.join(process.env.UE_ENGINE_DIR, 'Engine'));
  const assoc = projectInfo(projectFile)?.engineAssociation;
  if (assoc) {
    const src = sourceBuilds()[assoc];
    if (src) cands.push(path.join(src, 'Engine'));
    for (const inst of launcherInstalls()) if (inst.version === assoc) cands.push(path.join(inst.dir, 'Engine'));
    if (process.platform === 'darwin') cands.push(`/Users/Shared/Epic Games/UE_${assoc}/Engine`);
    if (process.platform === 'win32') cands.push(`C:\\Program Files\\Epic Games\\UE_${assoc}\\Engine`);
  }
  // relative engine (project inside an engine source tree)
  let d = path.dirname(projectFile);
  for (let i = 0; i < 4; i++) { d = path.dirname(d); cands.push(path.join(d, 'Engine')); }
  return cands.find(isEngineDir) || null;
}

export function editorExecutable(engineDir) {
  if (process.platform === 'darwin') {
    for (const n of ['UnrealEditor', 'UE4Editor']) {
      const app = path.join(engineDir, 'Binaries', 'Mac', `${n}.app`);
      if (fs.existsSync(app)) return { app, bin: path.join(app, 'Contents', 'MacOS', n) };
    }
    return null;
  }
  const ext = process.platform === 'win32' ? '.exe' : '';
  for (const n of ['UnrealEditor', 'UE4Editor']) {
    const bin = path.join(engineDir, 'Binaries', PLATFORM, n + ext);
    if (fs.existsSync(bin)) return { bin };
  }
  return null;
}

export function launchEditor(projectFile, engineDir) {
  const exe = editorExecutable(engineDir);
  if (!exe) throw new Error(`UnrealEditor not found under ${engineDir}`);
  const child = process.platform === 'darwin'
    ? spawn('open', ['-n', '-a', exe.app, '--args', projectFile], { detached: true, stdio: 'ignore' })
    : spawn(exe.bin, [projectFile], { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  return exe;
}

// ---------------------------------------------------------------- diagnostics

const PATTERNS = [
  // clang / gcc: /path/File.cpp:12:5: error: message
  [/^(.+?):(\d+):(\d+):\s+(fatal error|error|warning):\s+(.*)$/, (m) => ({ file: m[1], line: +m[2], col: +m[3], severity: m[4].includes('error') ? 'error' : 'warning', message: m[5] })],
  // MSVC / UHT: C:\path\File.cpp(12): error C2065: message   |  File.h(12): Error: message
  [/^\s*(.+?)\((\d+)(?:,(\d+))?\)\s*:\s+(fatal error|error|warning|Error|Warning)\s*([A-Z]+\d+)?:?\s*(.*)$/, (m) => ({ file: m[1], line: +m[2], col: m[3] ? +m[3] : undefined, severity: /error/i.test(m[4]) ? 'error' : 'warning', code: m[5], message: m[6] })],
  // linker
  [/^(?:ld|clang|lld|LINK)\s*:\s*(?:fatal )?error\s*(\w+)?:?\s*(.*)$/i, (m) => ({ severity: 'error', code: m[1], message: m[2] })],
  [/^\s*(Undefined symbols for architecture .*|"[^"]+", referenced from:)$/, (m) => ({ severity: 'error', message: m[1] })],
  [/^.*error LNK\d+:.*$/, (m) => ({ severity: 'error', message: m[0].trim() })],
  // UnrealBuildTool
  [/^(?:ERROR|Error):\s+(.*)$/, (m) => ({ severity: 'error', message: m[1] })],
];

export function parseDiagnostics(text, projectDir) {
  const out = [];
  const seen = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '');
    for (const [re, fn] of PATTERNS) {
      const m = re.exec(line);
      if (!m) continue;
      const d = fn(m);
      if (d.file && projectDir && path.isAbsolute(d.file) && d.file.startsWith(projectDir)) d.file = path.relative(projectDir, d.file);
      const key = `${d.file}:${d.line}:${d.message}`;
      if (!seen.has(key)) { seen.add(key); out.push(d); }
      break;
    }
  }
  out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
  return out;
}

// ---------------------------------------------------------------- toolchain checks

export function toolchainProblem() {
  if (process.platform === 'darwin') {
    let dev = '';
    try { dev = execFileSync('xcode-select', ['-p'], { encoding: 'utf8' }).trim(); } catch { /* none */ }
    if (!dev.includes('.app/')) {
      return 'C++ builds on macOS need the full Xcode app (only the Command Line Tools are active). '
        + 'Install Xcode, then run `sudo xcode-select -s /Applications/Xcode.app`. Blueprint/Python/asset work does not need it.';
    }
  }
  return null;
}

// ---------------------------------------------------------------- build

function markerFile(projectDir) { return path.join(projectDir, 'Saved', 'UEAgentBridge', 'last_build.json'); }

export function lastBuild(projectDir) { return readJson(markerFile(projectDir)); }

/** Newest mtime of C++/C# build inputs under Source/ and Plugins/<x>/Source (bounded walk). */
export function newestSourceChange(projectDir) {
  let newest = 0;
  let newestFile = null;
  let budget = 20000;
  const walk = (dir, depth) => {
    if (depth > 12 || budget <= 0) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (--budget <= 0) return;
      if (e.name.startsWith('.') || e.name === 'Intermediate' || e.name === 'Binaries') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/\.(h|hpp|cpp|cc|inl|cs)$/i.test(e.name)) {
        try { const t = fs.statSync(p).mtimeMs; if (t > newest) { newest = t; newestFile = p; } } catch { /* skip */ }
      }
    }
  };
  walk(path.join(projectDir, 'Source'), 0);
  const plugins = path.join(projectDir, 'Plugins');
  try {
    for (const e of fs.readdirSync(plugins, { withFileTypes: true })) {
      if (e.isDirectory() || e.isSymbolicLink()) walk(path.join(plugins, e.name, 'Source'), 0);
    }
  } catch { /* none */ }
  return { time: newest, file: newestFile };
}

function runUbt({ engineDir, project, config, onLine, signal }) {
  const bat = process.platform === 'win32'
    ? path.join(engineDir, 'Build', 'BatchFiles', 'Build.bat')
    : path.join(engineDir, 'Build', 'BatchFiles', PLATFORM, 'Build.sh');
  const args = [`${project.name}Editor`, PLATFORM, config, `-Project=${project.file}`, '-WaitMutex', '-NoHotReloadFromIDE'];
  // .bat files must run through cmd.exe (shell: true), which does not quote arguments for us
  const win = process.platform === 'win32';
  const q = (a) => (win && /[\s"&()^]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);
  return new Promise((resolve) => {
    const child = spawn(q(bat), args.map(q), { cwd: project.dir, shell: win, windowsHide: true });
    let out = '';
    const feed = (b) => {
      const s = b.toString();
      out += s;
      if (out.length > 8e6) out = out.slice(-4e6);
      for (const l of s.split(/\r?\n/)) if (l.trim()) onLine?.(l);
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    signal?.addEventListener('abort', () => child.kill());
    child.on('close', (code) => resolve({ code, out, cmd: `${bat} ${args.join(' ')}` }));
    child.on('error', (e) => resolve({ code: -1, out: String(e), cmd: bat }));
  });
}

async function liveCoding({ bridge, project, timeoutMs, onLine }) {
  const before = logSize(project.file);
  await bridge.call('console', { commands: ['LiveCoding.Compile'] });
  const end = Date.now() + timeoutMs;
  let cursor = before;
  const collected = [];
  while (Date.now() < end) {
    await sleep(750);
    const r = readLog(project.file, { since: cursor, category: 'LiveCoding', lines: 400 });
    cursor = r.cursor;
    for (const l of r.lines) { collected.push(l); onLine?.(l); }
    const all = collected.join('\n');
    if (/succeeded|no changes|nothing to (compile|patch)/i.test(all)) return { ok: true, lines: collected };
    if (/failed|error|cancelled/i.test(all) && /live coding/i.test(all)) return { ok: false, lines: collected };
  }
  return { ok: false, timeout: true, lines: collected };
}

/**
 * Compile the project's C++.
 * mode: auto (Live Coding on Windows while the editor runs, else UBT) | ubt | livecoding
 * restartEditor: on macOS/Linux the running editor cannot hot-apply C++; this saves,
 *                closes, builds and relaunches it, then waits for the bridge.
 */
export async function build({ projectFile, bridge, mode = 'auto', restartEditor = false, config = 'Development', onProgress, signal }) {
  const project = projectInfo(projectFile);
  const t0 = Date.now();
  if (!project.hasSource && !project.modules.length) {
    return { ok: true, summary: 'Blueprint-only project: no C++ modules to compile.' };
  }
  let editorUp = false;
  try { await bridge.connect(); editorUp = true; } catch { /* not running */ }
  const engineDir = findEngine(projectFile, bridge.info?.engine_dir);
  const record = (res) => {
    writeJsonAtomic(markerFile(project.dir), { time: Date.now(), ok: res.ok, mode: res.mode, errors: res.errors ?? 0 });
    return { ...res, seconds: Math.round((Date.now() - t0) / 100) / 10 };
  };

  if (editorUp && (mode === 'livecoding' || (mode === 'auto' && process.platform === 'win32'))) {
    onProgress?.('Live Coding compile…');
    const r = await liveCoding({ bridge, project, timeoutMs: 600000, onLine: onProgress });
    const diags = parseDiagnostics(r.lines.join('\n'), project.dir);
    return record({ ok: r.ok, mode: 'livecoding', timeout: r.timeout, errors: diags.filter((d) => d.severity === 'error').length, diagnostics: diags.slice(0, 40), log_tail: r.lines.slice(-15) });
  }
  const tc = toolchainProblem();
  if (tc) return { ok: false, mode: 'ubt', error: 'toolchain_missing', message: tc };
  if (!engineDir) return { ok: false, error: 'engine_not_found', message: 'Could not find the engine. Set UE_ENGINE_DIR or start the editor once so the bridge reports it.' };

  let relaunch = false;
  if (editorUp && process.platform !== 'win32') {
    if (!restartEditor) {
      return {
        ok: false, mode: 'ubt', error: 'editor_running',
        message: 'The editor is running and cannot hot-apply C++ on this platform. Call ue_build with restart_editor: true '
          + '(saves everything, closes the editor, compiles, relaunches and reconnects), or close the editor first.',
      };
    }
    onProgress?.('Saving and closing the editor…');
    const pid = bridge.info.pid;
    try { await bridge.call('save', {}, { timeout: 120000 }); } catch { /* best effort */ }
    try { await bridge.call('python', { code: 'unreal.SystemLibrary.quit_editor()', timeout: 10 }); } catch { /* connection drops */ }
    const end = Date.now() + 90000;
    while (pidAlive(pid) && Date.now() < end) await sleep(500);
    if (pidAlive(pid)) return { ok: false, error: 'editor_did_not_quit', message: 'The editor did not close (unsaved-changes dialog?). Close it manually and retry.' };
    relaunch = true;
  }

  onProgress?.(`UnrealBuildTool: ${project.name}Editor ${PLATFORM} ${config}`);
  let lines = 0;
  const r = await runUbt({ engineDir, project, config, signal, onLine: (l) => { if (++lines % 25 === 0 || /error|warning/i.test(l)) onProgress?.(l.slice(0, 200)); } });
  const logPath = path.join(project.dir, 'Saved', 'UEAgentBridge', 'build.log');
  try { fs.mkdirSync(path.dirname(logPath), { recursive: true }); fs.writeFileSync(logPath, r.out); } catch { /* ignore */ }
  const diags = parseDiagnostics(r.out, project.dir);
  const ok = r.code === 0;
  const res = {
    ok, mode: 'ubt', exit_code: r.code,
    errors: diags.filter((d) => d.severity === 'error').length,
    warnings: diags.filter((d) => d.severity === 'warning').length,
    diagnostics: diags.slice(0, 40),
    full_log: logPath,
  };
  if (!ok && !diags.length) res.log_tail = r.out.split(/\r?\n/).filter(Boolean).slice(-25);
  if (relaunch) {
    onProgress?.(ok ? 'Relaunching the editor…' : 'Build failed; relaunching the previous editor build…');
    launchEditor(project.file, engineDir);
    try {
      const info = await bridge.waitForEditor(300000, { onTick: () => onProgress?.('waiting for the editor bridge…') });
      res.editor = { relaunched: true, pid: info.pid };
    } catch (e) {
      res.editor = { relaunched: true, connected: false, message: e.message };
    }
  }
  return record(res);
}
