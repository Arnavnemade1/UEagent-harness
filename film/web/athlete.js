// Athletes: skin tone, hair/gear attachments and procedural sports kits for any skinned humanoid
// (universal, Rigify or Mixamo bone names). Runs in the page.
//
// Kits are real garment shells, not paint: the body's triangles under each garment are copied,
// pushed out along their normals (looser at hems), skinned to the same skeleton and cut to shape
// per pixel. The body is hidden underneath, so limbs never poke through. Garment zones come from
// the bind pose: every vertex knows how much it belongs to the torso, an arm, a leg or the head
// (from its skin weights) and its position along that part (0 shoulder → 1 elbow → 2 wrist,
// 0 hip → 1 knee → 2 ankle → 3 toes), so hems, cuffs and sock lines are clean on any body.
import * as THREE from 'three';
import { boneMap } from './motion.js';

const SIDES = ['l', 'r'];
const GROUPS = { torso: 0, arm: 1, leg: 2, head: 3 };
const GROUP_OF = (u) => (/^(pelvis|spine_0\d|clavicle_[lr])$/.test(u) ? 'torso' : /^(neck_01|Head)$/.test(u) ? 'head'
  : /^(upperarm|lowerarm|hand|index|middle|ring|pinky|thumb)/.test(u) ? 'arm' : /^(thigh|calf|foot|ball)/.test(u) ? 'leg' : null);

export const KIT_DEFAULTS = {
  shirt: '#c8102e', trim: '#ffffff', pattern: 'plain', patternColor: '#ffffff', patternScale: 0.11, sleeve: null,
  sleeves: 'short', collar: 'crew', number: null, name: null, numberColor: '#ffffff', numberOutline: null,
  sponsor: null, sponsorColor: null, badge: null, maker: true,
  shorts: '#ffffff', shortsTrim: null, socks: null, sockTrim: null, boots: '#141414', bootAccent: '#e9e9e9', gloves: null,
  fabric: { sheen: 0.6, roughness: 0.72 }, fit: 1,
};

// ------------------------------------------------------------------ bind-space landmarks
function landmarks(mesh, map) {
  const sk = mesh.skeleton, idx = {}, pos = {};
  sk.bones.forEach((b, i) => { idx[b.name] = i; });
  const inv = mesh.bindMatrixInverse;
  const at = (u) => {
    const i = idx[map[u]];
    if (i === undefined) return null;
    return new THREE.Vector3().applyMatrix4(sk.boneInverses[i].clone().invert()).applyMatrix4(inv);
  };
  for (const u of ['pelvis', 'spine_03', 'neck_01', 'Head', ...SIDES.flatMap((s) => [`upperarm_${s}`, `lowerarm_${s}`, `hand_${s}`, `thigh_${s}`, `calf_${s}`, `foot_${s}`, `ball_${s}`])]) pos[u] = at(u);
  // group of every bone (unmapped bones inherit from their nearest mapped ancestor)
  const uOf = Object.fromEntries(Object.entries(map).map(([u, n]) => [n, u]));
  const boneGroup = sk.bones.map((b) => {
    for (let o = b; o; o = o.parent) { const u = uOf[o.name]; const g = u && GROUP_OF(u); if (g) return { g, side: /_l$/.test(u) ? 'l' : /_r$/.test(u) ? 'r' : null, u }; }
    return { g: 'torso', side: null, u: null };
  });
  return { pos, boneGroup };
}

const proj = (p, a, b) => { const d = b.clone().sub(a); return p.clone().sub(a).dot(d) / d.lengthSq(); };

