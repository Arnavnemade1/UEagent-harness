// Unreal Engine plate provider: renders the static world (everything except the actors the film
// re-creates) from the film's own cameras, and exports holdouts, the sun and hidden-actor
// transforms. Two headless Unreal runs: a commandlet that prepares assets, then a game-mode
// Movie Render Queue render under a memory cap.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bakeFilm, FilmError, loadFilm } from './spec.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function findUnreal() {
  const roots = [process.env.UE_ROOT];
  if (process.platform === 'darwin') for (const v of ['5.8', '5.7', '5.6', '5.5', '5.4']) roots.push(`/Users/Shared/Epic Games/UE_${v}`);
  if (process.platform === 'win32') for (const v of ['5.8', '5.7', '5.6', '5.5', '5.4']) roots.push(`C:/Program Files/Epic Games/UE_${v}`);
  if (process.platform === 'linux') roots.push(path.join(os.homedir(), 'UnrealEngine'));
  for (const r of roots.filter(Boolean)) if (fs.existsSync(path.join(r, 'Engine'))) return r;
  return null;
}

function editorCmd(root) {
  const bin = { darwin: 'Mac/UnrealEditor-Cmd', win32: 'Win64/UnrealEditor-Cmd.exe', linux: 'Linux/UnrealEditor-Cmd' }[process.platform];
  const exe = path.join(root, 'Engine', 'Binaries', bin);
  if (!fs.existsSync(exe)) throw new FilmError(`Unreal editor binary not found: ${exe}`);
  return exe;
}

const list = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((s) => s.trim()).filter(Boolean);

function rssBytes(pid) {
  try {
    const { execFileSync } = _cp;
    if (process.platform === 'win32') return 0;
    return parseInt(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim(), 10) * 1024 || 0;
  } catch { return 0; }
}
let _cp = null;

function run(exe, args, { logFile, env, memoryGB, onTick, timeoutMin = 120 }) {
  return new Promise((resolve) => {
    const out = fs.openSync(logFile, 'w');
    const proc = spawn(exe, args, { stdio: ['ignore', out, out], env: { ...process.env, UE_AGENT_BRIDGE_DISABLE: '1', ...env } });
    const started = Date.now();
    let stopped = null;
    const timer = setInterval(() => {
      const rss = rssBytes(proc.pid);
      onTick?.({ rssGB: Math.round(rss / 1e8) / 10, seconds: Math.round((Date.now() - started) / 1000) });
      if (memoryGB && rss > memoryGB * 1024 ** 3) stopped = `memory cap ${memoryGB} GB reached`;
      if (Date.now() - started > timeoutMin * 60000) stopped = `timeout ${timeoutMin} min`;
      if (stopped) { proc.kill('SIGTERM'); setTimeout(() => proc.kill('SIGKILL'), 15000).unref(); }
    }, 3000);
    proc.on('exit', (code) => { clearInterval(timer); fs.closeSync(out); resolve({ code, stopped }); });
  });
}

