// Hybrid Film renderer (runs in the browser page).
//
// Film mode: every output frame is the average of N sub-frames, each with
//   - sub-pixel jitter            -> anti-aliasing
//   - a time inside the shutter   -> true motion blur
//   - a point on the lens         -> thin-lens depth of field (focus plane stays fixed)
//   - a point on the sun's disc   -> soft, physically sized shadows
// Plate mode composites the result over per-frame background plates (from Unreal or any
// renderer) using holdouts (depth-only stand-ins for plate geometry) and a shadow catcher
// that adds ONLY the shadows the new actors cast (full shadow mask minus static-only mask).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

const L = { ACTOR: 1, HOLDOUT: 2, CATCHER: 3, LIGHT_FULL: 4, LIGHT_STATIC: 5, AMBIENT: 6 };

// ---------------------------------------------------------------- sampling helpers
function halton(i, b) {
  let f = 1, r = 0;
  while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); }
  return r;
}
function diskSample(i) {  // concentric-ish mapping of a 2D Halton point onto the unit disc
  const r = Math.sqrt(halton(i + 1, 5)), a = 2 * Math.PI * halton(i + 1, 7);
  return [r * Math.cos(a), r * Math.sin(a)];
}

// ---------------------------------------------------------------- per-frame track evaluation
// Tracks are baked per integer frame (index = frame - start). Sub-frame times interpolate
// (Catmull-Rom for vectors, slerp for rotations) but never across a camera cut.
class Timeline {
  constructor(spec) {
    this.start = spec.start; this.end = spec.end;
    const cuts = [...new Set([spec.start, ...(spec.cuts || [])])].filter((c) => c >= spec.start && c < spec.end).sort((a, b) => a - b);
    this.cuts = cuts;
  }
  segment(frame) {  // [first, last] integer frames of the shot containing `frame`
    let a = this.start, b = this.end - 1;
    for (const c of this.cuts) { if (c <= frame) a = c; else { b = c - 1; break; } }
    return [a, b];
  }
  // returns [i0, i1, i2, i3, t] indices into baked arrays for time `t` within shot of `frame`
  locate(frame, t) {
    const [a, b] = this.segment(frame);
    const tc = Math.min(Math.max(t, a), b);
    const f1 = Math.min(Math.floor(tc), b), f2 = Math.min(f1 + 1, b);
    const f0 = Math.max(f1 - 1, a), f3 = Math.min(f2 + 1, b);
    return [f0 - this.start, f1 - this.start, f2 - this.start, f3 - this.start, tc - f1];
  }
}
function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return p1.map((_, k) => 0.5 * ((2 * p1[k]) + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3));
}
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();
function sampleVec(arr, loc) { const [a, b, c, d, t] = loc; return catmull(arr[a], arr[b], arr[c], arr[d], t); }
function sampleNum(arr, loc) { const [, b, c, , t] = loc; return arr[b] + (arr[c] - arr[b]) * t; }
// Baked quaternions are rounded, so not exactly unit length: three.js slerp then treats two nearby
// rotations (dot >= 1) as identical and holds the first, which split motion-blur samples between two
// frames' cameras (double images on slow pans). Normalise, take the short way, nlerp when nearly equal.
function sampleQuat(arr, loc, out) {
  const [, b, c, , t] = loc;
  _qa.fromArray(arr[b]).normalize(); _qb.fromArray(arr[c]).normalize();
  let d = _qa.dot(_qb);
  if (d < 0) { _qb.set(-_qb.x, -_qb.y, -_qb.z, -_qb.w); d = -d; }
  if (d > 0.9995) return out.set(_qa.x + (_qb.x - _qa.x) * t, _qa.y + (_qb.y - _qa.y) * t, _qa.z + (_qb.z - _qa.z) * t, _qa.w + (_qb.w - _qa.w) * t).normalize();
  return out.slerpQuaternions(_qa, _qb, t);
}

// ---------------------------------------------------------------- shaders
const QUAD_VS = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const ACCUM_FS = `
  uniform sampler2D tSub; uniform sampler2D tShFull; uniform sampler2D tShStatic; uniform float weight; uniform int mode;
  varying vec2 vUv;
  void main(){
    if (mode == 0) { gl_FragColor = texture2D(tSub, vUv) * weight; }
    else { float s = max(texture2D(tShFull, vUv).a - texture2D(tShStatic, vUv).a, 0.0); gl_FragColor = vec4(s * weight, 0.0, 0.0, 0.0); }
  }`;