/** Per-vertex aGrp (torso, arm, leg, head memberships) and aPar (position along each part). */
function kitAttributes(mesh, map) {
  const geo = mesh.geometry;
  if (geo.userData.kitAttrs) return geo.userData.kitAttrs;
  const { pos: L, boneGroup } = landmarks(mesh, map);
  const P = geo.attributes.position, SI = geo.attributes.skinIndex, SW = geo.attributes.skinWeight, n = P.count;
  const grp = new Float32Array(n * 4), par = new Float32Array(n * 4);
  const v = new THREE.Vector3();
  const torsoY0 = L.pelvis.y, torsoY1 = (L.neck_01 || L.spine_03).y, headY1 = (L.Head || L.neck_01).y + 0.25;
  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(P, i);
    const w = [0, 0, 0, 0];
    let sideW = { l: 0, r: 0 }, legBone = { thigh: 0, calf: 0, foot: 0 }, armBone = { upper: 0, lower: 0 };
    for (let k = 0; k < 4; k++) {
      const wt = SW.getComponent(i, k);
      if (!wt) continue;
      const bg = boneGroup[SI.getComponent(i, k)];
      w[GROUPS[bg.g]] += wt;
      if (bg.side) sideW[bg.side] += wt;
      if (bg.u) {
        if (/^thigh/.test(bg.u)) legBone.thigh += wt; else if (/^calf/.test(bg.u)) legBone.calf += wt; else if (/^(foot|ball)/.test(bg.u)) legBone.foot += wt;
        if (/^upperarm/.test(bg.u)) armBone.upper += wt; else if (/^(lowerarm|hand|index|middle|ring|pinky|thumb)/.test(bg.u)) armBone.lower += wt;
      }
    }
    const s = sideW.l >= sideW.r ? (v.x >= 0 || sideW.l > 0 ? 'l' : 'r') : 'r';
    grp.set(w, i * 4);
    // torso: 0 at the pelvis joint, 1 at the neck joint
    const tp = (v.y - torsoY0) / (torsoY1 - torsoY0);
    // arm: shoulder 0, elbow 1, wrist 2, fingertips ~2.6
    let ap = 0;
    const sh = L[`upperarm_${s}`], el = L[`lowerarm_${s}`], wr = L[`hand_${s}`];
    if (sh && el && wr) { const a1 = proj(v, sh, el); ap = armBone.lower > armBone.upper && a1 > 0.6 ? 1 + proj(v, el, wr) : a1; }
    // leg: hip 0, knee 1, ankle 2, toes 3
    let lp = 0;
    const hp = L[`thigh_${s}`], kn = L[`calf_${s}`], an = L[`foot_${s}`], to = L[`ball_${s}`];
    if (hp && kn && an) {
      const dom = legBone.foot > Math.max(legBone.thigh, legBone.calf) ? 'foot' : legBone.calf > legBone.thigh ? 'calf' : 'thigh';
      lp = dom === 'thigh' ? proj(v, hp, kn) : dom === 'calf' ? 1 + proj(v, kn, an) : (to ? 2 + Math.max(0, proj(v, an, to)) : 2.2);
      // the ankle bone also skins the heel and the lower shin: below the ankle joint it is foot
      if (dom !== 'thigh' && v.y < an.y + 0.02) lp = Math.max(lp, 2 + Math.max(0, (an.y + 0.02 - v.y) / 0.1) * 0.15);
    }
    const hpar = (v.y - torsoY1) / (headY1 - torsoY1);
    par.set([tp, ap, lp, hpar], i * 4);
  }
  const chestZ = L.spine_03 ? L.spine_03.z : 0;
  const attrs = { grp, par, landmarks: L, chestZ, hipY: (L.thigh_l?.y ?? L.pelvis.y), shoulderY: (L.upperarm_l?.y ?? torsoY1), torsoY0, torsoY1 };
  geo.setAttribute('aGrp', new THREE.BufferAttribute(grp, 4));
  geo.setAttribute('aPar', new THREE.BufferAttribute(par, 4));
  geo.userData.kitAttrs = attrs;
  return attrs;
}