export async function uePlates(file, opts = {}) {
  const log = opts.log || (() => {});
  _cp = await import('node:child_process');
  const root = opts.engine || findUnreal();
  if (!root) throw new FilmError('Unreal Engine not found: pass --engine <UE root> or set UE_ROOT');
  const exe = editorCmd(root);
  if (!opts.project || !fs.existsSync(opts.project)) throw new FilmError('--project: path to the .uproject is required');
  if (!opts.map || !opts.map.startsWith('/')) throw new FilmError('--map: Unreal map path is required, e.g. /Game/Maps/MyLevel');
  const loaded = await loadFilm(file);
  const { baked } = bakeFilm(loaded, { ignorePlate: true });
  const name = (opts.name || path.basename(file).replace(/\.(m?js|json)$/, '')).replace(/[^A-Za-z0-9_]/g, '_');
  const outDir = path.resolve(opts.out || path.join(loaded.dir, 'plates', name));
  fs.mkdirSync(outDir, { recursive: true });
  if (!opts.skipRender) for (const f of fs.readdirSync(outDir)) if (/\.(jpe?g|png|exr)$/i.test(f)) fs.unlinkSync(path.join(outDir, f));
  const job = {
    map: opts.map, name, outDir, assetDir: opts.assetDir || '/Game/HFilm',
    hide: list(opts.hide), holdouts: list(opts.holdouts), ground: opts.ground || null, preset: opts.preset || null,
    grid: opts.grid ? { material: opts.grid, cell: +(opts.gridCell || 0.1), line: +(opts.gridLine || 0.064) } : null,
    temporalSamples: +(opts.temporalSamples || 4),
    fps: baked.fps, width: baked.width, height: baked.height, start: baked.start, end: baked.end, cuts: baked.cuts, camera: baked.camera,
  };
  // clear this provider's previously generated assets (only HFilm-namespaced files for this name) while
  // Unreal is not running; deleting a loaded world from inside Unreal is not reliable
  const contentDir = path.join(path.dirname(path.resolve(opts.project)), 'Content', ...job.assetDir.replace(/^\/Game\/?/, '').split('/').filter(Boolean));
  const mapName = `${opts.map.split('/').pop()}_HFilmPlates_${name}`;
  for (const f of [`LS_HFilm_${name}.uasset`, `MRQ_HFilm_${name}.uasset`, `${mapName}.umap`, `${mapName}_BuiltData.uasset`]) {
    const p = path.join(contentDir, f);
    if (fs.existsSync(p)) fs.rmSync(p);
  }
  const ext = path.join(path.dirname(path.resolve(opts.project)), 'Content', '__ExternalActors__', ...job.assetDir.replace(/^\/Game\/?/, '').split('/').filter(Boolean), mapName);
  if (fs.existsSync(ext)) fs.rmSync(ext, { recursive: true, force: true });
  const jobFile = path.join(outDir, 'job.json');
  fs.writeFileSync(jobFile, JSON.stringify(job));
  const prepared = path.join(outDir, 'prepared.json');
  if (fs.existsSync(prepared)) fs.unlinkSync(prepared);

  log(`1/2 preparing plates map, cameras and holdouts (headless Unreal)…`);
  const prep = await run(exe, [path.resolve(opts.project), '-run=pythonscript', `-script=${path.join(HERE, '..', 'ue', 'hfilm_ue.py')}`, '-unattended', '-nosplash', '-nullrhi', '-stdout', '-FullStdOutLogOutput'], {
    logFile: path.join(outDir, 'prepare.log'), env: { HFILM_JOB: jobFile }, memoryGB: opts.memoryGB || 10, timeoutMin: 30,
  });
  if (!fs.existsSync(prepared)) throw new FilmError(`prepare step produced no result (exit ${prep.code}${prep.stopped ? `, ${prep.stopped}` : ''}); see ${path.join(outDir, 'prepare.log')}`);
  const prep2 = JSON.parse(fs.readFileSync(prepared, 'utf8'));
  if (!prep2.ok) throw new FilmError(`prepare failed: ${prep2.error}\n${prep2.trace || ''}`);
  for (const l of prep2.log) log(`   ${l}`);

  const n = baked.end - baked.start;
  if (opts.skipRender) {
    log('2/2 skipped (--skip-render): holdouts, sun and hidden actors refreshed; existing plates kept');
    const s = JSON.parse(fs.readFileSync(path.join(outDir, 'plates.json'), 'utf8'));
    Object.assign(s, { holdoutCount: prep2.holdoutCount, sun: prep2.sun, groundY: prep2.groundY, folders: prep2.folders });
    fs.writeFileSync(path.join(outDir, 'plates.json'), JSON.stringify(s, null, 1));
    return s;
  }
  log(`2/2 rendering ${n} plates (${baked.width}x${baked.height}) with Movie Render Queue…`);
  const seqName = prep2.sequence.split('/').pop(), cfgName = prep2.config.split('/').pop();
  let lastPrint = 0;
  const count = () => fs.readdirSync(outDir).filter((f) => /\.jpe?g$/i.test(f)).length;
  const render = await run(exe, [path.resolve(opts.project), prep2.plateMap, '-game', `-LevelSequence=${prep2.sequence}.${seqName}`, `-MoviePipelineConfig=${prep2.config}.${cfgName}`,
    '-windowed', `-ResX=${baked.width}`, `-ResY=${baked.height}`, '-unattended', '-nosplash', '-stdout', '-FullStdOutLogOutput', '-NoLoadingScreen'], {
    logFile: path.join(outDir, 'render.log'), memoryGB: opts.memoryGB || 9, timeoutMin: opts.timeoutMin || 120,
    onTick: ({ rssGB, seconds }) => { if (seconds - lastPrint >= 15) { lastPrint = seconds; log(`   ${count()}/${n} plates · ${rssGB} GB · ${seconds}s`); } },
  });
  const done = count();
  if (done < n) throw new FilmError(`plate render incomplete: ${done}/${n} frames (exit ${render.code}${render.stopped ? `, ${render.stopped}` : ''}); see ${path.join(outDir, 'render.log')}`);
  const pattern = `LS_HFilm_${name}.{frame:4}.jpeg`;
  const summary = {
    ok: true, plates: path.join(outDir, pattern), frames: n, offset: -baked.start,
    holdouts: path.join(outDir, 'holdouts.json'), holdoutCount: prep2.holdoutCount, hidden: path.join(outDir, 'hidden.json'),
    sun: prep2.sun, groundY: prep2.groundY, sequence: prep2.sequence, plateMap: prep2.plateMap, folders: prep2.folders,
    usage: { plate: { frames: path.relative(loaded.dir, path.join(outDir, pattern)), offset: -baked.start }, holdouts: path.relative(loaded.dir, path.join(outDir, 'holdouts.json')) },
  };
  fs.writeFileSync(path.join(outDir, 'plates.json'), JSON.stringify(summary, null, 1));
  return summary;
}