const COMPOSITE_FS = `
  #include <tonemapping_pars_fragment>
  uniform sampler2D tAccum; uniform sampler2D tShadow; uniform sampler2D tPlate;
  uniform bool hasPlate; uniform vec3 bgColor; uniform float bgAlpha; uniform float exposure; uniform int toneMode;
  uniform float shadowOpacity; uniform vec3 shadowTint; uniform vec3 layerGain; uniform float layerSaturation;
  uniform float dither;
  varying vec2 vUv;
  vec3 toLinear(vec3 c){ return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
  vec3 toSRGB(vec3 c){ c = clamp(c, 0.0, 1.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
  float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
  void main(){
    vec4 acc = texture2D(tAccum, vUv);                       // premultiplied, linear HDR
    vec3 layer = acc.a > 1e-5 ? acc.rgb / acc.a : vec3(0.0);
    layer *= layerGain * exposure;
    float luma = dot(layer, vec3(0.2126, 0.7152, 0.0722));
    layer = mix(vec3(luma), layer, layerSaturation);
    if (toneMode == 1) layer = AgXToneMapping(layer);
    else if (toneMode == 2) layer = ACESFilmicToneMapping(layer);
    else if (toneMode == 3) layer = NeutralToneMapping(layer);
    else layer = clamp(layer, 0.0, 1.0);
    vec3 base; float baseA = 1.0;
    if (hasPlate) {
      vec3 plate = toLinear(texture2D(tPlate, vec2(vUv.x, 1.0 - vUv.y)).rgb);
      float s = clamp(texture2D(tShadow, vUv).r, 0.0, 1.0) * shadowOpacity;
      base = plate * mix(vec3(1.0), shadowTint, s);           // tinted, only-new shadows
    } else { base = toLinear(bgColor); baseA = bgAlpha; }
    vec3 outc = toSRGB(base * (1.0 - acc.a) + layer * acc.a);
    outc += (hash(gl_FragCoord.xy) - 0.5) * dither / 255.0;   // break up banding before H.264
    gl_FragColor = vec4(outc, max(baseA, acc.a));
  }`;