// ------------------------------------------------------------------ zones (JS mirror of the GLSL)
function thresholds(kit, A) {
  const t = A.torsoY1 - A.torsoY0;
  return {
    shirtHem: (A.hipY - 0.035 - A.torsoY0) / t,               // untucked hem just below the hip joints
    collarR: kit.collar === 'polo' ? 0.072 : 0.082, collarDrop: kit.collar === 'polo' ? 0.0 : 0.025, vDepth: kit.collar === 'v' ? 0.11 : 0.0, vWidth: 0.065,
    neck: A.landmarks.neck_01 || A.landmarks.spine_03,
    sleeveEnd: kit.sleeves === 'long' ? 1.93 : 0.66, gloveStart: kit.gloves ? 1.88 : 99,
    shortsHem: 0.42 * (kit.fit ?? 1), sockTop: 1.13, bootTop: 1.9, chestZ: A.chestZ,
  };
}
// the neck hole: inside a radius around the neck axis and above the neckline (lower at the front for a V)
function neckHole(x, y, z, T) {
  const dx = x - T.neck.x, dz = z - T.neck.z, r = Math.hypot(dx, dz);
  const drop = T.collarDrop + (dz > 0 ? T.vDepth * Math.max(0, 1 - Math.abs(dx) / T.vWidth) + 0.02 * Math.min(1, dz / 0.06) : 0);
  return Math.min(T.collarR - r, y - (T.neck.y - drop));   // > 0 inside the hole
}
function zoneOf(g, p, x, y, z, T) {   // 0 skin, 1 shirt, 2 shorts, 3 socks, 4 boots, 5 gloves
  let gi = 0;
  for (let k = 1; k < 4; k++) if (g[k] > g[gi]) gi = k;
  if (gi === 0) return neckHole(x, y, z, T) > 0 ? 0 : p[0] >= T.shirtHem ? 1 : 2;
  if (gi === 1) return p[1] <= T.sleeveEnd ? 1 : p[1] >= T.gloveStart ? 5 : 0;
  if (gi === 2) return p[2] <= T.shortsHem ? 2 : p[2] >= T.bootTop ? 4 : p[2] >= T.sockTop ? 3 : 0;
  return 0;
}

const ZONE_GLSL = /* glsl */`
uniform float kShirtHem, kCollarR, kCollarDrop, kVDepth, kVWidth, kSleeveEnd, kGloveStart, kShortsHem, kSockTop, kBootTop, kChestZ;
uniform vec3 kNeck;
float neckHole(vec3 b) {
  vec2 d = b.xz - kNeck.xz; float r = length(d);
  float drop = kCollarDrop + (d.y > 0.0 ? kVDepth * max(0.0, 1.0 - abs(d.x) / kVWidth) + 0.02 * min(1.0, d.y / 0.06) : 0.0);
  return min(kCollarR - r, b.y - (kNeck.y - drop));
}
int kitZone(vec4 g, vec4 p, vec3 b) {
  int gi = 0; float m = g.x;
  if (g.y > m) { gi = 1; m = g.y; }
  if (g.z > m) { gi = 2; m = g.z; }
  if (g.w > m) { gi = 3; }
  if (gi == 0) return neckHole(b) > 0.0 ? 0 : (p.x >= kShirtHem ? 1 : 2);
  if (gi == 1) return p.y <= kSleeveEnd ? 1 : (p.y >= kGloveStart ? 5 : 0);
  if (gi == 2) return p.z <= kShortsHem ? 2 : (p.z >= kBootTop ? 4 : (p.z >= kSockTop ? 3 : 0));
  return 0;
}`;

function zoneUniforms(T) {
  return { kShirtHem: { value: T.shirtHem }, kCollarR: { value: T.collarR }, kCollarDrop: { value: T.collarDrop }, kNeck: { value: T.neck.clone() }, kVDepth: { value: T.vDepth }, kVWidth: { value: T.vWidth },
    kSleeveEnd: { value: T.sleeveEnd }, kGloveStart: { value: T.gloveStart }, kShortsHem: { value: T.shortsHem }, kSockTop: { value: T.sockTop },
    kBootTop: { value: T.bootTop }, kChestZ: { value: T.chestZ } };
}

