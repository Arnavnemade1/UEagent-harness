// Orchestrates a render: bake -> local server -> headless Chrome -> frames -> MP4.
import path from 'node:path';
import { launchChrome, openPage } from './chrome.mjs';
import { startServer } from './server.mjs';
import fs from 'node:fs';
import { bakeFilm, FilmError, loadFilm } from './spec.mjs';

export async function render(file, { out, frames, samples, framesDir, show = false, onProgress = () => {}, onLog = () => {}, probe = null } = {}) {
  const t0 = Date.now();
  const loaded = await loadFilm(file);
  const { baked, assets, plate } = bakeFilm(loaded, { frames, samples });
  const outFile = out === false ? null : path.resolve(out || path.join(loaded.dir, 'out', `${path.basename(file).replace(/\.(m?js|json)$/, '')}.mp4`));
  const server = await startServer({ baked, assets, plate, outFile, framesDir: framesDir ? path.resolve(framesDir) : null });
  const browser = await launchChrome({ headless: !show, width: baked.width, height: baked.height, onLog });
  try {
    const page = await openPage(browser.cdp, `${server.url}/?mode=render`, { width: baked.width, height: baked.height });
    for (let i = 0; i < 100 && !(await page.evaluate('!!window.hfilm')); i++) await new Promise((r) => setTimeout(r, 50));
    const info = await page.evaluate('hfilm.init()');
    if (outFile) await page.evaluate(`hfilm.startVideo(${JSON.stringify({ bitrate: baked.render.bitrate })})`);
    let total = 0;
    for (let f = baked.start, i = 0; f < baked.end; f++, i++) {
      const r = await page.evaluate(`hfilm.render(${f})`);
      if (outFile) await page.evaluate(`hfilm.encode(${i})`);
      if (framesDir) await page.evaluate(`hfilm.snapshot(${f})`);
      if (probe && probe.frames.includes(f)) probe.results[f] = await page.evaluate(`hfilm.sample(${JSON.stringify(probe.points)})`);
      total += r.ms;
      onProgress({ frame: f, index: i, count: baked.end - baked.start, ms: r.ms });
    }
    const bytes = outFile ? await page.evaluate('hfilm.finishVideo()') : 0;
    const count = baked.end - baked.start;
    return {
      ok: true, output: outFile, bytes, frames: count, fps: baked.fps, size: [baked.width, baked.height],
      samples: baked.render.samples, gpu: info.gpu, actors: info.actors, holdouts: info.holdouts, plate: info.plate,
      avgFrameMs: Math.round(total / count), seconds: Math.round((Date.now() - t0) / 100) / 10,
    };
  } finally {
    await browser.close();
    await server.close();
  }
}

export async function preview(file, { onLog = () => {} } = {}) {
  const loaded = await loadFilm(file);
  const { baked, assets, plate } = bakeFilm(loaded, {});
  const server = await startServer({ baked, assets, plate });
  const browser = await launchChrome({ headless: false, width: Math.min(1440, baked.width + 40), height: Math.min(1000, baked.height + 120), onLog });
  await openPage(browser.cdp, `${server.url}/?mode=preview`, { width: Math.min(1440, baked.width + 40), height: Math.min(1000, baked.height + 120) });
  return { url: `${server.url}/?mode=preview`, close: async () => { await browser.close(); await server.close(); }, exited: new Promise((r) => browser.proc.on('exit', r)) };
}

/** Inspect a glTF/GLB model: clips, durations, natural ground speed, height, facing. */
export async function inspect(model) {
  const abs = path.resolve(model);
  if (!fs.existsSync(abs)) throw new FilmError(`model not found: ${abs}`);
  const assets = { dirs: [path.dirname(abs)] };
  const server = await startServer({ baked: null, assets, plate: null });
  const browser = await launchChrome({});
  try {
    const page = await openPage(browser.cdp, `${server.url}/?mode=inspect`);
    for (let i = 0; i < 100 && !(await page.evaluate('!!window.hfilm')); i++) await new Promise((r) => setTimeout(r, 50));
    return { ok: true, model: abs, ...(await page.evaluate(`hfilm.inspect(${JSON.stringify(`/asset/0/${encodeURIComponent(path.basename(abs))}`)})`)) };
  } finally {
    await browser.close();
    await server.close();
  }
}
