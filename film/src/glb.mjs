// Minimal glTF -> GLB packer for building library assets: drops unwanted vertex attributes,
// compacts buffers (one tightly packed bufferView per accessor) and embeds images.
import fs from 'node:fs';
import path from 'node:path';
import { readGltf } from './rig.mjs';

const SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const WIDTH = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

/**
 * @param {string} file .gltf/.glb
 * @param {object} o
 *   dropAttributes: attribute names to remove from every primitive (e.g. ['COLOR_0'])
 *   image(img, bytes) -> { data: Buffer, mimeType } | null   re-encode or drop (null) an image
 *   keepMeshes: optional predicate on mesh name
 *   edit(json): last-chance JSON edit (materials, names) before packing
 */
export function packGlb(file, { dropAttributes = [], image = null, edit = null } = {}) {
  const g = readGltf(file), json = structuredClone(g.json);
  for (const m of json.meshes || []) for (const p of m.primitives) for (const a of dropAttributes) delete p.attributes[a];
  if (edit) edit(json);
  // used accessors
  const used = new Set();
  for (const m of json.meshes || []) for (const p of m.primitives) {
    for (const i of Object.values(p.attributes)) used.add(i);
    if (p.indices !== undefined) used.add(p.indices);
    for (const t of p.targets || []) for (const i of Object.values(t)) used.add(i);
  }
  for (const s of json.skins || []) if (s.inverseBindMatrices !== undefined) used.add(s.inverseBindMatrices);
  for (const a of json.animations || []) for (const s of a.samplers) { used.add(s.input); used.add(s.output); }
  const chunks = [], views = [], remap = new Map(), accessors = [];
  let off = 0;
  const push = (buf) => { const pad = (4 - (off % 4)) % 4; if (pad) { chunks.push(Buffer.alloc(pad)); off += pad; } const o = off; chunks.push(buf); off += buf.length; return o; };
  [...used].sort((a, b) => a - b).forEach((i) => {
    const a = json.accessors[i], el = SIZE[a.componentType] * WIDTH[a.type];
    const bv = g.json.bufferViews[a.bufferView], src = g.buffers[bv.buffer];
    const stride = bv.byteStride || el, base = (bv.byteOffset || 0) + (a.byteOffset || 0);
    const out = Buffer.alloc(el * a.count);
    for (let k = 0; k < a.count; k++) src.copy(out, k * el, base + k * stride, base + k * stride + el);
    const o = push(out);
    views.push({ buffer: 0, byteOffset: o, byteLength: out.length, ...(bv.target ? { target: bv.target } : {}) });
    remap.set(i, accessors.length);
    const { bufferView, byteOffset, ...rest } = a; void bufferView; void byteOffset;
    accessors.push({ ...rest, bufferView: views.length - 1 });
  });
  const fix = (i) => remap.get(i);
  for (const m of json.meshes || []) for (const p of m.primitives) {
    for (const k of Object.keys(p.attributes)) p.attributes[k] = fix(p.attributes[k]);
    if (p.indices !== undefined) p.indices = fix(p.indices);
    for (const t of p.targets || []) for (const k of Object.keys(t)) t[k] = fix(t[k]);
  }
  for (const s of json.skins || []) if (s.inverseBindMatrices !== undefined) s.inverseBindMatrices = fix(s.inverseBindMatrices);
  for (const a of json.animations || []) for (const s of a.samplers) { s.input = fix(s.input); s.output = fix(s.output); }
  // images
  const images = [];
  const imgMap = new Map();
  (json.images || []).forEach((img, i) => {
    let bytes;
    if (img.bufferView !== undefined) { const bv = g.json.bufferViews[img.bufferView]; bytes = g.buffers[bv.buffer].subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength); }
    else if (img.uri?.startsWith('data:')) bytes = Buffer.from(img.uri.split(',')[1], 'base64');
    else bytes = fs.readFileSync(path.join(g.dir, decodeURIComponent(img.uri)));
    const r = image ? image(img, bytes) : { data: bytes, mimeType: img.mimeType || 'image/png' };
    if (!r) return;
    const o = push(r.data);
    views.push({ buffer: 0, byteOffset: o, byteLength: r.data.length });
    imgMap.set(i, images.length);
    images.push({ name: img.name, mimeType: r.mimeType, bufferView: views.length - 1 });
  });
  if (json.textures) {
    const keep = [];
    const texMap = new Map();
    json.textures.forEach((t, i) => { if (imgMap.has(t.source)) { texMap.set(i, keep.length); keep.push({ ...t, source: imgMap.get(t.source) }); } });
    json.textures = keep;
    const walk = (o) => { if (!o || typeof o !== 'object') return; for (const [k, v] of Object.entries(o)) { if (v && typeof v === 'object' && 'index' in v && /Texture$/.test(k)) { if (texMap.has(v.index)) v.index = texMap.get(v.index); else delete o[k]; } else walk(v); } };
    for (const m of json.materials || []) walk(m);
  }
  const bin = Buffer.concat(chunks);
  json.accessors = accessors; json.bufferViews = views; json.buffers = [{ byteLength: bin.length }];
  json.images = images.length ? images : undefined;
  json.asset = { ...json.asset, generator: 'hybrid-film glb.mjs' };
  let js = Buffer.from(JSON.stringify(json));
  js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
  const binP = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
  const head = Buffer.alloc(12); head.write('glTF', 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + js.length + 8 + binP.length, 8);
  const ch = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b; };
  return Buffer.concat([head, ch(js.length, 0x4e4f534a), js, ch(binP.length, 0x004e4942), binP]);
}