// ------------------------------------------------------------------ decal sheet (names, numbers, badge, sponsor)
const PANEL = { back: { w: 0.46, h: 0.62 }, front: { w: 0.46, h: 0.62 } };
function decalSheet(kit, A) {
  const S = 1024, c = document.createElement('canvas');
  c.width = S; c.height = S / 2;
  const g = c.getContext('2d');
  g.clearRect(0, 0, S, S / 2);
  const px = (S / 2) / PANEL.back.w, py = (S / 2) / PANEL.back.h;   // pixels per metre in each panel
  const text = (str, cx, cy, hM, color, { font = '900', family = '"Arial Black", "Helvetica Neue", Arial, sans-serif', squeeze = 0.78, outline = null, maxW = 0.4 } = {}) => {
    g.save();
    g.translate(cx, cy);
    g.scale(px / py * squeeze, 1);
    g.font = `${font} ${Math.round(hM * py * 1.33)}px ${family}`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const w = g.measureText(str).width * px / py * squeeze;
    if (w > maxW * px) g.scale(maxW * px / w, 1);
    if (outline) { g.lineWidth = hM * py * 0.12; g.strokeStyle = outline; g.lineJoin = 'round'; g.strokeText(str, 0, 0); }
    g.fillStyle = color; g.fillText(str, 0, 0);
    g.restore();
  };
  // back panel: x in [0, S/2); top of panel = shoulder line
  const bx = S / 4;
  if (kit.name) text(String(kit.name).toUpperCase(), bx, 0.13 * py, 0.065, kit.numberColor, { font: '700', family: '"Helvetica Neue", Arial, sans-serif', squeeze: 0.95, outline: kit.numberOutline, maxW: 0.34 });
  if (kit.number != null) text(String(kit.number), bx, 0.36 * py, 0.25, kit.numberColor, { outline: kit.numberOutline, maxW: 0.36 });
  // front panel: x in [S/2, S); the character's left chest is on the viewer's right
  const fx = S * 3 / 4;
  if (kit.sponsor) text(String(kit.sponsor).toUpperCase(), fx, 0.27 * py, 0.075, kit.sponsorColor || kit.numberColor, { font: '800', family: '"Helvetica Neue", Arial, sans-serif', squeeze: 0.9, maxW: 0.28 });
  if (kit.badge !== false) {   // a simple shield crest on the left chest
    const b = kit.badge || {}, cx = fx + 0.085 * px, cy = 0.105 * py, w = 0.06 * px, h = 0.07 * py;
    g.save(); g.translate(cx, cy);
    g.beginPath(); g.moveTo(-w / 2, -h / 2); g.lineTo(w / 2, -h / 2); g.lineTo(w / 2, 0); g.quadraticCurveTo(w / 2, h * 0.35, 0, h / 2); g.quadraticCurveTo(-w / 2, h * 0.35, -w / 2, 0); g.closePath();
    g.fillStyle = b.color || kit.trim; g.fill(); g.lineWidth = w * 0.12; g.strokeStyle = b.outline || kit.numberColor; g.stroke();
    g.fillStyle = b.inner || kit.shirt; g.fillRect(-w * 0.08, -h * 0.32, w * 0.16, h * 0.6);
    g.restore();
  }
  if (kit.maker) {   // a small generic maker mark on the right chest
    const cx = fx - 0.085 * px, cy = 0.105 * py;
    g.save(); g.translate(cx, cy); g.strokeStyle = kit.numberColor; g.lineWidth = 0.008 * px; g.beginPath();
    g.moveTo(-0.022 * px, -0.004 * py); g.lineTo(0, 0.014 * py); g.lineTo(0.022 * px, -0.004 * py); g.stroke(); g.restore();
  }
  // shorts number: bottom-left corner of the front panel area is free; use a dedicated square at (S/2..S/2+128, S/2-128..S/2)
  if (kit.number != null) text(String(kit.number), S / 2 + 64 * (1 / 1), S / 2 - 64, 0.1, kit.shortsNumberColor || kit.numberColor, { maxW: 0.11 });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8; tex.flipY = false;
  return { tex, px, py };
}

// ------------------------------------------------------------------ materials
const col = (c) => new THREE.Color(c);
const PATTERNS = { plain: 0, stripes: 1, hoops: 2, halves: 3, sash: 4, pinstripes: 5, gradient: 6, chevron: 7 };

