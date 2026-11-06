// Skeletons, clip sampling and motion encoding (Node side).
//
// Every motion source (a glTF clip, an Acclaim/CMU capture) becomes a *pose stream*: per frame, the
// model-space rotation of each universal bone plus the hips position, with the source's rest pose.
// Streams can be mirrored, made in-place, trimmed and looped, then written as rig-neutral
// "hfilm-motion@1" clips (see web/motion.js), which any humanoid rig plays correctly.
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { UNIVERSAL, DIR_CHILD, RIGIFY_MAP, MIXAMO_MAP, rigOf, decodeMotion, bakeForRig } from '../web/motion.js';

// ------------------------------------------------------------------ glTF reading
export function readGltf(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('ascii', 0, 4) === 'glTF') {
    let off = 12, json = null, bin = null;
    while (off < buf.length) {
      const len = buf.readUInt32LE(off), type = buf.readUInt32LE(off + 4);
      const chunk = buf.subarray(off + 8, off + 8 + len);
      if (type === 0x4e4f534a) json = JSON.parse(chunk.toString('utf8'));
      else if (type === 0x004e4942) bin = chunk;
      off += 8 + len;
    }
    return { json, buffers: [bin], dir: path.dirname(file), file };
  }
  const json = JSON.parse(buf.toString('utf8'));
  const buffers = (json.buffers || []).map((b) => (b.uri?.startsWith('data:')
    ? Buffer.from(b.uri.split(',')[1], 'base64') : fs.readFileSync(path.join(path.dirname(file), decodeURIComponent(b.uri)))));
  return { json, buffers, dir: path.dirname(file), file };
}

const COMP = { 5120: [Int8Array, 127], 5121: [Uint8Array, 255], 5122: [Int16Array, 32767], 5123: [Uint16Array, 65535], 5125: [Uint32Array, 0], 5126: [Float32Array, 0] };
const WIDTH = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

/** Accessor -> Float32Array (normalized integers are converted to floats). */
export function accessor(g, i) {
  const a = g.json.accessors[i], n = WIDTH[a.type], [T, norm] = COMP[a.componentType];
  const out = new Float32Array(a.count * n);
  if (a.bufferView === undefined) return out;
  const bv = g.json.bufferViews[a.bufferView], buf = g.buffers[bv.buffer];
  const stride = bv.byteStride || n * T.BYTES_PER_ELEMENT;
  const dv = new DataView(buf.buffer, buf.byteOffset + (bv.byteOffset || 0) + (a.byteOffset || 0));
  const get = { 5120: 'getInt8', 5121: 'getUint8', 5122: 'getInt16', 5123: 'getUint16', 5125: 'getUint32', 5126: 'getFloat32' }[a.componentType];
  for (let k = 0; k < a.count; k++) for (let c = 0; c < n; c++) {
    let v = dv[get](k * stride + c * T.BYTES_PER_ELEMENT, true);
    if (a.normalized && norm) v = Math.max(v / norm, -1);
    out[k * n + c] = v;
  }
  return out;
}

/** The node hierarchy of a glTF scene with rest TRS. Names are kept as authored. */
export function skeletonOf(g) {
  const { json } = g, nodes = json.nodes.map((n, i) => ({
    i, name: n.name ?? `node${i}`, parent: -1, children: n.children || [],
    t: new THREE.Vector3(...(n.translation || [0, 0, 0])), q: new THREE.Quaternion(...(n.rotation || [0, 0, 0, 1])), s: new THREE.Vector3(...(n.scale || [1, 1, 1])),
  }));
  for (const n of nodes) for (const c of n.children) nodes[c].parent = n.i;
  const order = [], visit = (i) => { order.push(i); for (const c of nodes[i].children) visit(c); };
  for (const r of json.scenes?.[json.scene ?? 0]?.nodes || nodes.filter((n) => n.parent < 0).map((n) => n.i)) visit(r);
  const byName = new Map(nodes.map((n) => [n.name, n]));
  const joints = new Set((json.skins || []).flatMap((s) => s.joints));
  return { nodes, order, byName, joints };
}

/** World (model-space) matrices for local TRS overrides `locals` (Map index -> {t,q,s}). */
export function fk(sk, locals = new Map()) {
  const world = new Array(sk.nodes.length);
  const m = new THREE.Matrix4();
  for (const i of sk.order) {
    const n = sk.nodes[i], l = locals.get(i) || n;
    m.compose(l.t || n.t, l.q || n.q, l.s || n.s);
    world[i] = n.parent >= 0 ? world[n.parent].clone().multiply(m) : m.clone();
  }
  return world;
}

