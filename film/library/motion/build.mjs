#!/usr/bin/env node
// Rebuilds the rig-neutral motion library in this folder (hfilm-motion@1, see web/motion.js).
// The built .motion.json files are committed; run this only to change the selection.
//
//   node build.mjs [--sources dir]
//
// Sources (downloaded into ~/.cache/hybrid-film/sources unless --sources has them, all checksummed):
//   - Quaternius "Universal Animation Library" 1 + 2 [Standard], CC0  (opengameart.org)
//   - CMU Graphics Lab Motion Capture Database, mocap.cs.cmu.edu. Free to use (the data may not be
//     resold as-is); please credit: "The data used in this project was obtained from mocap.cs.cmu.edu.
//     The database was created with funding from NSF EIA-0196217."
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import * as R from '../../src/rig.mjs';
import { amcJointTrack, amcStream } from '../../src/mocap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const SRC = arg('--sources') || path.join(os.homedir(), '.cache', 'hybrid-film', 'sources');
const FPS = 30;

const ZIPS = {
  'ual1.zip': ['https://opengameart.org/sites/default/files/universal_animation_librarystandard.zip', '18ff1a7215f4852b320203e8aaf02a1578b5c8eef9027fbaedfcedc7b85a3ac2'],
  'ual2.zip': ['https://opengameart.org/sites/default/files/universal_animation_library_2standard.zip', 'ec0e40d6d78fe9aaad59e322f40865a8675c22f0745e291622e54520391a9217'],
};
const CMU = {
  '10.asf': 'd4e604fd582403e9f4bca3382e74dd0cc01e15cd712255e7bd34863b922b6200', '11.asf': '9ef0d3fbc731fe4baa376d50ab22f3c2c29486aa30eb3d0ec1764654aa879a6f',
  '13.asf': 'eb33390bcbccb739d7622bd583fd9be55020868f68689aa6f2060ad688df10dc', '16.asf': '2323f876564610f84bfbec9b90b8ebffb57515673b7f4a45b0fb0849af465bdb',
  '35.asf': '2a8e2eda3c0d7d828566b2a9a8ab36b2b8b3864110574e8b73c8f069fded416c', '49.asf': '2496dbef32b4e2e736699c4ea528499d3c8a1d31012974c68ae23d4a787584cb',
  '82.asf': '32f0f3a53099526ed4df3ef443d4ba65419e4952ab3fd6bdf89d901addda4a1f', '141.asf': 'e32993b8079c0914ed4d865ad53f7b9646398808855233e6f650d4f4417df2bb',
  '143.asf': '6d7207da3bb9eceeaa32f23fb641b69f5836d11242b00c052e7d64f0cbe20a35',
  '10_01.amc': '4277e748947e8703825f340f94582f48997ca01b308f2447075eab4c42029e84', '10_02.amc': '68d08f7b47bca54e1fd9ca1739533f8dc973e1200a93c1f4471891a266769d53',
  '10_03.amc': 'ffc0f091c8eeb3392797933e23612540a711a07f9a7a49d62c7d1c6d0128a290', '10_05.amc': 'e0d9f9c3fd5856325f4ac3aed71d24886ffad27adeed03887b006dfac49b7c38',
  '10_06.amc': 'f1d5332d88cf419d3edae357886f59eb6345a577da1fc2846a04fb6afcd20e75', '11_01.amc': '326e635daf89bc8e33511f0b3768d9864da9e51d1bfab1ff97ad01993a5b25fd',
  '143_36.amc': 'b8292c4d7b4ddd612f61b7958db9e65ecc4f814d853b3dcd7507cb540eb55219', '49_02.amc': 'e53f7db5907c6dd5adb3d5c79b1ef31c622316d44d34eec309ab1eee9989dfcb',
  '13_39.amc': 'feba5aacb550922f06a321ce1ec58904a18ef2238d66f8e3f468a25260ea49d5', '141_22.amc': 'a259f0e51c46e0cdca15c8b98506a3bf8a74e05a20f98770068c400cd8ab35b7',
  '13_27.amc': '8679214b96f59a8c49210131373bca9303767e6780073ef35a3b36045955ccfe', '143_25.amc': '23b09138701a3796592fc1bf16e31ac1cb4501a130f57f5f0dd2238fab0bd72c',
  '141_21.amc': '5d7a1fa9d3d805cbf233a33db13030b600bc928cc52744a720a65a2216a0a9b9', '35_17.amc': '8096cd53878242dbc35e987288cef6ae81d4e1c0e207086639bbed5cc06c8fee',
  '16_35.amc': '28e83b8ee8ff46e15cb7d41d5e77faaefe3e06cf165f05fb18dd348457bdf387', '143_42.amc': 'ac76bc5b1b11f9b3e3df85131d64320ffba533996d605b1d736f53cdb66cc9b8',
  '143_39.amc': 'eb7689a55c369a52a2461f083d1d246d2f0517163305ef3b56843f68935a7f64', '143_40.amc': 'aae79799a23704fe566c84cb9a609266f05d425a780c88654dcce20a93392931',
  '82_10.amc': 'c857767b40f7d4300b13a7c55daa9ace302ceda559fa02f4b922ab9ddb682731',
};

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
async function fetchTo(url, dest, sum) {
  if (fs.existsSync(dest) && sha(dest) === sum) return dest;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  console.log(`downloading ${url}`);
  const res = await fetch(url, { headers: { 'user-agent': 'hybrid-film motion library build' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  if (sha(dest) !== sum) throw new Error(`${dest}: checksum mismatch`);
  return dest;
}
for (const [f, [url, sum]] of Object.entries(ZIPS)) await fetchTo(url, path.join(SRC, f), sum);
for (const [f, sum] of Object.entries(CMU)) await fetchTo(`http://mocap.cs.cmu.edu/subjects/${f.split(/[_.]/)[0]}/${f}`, path.join(SRC, 'cmu', f), sum);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hfilm-motion-'));
const glbFrom = (zip) => {
  const dir = path.join(tmp, path.basename(zip, '.zip'));
  execFileSync('unzip', ['-q', '-o', zip, '-d', dir]);
  const find = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? find(path.join(d, e.name)) : /UAL2_Standard\.glb$|AnimationLibrary_Godot_Standard\.glb$/.test(e.name) ? [path.join(d, e.name)] : []));
  return R.readGltf(find(dir)[0]);
};

// ------------------------------------------------------------------ relaxed hands
// Fingers curl a little at every joint (about the forward axis in the T-pose rest), relative to the
// parent bone, for clips that have no finger data (or fists we don't want).
const FINGERS = ['index', 'middle', 'ring', 'pinky'];
function hand(curl) {
  const out = {};
  for (const s of ['l', 'r']) for (const f of FINGERS) for (const k of [1, 2, 3]) {
    const a = THREE.MathUtils.degToRad(curl[k - 1] * (f === 'pinky' ? 1.25 : f === 'ring' ? 1.12 : f === 'index' ? 0.85 : 1));
    out[`${f}_0${k}_${s}`] = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), s === 'l' ? -a : a);
  }
  return out;
}
const RELAXED = hand([16, 24, 16]), FIST = hand([75, 95, 60]);
const noFingers = (st) => ({ ...st, rest: Object.fromEntries(Object.entries(st.rest).filter(([b]) => !/^(index|middle|ring|pinky|thumb)/.test(b))) });