function kitMaterial(kit, garment, T, A, sheet) {
  const m = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, roughness: garment === 5 ? 0.6 : kit.fabric.roughness, metalness: 0,
    sheen: garment === 5 ? 0 : kit.fabric.sheen, sheenRoughness: 0.55, sheenColor: new THREE.Color(0xffffff).multiplyScalar(0.35),
    side: THREE.DoubleSide,
  });
  const u = {
    ...zoneUniforms(T), kGarment: { value: garment },
    cShirt: { value: col(kit.shirt) }, cTrim: { value: col(kit.trim) }, cPattern: { value: col(kit.patternColor) }, cSleeve: { value: col(kit.sleeve || kit.shirt) },
    cShorts: { value: col(kit.shorts) }, cShortsTrim: { value: col(kit.shortsTrim || kit.trim) }, cSocks: { value: col(kit.socks || kit.shirt) }, cSockTrim: { value: col(kit.sockTrim || kit.trim) },
    cBoots: { value: col(kit.boots) }, cBootAccent: { value: col(kit.bootAccent) }, cGloves: { value: col(kit.gloves || '#e8e8e8') },
    kPattern: { value: PATTERNS[kit.pattern] ?? 0 }, kPatternScale: { value: kit.patternScale },
    tDecal: { value: sheet.tex }, kShoulderY: { value: A.shoulderY }, kHipY: { value: A.hipY },
    kPanel: { value: new THREE.Vector2(PANEL.back.w, PANEL.back.h) },
  };
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aGrp; attribute vec4 aPar; varying vec4 vGrp; varying vec4 vPar; varying vec3 vBind; varying vec3 vBindN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGrp = aGrp; vPar = aPar; vBind = position; vBindN = normal;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec4 vGrp; varying vec4 vPar; varying vec3 vBind; varying vec3 vBindN;
uniform int kGarment, kPattern; uniform float kPatternScale, kShoulderY, kHipY; uniform vec2 kPanel;
uniform vec3 cShirt, cTrim, cPattern, cSleeve, cShorts, cShortsTrim, cSocks, cSockTrim, cBoots, cBootAccent, cGloves;
uniform sampler2D tDecal;
${ZONE_GLSL}
vec3 shirtColor(vec3 b, bool sleeve, float s) {
  vec3 base = sleeve ? cSleeve : cShirt;
  float k = 0.0;
  if (kPattern == 1) k = step(0.5, fract(b.x / kPatternScale + 0.25));
  else if (kPattern == 2) k = step(0.5, fract((b.y - kHipY) / kPatternScale));
  else if (kPattern == 3) k = sleeve ? step(0.0, b.x) : step(0.0, b.x);
  else if (kPattern == 4) k = step(abs((b.y - kHipY) - (b.x * (b.z > 0.0 ? 1.0 : -1.0)) * 0.9 - 0.32), 0.07);
  else if (kPattern == 5) k = step(0.93, fract(b.x / (kPatternScale * 0.4)));
  else if (kPattern == 6) k = smoothstep(kHipY, kShoulderY + 0.05, b.y);
  else if (kPattern == 7) k = step(abs((b.y - kShoulderY + 0.16) + abs(b.x) * 0.7), 0.035) * step(0.0, b.z);
  if (sleeve && kPattern != 3 && kPattern != 1) k = 0.0;
  return mix(base, cPattern, k);
}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
  int z = kitZone(vGrp, vPar, vBind);
  bool mine = (kGarment == 1 && z == 1) || (kGarment == 2 && z == 2) || (kGarment == 3 && (z == 3 || z == 4)) || (kGarment == 5 && z == 5);
  if (!mine) discard;
  vec3 kc = vec3(1.0);
  int gi = 0; { float m = vGrp.x; if (vGrp.y > m) { gi = 1; m = vGrp.y; } if (vGrp.z > m) { gi = 2; m = vGrp.z; } if (vGrp.w > m) gi = 3; }
  if (z == 1) {
    bool sleeve = gi == 1;
    kc = shirtColor(vBind, sleeve, vPar.y);
    // trims: collar band and sleeve cuffs
    if (!sleeve) kc = mix(kc, cTrim, step(-0.016, neckHole(vBind)));
    else kc = mix(kc, cTrim, step(kSleeveEnd - 0.06, vPar.y));
    // decals: back (name + number) and front (badge, maker, sponsor), planar in the bind pose, faded on the sides
    if (!sleeve) {
      float top = kShoulderY + 0.06;
      float fb = smoothstep(-0.25, -0.6, vBindN.z), ff = smoothstep(0.25, 0.6, vBindN.z);
      vec2 uvB = vec2(0.25 - vBind.x / kPanel.x * 0.5, (top - vBind.y) / kPanel.y);
      vec2 uvF = vec2(0.75 + vBind.x / kPanel.x * 0.5, (top - vBind.y) / kPanel.y);
      if (fb > 0.0 && uvB.x > 0.0 && uvB.x < 0.5 && uvB.y > 0.0 && uvB.y < 1.0) { vec4 d = texture2D(tDecal, uvB); kc = mix(kc, d.rgb, d.a * fb); }
      if (ff > 0.0 && uvF.x > 0.5 && uvF.x < 1.0 && uvF.y > 0.0 && uvF.y < 0.75) { vec4 d = texture2D(tDecal, uvF); kc = mix(kc, d.rgb, d.a * ff); }
    }
  } else if (z == 2) {
    kc = cShorts;
    if (gi == 2) kc = mix(kc, cShortsTrim, step(kShortsHem - 0.035, vPar.z));                 // hem band
    // side stripe
    if (gi == 2 && abs(vBindN.x) > 0.965) kc = mix(kc, cShortsTrim, 0.85);
    // number on the front of the left leg
    if (gi == 2 && vBind.x > 0.0 && vBindN.z > 0.3) {
      vec2 uv = vec2(0.5 + (vBind.x - 0.11 + 0.055) / 0.11 * 0.125, 0.75 + (kHipY - 0.14 + 0.055 - vBind.y) / 0.11 * 0.25);
      if (uv.x > 0.5 && uv.x < 0.625 && uv.y > 0.75 && uv.y < 1.0) { vec4 d = texture2D(tDecal, uv); kc = mix(kc, d.rgb, d.a * 0.95); }
    }
  } else if (z == 3) {
    kc = cSocks;
    kc = mix(kc, cSockTrim, step(vPar.z, kSockTop + 0.09) * step(kSockTop + 0.05, vPar.z));
  } else if (z == 4) {
    kc = cBoots;
    float side = abs(vBindN.x);
    kc = mix(kc, cBootAccent, step(0.75, side) * step(vPar.z, 2.55) * step(2.18, vPar.z) * 0.9);       // side flash
    kc = mix(kc, cBootAccent * 0.9, step(vBind.y, 0.012));                                               // sole
  } else if (z == 5) kc = cGloves;
  // inside of the garment (seen through openings) is darker
  diffuseColor.rgb = kc * (gl_FrontFacing ? 1.0 : 0.35);`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  if (z == 4) roughnessFactor = 0.32; else if (z == 3) roughnessFactor = 0.85;');
  };
  m.customProgramCacheKey = () => `hfilm-kit-${garment}`;
  return m;
}

function skinPatch(mat, skin, T, covered, darkTex, lightTex) {
  const u = { ...zoneUniforms(T), kTone: { value: skin.tone ?? 0 }, kTint: { value: col(skin.tint || '#ffffff') },
    tSkinDark: { value: darkTex }, tSkinLight: { value: lightTex }, kCover: { value: covered ? 1 : 0 } };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aGrp; attribute vec4 aPar; varying vec4 vGrp; varying vec4 vPar; varying vec3 vBind;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGrp = aGrp; vPar = aPar; vBind = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec4 vGrp; varying vec4 vPar; varying vec3 vBind;
uniform float kTone; uniform vec3 kTint; uniform sampler2D tSkinDark, tSkinLight; uniform int kCover;
${ZONE_GLSL}`)
      .replace('#include <map_fragment>', `
  if (kCover == 1 && kitZone(vGrp, vPar, vBind) != 0) discard;
  #ifdef USE_MAP
    vec4 sl = texture2D(tSkinLight, vMapUv), sd = texture2D(tSkinDark, vMapUv);
    diffuseColor *= mix(sl, sd, kTone) * vec4(kTint, 1.0);
  #endif`);
  };
  mat.customProgramCacheKey = () => `hfilm-skin-${covered ? 1 : 0}`;
}