const _tq = new THREE.Quaternion(), _ts = new THREE.Vector3();
const posOf = (m) => new THREE.Vector3().setFromMatrixPosition(m);
const rotOf = (m) => { const p = new THREE.Vector3(); const q = new THREE.Quaternion(); m.decompose(p, q, _ts); return q; };

/** Sample a glTF animation (LINEAR/STEP) at time t -> Map node index -> {t,q,s}. */
export function sampleGltfAnimation(g, anim, t, sk) {
  const out = new Map();
  for (const ch of anim.channels) {
    const node = ch.target.node, path_ = ch.target.path;
    if (!['translation', 'rotation', 'scale'].includes(path_)) continue;
    const s = anim.samplers[ch.sampler];
    s._in ??= accessor(g, s.input); s._out ??= accessor(g, s.output);
    const times = s._in, vals = s._out, n = path_ === 'rotation' ? 4 : 3;
    let k = 0; while (k < times.length - 2 && times[k + 1] < t) k++;
    const t0 = times[k], t1 = times[Math.min(k + 1, times.length - 1)];
    const u = s.interpolation === 'STEP' || t1 <= t0 ? 0 : Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
    const cubic = s.interpolation === 'CUBICSPLINE' ? 3 : 1, off = cubic === 3 ? n : 0;
    const a = vals.subarray((k * cubic) * n + off, (k * cubic) * n + off + n), b = vals.subarray((Math.min(k + 1, times.length - 1) * cubic) * n + off, (Math.min(k + 1, times.length - 1) * cubic) * n + off + n);
    const o = out.get(node) || { ...sk.nodes[node] }; out.set(node, o);
    if (n === 4) o.q = new THREE.Quaternion(...a).slerp(new THREE.Quaternion(...b), u);
    else o[path_ === 'translation' ? 't' : 's'] = new THREE.Vector3(...a).lerp(new THREE.Vector3(...b), u);
  }
  return out;
}

export function clipDuration(g, anim) {
  let d = 0;
  for (const s of anim.samplers) { const a = g.json.accessors[s.input]; d = Math.max(d, a.max?.[0] ?? 0); }
  return d;
}

// ------------------------------------------------------------------ the universal humanoid
export { UNIVERSAL, DIR_CHILD, RIGIFY_MAP, MIXAMO_MAP, rigOf, decodeMotion, bakeForRig };

/** A three.js Object3D tree (bones at rest) for a glTF file, e.g. to bake clips for it in Node. */
export function sceneOf(file) {
  const g = readGltf(file), sk = skeletonOf(g), objs = [];
  for (const n of sk.nodes) {
    const o = sk.joints.has(n.i) ? new THREE.Bone() : new THREE.Object3D();
    o.name = n.name; o.position.copy(n.t); o.quaternion.copy(n.q); o.scale.copy(n.s); objs[n.i] = o;
  }
  const root = new THREE.Group();
  for (const n of sk.nodes) (n.parent >= 0 ? objs[n.parent] : root).add(objs[n.i]);
  root.updateMatrixWorld(true);
  return root;
}

/** Pose stream from a glTF clip on its own skeleton, with a name map universal -> source names. */
export function gltfStream(g, anim, { map = null, fps = 30, from = 0, to = null } = {}) {
  const sk = skeletonOf(g), names = map || Object.fromEntries(UNIVERSAL.map((n) => [n, n]));
  const restW = fk(sk), bones = {};
  for (const [u, s] of Object.entries(names)) {
    const n = sk.byName.get(s);
    if (!n) continue;
    const childU = DIR_CHILD[u], child = childU && sk.byName.get(names[childU]) || sk.nodes[n.children.find((c) => sk.joints.has(c))];
    const p = posOf(restW[n.i]);
    bones[u] = { i: n.i, restWorld: rotOf(restW[n.i]), dir: child ? posOf(restW[child.i]).sub(p).normalize() : null, pos: p };
  }
  const dur = to ?? clipDuration(g, anim), frames = [];
  const N = Math.max(1, Math.round((dur - from) * fps));
  for (let k = 0; k <= N; k++) {
    const W = fk(sk, sampleGltfAnimation(g, anim, Math.min(dur, from + k / fps), sk));
    const f = {};
    for (const [u, b] of Object.entries(bones)) f[u] = rotOf(W[b.i]);
    frames.push({ rot: f, hips: posOf(W[bones.pelvis.i]) });
  }
  const leg = (s) => bones[`thigh_${s}`] && bones[`foot_${s}`] ? bones[`thigh_${s}`].pos.distanceTo(bones[`calf_${s}`].pos) + bones[`calf_${s}`].pos.distanceTo(bones[`foot_${s}`].pos) : 0;
  return { fps, frames, rest: bones, legLength: (leg('l') + leg('r')) / 2, hipsRest: bones.pelvis.pos.clone(), name: anim.name };
}

