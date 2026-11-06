// Stage external media with provenance, bounded transfer and no executable inputs.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { imageInfo, modelInfo } from './media.mjs';

export async function ingest(source, { out, sha256, maxMB = 256, timeoutSeconds = 60 } = {}) {
  if (typeof source !== 'string' || !source || !out) throw new Error('ingest requires source and explicit output path');
  if (!Number.isFinite(maxMB) || maxMB <= 0 || maxMB > 1024 || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 600) throw new Error('ingest limits: maxMB (0..1024], timeoutSeconds (0..600]');
  if (sha256 && !/^[a-f\d]{64}$/i.test(sha256)) throw new Error('sha256 must be a 64-character hex digest');
  const dest = path.resolve(out), extension = path.extname(dest).toLowerCase();
  if (!['.glb', '.gltf', '.png', '.jpg', '.jpeg', '.webp', '.hdr', '.exr', '.json'].includes(extension)) throw new Error('ingest supports GLB/glTF, images, HDR/EXR and JSON data; executable files are not imported');
  if (fs.existsSync(dest) || fs.existsSync(dest + '.source.json')) throw new Error('ingest output already exists; choose a new asset path');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const temp = `${dest}.${randomUUID()}.partial`, manifestTemp = `${temp}.json`;
  let stream, file, created = false;
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(new Error('Input transfer timed out')), timeoutSeconds * 1000);
  try {
    let origin;
    if (/^https?:\/\//i.test(source)) {
      const url = new URL(source);
      if (url.username || url.password) throw new Error('Use a URL without embedded credentials');
      const response = await fetch(url, { signal: abort.signal });
      if (!response.ok || !response.body) throw new Error(`Input download failed: HTTP ${response.status}`);
      const declared = Number(response.headers.get('content-length'));
      if (declared > maxMB * 1024 ** 2) { await response.body.cancel(); throw new Error('Input exceeds maximum transfer size'); }
      stream = Readable.fromWeb(response.body);
      const resolved = new URL(response.url);
      origin = { kind: 'url', location: resolved.origin + resolved.pathname }; // omit signed query tokens
    } else {
      const input = path.resolve(source);
      if (!fs.statSync(input).isFile()) throw new Error('Input must be a regular file');
      if (fs.statSync(input).size > maxMB * 1024 ** 2) throw new Error('Input exceeds maximum transfer size');
      stream = fs.createReadStream(input, { signal: abort.signal });
      origin = { kind: 'file', location: input };
    }
    file = fs.openSync(temp, 'wx');
    const hash = createHash('sha256'); let bytes = 0;
    for await (const chunk of stream) {
      bytes += chunk.length;
      if (bytes > maxMB * 1024 ** 2) throw new Error('Input exceeds maximum transfer size');
      hash.update(chunk);
      let written = 0; while (written < chunk.length) written += fs.writeSync(file, chunk, written);
    }
    fs.fsyncSync(file); fs.closeSync(file); file = null;
    const digest = hash.digest('hex');
    if (sha256 && digest !== sha256.toLowerCase()) throw new Error('Input SHA-256 checksum mismatch');
    let validation;
    if (extension === '.json') {
      if (bytes > 16 * 1024 ** 2) throw new Error('JSON input exceeds the 16 MiB parse budget; split the dataset');
      JSON.parse(fs.readFileSync(temp, 'utf8')); validation = 'JSON syntax; data semantics not verified';
    } else if (['.glb', '.gltf'].includes(extension)) {
      // Keep the extension for glTF/GLB identification; the file remains staged.
      const staged = `${temp}${extension}`; fs.renameSync(temp, staged);
      try { const info = modelInfo(staged); validation = { meshes: info.meshes, animations: info.animations, dependencies: info.dependencies }; }
      finally { fs.renameSync(staged, temp); }
    } else validation = imageInfo(temp);
    if (validation && typeof validation === 'object') { validation = { ...validation }; delete validation.file; }
    const report = { ok: true, output: dest, bytes, sha256: digest, source: origin, imported_at: new Date().toISOString(), validation };
    fs.writeFileSync(manifestTemp, JSON.stringify(report, null, 2), { flag: 'wx' });
    // Exclusive publication: a competing import cannot overwrite this asset.
    fs.linkSync(temp, dest); created = true;
    fs.linkSync(manifestTemp, dest + '.source.json');
    return report;
  } catch (error) {
    if (created) fs.rmSync(dest, { force: true });
    throw error;
  } finally {
    clearTimeout(timer); stream?.destroy();
    if (file !== undefined && file !== null) fs.closeSync(file);
    fs.rmSync(temp, { force: true }); fs.rmSync(manifestTemp, { force: true });
  }
}
