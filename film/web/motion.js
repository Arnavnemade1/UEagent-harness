// Rig-neutral motion clips (format "hfilm-motion@1"), shared by Node (tools, tests) and the page.
//
// A clip stores, per bone of the universal humanoid, the bone's WORLD rotation delta from its rest
// pose (delta(t) = world(t) * restWorld^-1), the bone's rest direction in the source rig, and the
// hips displacement divided by the source leg length. Applying it to any humanoid:
//
//   world_b(t) = delta_b(t) * align_b * restWorld_b,  align_b swings the target's rest direction
//   onto the source's, so A-pose/T-pose, bone axes and proportions don't matter.
//
// Rigs are matched by name: universal (Unreal/Quaternius) names directly, Rigify "DEF-" and Mixamo
// names through built-in maps, anything else through an explicit map.
import * as THREE from 'three';

export const SIDES = ['l', 'r'];
const FINGERS = ['index', 'middle', 'ring', 'pinky', 'thumb'];
export const UNIVERSAL = ['root', 'pelvis', 'spine_01', 'spine_02', 'spine_03', 'neck_01', 'Head',
  ...SIDES.flatMap((s) => [`clavicle_${s}`, `upperarm_${s}`, `lowerarm_${s}`, `hand_${s}`, `thigh_${s}`, `calf_${s}`, `foot_${s}`, `ball_${s}`,
    ...FINGERS.flatMap((f) => [1, 2, 3].map((k) => `${f}_0${k}_${s}`))])];

export const DIR_CHILD = { pelvis: 'spine_01', spine_01: 'spine_02', spine_02: 'spine_03', spine_03: 'neck_01', neck_01: 'Head',
  ...Object.fromEntries(SIDES.flatMap((s) => [[`clavicle_${s}`, `upperarm_${s}`], [`upperarm_${s}`, `lowerarm_${s}`], [`lowerarm_${s}`, `hand_${s}`], [`hand_${s}`, `middle_01_${s}`],
    [`thigh_${s}`, `calf_${s}`], [`calf_${s}`, `foot_${s}`], [`foot_${s}`, `ball_${s}`],
    ...FINGERS.flatMap((f) => [[`${f}_01_${s}`, `${f}_02_${s}`], [`${f}_02_${s}`, `${f}_03_${s}`]])])) };

export const RIGIFY_MAP = Object.fromEntries([
  ['pelvis', 'DEF-hips'], ['spine_01', 'DEF-spine.001'], ['spine_02', 'DEF-spine.002'], ['spine_03', 'DEF-spine.003'], ['neck_01', 'DEF-neck'], ['Head', 'DEF-head'],
  ...SIDES.flatMap((s) => { const S = s.toUpperCase(); return [
    [`clavicle_${s}`, `DEF-shoulder.${S}`], [`upperarm_${s}`, `DEF-upper_arm.${S}`], [`lowerarm_${s}`, `DEF-forearm.${S}`], [`hand_${s}`, `DEF-hand.${S}`],
    [`thigh_${s}`, `DEF-thigh.${S}`], [`calf_${s}`, `DEF-shin.${S}`], [`foot_${s}`, `DEF-foot.${S}`], [`ball_${s}`, `DEF-toe.${S}`],
    ...['index', 'middle', 'ring', 'pinky'].flatMap((f) => [1, 2, 3].map((k) => [`${f}_0${k}_${s}`, `DEF-f_${f}.0${k}.${S}`])),
    ...[1, 2, 3].map((k) => [`thumb_0${k}_${s}`, `DEF-thumb.0${k}.${S}`])]; }),
]);

export const MIXAMO_MAP = Object.fromEntries([
  ['pelvis', 'mixamorig:Hips'], ['spine_01', 'mixamorig:Spine'], ['spine_02', 'mixamorig:Spine1'], ['spine_03', 'mixamorig:Spine2'], ['neck_01', 'mixamorig:Neck'], ['Head', 'mixamorig:Head'],
  ...SIDES.flatMap((s) => { const S = s === 'l' ? 'Left' : 'Right'; return [
    [`clavicle_${s}`, `mixamorig:${S}Shoulder`], [`upperarm_${s}`, `mixamorig:${S}Arm`], [`lowerarm_${s}`, `mixamorig:${S}ForeArm`], [`hand_${s}`, `mixamorig:${S}Hand`],
    [`thigh_${s}`, `mixamorig:${S}UpLeg`], [`calf_${s}`, `mixamorig:${S}Leg`], [`foot_${s}`, `mixamorig:${S}Foot`], [`ball_${s}`, `mixamorig:${S}ToeBase`],
    ...FINGERS.flatMap((f) => [1, 2, 3].map((k) => [`${f}_0${k}_${s}`, `mixamorig:${S}Hand${f === 'pinky' ? 'Pinky' : f[0].toUpperCase() + f.slice(1)}${k}`]))]; }),
]);

