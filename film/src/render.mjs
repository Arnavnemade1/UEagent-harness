// Orchestrates a render: bake -> local server -> headless Chrome -> frames -> MP4.
import path from 'node:path';
import { launchChrome, openPage } from './chrome.mjs';
import { startServer } from './server.mjs';
import fs from 'node:fs';
import { FilmError } from './spec.mjs';
import { acquireLease } from './lease.mjs';
import { prepareFilm } from './preflight.mjs';
import { modelInfo } from './media.mjs';

export async function render(file, { out, frames, samples, quality, memoryGB, timeoutMin = 60, framesDir, show = false, onProgress = () => {}, onLog = () => {}, probe = null } = {}) {
  const t0 = Date.now();
  if (!Number.isFinite(timeoutMin) || timeoutMin <= 0) throw new FilmError('timeoutMin must be positive');
  const { loaded, baked, assets, plate, plan, report } = await prepareFilm(file, { frames, samples, quality, memoryGB });
  const outFile = out === false ? null : path.resolve(out || path.join(loaded.dir, 'out', `${path.basename(file).replace(/\.(m?js|json)$/, '')}.mp4`));
  const release = outFile ? acquireLease(outFile + '.render.lock') : () => {};
  let browser, server;
  try {
    server = await startServer({ baked, assets, plate, outFile, framesDir: framesDir ? path.resolve(framesDir) : null });
    browser = await launchChrome({ headless: !show, width: baked.width, height: baked.height, onLog, memoryGB: plan.memoryGB, timeoutMs: timeoutMin * 60000 });
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
      quality: plan, inputs: report.inputs, warnings: report.warnings,
      resource: { peakProcessTreeBytes: browser.guard.peakBytes, memoryGB: plan.memoryGB, sampleIntervalMs: 3000 },
      validation: outFile ? 'MP4 structure and encoded frame count validated before atomic publication' : 'rendered frames; no video requested',
    };
  } finally {
    try { await browser?.close(); } finally { try { await server?.close(); } finally { release(); } }
  }
}

export async function preview(file, { onLog = () => {} } = {}) {
  const { baked, assets, plate, plan } = await prepareFilm(file, { quality: 'preview' });
  const server = await startServer({ baked, assets, plate });
  let browser;
  try {
    browser = await launchChrome({ headless: false, width: Math.min(1440, baked.width + 40), height: Math.min(1000, baked.height + 120), onLog, memoryGB: plan.memoryGB });
    await openPage(browser.cdp, `${server.url}/?mode=preview`, { width: Math.min(1440, baked.width + 40), height: Math.min(1000, baked.height + 120) });
    return { url: `${server.url}/?mode=preview`, close: async () => { try { await browser.close(); } finally { await server.close(); } }, exited: new Promise((r) => { if (browser.proc.exitCode !== null || browser.proc.signalCode !== null) r(); else browser.proc.once('exit', r); }) };
  } catch (e) { try { await browser?.close(); } finally { await server.close(); } throw e; }
}

/** Inspect a glTF/GLB model: clips, durations, natural ground speed, height, facing. */
export async function inspect(model) {
  const abs = path.resolve(model);
  if (!fs.existsSync(abs)) throw new FilmError(`model not found: ${abs}`);
  modelInfo(abs);
  const assets = { dirs: [path.dirname(abs)] };
  const server = await startServer({ baked: null, assets, plate: null });
  let browser;
  try {
    browser = await launchChrome({});
    const page = await openPage(browser.cdp, `${server.url}/?mode=inspect`);
    for (let i = 0; i < 100 && !(await page.evaluate('!!window.hfilm')); i++) await new Promise((r) => setTimeout(r, 50));
    return { ok: true, model: abs, ...(await page.evaluate(`hfilm.inspect(${JSON.stringify(`/asset/0/${encodeURIComponent(path.basename(abs))}`)})`)) };
  } finally {
    try { await browser?.close(); } finally { await server.close(); }
  }
}
