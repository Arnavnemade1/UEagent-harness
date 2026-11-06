// Bounded structural inspection of external media. No decoding or network requests.
import fs from 'node:fs';
import path from 'node:path';

export function imageInfo(file, { offset: base = 0, length } = {}) {
  const fd = fs.openSync(file, 'r');
  try {
    const fileSize = fs.fstatSync(fd).size;
    const size = length ?? (fileSize - base);
    if (!Number.isSafeInteger(base) || !Number.isSafeInteger(size) || base < 0 || size <= 0 || base + size > fileSize) throw new Error(`Invalid image byte range: ${file}`);
    if (!size) throw new Error(`Empty image: ${file}`);
    const head = Buffer.alloc(Math.min(size, 65536));
    fs.readSync(fd, head, 0, head.length, base);
    const tail = Buffer.alloc(Math.min(size, 12));
    fs.readSync(fd, tail, 0, tail.length, base + size - tail.length);
    let width, height, format;
    if (head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      if (size < 45 || head.toString('ascii', 12, 16) !== 'IHDR' || tail.toString('ascii', 4, 8) !== 'IEND') throw new Error(`Incomplete PNG: ${file}`);
      width = head.readUInt32BE(16); height = head.readUInt32BE(20); format = 'png';
    } else if (head[0] === 255 && head[1] === 216) {
      if (tail.at(-2) !== 255 || tail.at(-1) !== 217) throw new Error(`Incomplete JPEG: ${file}`);
      let offset = 2, markers = 0;
      while (offset + 4 <= size && ++markers <= 4096) {
        const marker = Buffer.alloc(4);
        if (fs.readSync(fd, marker, 0, 4, base + offset) !== 4 || marker[0] !== 255) break;
        if (marker[1] === 255) { offset++; continue; }
        if ([0xd9, 0xda].includes(marker[1])) break;
        const length = marker.readUInt16BE(2);
        if (length < 2 || offset + 2 + length > size) break;
        if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker[1])) {
          const dims = Buffer.alloc(5); fs.readSync(fd, dims, 0, 5, base + offset + 4);
          height = dims.readUInt16BE(1); width = dims.readUInt16BE(3); format = 'jpeg'; break;
        }
        offset += 2 + length;
      }
    } else if (/^#\?(RADIANCE|RGBE)/.test(head.toString('ascii', 0, 16))) {
      const match = head.toString('ascii').match(/[-+]Y\s+(\d+)\s+[-+]X\s+(\d+)/);
      if (match) { height = +match[1]; width = +match[2]; format = 'hdr'; }
    } else if (head.length >= 8 && head.readUInt32LE(0) === 20000630) {
      // OpenEXR attributes are null-terminated name/type, then uint32 size.
      let p = 8;
      while (p < head.length && head[p]) {
        const end = head.indexOf(0, p), typeEnd = head.indexOf(0, end + 1);
        if (end < 0 || typeEnd < 0 || typeEnd + 5 > head.length) break;
        const name = head.toString('ascii', p, end), length = head.readUInt32LE(typeEnd + 1), data = typeEnd + 5;
        if (data + length > head.length) break;
        if (name === 'dataWindow' && length === 16) {
          width = head.readInt32LE(data + 8) - head.readInt32LE(data) + 1;
          height = head.readInt32LE(data + 12) - head.readInt32LE(data + 4) + 1; format = 'exr'; break;
        }
        p = data + length;
      }
    } else if (head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP') {
      if (head.readUInt32LE(4) + 8 !== size) throw new Error(`Incomplete WebP: ${file}`);
      for (let p = 12; p + 8 < head.length;) {
        const kind = head.toString('ascii', p, p + 4), count = head.readUInt32LE(p + 4), data = p + 8;
        if (kind === 'VP8X' && data + 10 <= head.length) { width = head.readUIntLE(data + 4, 3) + 1; height = head.readUIntLE(data + 7, 3) + 1; }
        if (kind === 'VP8L' && data + 5 <= head.length && head[data] === 47) { const bits = head.readUInt32LE(data + 1); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1; }
        if (kind === 'VP8 ' && data + 10 <= head.length && head.subarray(data + 3, data + 6).equals(Buffer.from([0x9d, 1, 0x2a]))) { width = head.readUInt16LE(data + 6) & 0x3fff; height = head.readUInt16LE(data + 8) & 0x3fff; }
        if (width && height) { format = 'webp'; break; }
        p = data + count + (count % 2);
      }
    }
    if (!(width > 0 && height > 0)) throw new Error(`Unsupported or malformed image header: ${file}`);
    return { file, format, bytes: size, width, height, validation: 'header and container markers; pixels not decoded' };
  } finally { fs.closeSync(fd); }
}