/** three.js sanitises node names (drops . : / [ ]); match either spelling. */
export const sanitize = (n) => n.replace(/\s/g, '_').replace(/[\[\].:/]/g, '');

/** Universal name -> actual bone name for a set of bone names (auto-detects Rigify / Mixamo). */
export function boneMap(names, explicit = null) {
  const have = new Set(names), out = {};
  const pick = (cands) => cands.find((c) => have.has(c)) ?? cands.map(sanitize).find((c) => have.has(c));
  for (const u of UNIVERSAL) {
    const hit = pick([explicit?.[u], u, RIGIFY_MAP[u], MIXAMO_MAP[u]].filter(Boolean));
    if (hit) out[u] = hit;
  }
  return out;
}

const _v = new THREE.Vector3(), _q = new THREE.Quaternion();

/** Rest description of a skinned humanoid (an Object3D tree with bones in their rest pose). */
export function rigOf(root, explicitMap = null) {
  const byName = {};
  root.traverse((o) => { if (o.isBone || o.type === 'Bone') byName[o.name] = o; });
  const map = boneMap(Object.keys(byName), explicitMap);
  root.updateMatrixWorld(true);
  const rootInv = root.matrixWorld.clone().invert();
  const world = (o) => o.matrixWorld.clone().premultiply(rootInv);
  const bones = {};
  for (const [u, name] of Object.entries(map)) {
    const b = byName[name], W = world(b), pos = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    W.decompose(pos, q, s);
    bones[u] = { bone: b, name, restWorld: q, restLocal: b.quaternion.clone(), pos };
  }
  for (const [u, b] of Object.entries(bones)) {
    const c = bones[DIR_CHILD[u]] || (() => { const k = b.bone.children.find((x) => x.isBone || x.type === 'Bone'); return k ? { pos: new THREE.Vector3().setFromMatrixPosition(world(k)) } : null; })();
    b.dir = c && c.pos.distanceTo(b.pos) > 1e-6 ? c.pos.clone().sub(b.pos).normalize() : null;
  }
  const leg = (s) => (bones[`thigh_${s}`] && bones[`calf_${s}`] && bones[`foot_${s}`] ? bones[`thigh_${s}`].pos.distanceTo(bones[`calf_${s}`].pos) + bones[`calf_${s}`].pos.distanceTo(bones[`foot_${s}`].pos) : 0);
  const pelvis = bones.pelvis;
  const parentRestWorldInv = pelvis ? world(pelvis.bone.parent).invert() : new THREE.Matrix4();
  return { bones, map, legLength: (leg('l') + leg('r')) / 2, hips: pelvis?.pos.clone(), parentRestWorldInv, rootWorld: root.matrixWorld.clone() };
}