// ------------------------------------------------------------------ stream operations
const MIRROR_NAME = (n) => n.replace(/_l$/, '_@').replace(/_r$/, '_l').replace(/_@$/, '_r');
const mirrorQ = (q) => new THREE.Quaternion(q.x, -q.y, -q.z, q.w);

/** Left/right mirror of a pose stream (a right-foot kick becomes a left-foot kick). */
export function mirrorStream(st) {
  const rest = {};
  for (const [n, b] of Object.entries(st.rest)) rest[MIRROR_NAME(n)] = { ...b, restWorld: mirrorQ(b.restWorld), dir: b.dir && new THREE.Vector3(-b.dir.x, b.dir.y, b.dir.z), pos: b.pos && new THREE.Vector3(-b.pos.x, b.pos.y, b.pos.z) };
  const frames = st.frames.map((f) => ({ rot: Object.fromEntries(Object.entries(f.rot).map(([n, q]) => [MIRROR_NAME(n), mirrorQ(q)])), hips: new THREE.Vector3(-f.hips.x, f.hips.y, f.hips.z) }));
  return { ...st, rest, frames, hipsRest: new THREE.Vector3(-st.hipsRest.x, st.hipsRest.y, st.hipsRest.z) };
}

/** Heading (yaw, radians, 0 = +Z) of the hips' forward axis in a frame. */
export function streamHeading(st, k) {
  const f = st.frames[k], q = f.rot.pelvis.clone().multiply(st.rest.pelvis.restWorld.clone().invert());
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  return Math.atan2(fwd.x, fwd.z);
}

/**
 * Normalise a stream for in-place use: rotate so the body faces +Z at frame `faceAt` and move the
 * hips' ground track to the origin (keeping vertical motion). `travel` keeps that fraction of the
 * horizontal displacement (0 = fully in place).
 */
export function inPlace(st, { faceAt = 0, travel = 0, smooth = 0.25 } = {}) {
  const yaw = streamHeading(st, Math.round(faceAt)), turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -yaw);
  const ref = st.frames[Math.round(faceAt)].hips.clone();
  // low-passed ground track so the pelvis keeps its natural sway
  const n = st.frames.length, w = Math.max(1, Math.round(smooth * st.fps));
  const track = st.frames.map((_, k) => {
    const acc = new THREE.Vector3(); let c = 0;
    for (let j = Math.max(0, k - w); j <= Math.min(n - 1, k + w); j++) { acc.add(st.frames[j].hips); c++; }
    return acc.divideScalar(c);
  });
  const frames = st.frames.map((f, k) => {
    const h = f.hips.clone().sub(ref);
    const drift = track[k].clone().sub(ref).multiplyScalar(1 - travel); drift.y = 0;
    h.sub(drift).applyQuaternion(turn).add(new THREE.Vector3(st.hipsRest.x, ref.y, st.hipsRest.z));
    return { rot: Object.fromEntries(Object.entries(f.rot).map(([b, q]) => [b, turn.clone().multiply(q)])), hips: h };
  });
  return { ...st, frames };
}

/** Keep [from, to] seconds of a stream. */
export function trim(st, from = 0, to = null) {
  const a = Math.max(0, Math.round(from * st.fps)), b = Math.min(st.frames.length - 1, Math.round((to ?? 1e9) * st.fps));
  return { ...st, frames: st.frames.slice(a, b + 1) };
}

/** Make a looping stream seamless: ease the last `blend` seconds onto the first frame. */
export function loopStream(st, blend = 0.2) {
  const n = st.frames.length, m = Math.max(1, Math.min(n - 2, Math.round(blend * st.fps)));
  const frames = st.frames.map((f) => ({ rot: { ...f.rot }, hips: f.hips.clone() }));
  for (let k = n - m; k < n; k++) {
    const x = (k - (n - m) + 1) / m, w = x * x * (3 - 2 * x);
    for (const b of Object.keys(frames[k].rot)) frames[k].rot[b] = frames[k].rot[b].clone().slerp(frames[0].rot[b], w);
    frames[k].hips.lerp(frames[0].hips, w);
  }
  return { ...st, frames, loop: true };
}

// ------------------------------------------------------------------ hfilm-motion@1
const b64 = (ta) => Buffer.from(ta.buffer, ta.byteOffset, ta.byteLength).toString('base64');
const r4 = (v) => Math.round(v * 1e4) / 1e4;

