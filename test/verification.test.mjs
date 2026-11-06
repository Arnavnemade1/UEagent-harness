import assert from 'node:assert/strict';
import { it } from 'node:test';
import { framing } from '../src/scene-intelligence.mjs';
import { verifyScene } from '../src/verification.mjs';

const request = 'Place the ball at the centre of the stage, fully in shot, clear of the wall, moving smoothly.';
const camera = { location: [0, 0, 0], rotation: [0, 0, 0], projection: 'perspective', hfov: 90, aspect: 16 / 9 };
function snapshot() {
  const actors = [
    { path: '/Game/Map.Map:PersistentLevel.Ball', label: 'Ball', location: [1000, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], parent: null,
      bounds: { center: [1000, 0, 0], extent: [50, 50, 50] }, components: [{ path: 'Ball.Mesh', mesh_kind: 'static', mesh_assigned: true, mesh: '/Game/Ball' }], component_count: 1 },
    { path: '/Game/Map.Map:PersistentLevel.Wall', label: 'Wall', location: [1500, 0, 0], bounds: { center: [1500, 0, 0], extent: [50, 50, 50] } },
  ];
  for (const actor of actors) actor.framing = framing(actor, camera);
  return { id: 'current', project: '/project/Game.uproject', level: '/Game/Map', world: 'editor', revision: 1, actors, camera,
    scope: { targets: [], filter: {} }, coverage: { complete: true }, missing_targets: [], unreadable: [], timeline: null };
}
const criterion = (type, extra = {}) => ({ id: type, type, actor: 'Ball', reason: 'Matches the placement and motion requested in the brief.', ...extra });
const verify = (state, criteria, previous) => verifyScene(state, previous, { request, criteria });
const timeline = (frame) => ({ sequence: '/Game/Shot', frame, rate: { numerator: 30, denominator: 1 }, playing: false });

it('detects seeded placement, framing, overlap and missing-mesh defects with actor/property evidence', () => {
  const s = snapshot();
  s.actors[0].location = [1490, 0, 0];
  s.actors[0].bounds.center = [1490, 0, 0];
  s.actors[0].components[0].mesh_assigned = false;
  s.actors[0].framing = framing(s.actors[0], { ...camera, rotation: [0, 180, 0] });
  const report = verify(s, [criterion('location', { expected: [1000, 0, 0], tolerance_cm: 1 }), criterion('separated', { other: 'Wall' }), criterion('in_frame'), criterion('mesh_assigned')]);
  assert.equal(report.status, 'fail');
  assert.deepEqual(report.counts, { pass: 0, fail: 4, unknown: 0 });
  for (const check of report.checks) { assert.equal(check.actor, s.actors[0].path); assert.ok(check.property); }
  assert.equal(report.checks[0].evidence.error_cm, 490);
  assert.equal(report.checks[0].repair, undefined, 'coupled constraints must not pick a repair silently');
});

it('generates exact static repair preconditions and verifies the repaired result', () => {
  const s = snapshot();
  const criteria = [criterion('location', { expected: [1200, 0, 0], tolerance_cm: 0.1 })];
  const failed = verify(s, criteria);
  const repair = failed.checks[0].repair;
  assert.equal(repair.target, s.actors[0].path);
  assert.deepEqual(repair.precondition.location, [1000, 0, 0]);
  s.actors[0].location = repair.location;
  assert.equal(verify(s, criteria).status, 'pass');
  s.actors[0].location = [1000, 0, 0];
  s.timeline = timeline(0);
  assert.equal(verify(s, criteria).checks[0].repair, undefined, 'a transform edit cannot repair animation keys');
});