// ------------------------------------------------------------------ decoding
function b64ToBytes(s) {
  if (typeof Buffer !== 'undefined') { const b = Buffer.from(s, 'base64'); return new Uint8Array(b.buffer, b.byteOffset, b.byteLength); }
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const i16 = (s) => { const b = b64ToBytes(s); const a = new Int16Array(b.byteLength / 2); new Uint8Array(a.buffer).set(b); return Float32Array.from(a, (v) => v / 32767); };
const f32 = (s) => { const b = b64ToBytes(s); const a = new Float32Array(b.byteLength / 4); new Uint8Array(a.buffer).set(b); return a; };

export function decodeMotion(doc) {
  if (doc?.format !== 'hfilm-motion@1') throw new Error('expected an hfilm-motion@1 document');
  return doc.clips.map((c) => ({
    ...c,
    rest: Object.fromEntries(Object.entries(c.rest || {}).map(([b, d]) => [b, d ? new THREE.Vector3(...d) : null])),
    tracks: Object.fromEntries(Object.entries(c.tracks).map(([b, s]) => [b, i16(s)])),
    relative: Object.fromEntries(Object.entries(c.relative || {}).map(([b, q]) => [b, new THREE.Quaternion(...q)])),
    hips: c.hips ? f32(c.hips) : null,
  }));
}

/**
 * Local-rotation tracks for one rig. Returns { name, duration, times, local: {actualName: Float32Array}, hips: Float32Array|null }.
 * Bones the clip doesn't drive keep their rest local rotation; `relative` bones follow their parent.
 */
export function bakeForRig(clip, rig) {
  const n = clip.frames, times = new Float32Array(n);
  for (let k = 0; k < n; k++) times[k] = k / clip.fps;
  // parents before children, universal names only
  const order = Object.keys(rig.bones).sort((a, b) => depth(rig.bones[a].bone) - depth(rig.bones[b].bone));
  const align = {};
  for (const u of order) {
    const src = clip.rest[u], dst = rig.bones[u].dir;
    align[u] = src && dst ? new THREE.Quaternion().setFromUnitVectors(dst, src) : new THREE.Quaternion();
  }
  const local = {}, world = {}, delta = {};
  for (const u of order) if (clip.tracks[u] || clip.relative[u]) local[rig.bones[u].name] = new Float32Array(n * 4);
  const hips = clip.hips && rig.hips ? new Float32Array(n * 3) : null;
  const parentU = {};
  for (const u of order) { let p = rig.bones[u].bone.parent; parentU[u] = null; while (p) { const hit = order.find((x) => rig.bones[x].bone === p); if (hit) { parentU[u] = hit; break; } p = p.parent; } }
  const restParentWorld = (u) => { // rest world rotation of the bone's direct parent object
    const b = rig.bones[u], q = b.restWorld.clone().multiply(b.restLocal.clone().invert()); return q;
  };
  const pw = {};
  for (let k = 0; k < n; k++) {
    for (const u of order) {
      const b = rig.bones[u];
      const pu = parentU[u];
      // world rotation of the direct parent this frame: rest-parent world adjusted by the nearest driven ancestor's change
      let parentWorld;
      if (pu && pu === nearestParentIsBone(b, rig, pu)) parentWorld = world[pu];
      else parentWorld = pu ? world[pu].clone().multiply(rig.bones[pu].restWorld.clone().invert()).multiply(restParentWorld(u)) : restParentWorld(u);
      let w;
      if (clip.tracks[u]) {
        const t = clip.tracks[u];
        delta[u] = new THREE.Quaternion(t[k * 4], t[k * 4 + 1], t[k * 4 + 2], t[k * 4 + 3]).normalize();
        w = delta[u].clone().multiply(align[u]).multiply(b.restWorld);
      } else if (clip.relative[u] && pu && delta[pu]) {
        delta[u] = delta[pu].clone().multiply(clip.relative[u]);
        w = delta[u].clone().multiply(align[u]).multiply(b.restWorld);
      } else {
        w = parentWorld.clone().multiply(b.restLocal);
        delta[u] = w.clone().multiply(b.restWorld.clone().invert());
      }
      world[u] = w;
      pw[u] = parentWorld;
      const arr = local[b.name];
      if (arr) { _q.copy(parentWorld).invert().multiply(w).normalize(); arr.set([_q.x, _q.y, _q.z, _q.w], k * 4); }
    }
    if (hips) {
      _v.set(clip.hips[k * 3], clip.hips[k * 3 + 1], clip.hips[k * 3 + 2]).multiplyScalar(rig.legLength).add(rig.hips).applyMatrix4(rig.parentRestWorldInv);
      hips.set([_v.x, _v.y, _v.z], k * 3);
    }
  }
  return { name: clip.name, duration: (n - 1) / clip.fps, times, local, hips, pelvisName: rig.bones.pelvis?.name };
}
function depth(o) { let d = 0; while (o.parent) { d++; o = o.parent; } return d; }
// the universal parent is the direct parent object (no unmapped bones in between)
function nearestParentIsBone(b, rig, pu) { return b.bone.parent === rig.bones[pu].bone ? pu : null; }

/** A THREE.AnimationClip for a rig (bone names as the mixer binds them). */
export function threeClip(clip, rig) {
  const baked = bakeForRig(clip, rig), tracks = [];
  for (const [name, arr] of Object.entries(baked.local)) tracks.push(new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, baked.times, arr));
  if (baked.hips && baked.pelvisName) tracks.push(new THREE.VectorKeyframeTrack(`${baked.pelvisName}.position`, baked.times, baked.hips));
  return new THREE.AnimationClip(clip.name, baked.duration, tracks);
}
