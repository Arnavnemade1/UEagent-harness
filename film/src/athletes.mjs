// Athletes for films (Node side): squads with kits, faces, hair and builds, plus the motion library's
// clip facts (durations, strides, kick contact times) for animation code. Everything here points at
// the framework's shared library (film/library), so any film on any machine gets the same cast.
//
//   const team = athletes.squad({ kit: athletes.KITS.redsHome, players: [{ id: 7, number: 7, name: 'Hale' }, ...], seed: 3 });
//   actors: team.map((p) => ({ id: p.id, model: p.model, transform: ..., animation: ..., pose: ... }))
import fs from 'node:fs';
import path from 'node:path';
import { LIBRARY } from './spec.mjs';

export const LEG_LENGTH = 0.888;   // athlete_m hip-to-ankle, metres (strides in the library are in leg lengths)
export const MOTION = ['library:motion/ual.motion.json', 'library:motion/cmu-sports.motion.json'];

export const HAIR = {
  m: [['hair_buzzed.glb', 0.45], ['hair_simpleparted.glb', 0.35], ['hair_long.glb', 0.08], [null, 0.12]],
  f: [['hair_buns.glb', 0.35], ['hair_long.glb', 0.35], ['hair_buzzedfemale.glb', 0.3]],
};
export const HAIR_COLORS = ['#16110d', '#22170f', '#2e1f14', '#3b2716', '#4d331d', '#6b4a2b', '#8a6a42', '#b8925c', '#d1b07a', '#5a2a16'];

/** Ready-made kits (fictional). Override any field: { ...KITS.redsHome, number: 9 }. */
export const KITS = {
  redsHome: { shirt: '#b5121b', trim: '#14161a', sleeve: null, pattern: 'plain', collar: 'crew', numberColor: '#ffffff', sponsor: 'Nova', shorts: '#f4f4f6', shortsTrim: '#b5121b', socks: '#b5121b', sockTrim: '#14161a', boots: '#111214', bootAccent: '#e9e9e9' },
  whitesAway: { shirt: '#eceef2', trim: '#1b2a55', pattern: 'sash', patternColor: '#1b2a55', collar: 'v', numberColor: '#1b2a55', sponsor: 'Kestrel', shorts: '#1b2a55', shortsTrim: '#eceef2', socks: '#eceef2', sockTrim: '#1b2a55', boots: '#f3f3f3', bootAccent: '#d4361f' },
  bluesStripes: { shirt: '#1d4fa8', trim: '#ffd400', pattern: 'stripes', patternColor: '#0c2a66', numberColor: '#ffffff', sponsor: 'Arc', shorts: '#0c2a66', socks: '#1d4fa8', boots: '#ffd400', bootAccent: '#111' },
  greensHoops: { shirt: '#0e7a3e', trim: '#ffffff', pattern: 'hoops', patternColor: '#f4f4f4', numberColor: '#111111', sponsor: 'Fjord', shorts: '#ffffff', socks: '#0e7a3e', boots: '#111', bootAccent: '#2bd46b' },
  keeperGold: { shirt: '#e3a400', trim: '#151515', sleeves: 'long', gloves: '#f2f2f2', numberColor: '#151515', sponsor: 'Nova', shorts: '#151515', socks: '#e3a400', boots: '#151515', bootAccent: '#e3a400' },
  keeperGreen: { shirt: '#14a05a', trim: '#0b2b19', sleeves: 'long', gloves: '#ffdd33', numberColor: '#0b2b19', sponsor: 'Kestrel', shorts: '#0b2b19', socks: '#14a05a', boots: '#0b2b19', bootAccent: '#ffdd33' },
};

function rng(seed) { let s = (Math.abs(Math.floor(seed)) % 2147483646) + 1; return () => (s = (s * 16807) % 2147483647) / 2147483647; }
const pick = (r, weighted) => { let x = r() * weighted.reduce((a, [, w]) => a + w, 0); for (const [v, w] of weighted) if ((x -= w) <= 0) return v; return weighted[0][0]; };

/**
 * One athlete's model spec. Options: kit, number, name, sex ('m'|'f'), tone (0 light .. 1 dark),
 * hair (file or null), hairColor, beard (bool), seed (fills anything not given).
 */
export function athlete({ kit = KITS.redsHome, number = null, name = null, sex = 'm', tone, tint, hair, hairColor, beard, seed = 1 } = {}) {
  const r = rng(seed * 7919 + 13);
  tone ??= Math.min(1, Math.max(0, pick(r, [[0.05, 3], [0.2, 3], [0.4, 2], [0.62, 2], [0.85, 2], [1.0, 1.5]]) + (r() - 0.5) * 0.12));
  tint ??= ['#ffffff', '#fff3ec', '#fff7f0', '#f6f1ec'][Math.floor(r() * 4)];
  hair = hair === undefined ? pick(r, HAIR[sex]) : hair;
  hairColor ??= tone > 0.6 ? HAIR_COLORS[Math.floor(r() * 3)] : HAIR_COLORS[Math.floor(r() * HAIR_COLORS.length)];
  beard ??= sex === 'm' && r() < 0.3;
  const L = (f) => `library:athletes/${f}`;
  return {
    url: L(`athlete_${sex}.glb`),
    motion: MOTION,
    skin: { tone, tint, light: L(`skin_${sex}_light.jpg`), dark: L(`skin_${sex}_dark.jpg`) },
    kit: { ...kit, number, name },
    attach: [...(hair ? [{ url: L(hair), color: hairColor }] : []), ...(beard ? [{ url: L('hair_beard.glb'), color: hairColor }] : [])],
    hairColor,
  };
}