/**
 * Rig-neutral clip from a stream: per-bone world deltas (int16), source rest directions, hips
 * displacement in leg lengths. `relative` adds constant bone deltas relative to the parent bone
 * (e.g. a relaxed hand for captures without fingers).
 */
export function encodeStream(st, { name = st.name, meta = null, relative = null } = {}) {
  const tracks = {}, rest = {}, n = st.frames.length;
  for (const [u, r] of Object.entries(st.rest)) {
    if (!st.frames[0].rot[u]) continue;
    const inv = r.restWorld.clone().invert(), arr = new Int16Array(n * 4), q = new THREE.Quaternion();
    let prev = null;
    for (let k = 0; k < n; k++) {
      q.copy(st.frames[k].rot[u]).multiply(inv).normalize();
      if (prev && prev.dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w);   // keep the hemisphere continuous
      prev = q.clone();
      arr.set([q.x, q.y, q.z, q.w].map((v) => Math.round(v * 32767)), k * 4);
    }
    tracks[u] = b64(arr);
    rest[u] = r.dir ? r.dir.toArray().map(r4) : null;
  }
  const hips = new Float32Array(n * 3), L = st.legLength || 1;
  for (let k = 0; k < n; k++) hips.set(st.frames[k].hips.clone().sub(st.hipsRest).divideScalar(L).toArray(), k * 3);
  return {
    name, fps: st.fps, frames: n, duration: r4((n - 1) / st.fps), loop: !!st.loop, ...(meta ? { meta } : {}),
    rest, tracks, hips: b64(hips), ...(relative ? { relative: Object.fromEntries(Object.entries(relative).map(([b, q]) => [b, q.toArray().map((v) => Math.round(v * 1e5) / 1e5)])) } : {}),
  };
}

export function motionDoc(clips, info = {}) { return { format: 'hfilm-motion@1', ...info, clips }; }

/** Constant parent-relative deltas of `bones` at one frame of a stream (e.g. a relaxed hand). */
export function relativeAt(st, k, bones, parentOf) {
  const out = {}, f = st.frames[k];
  for (const b of bones) {
    const p = parentOf(b);
    if (!f.rot[b] || !f.rot[p]) continue;
    const db = f.rot[b].clone().multiply(st.rest[b].restWorld.clone().invert());
    const dp = f.rot[p].clone().multiply(st.rest[p].restWorld.clone().invert());
    out[b] = dp.invert().multiply(db).normalize();
  }
  return out;
}

// ------------------------------------------------------------------ cycles
const _yawInv = (st, k) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -streamHeading(st, k));

/**
 * Find the best loop [a, b] (frame indices) inside [from, to] seconds whose length is between
 * minLen and maxLen seconds: the two ends have the most similar heading-free poses.
 */
export function findCycle(st, { from = 0, to = null, minLen = 0.5, maxLen = 1.6 } = {}) {
  const n = st.frames.length, A = Math.round(from * st.fps), B = Math.min(n - 1, Math.round((to ?? n / st.fps) * st.fps));
  const bones = Object.keys(st.rest).filter((b) => st.frames[0].rot[b] && !/^(index|middle|ring|pinky|thumb)/.test(b));
  const norm = st.frames.map((f, k) => { const y = _yawInv(st, k); return bones.map((b) => y.clone().multiply(f.rot[b])); });
  let best = null;
  for (let a = A; a < B; a++) for (let b = a + Math.round(minLen * st.fps); b <= Math.min(B, a + Math.round(maxLen * st.fps)); b++) {
    let d = 0;
    for (let k = 0; k < bones.length; k++) d += 1 - Math.abs(norm[a][k].dot(norm[b][k]));
    d += Math.abs(st.frames[a].hips.y - st.frames[b].hips.y) / (st.legLength || 1) * 2;
    // also match velocity: compare the next frame
    if (a + 1 < n && b + 1 < n) for (let k = 0; k < bones.length; k++) d += 0.5 * (1 - Math.abs(norm[a + 1][k].dot(norm[b + 1][k])));
    if (!best || d < best.d) best = { a, b, d };
  }
  return best;
}

/** Mean ground speed of the hips over a stream, in leg lengths per second. */
export function groundSpeed(st) {
  const f0 = st.frames[0].hips, f1 = st.frames[st.frames.length - 1].hips;
  return Math.hypot(f1.x - f0.x, f1.z - f0.z) / (st.legLength || 1) / ((st.frames.length - 1) / st.fps);
}
