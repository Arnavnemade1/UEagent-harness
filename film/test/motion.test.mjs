import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as THREE from 'three';
import * as R from '../src/rig.mjs';
import { amcStream, parseAMC, parseASF, poseASF } from '../src/mocap.mjs';
import * as A from '../src/athletes.mjs';
import { LIBRARY, bakeFilm, loadFilm } from '../src/spec.mjs';

const ATHLETE = path.join(LIBRARY, 'athletes', 'athlete_m.glb');
const lib = (f) => JSON.parse(fs.readFileSync(path.join(LIBRARY, 'motion', f), 'utf8'));

/** world direction of a bone (to its child) after applying baked local rotations at frame k */
function boneDir(scene, baked, k, bone, child) {
  const byName = {};
  scene.traverse((o) => { byName[o.name] = o; });
  for (const [name, arr] of Object.entries(baked.local)) byName[name]?.quaternion.fromArray(arr, k * 4);
  scene.updateMatrixWorld(true);
  const a = new THREE.Vector3().setFromMatrixPosition(byName[bone].matrixWorld), b = new THREE.Vector3().setFromMatrixPosition(byName[child].matrixWorld);
  return b.sub(a).normalize();
}

test('the athlete rig maps onto the universal humanoid', () => {
  const rig = R.rigOf(R.sceneOf(ATHLETE));
  for (const b of ['pelvis', 'spine_03', 'Head', 'upperarm_l', 'lowerarm_r', 'thigh_l', 'calf_r', 'foot_l', 'ball_r', 'index_01_l']) assert.ok(rig.bones[b], `bone ${b}`);
  assert.ok(rig.legLength > 0.8 && rig.legLength < 1.0, `leg length ${rig.legLength}`);
  assert.ok(rig.bones.thigh_l.pos.x > 0, 'the character\'s left is +X (facing +Z)');
});

test('retargeting transfers motion, not raw rotations: a lowered arm stays lowered on another rig', () => {
  // source: a T-pose rig whose left arm rotates 80 degrees down over the clip (world delta)
  const rest = { pelvis: { restWorld: new THREE.Quaternion(), dir: null, pos: new THREE.Vector3(0, 1, 0) },
    upperarm_l: { restWorld: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.3), dir: new THREE.Vector3(1, 0, 0), pos: new THREE.Vector3(0.2, 1.4, 0) } };
  const down = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -80 * Math.PI / 180);
  const frames = [0, 1].map((k) => ({ rot: { pelvis: new THREE.Quaternion(), upperarm_l: (k ? down.clone() : new THREE.Quaternion()).multiply(rest.upperarm_l.restWorld) }, hips: new THREE.Vector3(0, 1, 0) }));
  const st = { fps: 1, frames, rest, legLength: 0.9, hipsRest: new THREE.Vector3(0, 1, 0), name: 'Lower' };
  const doc = R.motionDoc([R.encodeStream(st)]);
  const [clip] = R.decodeMotion(JSON.parse(JSON.stringify(doc)));
  const scene = R.sceneOf(ATHLETE), rig = R.rigOf(scene), baked = R.bakeForRig(clip, rig);
  const d0 = boneDir(scene, baked, 0, 'upperarm_l', 'lowerarm_l'), d1 = boneDir(scene, baked, 1, 'upperarm_l', 'lowerarm_l');
  assert.ok(Math.abs(d0.y) < 0.25 && d0.x > 0.9, `rest: arm out to the left (${d0.toArray().map((v) => v.toFixed(2))})`);
  assert.ok(d1.y < -0.9, `after: arm lowered (${d1.toArray().map((v) => v.toFixed(2))})`);
});

test('every library clip bakes onto the athlete with unit quaternions', () => {
  const rig = R.rigOf(R.sceneOf(ATHLETE));
  for (const f of ['ual.motion.json', 'cmu-sports.motion.json']) {
    const clips = R.decodeMotion(lib(f));
    assert.ok(clips.length > 20, `${f} has clips`);
    for (const c of clips) {
      const b = R.bakeForRig(c, rig);
      for (const arr of Object.values(b.local)) for (let k = 0; k < arr.length; k += 4) {
        const n = Math.hypot(arr[k], arr[k + 1], arr[k + 2], arr[k + 3]);
        assert.ok(Math.abs(n - 1) < 1e-3, `${c.name}: unit quaternion`);
      }
      assert.ok(b.hips.every(Number.isFinite), `${c.name}: finite hips`);
    }
  }
});

