// Conservative planning estimates, not a guarantee of a model's GPU footprint.
import os from 'node:os';

export const PROFILES = {
  preview: { width: 960, height: 540, samples: 4, shadow: 1024 },
  balanced: { width: 1920, height: 1080, samples: 16, shadow: 2048 },
  final: { width: 3840, height: 2160, samples: 32, shadow: 4096 },
};

export function qualityPlan(film, { quality, memoryGB, samples } = {}, totalBytes = os.totalmem()) {
  if (quality !== undefined && !Object.hasOwn(PROFILES, quality)) throw new Error('quality: expected preview, balanced or final');
  const budgetGB = memoryGB ?? Math.max(1, Math.min(4, totalBytes / 1024 ** 3 / 4));
  if (!Number.isFinite(budgetGB) || budgetGB < 0.5 || budgetGB > totalBytes / 1024 ** 3 * 0.8) throw new Error('memoryGB: expected 0.5 GiB to 80% of physical memory');
  const size = film.size || [film.width ?? 1280, film.height ?? 720];
  if (!Array.isArray(size) || size.length !== 2 || size.some((n) => !Number.isInteger(n) || n < 2 || n > 8192 || n % 2)) throw new Error('size: dimensions must be even integers from 2 to 8192');
  const profile = quality ? PROFILES[quality] : null;
  const scale = profile ? Math.min(1, profile.width / size[0], profile.height / size[1]) : 1;
  const output = size.map((n) => Math.max(2, Math.floor(n * scale / 2) * 2));
  const n = samples ?? profile?.samples ?? film.render?.samples ?? 16;
  if (!Number.isInteger(n) || n < 1 || n > 256) throw new Error('samples: expected an integer from 1 to 256');
  const shadow = profile ? Math.min(film.sun?.shadowMapSize || 4096, profile.shadow) : (film.sun?.shadowMapSize || 4096);
  if (!Number.isInteger(shadow) || shadow < 128 || shadow > 8192 || (shadow & (shadow - 1))) throw new Error('sun.shadowMapSize: expected a power of two from 128 to 8192');
  // Five half-float accumulation targets, depth buffers, canvas and encoding
  // surfaces, plus two shadow maps and process baseline. Asset memory is added
  // during preflight; samples change render time, not accumulation-buffer size.
  const baseBytes = 512 * 1024 ** 2 + output[0] * output[1] * 80 + shadow ** 2 * 16;
  if (baseBytes > budgetGB * 1024 ** 3 * 0.8) throw new Error(`Render buffers exceed the ${budgetGB} GiB planning budget; choose --quality preview or a smaller film size.`);
  const planned = { ...film, size: output, render: { ...film.render, samples: n },
    sun: film.sun === false ? false : { ...(film.sun || { direction: [0.4, 1, 0.3] }), shadowMapSize: shadow } };
  return { film: planned, profile: quality || 'authored', memoryGB: budgetGB, size: output, samples: n, shadowMapSize: shadow,
    baseBytes, changes: [...(output.some((v, i) => v !== size[i]) ? [`resolution ${size.join('x')} -> ${output.join('x')}`] : []),
      ...(n !== (film.render?.samples ?? 16) ? [`samples ${film.render?.samples ?? 16} -> ${n}`] : [])],
    note: 'Estimate excludes engine/GPU driver allocations. Runtime process monitoring is still required; no automatic retry or silent quality downgrade.' };
}
