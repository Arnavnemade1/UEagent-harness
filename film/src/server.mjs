// Tiny local server for the renderer page. Serves only: the page, vendored three.js and
// mp4-muxer, the baked spec, registered asset directories and plate frames. Accepts the
// finished MP4 and optional JPEG frames. Binds to 127.0.0.1 only.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { platePath } from './spec.mjs';
import { VideoOutput } from './output.mjs';
import { imageInfo } from './media.mjs';
import { randomUUID } from 'node:crypto';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const pkgRoot = (spec) => path.resolve(path.dirname(fileURLToPath(import.meta.resolve(spec))), '..');
const VENDOR = { three: pkgRoot('three'), 'mp4-muxer': pkgRoot('mp4-muxer') };
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.hdr': 'application/octet-stream', '.exr': 'application/octet-stream', '.ktx2': 'image/ktx2',
};

function within(root, rel) {
  const abs = path.resolve(root, rel);
  if (!(abs === root || abs.startsWith(root + path.sep))) return null;
  if (!fs.existsSync(abs)) return null;
  const real = fs.realpathSync(abs), base = fs.realpathSync(root);
  return real === base || real.startsWith(base + path.sep) ? abs : null;
}

export async function startServer({ baked, assets, plate, outFile = null, framesDir = null }) {
  const specJson = JSON.stringify(baked || {});
  const video = outFile ? new VideoOutput(outFile, { frames: baked.end - baked.start }) : null;
  const send = (res, code, body, type = 'text/plain') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
  const sendFile = (res, abs) => {
    if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return send(res, 404, 'not found');
    res.writeHead(200, { 'content-type': TYPES[path.extname(abs).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
    const stream = fs.createReadStream(abs);
    stream.on('error', () => res.destroy());
    res.once('close', () => stream.destroy());
    stream.pipe(res);
  };
  const readBody = async (req, limit = 8 * 1024 ** 2) => {
    const chunks = []; let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > limit) throw new Error('Upload exceeds bounded chunk limit');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const p = decodeURIComponent(url.pathname);
      const origin = req.headers.origin;
      if (origin && origin !== `http://127.0.0.1:${server.address().port}`) return send(res, 403, 'origin not allowed');
      if (req.method === 'POST' && p.startsWith('/video/')) {
        if (!video) return send(res, 400, 'no video output configured');
        if (p === '/video/start') { video.start(); return send(res, 200, 'ok'); }
        if (p === '/video/chunk') { video.write(await readBody(req), Number(url.searchParams.get('position'))); return send(res, 200, 'ok'); }
        if (p === '/video/finish') {
          const body = JSON.parse((await readBody(req, 1024)).toString());
          return send(res, 200, JSON.stringify(video.finish(body.bytes)), 'application/json');
        }
        return send(res, 404, 'unknown video operation');
      }
      if (req.method === 'POST' && p.startsWith('/frame/')) {
        if (!framesDir) return send(res, 400, 'no frames dir configured');
        if (!/^\/frame\/-?\d+$/.test(p)) return send(res, 400, 'invalid frame number');
        const n = Number(p.slice(7));
        if (!Number.isSafeInteger(n) || n < baked.start || n >= baked.end) return send(res, 400, 'frame outside render range');
        fs.mkdirSync(framesDir, { recursive: true });
        const dest = path.join(framesDir, `frame.${String(n).padStart(5, '0')}.jpg`);
        const temp = `${dest}.${randomUUID()}.partial`;
        try {
          fs.writeFileSync(temp, await readBody(req));
          const info = imageInfo(temp);
          if (info.width !== baked.width || info.height !== baked.height) throw new Error('Frame output dimensions differ');
          fs.renameSync(temp, dest);
        } finally { fs.rmSync(temp, { force: true }); }
        return send(res, 200, 'ok');
      }
      if (req.method !== 'GET') return send(res, 405, 'method not allowed');
      if (p === '/') return sendFile(res, path.join(WEB, 'index.html'));
      if (p === '/spec.json') return send(res, 200, specJson, 'application/json');
      if (['/renderer.js', '/encoder.js', '/inspect.js'].includes(p)) return sendFile(res, path.join(WEB, p.slice(1)));
      const v = p.match(/^\/vendor\/(three|mp4-muxer)\/(.+)$/);
      if (v) return sendFile(res, within(VENDOR[v[1]], v[2]));
      const a = p.match(/^\/asset\/(\d+)\/(.+)$/);
      if (a && assets.dirs[+a[1]]) return sendFile(res, within(assets.dirs[+a[1]], a[2]));
      const pl = p.match(/^\/plate\/(-?\d+)$/);
      if (pl && plate) return sendFile(res, platePath(plate, +pl[1]));
      return send(res, 404, 'not found');
    } catch (e) {
      return send(res, 500, String(e?.message || e));
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.close(() => { video?.close(); r(); }); server.closeAllConnections(); }) };
}