const LICENSES = {
  ual: 'Quaternius Universal Animation Library 1/2 [Standard], CC0 1.0 (https://quaternius.com)',
  cmu: 'CMU Graphics Lab Motion Capture Database (mocap.cs.cmu.edu), created with funding from NSF EIA-0196217. Free to use; do not resell the data.',
};

// ------------------------------------------------------------------ locomotion + gestures (UAL, in place)
const ual1 = glbFrom(path.join(SRC, 'ual1.zip')), ual2 = glbFrom(path.join(SRC, 'ual2.zip'));
const UAL = [
  [ual1, R.RIGIFY_MAP, ['Idle_Loop', 'Walk_Loop', 'Jog_Fwd_Loop', 'Sprint_Loop', 'Idle_Talking_Loop', 'Crouch_Idle_Loop', 'Jump_Start', 'Jump_Loop', 'Jump_Land', 'Roll', 'Hit_Chest', 'Death01', 'Dance_Loop', 'Interact']],
  [ual2, null, ['Idle_FoldArms_Loop', 'Idle_No_Loop', 'Yes', 'Slide_Start', 'Slide_Loop', 'Slide_Exit', 'OverhandThrow', 'LayToIdle', 'Hit_Knockback', 'Idle_Rail_Call']],
];
const loco = [];
for (const [g, map, names] of UAL) for (const name of names) {
  const anim = g.json.animations.find((a) => a.name === name);
  if (!anim) { console.warn(`missing ${name}`); continue; }
  let st = R.gltfStream(g, anim, { map, fps: FPS });
  st = noFingers(st);
  st.loop = /_Loop$/.test(name);
  loco.push(R.encodeStream(st, { name, relative: /Punch|Fist/.test(name) ? FIST : RELAXED, meta: { source: 'ual', loop: st.loop } }));
}

