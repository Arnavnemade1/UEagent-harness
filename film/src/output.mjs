// Disk-backed video sink: bounded chunks, structural validation, atomic publication.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function validateMp4(file, expectedFrames) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size, seen = new Set();
    let frames = null, boxes = 0;
    const walk = (start, end, depth = 0) => {
      if (depth > 8) throw new Error('MP4 nesting limit exceeded');
      let p = start;
      while (p < end) {
        if (++boxes > 100000 || end - p < 8) throw new Error('Truncated MP4 box');
        const header = Buffer.alloc(24); fs.readSync(fd, header, 0, Math.min(24, end - p), p);
        let length = header.readUInt32BE(0), headerBytes = 8;
        const type = header.toString('ascii', 4, 8);
        if (length === 1) { length = Number(header.readBigUInt64BE(8)); headerBytes = 16; }
        if (length === 0) length = end - p;
        if (!Number.isSafeInteger(length) || length < headerBytes || p + length > end) throw new Error(`Invalid MP4 ${type} length`);
        if (depth === 0) seen.add(type);
        if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(type)) walk(p + headerBytes, p + length, depth + 1);
        if (type === 'stsz') {
          if (length < headerBytes + 12) throw new Error('Invalid MP4 sample table');
          frames = header.readUInt32BE(headerBytes + 8);
        }
        p += length;
      }
    };
    walk(0, size);
    if (!['ftyp', 'mdat', 'moov'].every((type) => seen.has(type))) throw new Error('MP4 is missing required container boxes');
    if (expectedFrames !== undefined && frames !== expectedFrames) throw new Error(`MP4 frame count mismatch: expected ${expectedFrames}, found ${frames}`);
    return { bytes: size, frames, validation: 'MP4 structure and sample count; no pixel-quality judgement' };
  } finally { fs.closeSync(fd); }
}

export class VideoOutput {
  constructor(file, { maxBytes = 8 * 1024 ** 3, frames } = {}) {
    this.file = file; this.maxBytes = maxBytes; this.frames = frames; this.fd = null; this.temp = null; this.bytes = 0;
  }
  start() {
    if (this.fd !== null) throw new Error('Video output already started');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.temp = `${this.file}.${randomUUID()}.partial`;
    this.fd = fs.openSync(this.temp, 'wx'); this.bytes = 0;
  }
  write(data, position) {
    if (this.fd === null) throw new Error('Video output not started');
    if (!Number.isSafeInteger(position) || position < 0 || position > this.bytes || position + data.length > this.maxBytes) throw new Error('Invalid or excessive video write range');
    let written = 0;
    while (written < data.length) written += fs.writeSync(this.fd, data, written, data.length - written, position + written);
    this.bytes = Math.max(this.bytes, position + data.length);
  }
  finish(expectedBytes) {
    if (this.fd === null || expectedBytes !== this.bytes) throw new Error('Video output byte count mismatch');
    fs.fsyncSync(this.fd); fs.closeSync(this.fd); this.fd = null;
    const report = validateMp4(this.temp, this.frames);
    fs.renameSync(this.temp, this.file); this.temp = null;
    return report;
  }
  close() {
    if (this.fd !== null) { fs.closeSync(this.fd); this.fd = null; }
    if (this.temp) { fs.rmSync(this.temp, { force: true }); this.temp = null; }
  }
}
