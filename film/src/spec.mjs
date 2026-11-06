// Load a film (film.mjs / film.json), validate it and bake it into per-frame tracks the
// renderer can sample. All errors name the field and say what was expected.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as THREE from 'three';

export class FilmError extends Error {}
const fail = (msg) => { throw new FilmError(msg); };
const isFn = (v) => typeof v === 'function';
const vec = (v, n, where) => {
  if (!Array.isArray(v) || v.length !== n || v.some((x) => typeof x !== 'number' || !Number.isFinite(x))) fail(`${where}: expected [${'n,'.repeat(n).slice(0, -1)}] of finite numbers, got ${JSON.stringify(v)}`);
  return v;
};
const r5 = (x) => Math.round(x * 1e5) / 1e5;
const rv = (a) => a.map(r5);
const rq = (q) => q.map((x) => Math.round(x * 1e8) / 1e8);   // rotations need more precision than positions

export async function loadFilm(file) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) fail(`film not found: ${abs}`);
  let film;
  if (abs.endsWith('.json')) film = JSON.parse(fs.readFileSync(abs, 'utf8'));
  else {
    const mod = await import(`${pathToFileURL(abs).href}?v=${Date.now()}`);
    film = mod.default ?? mod.film;
    const d = path.dirname(abs);
    const json = (rel, fallback) => { const p = path.resolve(d, rel); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : fallback; };
    if (isFn(film)) film = await film({ dir: d, anim: await import('./anim.mjs'), sports: await import('./sports.mjs'), THREE, json });
  }
  if (!film || typeof film !== 'object') fail(`${file}: the module must export default a film object (or a function returning one)`);
  return { film, dir: path.dirname(abs), file: abs };
}

/** Registry of local files the page may load. Each directory gets a URL prefix. */
class Assets {
  constructor(dir) { this.dir = dir; this.dirs = []; }
  url(rel, where) {
    if (typeof rel !== 'string') fail(`${where}: expected a file path string`);
    const abs = path.resolve(this.dir, rel);
    if (!fs.existsSync(abs)) fail(`${where}: file not found: ${abs}`);
    const d = path.dirname(abs);
    let i = this.dirs.indexOf(d);
    if (i < 0) { this.dirs.push(d); i = this.dirs.length - 1; }
    return `/asset/${i}/${encodeURIComponent(path.basename(abs))}`;
  }
}

function plateSource(plate, dir, where) {
  if (!plate) return null;
  const pattern = typeof plate === 'string' ? plate : plate.frames;
  if (typeof pattern !== 'string' || !/\{frame(:\d+)?\}/.test(pattern)) fail(`${where}.frames: expected a path pattern containing {frame} or {frame:4}, e.g. "plates/Shot.{frame:4}.jpeg"`);
  return { pattern: path.resolve(dir, pattern), offset: plate.offset || 0, opacity: plate.opacity ?? 1 };
}

export function platePath(src, frame) {
  return src.pattern.replace(/\{frame(?::(\d+))?\}/, (_, w) => String(frame + src.offset).padStart(+(w || 0), '0'));
}

function camState(c, f, aspect, where) {
  if (!c || typeof c !== 'object') fail(`${where} at frame ${f}: expected { position, target, fov | focalLength }`);
  const pos = vec(c.position, 3, `${where}.position (frame ${f})`);
  let q;
  if (c.quaternion) q = vec(c.quaternion, 4, `${where}.quaternion`);
  else {
    const tgt = vec(c.target, 3, `${where}.target (frame ${f})`);
    const m = new THREE.Matrix4().lookAt(new THREE.Vector3(...pos), new THREE.Vector3(...tgt), new THREE.Vector3(...(c.up || [0, 1, 0])));
    q = new THREE.Quaternion().setFromRotationMatrix(m).toArray();
  }
  const sensorW = c.sensorWidth ?? 36;
  let fov = c.fov;
  if (fov == null) {
    if (c.focalLength == null) fail(`${where} (frame ${f}): give fov (vertical degrees) or focalLength (mm)`);
    fov = THREE.MathUtils.radToDeg(2 * Math.atan((sensorW / aspect) / 2 / c.focalLength));
  }
  const focus = c.focusDistance ?? (c.target ? Math.hypot(...c.target.map((v, i) => v - pos[i])) : 10);
  return { pos, q, fov, focus: Math.max(0.05, focus), fstop: c.fStop || 0, sensorH: sensorW / aspect / 1000 };
}

