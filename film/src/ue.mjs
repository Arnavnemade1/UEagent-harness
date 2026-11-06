// Unreal Engine plate provider: renders the static world (everything except the actors the film
// re-creates) from the film's own cameras, and exports holdouts, the sun and hidden-actor
// transforms. Two headless Unreal runs: a commandlet that prepares assets, then a game-mode
// Movie Render Queue render under a memory cap.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bakeFilm, FilmError, loadFilm } from './spec.mjs';
import { runProcess as run } from './process.mjs';
import { imageInfo, validateImages } from './media.mjs';
import { acquireLease } from './lease.mjs';

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

export async function uePlates(file, opts = {}) {
  if (!opts.project || !fs.existsSync(opts.project)) throw new FilmError('--project: existing .uproject required');
  const release = acquireLease(path.join(path.dirname(path.resolve(opts.project)), 'Saved', 'HFilm', 'render.lock'));
  try { return await plateJob(file, opts); } finally { release(); }
}

async function plateJob(file, opts) {
  const log = opts.log || (() => {});
  const root = opts.engine || findUnreal();
  if (!root) throw new FilmError('Unreal Engine not found: pass --engine <UE root> or set UE_ROOT');
  const exe = editorCmd(root);
  if (!opts.project || !fs.existsSync(opts.project)) throw new FilmError('--project: path to the .uproject is required');
  if (!opts.map || !opts.map.startsWith('/')) throw new FilmError('--map: Unreal map path is required, e.g. /Game/Maps/MyLevel');
  const memoryGB = opts.memoryGB ?? 7;
  const timeoutMin = opts.timeoutMin ?? 120;
  if (!Number.isFinite(memoryGB) || memoryGB < 0.5 || memoryGB > os.totalmem() / 1024 ** 3 * 0.8) throw new FilmError('memory: expected 0.5 GiB to 80% of physical memory');
  if (!Number.isFinite(timeoutMin) || timeoutMin <= 0) throw new FilmError('timeout: expected positive minutes');
  if (opts.assetDir && !/^\/Game(?:\/[A-Za-z0-9_]+)+$/.test(opts.assetDir)) throw new FilmError('assetDir: expected a /Game folder without traversal');
  const discovery = path.join(path.dirname(path.resolve(opts.project)), 'Saved', 'UEAgentBridge', 'bridge.json');
  if (fs.existsSync(discovery)) {
    const info = JSON.parse(fs.readFileSync(discovery, 'utf8'));
    let alive = false;
    if (Number.isInteger(info.pid) && info.pid > 0) { try { process.kill(info.pid, 0); alive = true; } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    if (alive) throw new FilmError('Close this project’s editor before starting a separate plate worker; generated assets and memory must not be shared concurrently.');
  }
  const loaded = await loadFilm(file);
  const { baked } = bakeFilm(loaded, { ignorePlate: true });
  const name = (opts.name || path.basename(file).replace(/\.(m?js|json)$/, '')).replace(/[^A-Za-z0-9_]/g, '_');
  const outDir = path.resolve(opts.out || path.join(loaded.dir, 'plates', name));
  fs.mkdirSync(outDir, { recursive: true });
  // --resume continues an interrupted render, but only for the same cameras, size and frame range
  const camHash = createHash('sha1').update(JSON.stringify([baked.camera, baked.width, baked.height, baked.start, baked.end, baked.cuts, baked.fps, path.resolve(opts.project), opts.map, root, opts.preset, list(opts.hide), list(opts.holdouts), opts.ground, opts.grid, opts.gridCell, opts.gridLine, opts.temporalSamples ?? 4, fs.statSync(opts.project).mtimeMs, sourceState(opts.project, opts.assetDir || '/Game/HFilm', name, opts.map)])).digest('hex');
  const hashFile = path.join(outDir, 'cameras.sha1');
  const plateFile = (i) => path.join(outDir, `LS_HFilm_${name}.${String(i).padStart(4, '0')}.jpeg`);
  let renderStart = 0;
  if (opts.skipRender && (!fs.existsSync(hashFile) || fs.readFileSync(hashFile, 'utf8').trim() !== camHash)) throw new FilmError('--skip-render requires matching existing plate inputs; changed inputs need a new render.');
  if (opts.resume && !opts.skipRender) {
    const prev = fs.existsSync(hashFile) ? fs.readFileSync(hashFile, 'utf8').trim() : null;
    if (prev !== camHash) throw new FilmError('--resume: the cameras, size or frame range changed since these plates were rendered (or there is no earlier run). Run without --resume.');
    while (renderStart < baked.end - baked.start) {
      try { const info = imageInfo(plateFile(renderStart)); if (info.width !== baked.width || info.height !== baked.height) break; renderStart++; } catch { break; }
    }
    renderStart = Math.max(0, renderStart - 1);   // the last plate may have been cut off mid-write
    if (fs.existsSync(plateFile(renderStart))) fs.unlinkSync(plateFile(renderStart));
    log(`resuming at plate ${renderStart} of ${baked.end - baked.start}`);
  } else if (!opts.skipRender) for (const f of fs.readdirSync(outDir)) if (f.startsWith(`LS_HFilm_${name}.`) && /\.jpeg$/i.test(f)) fs.unlinkSync(path.join(outDir, f));
  const job = {
    map: opts.map, name, outDir, assetDir: opts.assetDir || '/Game/HFilm',
    hide: list(opts.hide), holdouts: list(opts.holdouts), ground: opts.ground || null, preset: opts.preset || null,
    grid: opts.grid ? { material: opts.grid, cell: +(opts.gridCell || 0.1), line: +(opts.gridLine || 0.064) } : null,
    temporalSamples: +(opts.temporalSamples ?? 4), renderStart,
    fps: baked.fps, width: baked.width, height: baked.height, start: baked.start, end: baked.end, cuts: baked.cuts, camera: baked.camera,
  };
  if (!Number.isInteger(job.temporalSamples) || job.temporalSamples < 1 || job.temporalSamples > 64) throw new FilmError('temporalSamples: expected integer 1..64');
  if (!Number.isInteger(job.fps)) throw new FilmError('Unreal plates currently require integer fps; use integer timing for this provider.');
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
    logFile: path.join(outDir, 'prepare.log'), env: { HFILM_JOB: jobFile }, memoryGB, timeoutMin: 30,
  });
  if (prep.code !== 0 || prep.stopped || !fs.existsSync(prepared)) throw new FilmError(`prepare step produced no result (exit ${prep.code}${prep.stopped ? `, ${prep.stopped}` : ''}); see ${path.join(outDir, 'prepare.log')}`);
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
  fs.writeFileSync(hashFile, camHash);
  log(`2/2 rendering ${n - renderStart} plates (${baked.width}x${baked.height}) with Movie Render Queue…`);
  const seqName = prep2.sequence.split('/').pop(), cfgName = prep2.config.split('/').pop();
  let lastPrint = 0;
  const count = () => fs.readdirSync(outDir).filter((f) => f.startsWith(`LS_HFilm_${name}.`) && /\.jpeg$/i.test(f)).length;
  const render = await run(exe, [path.resolve(opts.project), prep2.plateMap, '-game', `-LevelSequence=${prep2.sequence}.${seqName}`, `-MoviePipelineConfig=${prep2.config}.${cfgName}`,
    '-windowed', `-ResX=${baked.width}`, `-ResY=${baked.height}`, '-unattended', '-nosplash', '-stdout', '-FullStdOutLogOutput', '-NoLoadingScreen'], {
    logFile: path.join(outDir, 'render.log'), memoryGB, timeoutMin,
    onTick: ({ bytes, metric }) => { const now = Date.now(); if (now - lastPrint >= 15000) { lastPrint = now; log(`   ${count()}/${n} plates · ${(bytes / 1024 ** 3).toFixed(2)} GiB (${metric})`); } },
  });
  const done = count();
  if (render.code !== 0 || render.stopped || done < n) throw new FilmError(`plate render incomplete: ${done}/${n} frames (exit ${render.code}${render.stopped ? `, ${render.stopped}` : ''}); see ${path.join(outDir, 'render.log')}`);
  const validation = validateImages((function* () { for (let i = 0; i < n; i++) yield plateFile(i); })(), { width: baked.width, height: baked.height });
  const pattern = `LS_HFilm_${name}.{frame:4}.jpeg`;
  const summary = {
    ok: true, validation, resource: { memoryGB, peakBytes: render.peakBytes }, plates: path.join(outDir, pattern), frames: n, offset: -baked.start,
    holdouts: path.join(outDir, 'holdouts.json'), holdoutCount: prep2.holdoutCount, hidden: path.join(outDir, 'hidden.json'),
    sun: prep2.sun, groundY: prep2.groundY, sequence: prep2.sequence, plateMap: prep2.plateMap, folders: prep2.folders,
    usage: { plate: { frames: path.relative(loaded.dir, path.join(outDir, pattern)), offset: -baked.start }, holdouts: path.relative(loaded.dir, path.join(outDir, 'holdouts.json')) },
  };
  fs.writeFileSync(path.join(outDir, 'plates.json'), JSON.stringify(summary, null, 1));
  return summary;
}

export function sourceState(project, generated, name, sourceMap) {
  const root = path.join(path.dirname(path.resolve(project)), 'Content');
  const excluded = generated.replace(/^\/Game\//, '').split('/').join(path.sep);
  const mapName = `${sourceMap.split('/').pop()}_HFilmPlates_${name}`;
  const generatedFiles = new Set([`LS_HFilm_${name}.uasset`, `MRQ_HFilm_${name}.uasset`, `${mapName}.umap`, `${mapName}_BuiltData.uasset`].map((f) => path.join(excluded, f)));
  const external = path.join('__ExternalActors__', excluded, mapName);
  const hash = createHash('sha256');
  const scan = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name), rel = path.relative(root, file);
      if (generatedFiles.has(rel) || rel === external || rel.startsWith(external + path.sep)) continue;
      if (entry.isDirectory()) scan(file);
      else if (entry.isFile() && /\.(uasset|umap|ini)$/.test(file)) { const stat = fs.statSync(file); hash.update(JSON.stringify([rel, stat.size, stat.mtimeMs])); }
    }
  };
  scan(root);
  scan(path.join(path.dirname(root), 'Config'));
  return hash.digest('hex');
}