// ------------------------------------------------------------------ shells
function shellGeometry(src, A, T, garment, thick, drape = 0) {
  const P = src.attributes.position, N = src.attributes.normal, n = P.count;
  const zone = new Int8Array(n), g = [0, 0, 0, 0], p = [0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 4; k++) { g[k] = A.grp[i * 4 + k]; p[k] = A.par[i * 4 + k]; }
    zone[i] = zoneOf(g, p, P.getX(i), P.getY(i), P.getZ(i), T);
  }
  const want = (z) => (garment === 1 ? z === 1 : garment === 2 ? z === 2 : garment === 3 ? z === 3 || z === 4 : z === 5);
  const idx = src.index.array, keep = [];
  // keep triangles touching the garment (plus a one-ring so hems can be cut per pixel)
  const near = new Uint8Array(n);
  for (let t = 0; t < idx.length; t += 3) if (want(zone[idx[t]]) || want(zone[idx[t + 1]]) || want(zone[idx[t + 2]])) near[idx[t]] = near[idx[t + 1]] = near[idx[t + 2]] = 1;
  for (let t = 0; t < idx.length; t += 3) if (near[idx[t]] || near[idx[t + 1]] || near[idx[t + 2]]) keep.push(idx[t], idx[t + 1], idx[t + 2]);
  const geo = src.clone();
  geo.setIndex(keep);
  const pos = geo.attributes.position.clone();
  for (let i = 0; i < n; i++) {
    const d = thick(i, zone[i]);
    pos.setXYZ(i, P.getX(i) + N.getX(i) * d, P.getY(i) + N.getY(i) * d, P.getZ(i) + N.getZ(i) * d);
  }
  if (drape > 0) taubin(pos, keep, n, drape);
  geo.setAttribute('position', pos);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

