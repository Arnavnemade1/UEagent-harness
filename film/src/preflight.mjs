import { bakeFilm, loadFilm } from './spec.mjs';
import { qualityPlan } from './quality.mjs';

export async function prepareFilm(file, options = {}) {
  const loaded = await loadFilm(file);
  const plan = qualityPlan(loaded.film, options);
  const result = bakeFilm({ ...loaded, film: plan.film }, options);
  // Header dimensions catch textures whose tiny compressed files expand into
  // very large allocations. Unknown embedded GLB images remain an estimate.
  const assetBytes = result.media.reduce((sum, item) => sum + (item.width && item.height
    ? item.width * item.height * (['hdr', 'exr'].includes(item.format) ? 16 : 6)
    : item.bytes * (item.kind === 'model' ? 6 : 2)), 0);
  const trackBytes = (result.baked.actors.length + 1) * result.frames * 256;
  const estimatedBytes = plan.baseBytes + assetBytes + trackBytes;
  if (estimatedBytes > plan.memoryGB * 1024 ** 3 * 0.8) throw new Error(`Estimated render allocation ${(estimatedBytes / 1024 ** 3).toFixed(2)} GiB exceeds the planning headroom for ${plan.memoryGB} GiB. Reduce texture size, split the shot, or select preview quality.`);
  const { film: ignored, ...publicPlan } = plan;
  return { ...result, loaded, plan: { ...publicPlan, estimatedBytes, assetBytes, trackBytes },
    report: { ok: true, film: loaded.file, frames: result.frames, fps: result.baked.fps, size: plan.size,
      quality: { ...publicPlan, estimatedBytes, assetBytes, trackBytes }, inputs: result.media,
      warnings: result.warnings, validation: 'All expected plate paths and media headers/dependencies checked. Pixel decoding and subjective visual quality require a preview.' } };
}

export async function preflight(file, options) { return (await prepareFilm(file, options)).report; }
