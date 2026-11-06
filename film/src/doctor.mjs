// Environment checks: Node, Chrome, GPU WebGL2, float targets, H.264 encoder, Unreal (optional).
import fs from 'node:fs';
import { findChrome, launchChrome, openPage } from './chrome.mjs';
import { findUnreal } from './ue.mjs';

export async function doctor() {
  const checks = [];
  const add = (name, ok, detail, optional = false) => checks.push({ name, ok, detail, optional });
  const major = +process.versions.node.split('.')[0];
  add('node', major >= 22, `v${process.versions.node}${major >= 22 ? '' : ' (need >= 22 for built-in WebSocket)'}`);
  const exe = findChrome();
  add('chrome', !!exe, exe || 'not found: install Google Chrome or set HFILM_CHROME');
  if (exe && major >= 22) {
    let b, srv;
    try {
      b = await launchChrome({});
      const http = await import('node:http');
      srv = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<!doctype html>ok'); });
      await new Promise((r) => srv.listen(0, '127.0.0.1', r));
      const p = await openPage(b.cdp, `http://127.0.0.1:${srv.address().port}/`);
      const g = await p.evaluate(`(async () => {
        const gl = document.createElement('canvas').getContext('webgl2');
        if (!gl) return { webgl2: false };
        const d = gl.getExtension('WEBGL_debug_renderer_info');
        const renderer = d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
        let h264 = false;
        try { h264 = (await VideoEncoder.isConfigSupported({ codec: 'avc1.640028', width: 1280, height: 720, bitrate: 1e7, framerate: 30 })).supported; } catch {}
        return { webgl2: true, renderer, float: !!gl.getExtension('EXT_color_buffer_float'), h264 };
      })()`);
      srv.close(); srv = null;
      const software = /swiftshader|llvmpipe|software/i.test(g.renderer || '');
      add('gpu', g.webgl2 && !software, g.webgl2 ? `${g.renderer}${software ? ' (software rendering: works, but slow)' : ''}` : 'WebGL2 unavailable');
      add('float-targets', !!g.float, g.float ? 'EXT_color_buffer_float' : 'missing: film-mode accumulation needs float render targets');
      add('h264', !!g.h264, g.h264 ? 'WebCodecs H.264 encoder available' : 'WebCodecs H.264 unavailable: use --frames-dir and encode externally');
    } catch (e) {
      add('gpu', false, `could not start headless Chrome: ${e.message.split('\n')[0]}`);
    } finally {
      try { if (b) await b.close(); } finally { if (srv) { srv.closeAllConnections(); await new Promise((resolve) => srv.close(resolve)); } }
    }
  }
  const ue = findUnreal();
  add('unreal', !!ue, ue ? `${ue} (plate provider available)` : 'not found (optional: only needed for "hfilm ue plates"; set UE_ROOT)', true);
  add('three', fs.existsSync(new URL(import.meta.resolve('three')).pathname), 'three.js installed');
  return { ok: checks.every((c) => c.ok || c.optional), checks };
}