function xform(t, f, where) {
  if (!t || typeof t !== 'object') fail(`${where} at frame ${f}: expected { position, rotation?, scale? }`);
  const p = vec(t.position || [0, 0, 0], 3, `${where}.position (frame ${f})`);
  let q = [0, 0, 0, 1];
  if (t.quaternion) q = vec(t.quaternion, 4, `${where}.quaternion (frame ${f})`);
  else if (t.yaw != null) q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(t.yaw)).toArray();
  else if (t.rotation) q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...vec(t.rotation, 3, `${where}.rotation`).map(THREE.MathUtils.degToRad), 'YXZ')).toArray();
  const s = t.scale == null ? [1, 1, 1] : typeof t.scale === 'number' ? [t.scale, t.scale, t.scale] : vec(t.scale, 3, `${where}.scale`);
  return { p, q, s };
}

function holdoutList(h, dir, where) {
  if (!h) return [];
  let list = h;
  if (typeof h === 'string') {
    const abs = path.resolve(dir, h);
    if (!fs.existsSync(abs)) fail(`${where}: file not found: ${abs}`);
    list = JSON.parse(fs.readFileSync(abs, 'utf8'));
    list = list.holdouts || list;
  }
  if (!Array.isArray(list)) fail(`${where}: expected an array of { shape, matrix } or a JSON file path`);
  return list.map((o, i) => {
    if (!['box', 'cylinder', 'sphere', 'plane'].includes(o.shape)) fail(`${where}[${i}].shape: expected box | cylinder | sphere | plane`);
    let m = o.matrix;
    if (!m) {
      const t = xform(o, 0, `${where}[${i}]`);
      m = new THREE.Matrix4().compose(new THREE.Vector3(...t.p), new THREE.Quaternion(...t.q), new THREE.Vector3(...t.s)).toArray();
    }
    vec(m, 16, `${where}[${i}].matrix`);
    const out = { shape: o.shape, matrix: m.map(r5) };
    if (o.grid) out.grid = { cell: +o.grid.cell || 0.1, line: +o.grid.line || 0.064 };
    return out;
  });
}