// Taubin (lambda/mu) smoothing over vertices welded by position: fabric drapes over muscle detail
// without shrinking. UV seams share positions, so welded vertices move together.
function taubin(pos, index, n, iterations) {
  const key = (i) => `${Math.round(pos.getX(i) * 2e3)},${Math.round(pos.getY(i) * 2e3)},${Math.round(pos.getZ(i) * 2e3)}`;
  const id = new Int32Array(n).fill(-1), groups = [], ids = new Map();
  for (const i of new Set(index)) { const k = key(i); let g = ids.get(k); if (g === undefined) { g = groups.length; ids.set(k, g); groups.push([]); } groups[g].push(i); id[i] = g; }
  const G = groups.length, nb = Array.from({ length: G }, () => new Set());
  for (let t = 0; t < index.length; t += 3) for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) if (a !== b) nb[id[index[t + a]]].add(id[index[t + b]]);
  // open boundary (hems) stays put so cut lines don't creep
  const P = new Float32Array(G * 3);
  groups.forEach((g, k) => { P[k * 3] = pos.getX(g[0]); P[k * 3 + 1] = pos.getY(g[0]); P[k * 3 + 2] = pos.getZ(g[0]); });
  const step = (f) => {
    const Q = P.slice();
    for (let k = 0; k < G; k++) {
      if (nb[k].size < 3) continue;
      let x = 0, y = 0, z = 0;
      for (const j of nb[k]) { x += P[j * 3]; y += P[j * 3 + 1]; z += P[j * 3 + 2]; }
      const c = nb[k].size;
      Q[k * 3] += f * (x / c - P[k * 3]); Q[k * 3 + 1] += f * (y / c - P[k * 3 + 1]); Q[k * 3 + 2] += f * (z / c - P[k * 3 + 2]);
    }
    P.set(Q);
  };
  for (let it = 0; it < iterations; it++) { step(0.5); step(-0.53); }
  groups.forEach((g, k) => { for (const i of g) pos.setXYZ(i, P[k * 3], P[k * 3 + 1], P[k * 3 + 2]); });
}

/**
 * Dress a cloned athlete. `opts.kit` (see KIT_DEFAULTS), `opts.skin` ({tone 0..1, tint}), textures
 * already loaded: { light, dark }. Returns the kit meshes.
 */
