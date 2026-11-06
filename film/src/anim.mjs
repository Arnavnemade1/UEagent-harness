// Authoring helpers for film modules: code-driven motion in the three.js spirit.
// World convention (same as three.js / glTF): metres, +Y up, right-handed.
//   import { keys, ease, arc, smooth, lookAt, handheld, ue } from 'hybrid-film/anim';
import * as THREE from 'three';

const isArr = Array.isArray;
const lerp = (a, b, t) => (isArr(a) ? a.map((v, i) => v + (b[i] - v) * t) : a + (b - a) * t);

/** Easing curves, t in [0,1]. */
export const ease = {
  linear: (t) => t,
  in: (t) => t * t * t,
  out: (t) => 1 - (1 - t) ** 3,
  inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  sine: (t) => 0.5 - 0.5 * Math.cos(Math.PI * t),
};

/**
 * Keyframe track -> function(frame).
 *   keys([[0, [0,0,0]], [30, [5,0,0], 'out'], [60, [5,2,0]]], { interp: 'smooth' })
 * Values: numbers or arrays. Per-key easing (3rd item) shapes the segment that ENDS at that key.
 * interp: 'smooth' (Catmull-Rom through the keys), 'linear', or 'hold'.
 */
export function keys(list, { interp = 'smooth' } = {}) {
  if (!list.length) throw new Error('keys(): need at least one key');
  const k = [...list].sort((a, b) => a[0] - b[0]);
  return (f) => {
    if (f <= k[0][0]) return k[0][1];
    if (f >= k[k.length - 1][0]) return k[k.length - 1][1];
    let i = 0;
    while (f > k[i + 1][0]) i++;
    const [f1, v1] = k[i], [f2, v2, e] = k[i + 1];
    let t = (f - f1) / (f2 - f1);
    if (e) t = (typeof e === 'function' ? e : ease[e])(t);
    if (interp === 'hold') return v1;
    if (interp === 'linear' || k.length < 3) return lerp(v1, v2, t);
    const v0 = (k[i - 1] || k[i])[1], v3 = (k[i + 2] || k[i + 1])[1];
    const cr = (p0, p1, p2, p3) => 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
    return isArr(v1) ? v1.map((_, j) => cr(v0[j], v1[j], v2[j], v3[j])) : cr(v0, v1, v2, v3);
  };
}

/** Ballistic arc from a to b peaking `height` metres above the straight line (t in [0,1]). */
export const arc = (a, b, height, t) => {
  const p = lerp(a, b, t);
  p[1] += 4 * height * t * (1 - t);
  return p;
};

/**
 * Critically damped smoothing of any frame->value function (like a camera operator following
 * action). Precomputes over [start, end). `lag` = how many frames the result trails a target
 * moving at constant speed (bigger = smoother, lazier operator).
 */
export function smooth(fn, start, end, lag = 6) {
  const out = new Map();
  const k = 2 / (Math.max(0.25, lag) + 0.5);   // +0.5: the target advances in whole-frame steps
  let x = fn(start), v = isArr(x) ? x.map(() => 0) : 0;
  for (let f = start; f < end; f++) {
    const target = fn(f);
    // exact critically damped spring step (dt = 1 frame)
    const ex = Math.exp(-k), step = (xi, vi, ti) => {
      const j0 = xi - ti, j1 = vi + j0 * k;
      return [ti + (j0 + j1) * ex, (vi - j1 * k) * ex];
    };
    if (isArr(x)) { const r = x.map((xi, i) => step(xi, v[i], target[i])); x = r.map((q) => q[0]); v = r.map((q) => q[1]); }
    else [x, v] = step(x, v, target);
    out.set(f, x);
  }
  return (f) => out.get(Math.min(end - 1, Math.max(start, Math.round(f)))) ?? fn(f);
}

/** Quaternion [x,y,z,w] for an object at `from` looking toward `to` (+Z forward, like glTF characters). */
export function lookAt(from, to, up = [0, 1, 0]) {
  const m = new THREE.Matrix4().lookAt(new THREE.Vector3(...to), new THREE.Vector3(...from), new THREE.Vector3(...up));
  return new THREE.Quaternion().setFromRotationMatrix(m).toArray();
}

/** Quaternion for a heading in degrees around +Y (0 = facing +Z). */
export const yaw = (deg) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(deg)).toArray();

/** Smooth deterministic noise in [-1,1]. */
export function noise(seed = 1) {
  const rnd = (i) => { const x = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453; return (x - Math.floor(x)) * 2 - 1; };
  return (t) => { const i = Math.floor(t), f = t - i, u = f * f * (3 - 2 * f); return rnd(i) * (1 - u) + rnd(i + 1) * u; };
}

/**
 * Broadcast/handheld camera feel: adds gentle operator drift to a camera function's target.
 *   camera: handheld((f) => ({ position, target, ... }), { amount: 0.15, speed: 0.6 })
 */
export function handheld(camFn, { amount = 0.12, speed = 0.5, seed = 7, fps = 30 } = {}) {
  const nx = noise(seed), ny = noise(seed + 11), nz = noise(seed + 23);
  return (f) => {
    const c = camFn(f);
    const t = (f / fps) * speed * 4;
    const d = Math.hypot(...c.target.map((v, i) => v - c.position[i]));
    const s = amount * Math.max(1, d / 20);
    return { ...c, target: [c.target[0] + nx(t) * s, c.target[1] + ny(t) * s * 0.6, c.target[2] + nz(t) * s] };
  };
}

/** Distance between two points. */
export const dist = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));

/**
 * Unreal Engine <-> film world conversion. Unreal: centimetres, +Z up, left-handed.
 * Film/three.js: metres, +Y up, right-handed. The mapping swaps Y and Z (a reflection,
 * which is exactly the handedness change) and scales by 1/100.
 */
export const ue = {
  pos: ([x, y, z]) => [x / 100, z / 100, y / 100],
  toUE: ([x, y, z]) => [x * 100, z * 100, y * 100],
  dir: ([x, y, z]) => [x, z, y],
  /** Unreal quaternion (x,y,z,w) -> film quaternion. */
  quat: ([x, y, z, w]) => [-x, -z, -y, w],
};

/** Colour temperature (Kelvin, 1000-40000) -> hex sRGB, e.g. kelvin(4600) for a golden-hour sun. */
export function kelvin(k) {
  const t = k / 100;
  const r = t <= 66 ? 255 : 329.698727446 * (t - 60) ** -0.1332047592;
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * (t - 60) ** -0.0755148492;
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const c = (v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}