/** A squad: players [{ id, number, name, gk, sex, ... }] -> [{ ...player, model, scale }], deterministic. */
export function squad({ kit, keeperKit = KITS.keeperGold, players, seed = 1 }) {
  return players.map((p, i) => {
    const s = seed * 1000 + (p.number ?? i) * 31 + i;
    const r = rng(s);
    const scale = p.scale ?? 0.95 + r() * 0.09;      // 1.72 m .. 1.88 m
    return { ...p, scale, model: athlete({ ...p, kit: p.gk ? keeperKit : kit, seed: s }) };
  });
}

// ------------------------------------------------------------------ motion library facts
let META = null;
/** name -> { duration, loop, meta } for every clip in the shared motion library. */
export function motionClips() {
  if (META) return META;
  META = {};
  for (const f of MOTION) {
    const doc = JSON.parse(fs.readFileSync(path.join(LIBRARY, f.slice(8)), 'utf8'));
    for (const c of doc.clips) META[c.name] = { duration: c.duration, loop: !!c.loop || !!c.meta?.loop, meta: c.meta || {} };
  }
  return META;
}

/** Locomotion clip set for sports.locomotion (strides in metres for a body `scale`). */
export function gaits(scale = 1) {
  const M = motionClips(), st = (n, fallback) => (M[n]?.meta?.stride != null ? M[n].meta.stride * LEG_LENGTH * scale : fallback * scale);
  return {
    idle: { clip: 'Idle_Loop', dur: M.Idle_Loop.duration },
    walk: { clip: 'Walk_Loop', dur: M.Walk_Loop.duration, stride: 1.42 * scale },
    jog: { clip: 'Run_Jog', dur: M.Run_Jog.duration, stride: st('Run_Jog', 2.5) },
    run: { clip: 'Run_Stride', dur: M.Run_Stride.duration, stride: st('Run_Stride', 2.4) },
    sprint: { clip: 'Run_Sprint', dur: M.Run_Sprint.duration, stride: st('Run_Sprint', 2.5) },
    back: { clip: 'Walk_Backward', dur: M.Walk_Backward.duration, stride: st('Walk_Backward', 2.1) },
    left: { clip: 'Walk_Side_L', dur: M.Walk_Side_L.duration, stride: st('Walk_Side_L', 2.3) },
    right: { clip: 'Walk_Side_R', dur: M.Walk_Side_R.duration, stride: st('Walk_Side_R', 2.3) },
  };
}

/** Kick clips for a foot ('R'|'L'): [{ clip, contact, duration }]. */
export function kicks(foot = 'R') {
  const M = motionClips();
  return Object.entries(M).filter(([n, c]) => c.meta.kind === 'kick' && n.startsWith(`Kick_${foot}_`)).map(([clip, c]) => ({ clip, contact: c.meta.contact, duration: c.duration }));
}

/** What the shared library offers (for `hfilm library` and agents). */
export function libraryIndex() {
  const dir = (d) => fs.readdirSync(path.join(LIBRARY, d)).filter((f) => !f.endsWith('.mjs'));
  const clips = Object.entries(motionClips()).map(([name, c]) => ({ name, duration: c.duration, kind: c.meta.kind || (c.meta.source === 'ual' ? 'ual' : 'other'), ...(c.meta.foot ? { foot: c.meta.foot, contact: c.meta.contact } : {}), ...(c.meta.stride ? { stride_m: +(c.meta.stride * LEG_LENGTH).toFixed(2) } : {}) }));
  return {
    athletes: dir('athletes').map((f) => `library:athletes/${f}`),
    kits: Object.keys(KITS),
    kitOptions: { pattern: ['plain', 'stripes', 'hoops', 'halves', 'sash', 'pinstripes', 'gradient', 'chevron'], collar: ['crew', 'v', 'polo'], sleeves: ['short', 'long'],
      fields: ['shirt', 'trim', 'sleeve', 'pattern', 'patternColor', 'patternScale', 'collar', 'sleeves', 'number', 'name', 'numberColor', 'numberOutline', 'sponsor', 'sponsorColor', 'badge', 'maker', 'shorts', 'shortsTrim', 'socks', 'sockTrim', 'boots', 'bootAccent', 'gloves', 'fit'] },
    motion: MOTION, clips,
    stadiums: ['oculus', 'classic'],
    helpers: { athletes: ['squad', 'athlete', 'gaits', 'kicks', 'motionClips', 'KITS'], sports: ['locomotion', 'kickOverlay', 'oneShot', 'layer', 'lookPose', 'touchPose', 'handsOnHeadPose', 'handsOnHipsPose', 'physicalBall', 'playerTracks', 'loadSkillCorner', 'extendTracks'] },
    docs: path.join(LIBRARY, 'README.md'),
  };
}