export function dressAthlete(root, opts, tex) {
  const bodies = [];
  root.traverse((o) => { if (o.isSkinnedMesh && o.geometry.attributes.skinWeight && o.geometry.attributes.position.count > 2000) bodies.push(o); });
  if (!bodies.length) return [];
  const body = bodies.sort((a, b) => b.geometry.attributes.position.count - a.geometry.attributes.position.count)[0];
  const map = boneMap(body.skeleton.bones.map((b) => b.name));
  const A = kitAttributes(body, map);
  const kit = opts.kit ? { ...KIT_DEFAULTS, ...opts.kit, fabric: { ...KIT_DEFAULTS.fabric, ...(opts.kit.fabric || {}) } } : null;
  const T = thresholds(kit || KIT_DEFAULTS, A);
  // skin
  body.material = body.material.clone();
  if (tex.light && tex.dark) skinPatch(body.material, opts.skin || {}, T, !!kit, tex.dark, tex.light);
  if (!kit) return [];
  const sheet = decalSheet(kit, A);
  const out = [];
  const fit = kit.fit ?? 1;
  const garments = [
    [1, (i, z) => { const tp = A.par[i * 4], ap = A.par[i * 4 + 1], arm = A.grp[i * 4 + 1] > A.grp[i * 4]; return (arm ? 0.014 + 0.012 * Math.max(0, ap) : 0.016 + 0.022 * (1 - THREE.MathUtils.smoothstep(tp, T.shirtHem, 0.55))) * fit; }],
    [2, (i) => { const lp = A.par[i * 4 + 2], leg = A.grp[i * 4 + 2] > A.grp[i * 4]; return (leg ? 0.014 + 0.018 * Math.max(0, Math.min(1, lp / T.shortsHem)) : 0.009) * fit; }],
    [3, (i, z) => (z === 4 || A.par[i * 4 + 2] > T.bootTop - 0.02 ? 0.009 : 0.005)],
    ...(kit.gloves ? [[5, () => 0.007]] : []),
  ];
  for (const [garment, thick] of garments) {
    const key = `${garment}|${JSON.stringify(T)}|${fit}`;
    body.geometry.userData.shells ??= new Map();
    if (!body.geometry.userData.shells.has(key)) body.geometry.userData.shells.set(key, shellGeometry(body.geometry, A, T, garment, thick, garment <= 2 ? 6 : 0));
    const geo = body.geometry.userData.shells.get(key);
    const mesh = new THREE.SkinnedMesh(geo, kitMaterial(kit, garment, T, A, sheet));
    mesh.name = `kit_${garment}`;
    mesh.bind(body.skeleton, body.bindMatrix);
    mesh.castShadow = body.castShadow; mesh.receiveShadow = true; mesh.frustumCulled = false;
    mesh.layers.mask = body.layers.mask;
    mesh.position.copy(body.position); mesh.quaternion.copy(body.quaternion); mesh.scale.copy(body.scale);
    body.parent.add(mesh);
    out.push(mesh);
  }
  return out;
}

/** Rebind skinned attachments (hair, gear) from another glTF of the same skeleton family. */
export function attach(root, scene, { color = null, roughness = null } = {}) {
  const byName = {};
  root.traverse((o) => { if (o.isBone) byName[o.name] = o; });
  let host = null;
  root.traverse((o) => { if (!host && o.isSkinnedMesh) host = o; });
  const added = [];
  scene.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    const bones = o.skeleton.bones.map((b) => byName[b.name] || byName[b.name.replace(/[\[\].:/]/g, '')]);
    if (bones.some((b) => !b)) return;
    const m = new THREE.SkinnedMesh(o.geometry, [].concat(o.material).map((x) => x.clone())[0]);
    if (color) m.material.color = col(color);
    if (roughness != null) m.material.roughness = roughness;
    m.material.side = THREE.DoubleSide;
    m.bind(new THREE.Skeleton(bones, o.skeleton.boneInverses.map((x) => x.clone())), o.bindMatrix.clone());
    m.frustumCulled = false; m.castShadow = true; m.receiveShadow = true;
    if (host) { m.position.copy(host.position); m.quaternion.copy(host.quaternion); m.scale.copy(host.scale); (host.parent || root).add(m); } else root.add(m);
    added.push(m);
  });
  return added;
}

/** Tint the eyebrows (glTF materials named like hair) of a body. */
export function tintHair(root, color) {
  root.traverse((o) => {
    if (!o.isMesh || o.isSkinnedMesh && o.geometry.attributes.position.count > 2000) return;
    if (![].concat(o.material).some((m) => /hair|brow/i.test(m.name))) return;
    o.material = Array.isArray(o.material) ? o.material.map((m) => m.clone()) : o.material.clone();
    for (const m of [].concat(o.material)) if (/hair|brow/i.test(m.name)) m.color = col(color);
  });
}
