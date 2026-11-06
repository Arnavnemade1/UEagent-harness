// Tiny local server for the renderer page. Serves only: the page, vendored three.js and
// mp4-muxer, the baked spec, registered asset directories and plate frames. Accepts the
// finished MP4 and optional JPEG frames. Binds to 127.0.0.1 only.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { platePath } from './spec.mjs';

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
  return abs === root || abs.startsWith(root + path.sep) ? abs : null;
}

export async function startServer({ baked, assets, plate, outFile = null, framesDir = null }) {
  const specJson = JSON.stringify(baked || {});
  const send = (res, code, body, type = 'text/plain') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
  const sendFile = (res, abs) => {
    if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return send(res, 404, 'not found');
    res.writeHead(200, { 'content-type': TYPES[path.extname(abs).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(abs).pipe(res);
  };
  const readBody = (req) => new Promise((resolve, reject) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => resolve(Buffer.concat(c))); req.on('error', reject); });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const p = decodeURIComponent(url.pathname);
      if (req.method === 'POST' && p === '/output.mp4') {
        if (!outFile) return send(res, 400, 'no video output configured');
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        fs.writeFileSync(outFile, await readBody(req));
        return send(res, 200, 'ok');
      }
      if (req.method === 'POST' && p.startsWith('/frame/')) {
        if (!framesDir) return send(res, 400, 'no frames dir configured');
        const n = parseInt(p.slice(7), 10);
        fs.mkdirSync(framesDir, { recursive: true });
        fs.writeFileSync(path.join(framesDir, `frame.${String(n).padStart(5, '0')}.jpg`), await readBody(req));
        return send(res, 200, 'ok');
      }
      if (req.method !== 'GET') return send(res, 405, 'method not allowed');
      if (p === '/') return sendFile(res, path.join(WEB, 'index.html'));
      if (p === '/spec.json') return send(res, 200, specJson, 'application/json');
      if (p === '/renderer.js' || p === '/encoder.js' || p === '/inspect.js') return sendFile(res, path.join(WEB, p.slice(1)));
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
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}