/** Bake a loaded film into the JSON the renderer consumes. */
export function bakeFilm({ film, dir }, { frames, samples, ignorePlate = false } = {}) {
  const assets = new Assets(dir);
  const fps = film.fps ?? 30;
  const [width, height] = film.size || [film.width ?? 1280, film.height ?? 720];
  if (width % 2 || height % 2) fail(`size: width and height must be even (H.264), got ${width}x${height}`);
  let [start, end] = film.frames || [0, Math.round((film.duration ?? 5) * fps)];
  if (frames) [start, end] = [Math.max(start, frames[0]), Math.min(end, frames[1])];
  if (!(end > start)) fail(`frames: empty range [${start}, ${end})`);
  const aspect = width / height;
  const N = end - start;
  const R = film.render || {};

  // camera
  if (!film.camera) fail('camera: required. Give a function (frame) => ({ position, target, focalLength }) or a static object');
  const camFn = isFn(film.camera) ? film.camera : () => film.camera;
  const cam = { position: [], quaternion: [], fov: [], focus: [], fstop: [], sensorHeight: 0 };
  for (let f = start; f < end; f++) {
    const c = camState(camFn(f), f, aspect, 'camera');
    cam.position.push(rv(c.pos)); cam.quaternion.push(rq(c.q)); cam.fov.push(r5(c.fov)); cam.focus.push(r5(c.focus)); cam.fstop.push(r5(c.fstop));
    cam.sensorHeight = c.sensorH;
  }
  if (!cam.fstop.some((v) => v > 0)) delete cam.fstop;
  const c0 = isFn(film.camera) ? film.camera(start) : film.camera;
  cam.near = c0.near ?? 0.05; cam.far = c0.far ?? 5000;

  // actors
  const ids = new Set();
  const actors = (film.actors || []).map((a, idx) => {
    const where = `actors[${idx}]${a.id ? ` (${a.id})` : ''}`;
    if (a.id && ids.has(a.id)) fail(`${where}: duplicate id`);
    ids.add(a.id);
    let model;
    if (typeof a.model === 'string') model = { url: assets.url(a.model, `${where}.model`) };
    else {
      model = { ...(a.model || { primitive: 'sphere', radius: 0.5 }) };
      if (model.material?.map) model.material = { ...model.material, map: assets.url(model.material.map, `${where}.model.material.map`) };
    }
    const tf = isFn(a.transform) ? a.transform : () => a.transform || {};
    const out = { id: a.id || `actor${idx}`, model, tint: a.tint, castShadow: a.castShadow, receiveShadow: a.receiveShadow, position: [], quaternion: [], scale: [] };
    if (a.animation) out.anim = [];
    if (isFn(a.visible)) out.visible = [];
    if (isFn(a.pose)) out.pose = [];
    for (let f = start; f < end; f++) {
      const t = xform(tf(f), f, `${where}.transform`);
      out.position.push(rv(t.p)); out.quaternion.push(rq(t.q)); out.scale.push(rv(t.s));
      if (a.animation) {
        const list = isFn(a.animation) ? a.animation(f) : a.animation;
        out.anim.push((list || []).map((x) => [x.clip, r5(x.time ?? f / fps), x.weight ?? 1]));
      }
      if (out.visible) out.visible.push(a.visible(f) ? 1 : 0);
      if (out.pose) {   // additive bone rotations in the actor's own frame (degrees), sparse per frame
        const p = a.pose(f) || {}, o = {};
        // bone names as three.js stores them (glTF names minus . : / [ ], spaces -> _)
        for (const [bone, v] of Object.entries(p)) { vec(v, 3, `${where}.pose['${bone}']`); if (v.some((x) => Math.abs(x) > 0.01)) o[bone.replace(/\s/g, '_').replace(/[\[\].:/]/g, '')] = v.map(r5); }
        out.pose.push(o);
      }
    }
    return out;
  });

  const plate = ignorePlate ? null : plateSource(film.plate, dir, 'plate');
  if (plate) for (const f of [start, end - 1]) if (!fs.existsSync(platePath(plate, f))) fail(`plate: missing plate for frame ${f}: ${platePath(plate, f)}`);
  const env = film.environment ? { ...film.environment, hdri: film.environment.hdri ? assets.url(film.environment.hdri, 'environment.hdri') : null } : null;
  let sun = film.sun ?? { direction: [0.4, 1, 0.3] };
  if (sun) {
    sun = { ...sun };
    if (sun.direction) vec(sun.direction, 3, 'sun.direction');
    else if (sun.elevation != null) {
      const el = THREE.MathUtils.degToRad(sun.elevation), az = THREE.MathUtils.degToRad(sun.azimuth || 0);
      sun.direction = [Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)];
    }
  }
  const baked = {
    version: 1, fps, width, height, start, end, cuts: (film.cuts || []).filter((c) => c > start && c < end),
    render: { samples: samples ?? R.samples ?? 16, shutter: R.shutter ?? 0.5, toneMapping: R.toneMapping || 'agx', exposure: R.exposure ?? 1, dof: R.dof !== false, dither: R.dither ?? 1, bitrate: R.bitrate },
    plate: plate ? { url: '/plate/{frame}', opacity: plate.opacity } : null,
    background: film.background === undefined ? '#000000' : film.background,
    environment: env, sun, ambient: film.ambient || null,
    catcher: plate ? (film.shadowCatcher === false ? null : (film.shadowCatcher || {})) : null,
    holdouts: holdoutList(film.holdouts, dir, 'holdouts'),
    grade: film.grade || null,
    camera: cam, actors,
  };
  return { baked, assets, plate, frames: N };
}
