// Motion capture input: Acclaim ASF/AMC (the CMU Graphics Lab Motion Capture Database format).
// `amcStream` turns a skeleton + motion pair into a pose stream for rig.mjs `retarget`.
//
// ASF/AMC math (per bone): L = C * R(motion) * C^-1, world = parent.world * L, where C comes from
// the bone's `axis` and both rotations use static XYZ Euler angles (R = Rz * Ry * Rx). A bone's
// segment runs from its parent's end along `direction * length`; its world rotation orients that
// segment. The zero pose is the ASF rest pose (a T-pose facing +Z, Y up), so rest world = identity.
import fs from 'node:fs';
import * as THREE from 'three';

const D2R = Math.PI / 180;
// static xyz (Rz*Ry*Rx) equals three.js intrinsic 'ZYX' order
const staticXYZ = (x, y, z) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x * D2R, y * D2R, z * D2R, 'ZYX'));

export function parseASF(text) {
  const bones = new Map([['root', { name: 'root', dir: new THREE.Vector3(), length: 0, axis: new THREE.Quaternion(), dof: ['tx', 'ty', 'tz', 'rx', 'ry', 'rz'], parent: null, children: [] }]]);
  const lines = text.split(/\r?\n/);
  let section = '', cur = null, units = { length: 1 };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith(':')) { section = line.split(/\s+/)[0]; continue; }
    const w = line.split(/\s+/);
    if (section === ':units' && w[0] === 'length') units.length = +w[1];
    else if (section === ':bonedata') {
      if (w[0] === 'begin') cur = { dir: new THREE.Vector3(), length: 0, axis: new THREE.Quaternion(), dof: [], children: [] };
      else if (w[0] === 'end') { bones.set(cur.name, cur); cur = null; }
      else if (w[0] === 'name') cur.name = w[1];
      else if (w[0] === 'direction') cur.dir.set(+w[1], +w[2], +w[3]).normalize();
      else if (w[0] === 'length') cur.length = +w[1];
      else if (w[0] === 'axis') cur.axis = staticXYZ(+w[1], +w[2], +w[3]);
      else if (w[0] === 'dof') cur.dof = w.slice(1).map((d) => d.toLowerCase());
    } else if (section === ':hierarchy') {
      if (w[0] === 'begin' || w[0] === 'end') continue;
      const p = bones.get(w[0]);
      for (const c of w.slice(1)) { const b = bones.get(c); if (b) { b.parent = w[0]; p.children.push(c); } }
    }
  }
  const order = [], visit = (n) => { order.push(n); for (const c of bones.get(n).children) visit(c); };
  visit('root');
  return { bones, order, units };
}

export function parseAMC(text) {
  const frames = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(':')) continue;
    if (/^\d+$/.test(line)) { cur = {}; frames.push(cur); continue; }
    if (!cur) continue;
    const w = line.split(/\s+/);
    cur[w[0]] = w.slice(1).map(Number);
  }
  return frames;
}

/** World rotations (and end positions) of every bone for one AMC frame. */
export function poseASF(asf, frame) {
  const out = new Map();
  for (const name of asf.order) {
    const b = asf.bones.get(name), vals = frame[name] || [];
    const rot = { rx: 0, ry: 0, rz: 0 }, pos = new THREE.Vector3();
    b.dof.forEach((d, k) => { if (d in rot) rot[d] = vals[k] ?? 0; else if (d === 'tx') pos.x = vals[k]; else if (d === 'ty') pos.y = vals[k]; else if (d === 'tz') pos.z = vals[k]; });
    const L = b.axis.clone().multiply(staticXYZ(rot.rx, rot.ry, rot.rz)).multiply(b.axis.clone().invert());
    if (!b.parent) { out.set(name, { q: L, start: pos.clone(), end: pos.clone() }); continue; }
    const p = out.get(b.parent), q = p.q.clone().multiply(L);
    out.set(name, { q, start: p.end.clone(), end: p.end.clone().add(b.dir.clone().applyQuaternion(q).multiplyScalar(b.length)) });
  }
  return out;
}