test('captured kicks carry their contact time and both feet exist', () => {
  for (const foot of ['R', 'L']) {
    const k = A.kicks(foot);
    assert.ok(k.length >= 6, `${foot} kicks`);
    for (const c of k) assert.ok(c.contact > 0.5 && c.contact < c.duration, `${c.clip} contact ${c.contact}`);
  }
  const g = A.gaits(1);
  assert.ok(g.sprint.stride > 1.5 && g.jog.stride > 1.5, 'capture-based strides in metres');
});

test('ASF/AMC: bone chains follow their directions and rotations', () => {
  const asf = parseASF(`:units\n  length 1\n:root\n  order TX TY TZ RX RY RZ\n:bonedata\n  begin\n    name lfemur\n    direction 0 -1 0\n    length 4\n    axis 0 0 0 XYZ\n    dof rx ry rz\n  end\n:hierarchy\n  begin\n    root lfemur\n  end\n`);
  const [f0, f1] = parseAMC(':FULLY-SPECIFIED\n1\nroot 0 10 0 0 0 0\nlfemur 0 0 0\n2\nroot 0 10 0 0 0 0\nlfemur 90 0 0\n');
  assert.ok(poseASF(asf, f0).get('lfemur').end.distanceTo(new THREE.Vector3(0, 6, 0)) < 1e-6, 'straight down');
  const e = poseASF(asf, f1).get('lfemur').end;
  assert.ok(Math.abs(e.y - 10) < 1e-6 && Math.abs(Math.abs(e.z) - 4) < 1e-6, `thigh raised 90 degrees (${e.toArray()})`);
});

test('mirroring swaps sides: a right-foot kick becomes a left-foot kick', () => {
  const rest = { thigh_r: { restWorld: new THREE.Quaternion(), dir: new THREE.Vector3(0, -1, 0), pos: new THREE.Vector3(-0.1, 0.9, 0) }, pelvis: { restWorld: new THREE.Quaternion(), dir: null, pos: new THREE.Vector3(0, 1, 0) } };
  const swing = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -1);
  const st = { fps: 1, frames: [{ rot: { thigh_r: swing, pelvis: new THREE.Quaternion() }, hips: new THREE.Vector3(0, 1, 0) }], rest, legLength: 1, hipsRest: new THREE.Vector3(0, 1, 0) };
  const m = R.mirrorStream(st);
  assert.ok(m.rest.thigh_l && !m.rest.thigh_r, 'renamed');
  const d = new THREE.Vector3(0, -1, 0).applyQuaternion(m.frames[0].rot.thigh_l);
  const o = new THREE.Vector3(0, -1, 0).applyQuaternion(swing);
  assert.ok(Math.abs(d.z - o.z) < 1e-6 && Math.abs(d.x + o.x) < 1e-6, 'same forward swing, mirrored across X');
});

test('squads are deterministic and films bake athletes from the shared library', async () => {
  const a = A.squad({ kit: A.KITS.redsHome, players: [{ id: 1, number: 9, name: 'Test' }, { id: 2, number: 1, gk: true }], seed: 3 });
  const b = A.squad({ kit: A.KITS.redsHome, players: [{ id: 1, number: 9, name: 'Test' }, { id: 2, number: 1, gk: true }], seed: 3 });
  assert.deepEqual(a, b);
  assert.equal(a[1].model.kit.gloves, A.KITS.keeperGold.gloves, 'keepers get the keeper kit');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hfilm-athletes-'));
  fs.writeFileSync(path.join(dir, 'film.mjs'), `export default ({ athletes }) => {
    const [p] = athletes.squad({ kit: athletes.KITS.whitesAway, players: [{ id: 5, number: 5, name: 'Five' }] });
    return { frames: [0, 2], size: [64, 36], camera: { position: [0, 1, 5], target: [0, 1, 0], fov: 40 },
      actors: [{ id: 'p', model: p.model, transform: { position: [0, 0, 0], scale: p.scale }, animation: (f) => [{ clip: 'Run_Jog', time: f / 30 }] }] };
  };`);
  const { baked, assets } = bakeFilm(await loadFilm(path.join(dir, 'film.mjs')));
  const m = baked.actors[0].model;
  assert.match(m.url, /^\/asset\/\d+\/athlete_m\.glb$/);
  assert.equal(m.motion.length, 2);
  assert.ok(m.attach.every((x) => /^\/asset\/\d+\/hair_/.test(x.url)) || m.attach.length === 0);
  assert.ok(assets.dirs.some((d) => d.endsWith(path.join('library', 'athletes'))));
  fs.rmSync(dir, { recursive: true, force: true });
});