// ------------------------------------------------------------------ captures (CMU)
const cmu = (trial) => [path.join(SRC, 'cmu', `${trial.split('_')[0]}.asf`), path.join(SRC, 'cmu', `${trial}.amc`)];
const soccer = [];
function addCapture({ name, trial, from, to, faceAt = null, mirror = false, loop = false, cycle = null, meta = {}, hands = RELAXED }) {
  const [asf, amc] = cmu(trial);
  let st = amcStream(asf, amc, { fps: FPS, name });
  let speed = null;
  if (cycle) {
    const c = R.findCycle(st, { from, to, ...cycle });
    st = R.trim(st, c.a / FPS, c.b / FPS);
    speed = R.groundSpeed(st);
  } else st = R.trim(st, from, to);
  const mid = faceAt == null ? Math.floor(st.frames.length / 2) : Math.round((faceAt - (cycle ? 0 : from)) * FPS);
  st = R.inPlace(st, { faceAt: Math.max(0, Math.min(st.frames.length - 1, mid)) });
  if (mirror) st = R.mirrorStream(st);
  if (loop) st = R.loopStream(st, 0.15);
  const m = { source: 'cmu', trial, ...meta, ...(speed != null ? { speed: +speed.toFixed(3), stride: +(speed * (st.frames.length - 1) / FPS).toFixed(3) } : {}), ...(loop ? { loop: true } : {}) };
  if (mirror && m.foot) m.foot = m.foot === 'r' ? 'l' : 'r';
  soccer.push(R.encodeStream(st, { name, relative: hands, meta: m }));
  return st;
}