it('never turns missing, ambiguous or partial evidence into a pass', () => {
  const s = snapshot();
  s.actors = [s.actors[0]];
  s.coverage.complete = false;
  assert.equal(verify(s, [criterion('exists')]).status, 'incomplete', 'a label can be ambiguous in an incomplete snapshot');
  assert.equal(verify(s, [criterion('exists', { actor: s.actors[0].path })]).status, 'pass');
  assert.equal(verify(s, [criterion('exists', { actor: 'Wall' })]).status, 'incomplete');
  s.missing_targets = ['Wall'];
  assert.equal(verify(s, [criterion('exists', { actor: 'Wall' })]).status, 'fail');
  s.actors.push({ ...s.actors[0], path: '/Game/Other.Ball' });
  s.coverage.complete = true;
  assert.equal(verify(s, [criterion('exists')]).status, 'incomplete');
  const cameraUnknown = snapshot();
  cameraUnknown.actors[0].framing = { state: 'unknown', reason: 'No lens calibration.' };
  assert.equal(verify(cameraUnknown, [criterion('in_frame')]).status, 'incomplete');
  delete cameraUnknown.actors[0].components;
  assert.equal(verify(cameraUnknown, [criterion('mesh_assigned')]).status, 'incomplete');
});

it('detects sampled animation discontinuities at exact frames and handles angle wraparound', () => {
  const before = snapshot(), after = snapshot();
  before.id = 'previous';
  before.timeline = timeline(29); after.timeline = timeline(30);
  before.actors[0].rotation = [0, 179, 0]; after.actors[0].rotation = [0, -179, 0];
  after.actors[0].location = [2000, 0, 0];
  const criteria = [criterion('max_speed', { max_cm_s: 1000 }), criterion('rotation_step', { max_degrees: 3 })];
  const report = verify(after, criteria, before);
  assert.equal(report.checks[0].status, 'fail');
  assert.equal(report.checks[0].evidence.speed_cm_s, 30000);
  assert.equal(report.checks[0].frame, 30);
  assert.equal(report.checks[0].previous_frame, 29);
  assert.equal(report.checks[1].status, 'pass');
  assert.ok(Math.abs(report.checks[1].evidence.step_degrees - 2) < 1e-8);
  after.actors[0].rotation = [0, -90, 0];
  assert.equal(verify(after, criteria, before).checks[1].status, 'fail');
  before.timeline.rate = after.timeline.rate = { numerator: 30000, denominator: 1001 };
  assert.ok(Math.abs(verify(after, criteria, before).checks[0].evidence.seconds - 1001 / 30000) < 1e-10);
});

it('rejects backwards, mismatched, running and unclocked temporal samples', () => {
  const previous = snapshot(); previous.timeline = timeline(10);
  for (const mutate of [
    (s) => { s.timeline = null; }, (s) => { s.timeline.frame = 10; }, (s) => { s.timeline.frame = 9; },
    (s) => { s.timeline.sequence = '/Game/Other'; }, (s) => { s.timeline.rate.numerator = 24; },
    (s) => { s.level = '/Game/Other'; }, (s) => { s.project = '/other/Game.uproject'; },
    (s) => { s.world = 'pie'; }, (s) => { s.timeline.playing = true; },
  ]) {
    const s = snapshot(); s.timeline = timeline(11); mutate(s);
    assert.equal(verify(s, [criterion('max_speed', { max_cm_s: 10 })], previous).status, 'incomplete');
  }
});

it('validates criteria strictly instead of silently ignoring intent or misspelled limits', () => {
  for (const criteria of [[], [criterion('collision')], [criterion('location', { expected: [0, 0], tolerance_cm: 0 })],
    [criterion('location', { expected: [0, 0, 0], tolerance_cm: -1 })], [criterion('max_speed', { max_cm_s: Infinity })],
    [criterion('in_frame', { fully_inside: 'true' })], [criterion('distance', { other: 'Wall', min_cm: 10, max_cm: 1 })],
    [criterion('exists'), criterion('exists')], [criterion('exists', { reason: '' })], [criterion('exists', { typo: true })]]) {
    assert.throws(() => verify(snapshot(), criteria), { code: 'bad_args' });
  }
});
