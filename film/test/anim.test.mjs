import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { arc, ease, keys, lookAt, smooth, ue, yaw } from '../src/anim.mjs';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('keys interpolates numbers and vectors, clamps outside the range', () => {
  const k = keys([[0, 0], [10, 10]], { interp: 'linear' });
  near(k(5), 5); near(k(-3), 0); near(k(99), 10);
  const v = keys([[0, [0, 0, 0]], [10, [10, 20, 30]]]);
  assert.deepEqual(v(10), [10, 20, 30]);
  const h = keys([[0, 1], [10, 2]], { interp: 'hold' });
  near(h(9), 1);
  const e = keys([[0, 0], [10, 1, 'in']], { interp: 'linear' });
  near(e(5), ease.in(0.5));
});

test('smooth trails a constant-speed target by ~lag frames', () => {
  const s = smooth((f) => f, 0, 200, 6);
  near(150 - s(150), 6, 0.05);
});

test('arc peaks at the requested height above the chord', () => {
  near(arc([0, 0, 0], [10, 0, 0], 2, 0.5)[1], 2);
  assert.deepEqual(arc([0, 0, 0], [10, 0, 0], 2, 1), [10, 0, 0]);
});

test('lookAt / yaw make +Z face the target', () => {
  const q = new THREE.Quaternion().fromArray(lookAt([0, 0, 0], [5, 0, 0]));
  const f = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  near(f.x, 1); near(f.z, 0);
  const y = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion().fromArray(yaw(90)));
  near(y.x, 1);
});

test('Unreal conversion is a cm->m reflection that preserves rotations', () => {
  assert.deepEqual(ue.pos([100, 200, 300]), [1, 3, 2]);
  ue.toUE(ue.pos([12, -34, 56])).forEach((x, i) => near(x, [12, -34, 56][i], 1e-9));
  // rotate an Unreal vector, convert, and compare with converting first then rotating by ue.quat()
  const uq = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0.3, -0.5, 0.8).normalize(), 1.1);
  const v = new THREE.Vector3(10, 20, 30);
  const a = ue.pos(v.clone().applyQuaternion(uq).toArray());
  const b = new THREE.Vector3(...ue.pos(v.toArray())).applyQuaternion(new THREE.Quaternion().fromArray(ue.quat(uq.toArray()))).toArray();
  a.forEach((x, i) => near(x, b[i], 1e-9));
});
