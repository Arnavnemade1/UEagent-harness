/** Pure geometry + bounded session evidence. No editor mutations or render allocations. */
import { randomUUID } from 'node:crypto';
import { BridgeError } from './bridge.mjs';

export const isVector = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);
export const distance = (a, b) => Math.hypot(...a.map((x, i) => x - b[i]));
export const validBounds = (b) => b && isVector(b.center) && isVector(b.extent) && b.extent.every((v) => v >= 0);

/** UE axes: X forward, Y right, Z up; rotator [pitch, yaw, roll]. */
export function cameraAxes(rotation) {
  const [p, y, r] = rotation.map((x) => x * Math.PI / 180);
  const [sp, cp, sy, cy, sr, cr] = [Math.sin(p), Math.cos(p), Math.sin(y), Math.cos(y), Math.sin(r), Math.cos(r)];
  return [
    [cp * cy, cp * sy, sp],
    [sr * sp * cy - cr * sy, sr * sp * sy + cr * cy, -sr * cp],
    [-(cr * sp * cy + sr * sy), cy * sr - cr * sp * sy, cr * cp],
  ];
}

export function framing(actor, camera) {
  const unknown = { state: 'unknown', occlusion: 'unknown' };
  if (!validBounds(actor.bounds)) return { ...unknown, reason: 'actor bounds unavailable' };
  if (!camera || !isVector(camera.location) || !isVector(camera.rotation)
    || !/^(perspective|CameraProjectionMode\.PERSPECTIVE)$/i.test(camera.projection || '')
    || !Number.isFinite(camera.hfov) || camera.hfov <= 1 || camera.hfov >= 179
    || !Number.isFinite(camera.aspect) || camera.aspect <= 0) {
    return { ...unknown, reason: 'perspective camera transform, horizontal FOV and aspect ratio required' };
  }
  const axes = cameraAxes(camera.rotation);
  const local = (point) => axes.map((axis) => dot(axis, point.map((v, i) => v - camera.location[i])));
  const center = local(actor.bounds.center);
  const th = Math.tan(camera.hfov * Math.PI / 360), tv = th / camera.aspect;
  const corners = [];
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
    corners.push(local(actor.bounds.center.map((v, i) => v + actor.bounds.extent[i] * [x, y, z][i])));
  }
  // AABB-plane test: conservative intersection, not a pixel visibility test.
  const planes = [([x]) => x - 0.01, ([x, y]) => x * th - y, ([x, y]) => x * th + y,
    ([x, , z]) => x * tv - z, ([x, , z]) => x * tv + z];
  const outside = planes.some((plane) => corners.every((corner) => plane(corner) < -1e-7));
  const inside = planes.every((plane) => corners.every((corner) => plane(corner) >= -1e-7));
  return {
    state: outside ? 'outside' : inside ? 'inside' : 'intersects',
    center_uv: center[0] > 0.01 ? [0.5 + center[1] / (2 * center[0] * th), 0.5 - center[2] / (2 * center[0] * tv)] : null,
    depth_cm: center[0], occlusion: 'unknown', method: 'world_aabb_frustum',
  };
}

export class ObservationStore {
  constructor({ maxCount = 32, maxBytes = 1024 * 1024 } = {}) {
    this.maxCount = maxCount;
    this.maxBytes = maxBytes;
    this.entries = new Map();
    this.bytes = 0;
  }
  clear() { this.entries.clear(); this.bytes = 0; }
  add(raw) {
    const value = structuredClone(raw);
    value.id = randomUUID();
    for (const actor of value.actors) actor.framing = framing(actor, value.camera);
    // The generic MCP text formatter truncates at 60K. Keep this tool below it
    // so agents always receive parseable JSON, even with long Unicode labels.
    let json = JSON.stringify(value);
    while (Buffer.byteLength(json) > 56000 && value.actors.length) {
      value.actors.pop();
      value.coverage.returned = value.actors.length;
      value.coverage.complete = false;
      json = JSON.stringify(value);
    }
    const bytes = Buffer.byteLength(json);
    if (bytes > Math.min(this.maxBytes, 56000)) throw new BridgeError('observation_too_large', 'Narrow targets or filters. Observation metadata exceeds the memory budget.');
    while (this.entries.size && (this.entries.size >= this.maxCount || this.bytes + bytes > this.maxBytes)) {
      const key = this.entries.keys().next().value;
      this.bytes -= this.entries.get(key).bytes;
      this.entries.delete(key);
    }
    this.entries.set(value.id, { json, bytes });
    this.bytes += bytes;
    return value;
  }
  get(id) {
    if (typeof id !== 'string' || !this.entries.has(id)) {
      throw new BridgeError('snapshot_unavailable', 'Observation expired, belongs to another session, or was invalidated by an editor restart. Capture again with ue_observe.');
    }
    return JSON.parse(this.entries.get(id).json);
  }
}
