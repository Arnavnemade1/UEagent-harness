#!/usr/bin/env node
// hfilm: film-quality video from code (three.js motion, offline film-mode rendering,
// optional compositing over Unreal Engine or any other plates).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { doctor } from '../src/doctor.mjs';
import { inspect, preview, render } from '../src/render.mjs';
import { bakeFilm, FilmError, loadFilm } from '../src/spec.mjs';

const HELP = `hfilm: film-quality video from code

Usage
  hfilm render <film.mjs|film.json> [-o out.mp4] [--frames 0:150] [--samples 16] [--frames-dir dir] [--show] [--json]
  hfilm preview <film>                 live player with scrubber (toggle film quality on any frame)
  hfilm bake <film> [-o baked.json]    evaluate the film to per-frame tracks (for other renderers / debugging)
  hfilm ue plates <film> --project P.uproject --map /Game/Maps/Level [--hide Folder,Label,tag:T] [--holdouts Folder,...]
                    [--grid MaterialName] [--ground ActorLabel] [--preset /Game/.../MRQConfig] [--memory 9] [--name shot] [--skip-render]
                    [--resume] [--timeout 120]
                                       render background plates + holdouts + sun from Unreal for this film's cameras
  hfilm inspect <model.glb>            clips, durations, ground speed (m/s) per clip, height, facing
  hfilm init <dir> [--template basic|soccer-goal]
  hfilm doctor [--json]                check Chrome, GPU, H.264, Unreal

Docs: README.md next to this CLI. Every command accepts --json for machine-readable output.`;

function parse(argv) {
  const out = { _: [] };
  const flags = new Set(['json', 'show', 'help', 'skip-render', 'resume']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o') out.o = argv[++i];
    else if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      out[k] = v ?? (flags.has(k) ? true : argv[++i]);
    } else out._.push(a);
  }
  return out;
}

const range = (s) => {
  if (!s) return undefined;
  const m = String(s).match(/^(\d+):(\d+)$/);
  if (!m) throw new FilmError(`--frames: expected start:end (end exclusive), e.g. 0:150, got ${s}`);
  return [+m[1], +m[2]];
};

async function main() {
  const args = parse(process.argv.slice(2));
  const [cmd, ...rest] = args._;
  const json = !!args.json;
  const say = (obj, text) => console.log(json ? JSON.stringify(obj) : text);
  if (!cmd || args.help || cmd === 'help') return console.log(HELP);

  if (cmd === 'doctor') {
    const r = await doctor();
    if (json) return console.log(JSON.stringify(r));
    for (const c of r.checks) console.log(`${c.ok ? '✓' : c.optional ? '·' : '✗'} ${c.name.padEnd(14)} ${c.detail}`);
    if (!r.ok) process.exitCode = 1;
    return;
  }
  if (cmd === 'render') {
    const file = rest[0] || fail('render: missing <film> path');
    let last = 0;
    const res = await render(file, {
      out: args.o, frames: range(args.frames), samples: args.samples ? +args.samples : undefined, framesDir: args['frames-dir'], show: args.show,
      onLog: (lvl, msg) => { if (lvl === 'error' || lvl === 'warn' || process.env.HFILM_DEBUG) process.stderr.write(`[page ${lvl}] ${msg}\n`); },
      onProgress: ({ index, count, ms }) => {
        if (json) return;
        const now = Date.now();
        if (now - last > 250 || index === count - 1) { last = now; process.stdout.write(`\r  frame ${index + 1}/${count}  ${ms} ms/frame   `); }
      },
    });
    if (!json) process.stdout.write('\n');
    return say(res, `✓ ${res.output} (${res.frames} frames, ${res.size.join('x')}@${res.fps}, ${res.samples} samples/frame, ${res.avgFrameMs} ms/frame, ${res.seconds}s, ${res.gpu})`);
  }
  if (cmd === 'preview') {
    const file = rest[0] || fail('preview: missing <film> path');
    const p = await preview(file, { onLog: (lvl, msg) => process.stderr.write(`[page ${lvl}] ${msg}\n`) });
    say({ ok: true, url: p.url }, `Preview open: ${p.url}  (close the window or Ctrl+C to stop)`);
    process.on('SIGINT', async () => { await p.close(); process.exit(0); });
    await p.exited;
    return p.close();
  }
  if (cmd === 'bake') {
    const file = rest[0] || fail('bake: missing <film> path');
    const { baked } = bakeFilm(await loadFilm(file), { frames: range(args.frames) });
    const outPath = args.o || file.replace(/\.(m?js|json)$/, '.baked.json');
    fs.writeFileSync(outPath, JSON.stringify(baked));
    return say({ ok: true, output: outPath, frames: baked.end - baked.start }, `✓ ${outPath} (${baked.end - baked.start} frames, ${baked.actors.length} actors)`);
  }
  if (cmd === 'ue') {
    const { uePlates } = await import('../src/ue.mjs');
    if (rest[0] !== 'plates') fail('ue: only "hfilm ue plates <film> ..." is supported');
    const res = await uePlates(rest[1] || fail('ue plates: missing <film> path'), {
      project: args.project, map: args.map, hide: args.hide, holdouts: args.holdouts, engine: args.engine, out: args.o,
      grid: args.grid, ground: args.ground, preset: args.preset, name: args.name, memoryGB: args.memory ? +args.memory : undefined,
      temporalSamples: args['temporal-samples'], skipRender: !!args['skip-render'], resume: !!args.resume,
      timeoutMin: args.timeout ? +args.timeout : undefined,
      log: (m) => { if (!json) console.log(m); },
    });
    return say(res, `✓ plates: ${res.plates}\n✓ holdouts: ${res.holdouts} (${res.holdoutCount})\n✓ sun: ${JSON.stringify(res.sun)}`);
  }
  if (cmd === 'inspect') {
    const r = await inspect(rest[0] || fail('inspect: missing <model.glb>'));
    if (json) return console.log(JSON.stringify(r));
    console.log(`${r.model}\n  height ${r.height} m · facing ${r.facing} · ${r.bones} bones · materials: ${r.materials.join(', ')}`);
    for (const c of r.clips) console.log(`  ${c.name.padEnd(28)} ${String(c.duration).padStart(6)} s${c.groundSpeed ? `   ground speed ${c.groundSpeed} m/s` : ''}`);
    return;
  }
  if (cmd === 'init') {
    const dir = path.resolve(rest[0] || fail('init: missing <dir>'));
    const tpl = args.template || 'basic';
    const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', tpl);
    if (!fs.existsSync(src)) fail(`init: unknown template "${tpl}" (basic, soccer-goal)`);
    if (fs.existsSync(dir) && fs.readdirSync(dir).length) fail(`init: ${dir} is not empty`);
    fs.cpSync(src, dir, { recursive: true, filter: (p) => !/[\\/](plates|out)([\\/]|$)|ual_mannequin\.glb$/.test(p) });
    return say({ ok: true, dir }, `✓ ${dir}\n  next: hfilm preview ${path.join(dir, 'film.mjs')}`);
  }
  fail(`unknown command "${cmd}"\n\n${HELP}`);
}

function fail(msg) { throw new FilmError(msg); }

main().catch((e) => {
  const known = e instanceof FilmError;
  if (process.argv.includes('--json')) console.log(JSON.stringify({ ok: false, error: e.message }));
  else console.error(`✗ ${known ? e.message : e.stack || e}`);
  process.exitCode = known ? 2 : 1;
});