export function modelInfo(file) {
  const stat = fs.statSync(file);
  let doc, binary = null;
  if (path.extname(file).toLowerCase() === '.glb') {
    const fd = fs.openSync(file, 'r');
    try {
      const head = Buffer.alloc(20); fs.readSync(fd, head, 0, 20, 0);
      if (head.toString('ascii', 0, 4) !== 'glTF' || head.readUInt32LE(4) !== 2 || head.readUInt32LE(8) !== stat.size || head.readUInt32LE(16) !== 0x4e4f534a) throw new Error(`Invalid GLB container: ${file}`);
      const bytes = head.readUInt32LE(12);
      if (bytes > 16 * 1024 ** 2 || bytes + 20 > stat.size) throw new Error(`GLB metadata too large or incomplete: ${file}`);
      const data = Buffer.alloc(bytes); fs.readSync(fd, data, 0, bytes, 20); doc = JSON.parse(data.toString('utf8'));
      const binHeader = Buffer.alloc(8), position = 20 + bytes;
      if (position + 8 <= stat.size && fs.readSync(fd, binHeader, 0, 8, position) === 8 && binHeader.readUInt32LE(4) === 0x004e4942) binary = { offset: position + 8, length: binHeader.readUInt32LE(0) };
      if (binary && binary.offset + binary.length > stat.size) throw new Error(`Truncated GLB binary: ${file}`);
    } finally { fs.closeSync(fd); }
  } else {
    if (stat.size > 16 * 1024 ** 2) throw new Error(`glTF JSON exceeds 16 MiB: ${file}`);
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  if (doc.asset?.version !== '2.0') throw new Error(`Expected glTF 2.0: ${file}`);
  for (const extension of doc.extensionsRequired || []) {
    if (['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_texture_basisu'].includes(extension)) throw new Error(`${file}: ${extension} needs a decoder not configured in this renderer; export an uncompressed glTF/GLB.`);
  }
  const dependencies = [], embeddedImages = [];
  if ((doc.images?.length || 0) + (doc.buffers?.length || 0) > 2048) throw new Error(`Too many glTF dependencies: ${file}`);
  for (const image of doc.images || []) {
    if (image.bufferView === undefined || !binary) continue;
    const view = doc.bufferViews?.[image.bufferView];
    if (!view || (view.buffer ?? 0) !== 0 || !Number.isSafeInteger(view.byteLength) || view.byteLength <= 0 || (view.byteOffset ?? 0) < 0 || (view.byteOffset ?? 0) + view.byteLength > binary.length) throw new Error(`Invalid embedded image range: ${file}`);
    embeddedImages.push(imageInfo(file, { offset: binary.offset + (view.byteOffset ?? 0), length: view.byteLength }));
  }
  for (const ref of [...(doc.buffers || []), ...(doc.images || [])]) {
    if (!ref.uri || ref.uri.startsWith('data:')) continue;
    if (/^[a-z][a-z\d+.-]*:|^[/\\]/i.test(ref.uri)) throw new Error(`${file}: stage external dependency locally before rendering: ${ref.uri}`);
    const root = fs.realpathSync(path.dirname(file));
    const resolved = path.resolve(root, decodeURIComponent(ref.uri));
    if (!resolved.startsWith(root + path.sep)) throw new Error(`${file}: keep glTF dependencies inside its asset directory: ${ref.uri}`);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error(`${file}: missing dependency ${ref.uri}`);
    if (!fs.realpathSync(resolved).startsWith(root + path.sep)) throw new Error(`${file}: dependency symlink leaves its asset directory: ${ref.uri}`);
    if (ref.byteLength && fs.statSync(resolved).size < ref.byteLength) throw new Error(`${file}: truncated buffer ${ref.uri}`);
    dependencies.push(resolved);
  }
  return { file, bytes: stat.size, dependencies, embeddedImages, animations: (doc.animations || []).map((a) => a.name || '(unnamed)'), meshes: doc.meshes?.length || 0 };
}

/** Exact frame coverage: never infer success from a directory's image count. */
export function validateImages(files, { width, height } = {}) {
  let count = 0;
  for (const file of files) {
    const info = imageInfo(file);
    if (width !== undefined && (info.width !== width || info.height !== height)) throw new Error(`Frame dimensions differ: ${file}; expected ${width}x${height}, got ${info.width}x${info.height}`);
    count++;
  }
  return { count, validation: 'expected paths, image headers and container markers; not full pixel decoding' };
}