/** CMU / Acclaim bone names -> universal names. */
export const CMU_MAP = {
  pelvis: 'root', spine_01: 'lowerback', spine_02: 'upperback', spine_03: 'thorax', neck_01: 'lowerneck', Head: 'head',
  clavicle_l: 'lclavicle', upperarm_l: 'lhumerus', lowerarm_l: 'lradius', hand_l: 'lhand',
  clavicle_r: 'rclavicle', upperarm_r: 'rhumerus', lowerarm_r: 'rradius', hand_r: 'rhand',
  thigh_l: 'lfemur', calf_l: 'ltibia', foot_l: 'lfoot', ball_l: 'ltoes',
  thigh_r: 'rfemur', calf_r: 'rtibia', foot_r: 'rfoot', ball_r: 'rtoes',
};

/**
 * ASF + AMC -> pose stream (universal bone names). `fps` resamples from the capture rate
 * (CMU: 120 Hz). `from`/`to` are capture seconds.
 */
export function amcStream(asfFile, amcFile, { fps = 60, captureFps = 120, from = 0, to = null, name = null } = {}) {
  const asf = parseASF(fs.readFileSync(asfFile, 'utf8'));
  const raw = parseAMC(fs.readFileSync(amcFile, 'utf8'));
  const dur = (raw.length - 1) / captureFps, end = Math.min(to ?? dur, dur);
  const rest = {};
  const restPose = poseASF(asf, {});
  for (const [u, s] of Object.entries(CMU_MAP)) {
    const b = asf.bones.get(s);
    if (!b) continue;
    // segment direction: for the pelvis use "up" (lowerback), otherwise the bone's own direction
    const dir = u === 'pelvis' ? null : b.dir.clone();
    rest[u] = { restWorld: new THREE.Quaternion(), dir, pos: restPose.get(s).start.clone() };
  }
  // leg length (ASF units) for scaling the hips: femur + tibia
  const len = (n) => asf.bones.get(n)?.length || 0;
  const legLength = (len('lfemur') + len('ltibia') + len('rfemur') + len('rtibia')) / 2;
  const frames = [];
  for (let t = from; t <= end + 1e-9; t += 1 / fps) {
    const x = t * captureFps, k = Math.min(raw.length - 2, Math.floor(x)), u = Math.min(1, x - k);
    const A = poseASF(asf, raw[k]), B = poseASF(asf, raw[k + 1] || raw[k]);
    const rot = {};
    for (const [uName, s] of Object.entries(CMU_MAP)) if (A.has(s)) rot[uName] = A.get(s).q.clone().slerp(B.get(s).q, u);
    const low = Math.min(...['lfoot', 'rfoot', 'ltoes', 'rtoes'].filter((j) => A.has(j)).map((j) => A.get(j).end.y));
    frames.push({ rot, hips: A.get('root').start.clone().lerp(B.get('root').start, u), low });
  }
  // the capture floor: feet rest on it most of the time (a low percentile of the lowest foot joint)
  const lows = frames.map((f) => f.low).sort((a, b) => a - b), ground = lows[Math.floor(lows.length * 0.05)] ?? 0;
  for (const f of frames) { f.hips.y -= ground; delete f.low; }
  // standing hip height: the rest pose's root sits that far above its lowest joint
  let minY = 0;
  for (const v of restPose.values()) minY = Math.min(minY, v.end.y);
  return { fps, frames, rest, legLength, hipsRest: new THREE.Vector3(0, -minY, 0), name: name || amcFile.split('/').pop().replace(/\.amc$/, '') };
}

/** Per-frame world position of a CMU joint end (e.g. 'rtoes'), for detecting contacts. */
export function amcJointTrack(asfFile, amcFile, joint, { fps = 60, captureFps = 120, from = 0, to = null } = {}) {
  const asf = parseASF(fs.readFileSync(asfFile, 'utf8'));
  const raw = parseAMC(fs.readFileSync(amcFile, 'utf8'));
  const end = Math.min(to ?? (raw.length - 1) / captureFps, (raw.length - 1) / captureFps), out = [];
  for (let t = from; t <= end + 1e-9; t += 1 / fps) out.push(poseASF(asf, raw[Math.min(raw.length - 1, Math.round(t * captureFps))]).get(joint).end.clone());
  return out;
}