// kicks: contact = the kicking toe's speed peak (found at the capture rate)
function contactOf(trial, foot = 'r') {
  const [asf, amc] = cmu(trial), tr = amcJointTrack(asf, amc, `${foot}toes`, { fps: 120 });
  let best = 0, at = 0;
  for (let k = 1; k < tr.length; k++) { const v = tr[k].distanceTo(tr[k - 1]); if (v > best) { best = v; at = k; } }
  return at / 120;
}
const KICKS = [['A', '10_01'], ['B', '10_02'], ['C', '10_03'], ['D', '10_05'], ['E', '10_06'], ['F', '11_01']];
for (const [id, trial] of KICKS) {
  const c = contactOf(trial), from = Math.max(0, c - 1.0), to = c + 1.0;
  for (const mirror of [false, true]) addCapture({ name: `Kick_${mirror ? 'L' : 'R'}_${id}`, trial, from, to, faceAt: c, mirror, meta: { kind: 'kick', foot: 'r', contact: +(c - from).toFixed(3) } });
}
// celebrations, gestures, reactions (one-shots, in place)
addCapture({ name: 'Celebrate_Airplane', trial: '143_36', from: 0.5, to: 5.4, meta: { kind: 'celebration', travels: true } });
addCapture({ name: 'Celebrate_JumpUpDown', trial: '49_02', from: 1.0, to: 3.9, meta: { kind: 'celebration' } });
addCapture({ name: 'Celebrate_TuckJump', trial: '49_02', from: 4.2, to: 6.0, meta: { kind: 'celebration' }, hands: FIST });
addCapture({ name: 'Celebrate_Leap', trial: '13_39', from: 0.2, to: 2.6, meta: { kind: 'celebration' }, hands: FIST });
addCapture({ name: 'Celebrate_ArmsUp', trial: '13_27', from: 0.6, to: 3.6, meta: { kind: 'celebration' } });
for (const mirror of [false, true]) {
  const S = mirror ? 'L' : 'R';
  addCapture({ name: `HighFive_${S}`, trial: '141_22', from: 0.0, to: 1.7, mirror, meta: { kind: 'gesture', travels: true } });
  addCapture({ name: `Point_${S}`, trial: '13_27', from: 4.3, to: 5.4, mirror, meta: { kind: 'gesture' } });
  addCapture({ name: `Wave_${mirror ? 'R' : 'L'}`, trial: '143_25', from: 0.4, to: 3.2, mirror, meta: { kind: 'gesture' } });
}
addCapture({ name: 'Applaud_Crowd', trial: '143_25', from: 3.2, to: 4.7, meta: { kind: 'gesture' } });
addCapture({ name: 'Shrug', trial: '141_21', from: 0.4, to: 1.6, meta: { kind: 'reaction' } });
// locomotion cycles from captures (in place, looped; meta.speed in leg lengths per second)
addCapture({ name: 'Run_Jog', trial: '35_17', from: 0.1, to: 1.4, loop: true, cycle: { minLen: 0.55, maxLen: 0.9 }, meta: { kind: 'locomotion' } });
addCapture({ name: 'Run_Stride', trial: '16_35', from: 0.1, to: 1.4, loop: true, cycle: { minLen: 0.55, maxLen: 0.9 }, meta: { kind: 'locomotion' } });
addCapture({ name: 'Run_Sprint', trial: '143_42', from: 2.85, to: 3.7, loop: true, cycle: { minLen: 0.45, maxLen: 0.8 }, meta: { kind: 'locomotion' } });
addCapture({ name: 'Walk_Backward', trial: '143_39', from: 2.0, to: 4.3, loop: true, cycle: { minLen: 0.8, maxLen: 1.4 }, meta: { kind: 'locomotion', direction: 'back' } });
for (const mirror of [false, true]) addCapture({ name: `Walk_Side_${mirror ? 'R' : 'L'}`, trial: '143_40', from: 1.0, to: 3.7, loop: true, mirror, cycle: { minLen: 0.8, maxLen: 1.6 }, meta: { kind: 'locomotion', direction: 'side' } });
addCapture({ name: 'Walk_Dejected', trial: '82_10', from: 1.8, to: 4.2, loop: true, cycle: { minLen: 0.8, maxLen: 1.4 }, meta: { kind: 'locomotion', mood: 'dejected' } });

const write = (file, clips, license) => {
  const doc = R.motionDoc(clips, { rig: 'universal humanoid (rig-neutral world deltas)', license, built: 'library/motion/build.mjs' });
  fs.writeFileSync(path.join(HERE, file), JSON.stringify(doc));
  console.log(`✓ ${file}: ${clips.length} clips, ${(fs.statSync(path.join(HERE, file)).size / 1e6).toFixed(2)} MB`);
};
write('ual.motion.json', loco, LICENSES.ual);
write('cmu-sports.motion.json', soccer, LICENSES.cmu);
fs.rmSync(tmp, { recursive: true, force: true });