// ---------------------------------------------------------------- film
export async function createFilm(canvas, spec, { onLog = console.log } = {}) {
  const W = spec.width, H = spec.height;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;  // composite shader does its own encoding
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.autoClear = false;
  const gl = renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown';

  const scene = new THREE.Scene();
  const timeline = new Timeline(spec);
  const plateMode = !!spec.plate;

  // ---- environment & lights
  if (spec.environment?.hdri) {
    const EnvLoader = /\.exr$/i.test(spec.environment.hdri) ? EXRLoader : RGBELoader;
    const tex = await new EnvLoader().loadAsync(spec.environment.hdri);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromEquirectangular(tex).texture;
    scene.environmentIntensity = spec.environment.intensity ?? 1;
    scene.environmentRotation.y = THREE.MathUtils.degToRad(spec.environment.rotation || 0);
    if (spec.environment.background && !plateMode) { scene.background = tex; scene.backgroundRotation.y = scene.environmentRotation.y; scene.backgroundIntensity = spec.environment.intensity ?? 1; }
    if (!spec.environment.background || plateMode) tex.dispose();
    pmrem.dispose();
  }
  const amb = spec.ambient || {};
  const hemi = new THREE.HemisphereLight(amb.sky || '#a9c0dc', amb.ground || '#3a3f33', amb.intensity ?? (scene.environment ? 0 : 0.8));
  hemi.layers.set(L.AMBIENT);
  scene.add(hemi);

  const sunSpec = spec.sun;
  const sunDir = new THREE.Vector3(...(sunSpec?.direction || [0.4, 1, 0.3])).normalize();
  const makeSun = (layer) => {
    const l = new THREE.DirectionalLight(sunSpec?.color || '#ffffff', sunSpec?.intensity ?? 3);
    l.castShadow = sunSpec?.shadow !== false;
    l.shadow.mapSize.set(sunSpec?.shadowMapSize || 4096, sunSpec?.shadowMapSize || 4096);
    l.shadow.bias = sunSpec?.shadowBias ?? -0.0004;
    l.shadow.normalBias = sunSpec?.shadowNormalBias ?? 0.02;
    l.shadow.autoUpdate = false;
    l.layers.set(layer);
    scene.add(l, l.target);
    return l;
  };
  const sunFull = sunSpec ? makeSun(L.LIGHT_FULL) : null;
  const sunStatic = sunSpec && plateMode ? makeSun(L.LIGHT_STATIC) : null;
  if (sunStatic) sunStatic.intensity = 0;  // only its shadow map is used (by the catcher)

  // ---- holdouts (plate geometry stand-ins: depth only, cast shadows onto actors)
  const holdoutMat = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide });
  const shapeGeo = {
    box: new THREE.BoxGeometry(1, 1, 1),
    cylinder: new THREE.CylinderGeometry(0.5, 0.5, 1, 24),
    sphere: new THREE.SphereGeometry(0.5, 24, 16),
    plane: new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
  };
  // grid holdouts (e.g. goal nets): occlude only along world-space grid lines, like the plate's net material
  const gridMats = new Map();
  const gridMat = (g) => {
    const key = `${g.cell}:${g.line}`;
    if (!gridMats.has(key)) gridMats.set(key, new THREE.ShaderMaterial({
      colorWrite: false, side: THREE.DoubleSide, uniforms: { cell: { value: g.cell }, line: { value: g.line } },
      vertexShader: `varying vec3 vW; varying vec3 vN;
        void main(){ mat4 m = modelMatrix * instanceMatrix; vec4 w = m * vec4(position, 1.0); vW = w.xyz; vN = normalize(mat3(m) * normal);
          gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `uniform float cell; uniform float line; varying vec3 vW; varying vec3 vN;
        void main(){ vec3 n = abs(normalize(vN)); vec2 uv = n.x > 0.5 ? vW.yz : (n.y > 0.5 ? vW.xz : vW.xy);
          vec2 f = abs(fract(uv / cell) - 0.5); if (max(f.x, f.y) <= 0.5 - line * 0.5) discard; gl_FragColor = vec4(0.0); }`,
    }));
    return gridMats.get(key);
  };
  const groups = {};
  for (const h of spec.holdouts || []) { const k = `${h.shape}|${h.grid ? `${h.grid.cell}:${h.grid.line}` : ''}`; (groups[k] ||= []).push(h); }
  let holdoutCount = 0;
  for (const list of Object.values(groups)) {
    const { shape, grid } = list[0];
    const geo = shapeGeo[shape];
    if (!geo) { onLog('warn', `unknown holdout shape ${shape}`); continue; }
    const im = new THREE.InstancedMesh(geo, grid ? gridMat(grid) : holdoutMat, list.length);
    const m = new THREE.Matrix4();
    list.forEach((h, i) => im.setMatrixAt(i, m.fromArray(h.matrix)));
    im.instanceMatrix.needsUpdate = true;
    im.computeBoundingSphere();
    im.castShadow = !grid;   // nets barely shadow; solid stand-ins do
    im.frustumCulled = false;
    im.renderOrder = -10;  // depth first so actors behind plate geometry are rejected
    im.layers.set(L.HOLDOUT);
    scene.add(im);
    holdoutCount += list.length;
  }

  // ---- shadow catcher (an invisible ground that only shows shadows)
  let catcher = null;
  if (plateMode && spec.catcher !== null) {
    const c = spec.catcher || {};
    catcher = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000).rotateX(-Math.PI / 2), new THREE.ShadowMaterial({ opacity: 1 }));
    catcher.position.y = c.y ?? 0;
    catcher.receiveShadow = true;
    catcher.layers.set(L.CATCHER);
    scene.add(catcher);
  }

  // ---- actors
  const gltfCache = new Map();
  const loader = new GLTFLoader();
  const texLoader = new THREE.TextureLoader();
  const actors = [];
  for (const a of spec.actors || []) {
    let root, mixer = null, actions = {};
    if (a.model?.url) {
      if (!gltfCache.has(a.model.url)) gltfCache.set(a.model.url, loader.loadAsync(a.model.url));
      const gltf = await gltfCache.get(a.model.url);
      root = SkeletonUtils.clone(gltf.scene);
      if (gltf.animations?.length) {
        mixer = new THREE.AnimationMixer(root);
        for (const clip of gltf.animations) actions[clip.name] = mixer.clipAction(clip);
      }
      if (a.tint) {
        root.traverse((o) => {
          if (!o.isMesh) return;
          o.material = Array.isArray(o.material) ? o.material.map((m) => m.clone()) : o.material.clone();
          for (const m of [].concat(o.material)) {
            const col = a.tint[m.name] ?? a.tint['*'];
            if (col && m.color) m.color.set(col);
          }
        });
      }
    } else {
      const p = a.model || { primitive: 'sphere', radius: 0.5 };
      const geo = p.primitive === 'box' ? new THREE.BoxGeometry(...(p.size || [1, 1, 1]))
        : p.primitive === 'cylinder' ? new THREE.CylinderGeometry(p.radius ?? 0.5, p.radius ?? 0.5, p.height ?? 1, 48)
        : p.primitive === 'plane' ? new THREE.PlaneGeometry(...(p.size || [1, 1])).rotateX(-Math.PI / 2)
        : new THREE.SphereGeometry(p.radius ?? 0.5, 96, 48);
      const mp = p.material || {};
      const mat = new THREE.MeshPhysicalMaterial({
        color: mp.color || '#ffffff', roughness: mp.roughness ?? 0.5, metalness: mp.metalness ?? 0,
        clearcoat: mp.clearcoat ?? 0, clearcoatRoughness: mp.clearcoatRoughness ?? 0.2,
        emissive: mp.emissive || '#000000', emissiveIntensity: mp.emissiveIntensity ?? 1,
      });
      for (const field of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap']) {
        if (!mp[field]) continue;
        const texture = await texLoader.loadAsync(mp[field]);
        texture.colorSpace = ['map', 'emissiveMap'].includes(field) ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
        mat[field] = texture;
      }
      if (mp.normalScale) mat.normalScale.fromArray(mp.normalScale);
      if (mp.aoMap) mat.aoMapIntensity = mp.aoMapIntensity ?? 1;
      if (mp.alphaMap) { mat.alphaTest = mp.alphaTest ?? 0.5; mat.transparent = mp.transparent ?? false; }
      root = new THREE.Mesh(geo, mat);
    }
    root.traverse((o) => {
      o.layers.set(L.ACTOR);
      if (o.isMesh) { o.castShadow = a.castShadow !== false; o.receiveShadow = a.receiveShadow !== false; o.frustumCulled = false; }
    });
    root.matrixAutoUpdate = true;
    scene.add(root);
    // bones by name, parents before children, for additive poses
    const bones = {}, depth = (o) => { let d = 0; while (o.parent) { d++; o = o.parent; } return d; };
    root.traverse((o) => { if (o.isBone) bones[o.name] = o; });
    const poseOrder = Object.keys(bones).sort((x, y) => depth(bones[x]) - depth(bones[y]));
    actors.push({ spec: a, root, mixer, actions, bones, poseOrder, restore: [] });
  }

  // ---- camera & render targets
  const camera = new THREE.PerspectiveCamera(50, W / H, spec.camera.near ?? 0.05, spec.camera.far ?? 5000);
  const rtOpts = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: true, colorSpace: THREE.LinearSRGBColorSpace };
  const rtSub = new THREE.WebGLRenderTarget(W, H, rtOpts);
  const rtShFull = new THREE.WebGLRenderTarget(W, H, rtOpts);
  const rtShStatic = new THREE.WebGLRenderTarget(W, H, rtOpts);
  const rtAcc = new THREE.WebGLRenderTarget(W, H, { ...rtOpts, depthBuffer: false });
  const rtShAcc = new THREE.WebGLRenderTarget(W, H, { ...rtOpts, depthBuffer: false });
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quadGeo = new THREE.PlaneGeometry(2, 2);
  const accumMat = new THREE.ShaderMaterial({
    vertexShader: QUAD_VS, fragmentShader: ACCUM_FS, depthTest: false, depthWrite: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    uniforms: { tSub: { value: rtSub.texture }, tShFull: { value: rtShFull.texture }, tShStatic: { value: rtShStatic.texture }, weight: { value: 1 }, mode: { value: 0 } },
  });
  const plateTex = new THREE.Texture();
  plateTex.colorSpace = THREE.NoColorSpace;
  plateTex.flipY = false;
  const g = spec.grade || {};
  const toneModes = { none: 0, agx: 1, aces: 2, neutral: 3 };
  const compMat = new THREE.ShaderMaterial({
    vertexShader: QUAD_VS, fragmentShader: COMPOSITE_FS, depthTest: false, depthWrite: false, toneMapped: false,
    uniforms: {
      tAccum: { value: rtAcc.texture }, tShadow: { value: rtShAcc.texture }, tPlate: { value: plateTex }, hasPlate: { value: plateMode },
      bgColor: { value: new THREE.Color(spec.background || '#000000') }, bgAlpha: { value: spec.background === null ? 0 : 1 },
      exposure: { value: spec.render.exposure ?? 1 }, toneMode: { value: toneModes[spec.render.toneMapping || 'agx'] ?? 1 },
      toneMappingExposure: { value: 1 },
      shadowOpacity: { value: spec.catcher?.opacity ?? 0.65 }, shadowTint: { value: new THREE.Color(spec.catcher?.tint || '#1d2a44') },
      layerGain: { value: new THREE.Vector3(...(g.gain || [1, 1, 1])) }, layerSaturation: { value: g.saturation ?? 1 },
      dither: { value: spec.render.dither ?? 1 },
    },
  });
  const quadScene = new THREE.Scene();
  const quad = new THREE.Mesh(quadGeo, accumMat);
  quad.frustumCulled = false;
  quadScene.add(quad);

  // ---- per-sample scene evaluation
  const camSpec = spec.camera;
  const _v = new THREE.Vector3(), _right = new THREE.Vector3(), _up = new THREE.Vector3(), _q = new THREE.Quaternion();
  const box = new THREE.Box3(), sphere = new THREE.Sphere();

  // Additive pose: per bone [x, y, z] degrees, a rotation expressed in the actor's own frame (+Z forward,
  // +Y up, +X the character's left) applied about the bone's pivot after the clips. Rig-independent:
  // "swing the right thigh 40 degrees forward" is { 'DEF-thigh.R': [-40, 0, 0] } on any skeleton.
  const _pe = new THREE.Euler(), _pq = new THREE.Quaternion(), _pr = new THREE.Quaternion(), _pri = new THREE.Quaternion(), _pp = new THREE.Quaternion();
  const D2R = Math.PI / 180, NO = [0, 0, 0];
  function applyPose(act, pose, loc) {
    const [, i1, i2, , u] = loc;
    const p1 = pose[i1] || {}, p2 = pose[i2] || {};
    let any = false;
    for (const k in p1) { any = true; break; }
    if (!any) for (const k in p2) { any = true; break; }
    if (!any) return;
    act.root.getWorldQuaternion(_pr); _pri.copy(_pr).invert();
    for (const name of act.poseOrder) {
      const v1 = p1[name], v2 = p2[name];
      if (!v1 && !v2) continue;
      const b = act.bones[name], a1 = v1 || NO, a2 = v2 || NO;
      _pe.set((a1[0] + (a2[0] - a1[0]) * u) * D2R, (a1[1] + (a2[1] - a1[1]) * u) * D2R, (a1[2] + (a2[2] - a1[2]) * u) * D2R, 'YXZ');
      _pq.setFromEuler(_pe).premultiply(_pr).multiply(_pri);           // actor-frame rotation -> world
      b.parent.getWorldQuaternion(_pp);
      _pq.premultiply(_pp.clone().invert()).multiply(_pp);             // world -> bone-parent frame
      act.restore.push([b, b.quaternion.clone()]);   // the mixer skips bones whose clip value didn't change,
      b.quaternion.premultiply(_pq);                 // so undo the pose before the next sample
      b.updateMatrixWorld(true);
    }
  }

  function placeActors(frame, t) {
    const loc = timeline.locate(frame, t);
    for (const act of actors) {
      const a = act.spec;
      for (const [bone, q] of act.restore) bone.quaternion.copy(q);
      act.restore.length = 0;
      act.root.position.fromArray(sampleVec(a.position, loc));
      sampleQuat(a.quaternion, loc, act.root.quaternion);
      act.root.scale.fromArray(sampleVec(a.scale, loc));
      act.root.visible = a.visible ? a.visible[loc[1]] !== 0 : true;
      if (act.mixer && a.anim) {
        const [, i1, i2, , u] = loc;
        const now = a.anim[i1] || [], next = a.anim[i2] || [];
        for (const action of Object.values(act.actions)) { action.enabled = false; action.weight = 0; }
        for (const [clip, time, weight] of now) {
          const action = act.actions[clip];
          if (!action) continue;
          const n = next.find((x) => x[0] === clip);
          action.enabled = true;
          action.play();
          action.setEffectiveWeight(weight ?? 1);
          // interpolate clip time for motion-blur sub-frames; a looping clip that wraps between two
          // frames (0.98 s -> 0.02 s) must go forward through the loop point, not back through the cycle
          const dur = action.getClip().duration;
          let t2 = n ? n[1] : time;
          if (t2 - time > dur / 2) t2 -= dur; else if (time - t2 > dur / 2) t2 += dur;
          let tt = time + (t2 - time) * u;
          if (tt < 0) tt += dur; else if (tt > dur) tt -= dur;
          action.time = tt;
        }
        act.mixer.update(0);
      }
      act.root.updateMatrixWorld(true);
      if (a.pose) applyPose(act, a.pose, loc);
    }
    return loc;
  }

  function placeCamera(loc, sample, n) {
    camera.position.fromArray(sampleVec(camSpec.position, loc));
    sampleQuat(camSpec.quaternion, loc, camera.quaternion);
    camera.fov = sampleNum(camSpec.fov, loc);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();
    const focus = sampleNum(camSpec.focus, loc);
    const fstop = camSpec.fstop ? sampleNum(camSpec.fstop, loc) : 0;
    const e = camera.projectionMatrix.elements;
    if (n > 1) {
      // sub-pixel jitter (box filter over one pixel)
      e[8] += (halton(sample + 1, 2) - 0.5) * 2 / W;
      e[9] += (halton(sample + 1, 3) - 0.5) * 2 / H;
      // thin lens: move the eye on the aperture, shear the frustum so the focus plane stays put
      if (fstop > 0 && spec.render.dof !== false) {
        const sensorH = camSpec.sensorHeight || 24 / 1000;                            // metres
        const focalM = (sensorH / 2) / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
        const apertureR = focalM / (2 * fstop);
        const [dx, dy] = diskSample(sample).map((v) => v * apertureR);
        _right.set(1, 0, 0).applyQuaternion(camera.quaternion);
        _up.set(0, 1, 0).applyQuaternion(camera.quaternion);
        camera.position.addScaledVector(_right, dx).addScaledVector(_up, dy);
        camera.updateMatrixWorld(true);
        e[8] += -e[0] * dx / focus;
        e[9] += -e[5] * dy / focus;
      }
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    }
  }

  function fitShadows(sample, n) {
    if (!sunFull) return;
    box.makeEmpty();
    for (const act of actors) if (act.spec.castShadow !== false && act.root.visible) box.expandByObject(act.root);
    if (box.isEmpty()) box.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(10, 2, 10));
    box.getBoundingSphere(sphere);
    const r = Math.max(sphere.radius + (sunSpec.shadowMargin ?? 6), 4);
    // soft shadows: jitter the light direction across the sun's angular diameter
    const soft = THREE.MathUtils.degToRad(sunSpec.softness ?? 0.6) * 0.5;
    _v.copy(sunDir);
    if (n > 1 && soft > 0) {
      const [sx, sy] = diskSample(sample + 101);
      _right.set(0, 1, 0).cross(sunDir).normalize();
      if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0);
      _up.crossVectors(sunDir, _right).normalize();
      _v.addScaledVector(_right, sx * soft).addScaledVector(_up, sy * soft).normalize();
    }
    for (const l of [sunFull, sunStatic]) {
      if (!l) continue;
      l.position.copy(sphere.center).addScaledVector(_v, r * 4);
      l.target.position.copy(sphere.center);
      l.target.updateMatrixWorld();
      const c = l.shadow.camera;
      c.left = -r; c.right = r; c.top = r; c.bottom = -r; c.near = 0.1; c.far = r * 8;
      c.updateProjectionMatrix();
      l.shadow.needsUpdate = true;
    }
  }

  function draw(target, layers) {
    camera.layers.disableAll();
    for (const l of layers) camera.layers.enable(l);
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    renderer.render(scene, camera);
  }

  function accumulate(target, mode, weight) {
    quad.material = accumMat;
    accumMat.uniforms.mode.value = mode;
    accumMat.uniforms.weight.value = weight;
    renderer.setRenderTarget(target);
    renderer.render(quadScene, quadCam);
  }

  let lastPlateFrame = null;
  async function loadPlate(frame) {
    if (!plateMode || lastPlateFrame === frame) return;
    const url = spec.plate.url.replace('{frame}', String(frame));
    const res = await fetch(url);
    if (!res.ok) throw new Error(`plate ${url}: HTTP ${res.status}`);
    const bmp = await createImageBitmap(await res.blob(), { imageOrientation: 'none', colorSpaceConversion: 'none' });
    if (plateTex.image?.close) plateTex.image.close();
    plateTex.image = bmp;
    plateTex.needsUpdate = true;
    lastPlateFrame = frame;
    if (amb.fromPlate) {  // hemisphere fill from the plate: top third = sky, bottom half = ground
      const c = new OffscreenCanvas(16, 9).getContext('2d');
      c.drawImage(bmp, 0, 0, 16, 9);
      const px = c.getImageData(0, 0, 16, 9).data;
      const avg = (y0, y1) => { const s = [0, 0, 0]; let k = 0; for (let y = y0; y < y1; y++) for (let x = 0; x < 16; x++, k++) for (let ch = 0; ch < 3; ch++) s[ch] += px[(y * 16 + x) * 4 + ch]; return s.map((v) => v / k / 255); };
      hemi.color.setRGB(...avg(0, 3), THREE.SRGBColorSpace);
      hemi.groundColor.setRGB(...avg(5, 9), THREE.SRGBColorSpace);
    }
  }

  async function renderFrame(frame, samples = spec.render.samples || 16) {
    const t0 = performance.now();
    await loadPlate(frame);
    const n = Math.max(1, samples | 0);
    const shutter = n > 1 ? (spec.render.shutter ?? 0.5) : 0;
    for (const rt of [rtAcc, rtShAcc]) { renderer.setRenderTarget(rt); renderer.setClearColor(0, 0); renderer.clear(true, false, false); }
    for (let i = 0; i < n; i++) {
      const t = frame + (n > 1 ? ((i + halton(i + 1, 11)) / n - 0.5) * shutter : 0);
      const loc = placeActors(frame, t);
      placeCamera(loc, i, n);
      fitShadows(i, n);
      // actors, shadowed by each other and by the plate geometry; static-only shadow map in the same pass
      draw(rtSub, [L.ACTOR, L.HOLDOUT, L.LIGHT_FULL, L.AMBIENT]);
      if (catcher) {
        if (sunFull) sunFull.shadow.needsUpdate = false;
        draw(rtShFull, [L.CATCHER, L.HOLDOUT, L.LIGHT_FULL]);
        draw(rtShStatic, [L.CATCHER, L.HOLDOUT, L.LIGHT_STATIC]);
        if (sunStatic) sunStatic.shadow.needsUpdate = false;
      }
      accumulate(rtAcc, 0, 1 / n);
      if (catcher) accumulate(rtShAcc, 1, 1 / n);
    }
    quad.material = compMat;
    renderer.setRenderTarget(null);
    renderer.setClearColor(0, 0);
    renderer.clear(true, true, true);
    renderer.render(quadScene, quadCam);
    gl.finish();
    return { frame, ms: Math.round(performance.now() - t0) };
  }

  return { renderFrame, info: { gpu, actors: actors.length, holdouts: holdoutCount, plate: plateMode, width: W, height: H } };
}
