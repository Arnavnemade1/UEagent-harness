import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as S from '../src/sports.mjs';
import { bakeFilm, loadFilm } from '../src/spec.mjs';

// a tiny synthetic match: A (home) passes along the ground to B, B lofts it to C, C shoots into the net
function synthetic() {
  const fps = 10, frames = [];
  for (let i = 0; i <= 120; i++) {
    const t = i / fps;
    const ball = t > 10 ? [52.9, 1.0, 0.6] : null;
    frames.push({ frame: i, t, period: 1, ball, ballDetected: !!ball, possession: {}, players: new Map([[1, [0 + t * 0.2, 0]], [2, [20, 0]], [3, [45, 5]]]) });
  }
  // the tracked ball approaches the goal mouth after the shot
  for (const [i, x] of [[95, 47], [96, 49], [97, 51.4], [98, 52.6]]) { frames[i].ball = [x, 3 + (x - 45) * -0.2, 0.5]; frames[i].ballDetected = true; }
  return {
    fps, from: 0, to: 12, pitch: { length: 105, width: 68 },
    players: new Map([[1, { id: 1, team: 'home' }], [2, { id: 2, team: 'home' }], [3, { id: 3, team: 'home' }]]),
    frames,
    events: [
      { player: 1, start: 0.5, end: 2.0, endType: 'pass', highPass: false },
      { player: 2, start: 3.5, end: 4.5, endType: 'pass', highPass: true },
      { player: 3, start: 7.0, end: 9.4, endType: 'shot', leadToGoal: true },
    ],
  };
}

test('physical ball: touches at the feet, rolling passes slow down, lofted passes fly, goals end in the net', () => {
  const m = synthetic(), tr = S.playerTracks(m), ball = S.physicalBall(m, tr);
  for (const tc of ball.touches) {
    const p = tr.get(tc.player).at(tc.t), b = ball.at(tc.t);
    assert.ok(Math.hypot(b[0] - p[0], b[1] - p[1]) < 0.6, `ball at the foot for ${tc.kind} at ${tc.t}`);
  }
  // ground pass 2.0 -> 3.5: decelerating, on the grass
  const sp = (t) => Math.hypot(...[0, 1].map((k) => ball.at(t + 0.05)[k] - ball.at(t - 0.05)[k])) / 0.1;
  assert.ok(sp(2.2) > sp(3.3) * 1.1, 'rolling pass decelerates');
  assert.ok(ball.at(2.7)[2] < 0.2, 'rolling pass stays on the ground');
  // high pass 4.5 -> 7.0: in the air midway
  assert.ok(ball.at(5.75)[2] > 3, `lofted pass is airborne (z=${ball.at(5.75)[2].toFixed(2)})`);
  // the shot ends up behind the goal line and stays there
  assert.equal(ball.goals.length, 1);
  const end = ball.at(11.5);
  assert.ok(end[0] > 52.5 && Math.abs(end[1]) < 3.66, `ball rests in the net (${end.map((v) => v.toFixed(2))})`);
});

test('locomotion blends gaits from speed and touchPose swings the kicking leg', () => {
  const m = synthetic(), tr = S.playerTracks(m);
  const clips = { idle: { clip: 'Idle', dur: 2 }, walk: { clip: 'Walk', dur: 1.3, stride: 1.3 }, jog: { clip: 'Jog', dur: 0.9, stride: 3.9 } };
  const loco = S.locomotion(tr.get(1), { t0: 0, t1: 12, clips });
  const names = loco.clips(5).map((c) => c.clip);
  assert.ok(names.includes('Idle'), 'slow drift (0.2 m/s) is mostly idle');
  const pose = S.touchPose(2.0, [{ t: 2.0, kind: 'pass', power: 0.8, foot: 'R' }]);
  assert.ok(pose['DEF-thigh.R'][0] < -5, 'right thigh swings forward at contact');
  assert.ok(pose['DEF-shin.R'][0] > 5, 'knee still bent at contact');
  assert.deepEqual(S.touchPose(5, [{ t: 2.0, kind: 'pass', foot: 'R' }]), {}, 'no pose away from touches');
});

test('films can use sports helpers and bake additive poses', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hfilm-sports-'));
  fs.writeFileSync(path.join(dir, 'film.mjs'), `export default ({ sports }) => ({
    frames: [0, 3], size: [64, 36], camera: { position: [0, 1, 5], target: [0, 1, 0], fov: 40 },
    actors: [{ id: 'p', model: { primitive: 'box' }, pose: (f) => sports.touchPose(f / 30, [{ t: 1 / 30, kind: 'pass', foot: 'R', power: 1 }]) }],
  });`);
  const { baked } = bakeFilm(await loadFilm(path.join(dir, 'film.mjs')));
  assert.equal(baked.actors[0].pose.length, 3);
  assert.ok(baked.actors[0].pose[1]['DEF-thighR'], 'pose baked at the touch frame, under the three.js bone name');
});
