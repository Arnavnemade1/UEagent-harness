// In-browser H.264 MP4 encoding: WebCodecs (hardware where available) + mp4-muxer.
// Works the same on macOS, Windows and Linux; no ffmpeg needed.
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';

function avcCodec(w, h, fps) {
  const mbps = Math.ceil(w / 16) * Math.ceil(h / 16) * fps;  // macroblocks per second -> level
  if (mbps <= 245760 && w * h <= 2097152) return 'avc1.640028';   // High@4.0  (1080p30)
  if (mbps <= 522240 && w * h <= 2228224) return 'avc1.64002a';   // High@4.2  (1080p60)
  if (mbps <= 983040 && w * h <= 5652480) return 'avc1.640032';   // High@5.0  (1440p60)
  return 'avc1.640033';                                            // High@5.1  (4K30)
}

export async function createEncoder(canvas, { width, height, fps, bitrate, keyframeSeconds = 2 }) {
  const codec = avcCodec(width, height, fps);
  const bps = bitrate || Math.round(width * height * fps * 0.35);   // ~10 Mbps at 720p30, ~22 Mbps at 1080p30
  const config = { codec, width, height, bitrate: bps, framerate: fps, latencyMode: 'quality', avc: { format: 'avc' } };
  const support = await VideoEncoder.isConfigSupported({ ...config, hardwareAcceleration: 'prefer-hardware' });
  if (!support.supported) {
    const sw = await VideoEncoder.isConfigSupported(config);
    if (!sw.supported) throw new Error(`H.264 ${codec} ${width}x${height} is not supported by this browser's WebCodecs`);
  }
  const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: 'avc', width, height, frameRate: fps }, fastStart: 'in-memory' });
  let failure = null;
  const enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { failure = e; } });
  enc.configure(support.supported ? { ...config, hardwareAcceleration: 'prefer-hardware' } : config);
  const us = 1e6 / fps;
  return {
    async add(index) {
      if (failure) throw failure;
      while (enc.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 2));
      const vf = new VideoFrame(canvas, { timestamp: Math.round(index * us), duration: Math.round(us) });
      enc.encode(vf, { keyFrame: index % Math.max(1, Math.round(keyframeSeconds * fps)) === 0 });
      vf.close();
    },
    queue: () => enc.encodeQueueSize,
    async finish() {
      await enc.flush();
      if (failure) throw failure;
      muxer.finalize();
      const buf = muxer.target.buffer;
      const res = await fetch('/output.mp4', { method: 'POST', body: buf });
      if (!res.ok) throw new Error(`could not write video: HTTP ${res.status}`);
      return buf.byteLength;
    },
  };
}
