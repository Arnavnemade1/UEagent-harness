/** Deterministic, evidence-scoped checks. Unknown evidence never counts as a pass. */
import { BridgeError } from './bridge.mjs';
import { cameraAxes, distance, isVector, validBounds } from './scene-intelligence.mjs';

const FIELDS = {
  exists: [], location: ['expected', 'tolerance_cm'], distance: ['other', 'min_cm', 'max_cm'],
  separated: ['other'], in_frame: ['fully_inside'], mesh_assigned: [],
  max_speed: ['max_cm_s'], rotation_step: ['max_degrees'],
};
const text = (v, max = 2048) => typeof v === 'string' && v.length > 0 && v.length <= max;
const nonnegative = (v) => Number.isFinite(v) && v >= 0;
const bad = (message) => { throw new BridgeError('bad_args', message); };

export function validateCriteria(request, criteria) {
  if (!text(request, 4000)) bad('request must preserve the original creative brief (1..4000 characters).');
  if (!Array.isArray(criteria) || !criteria.length || criteria.length > 16) bad('Provide 1..16 explicit criteria tied to the request.');
  const ids = new Set();
  if (Buffer.byteLength(JSON.stringify(criteria)) > 16000) bad('Criteria exceed 16 KiB; use fewer exact targets.');
  for (const c of criteria) {
    if (!c || !Object.hasOwn(FIELDS, c.type)) bad('Unknown criterion type.');
    if (!text(c.id, 64) || ids.has(c.id)) bad('Each criterion needs a unique id (1..64 characters).');
    ids.add(c.id);
    if (!text(c.actor) || /[*?\[]/.test(c.actor) || /^[\$@]/.test(c.actor)) bad(`${c.id}: actor must be an exact path or unique label.`);
    if (!text(c.reason, 500)) bad(`${c.id}: reason must explain how this check serves the user request.`);
    if (Object.keys(c).some((key) => !['id', 'type', 'actor', 'reason', ...FIELDS[c.type]].includes(key))) bad(`${c.id}: unknown criterion field.`);
    if (['distance', 'separated'].includes(c.type) && (!text(c.other) || /[*?\[]/.test(c.other) || /^[\$@]/.test(c.other))) bad(`${c.id}: other must be an exact path or unique label.`);
    if (c.type === 'location' && (!isVector(c.expected) || !nonnegative(c.tolerance_cm))) bad(`${c.id}: expected [x,y,z] and nonnegative tolerance_cm required.`);
    if (c.type === 'distance' && ((c.min_cm === undefined && c.max_cm === undefined)
      || (c.min_cm !== undefined && !nonnegative(c.min_cm)) || (c.max_cm !== undefined && !nonnegative(c.max_cm))
      || (c.min_cm !== undefined && c.max_cm !== undefined && c.min_cm > c.max_cm))) bad(`${c.id}: valid min_cm and/or max_cm required.`);
    if (c.type === 'in_frame' && c.fully_inside !== undefined && typeof c.fully_inside !== 'boolean') bad(`${c.id}: fully_inside must be boolean.`);
    if (c.type === 'max_speed' && !nonnegative(c.max_cm_s)) bad(`${c.id}: nonnegative max_cm_s required.`);
    if (c.type === 'rotation_step' && (!nonnegative(c.max_degrees) || c.max_degrees > 180)) bad(`${c.id}: max_degrees must be 0..180.`);
  }
}

function resolve(snapshot, target) {
  const exact = snapshot.actors.find((a) => a.path === target);
  if (exact) return { actor: exact };
  const labels = snapshot.actors.filter((a) => a.label === target);
  if (labels.length > 1) return { unknown: 'Ambiguous actor label; use an exact path.' };
  const explicitlyResolved = snapshot.scope?.targets?.includes(target);
  if (labels.length === 1) {
    if (!snapshot.coverage.complete && !explicitlyResolved) return { unknown: 'Partial coverage cannot establish label uniqueness; use an exact path.' };
    return { actor: labels[0] };
  }
  if (snapshot.unreadable?.includes(target)) return { unknown: 'Actor was present but could not be read.' };
  if (snapshot.missing_targets?.includes(target)) return { missing: true };
  const fullScene = snapshot.coverage.complete && !snapshot.scope?.targets?.length && !Object.keys(snapshot.scope?.filter || {}).length;
  return fullScene ? { missing: true } : { unknown: 'Actor was not observed; capture it explicitly before verifying.' };
}

function secondsBetween(current, previous) {
  if (!previous || !current.project || !current.level || current.project !== previous.project || current.level !== previous.level || current.world !== previous.world) return null;
  if (JSON.stringify(current.bridge_instance) !== JSON.stringify(previous.bridge_instance)) return null;
  const a = previous.timeline, b = current.timeline;
  if (!a || !b || a.sequence !== b.sequence || a.playing !== false || b.playing !== false
    || !Number.isFinite(a.frame) || !Number.isFinite(b.frame) || b.frame <= a.frame
    || a.rate?.numerator !== b.rate?.numerator || a.rate?.denominator !== b.rate?.denominator
    || !(b.rate?.numerator > 0 && b.rate?.denominator > 0)) return null;
  return (b.frame - a.frame) * b.rate.denominator / b.rate.numerator;
}

function evaluate(c, current, previous) {
  const resolved = resolve(current, c.actor);
  if (resolved.unknown) return { status: 'unknown', message: resolved.unknown };
  if (resolved.missing) return { status: 'fail', message: 'Required actor is absent in the observed scope.', property: 'existence' };
  const actor = resolved.actor;
  const result = (pass, property, evidence, message) => ({ status: pass ? 'pass' : 'fail', actor: actor.path, property, evidence, message });
  const unknown = (message) => ({ status: 'unknown', actor: actor.path, message });
  if (c.type === 'exists') return result(true, 'existence', { path: actor.path }, 'Actor exists.');
  if (c.type === 'location') {
    if (!isVector(actor.location)) return unknown('Location is unavailable.');
    const delta = distance(actor.location, c.expected);
    const r = result(delta <= c.tolerance_cm, 'location', { actual: actor.location, expected: c.expected, error_cm: delta, tolerance_cm: c.tolerance_cm }, 'World-space location compared with the requested position.');
    // Only static editor state is eligible; changing a sampled animation actor
    // would not repair its keys. No automatic camera/asset/collision guesses.
    if (r.status === 'fail' && current.world === 'editor' && !current.timeline && isVector(actor.rotation) && isVector(actor.scale)) {
      r.repair = { operation: 'set_location', target: actor.path, location: c.expected,
        precondition: { location: actor.location, rotation: actor.rotation, scale: actor.scale, parent: actor.parent } };
    }
    return r;
  }
  if (['distance', 'separated'].includes(c.type)) {
    const other = resolve(current, c.other);
    if (!other.actor) return unknown(other.unknown || 'Comparison actor is absent.');
    if (c.type === 'distance') {
      if (!isVector(actor.location) || !isVector(other.actor.location)) return unknown('Actor locations are unavailable.');
      const d = distance(actor.location, other.actor.location);
      return result(d >= (c.min_cm ?? 0) && d <= (c.max_cm ?? Infinity), 'location', { other: other.actor.path, distance_cm: d }, 'Distance between actor origins, in centimetres.');
    }
    if (!validBounds(actor.bounds) || !validBounds(other.actor.bounds)) return unknown('World bounds are unavailable.');
    const overlap = actor.bounds.center.map((v, i) => actor.bounds.extent[i] + other.actor.bounds.extent[i] - Math.abs(v - other.actor.bounds.center[i]));
    return result(overlap.some((v) => v <= 0), 'bounds', { other: other.actor.path, overlap_cm: overlap }, 'World AABB overlap only; overlapping bounds do not prove a mesh collision.');
  }
  if (c.type === 'in_frame') {
    const f = actor.framing;
    if (!f || f.state === 'unknown') return unknown(f?.reason || 'Camera framing is unavailable.');
    return result((c.fully_inside ?? true) ? f.state === 'inside' : ['inside', 'intersects'].includes(f.state), 'framing', f, 'Conservative bounds test; occlusion, component visibility and rendered pixels are unverified.');
  }
  if (c.type === 'mesh_assigned') {
    if (!actor.components) return unknown('Recapture with components=true.');
    const meshes = actor.components.filter((component) => component.mesh_kind);
    if (meshes.some((component) => component.mesh_assigned === false)) {
      return result(false, 'components.mesh', { components: meshes.filter((component) => component.mesh_assigned === false).map((component) => component.path) }, 'Mesh component has no assigned asset.');
    }
    if (actor.component_count !== actor.components.length || !meshes.length || meshes.some((component) => component.mesh_assigned !== true)) return unknown('Mesh component coverage is incomplete or unavailable.');
    return result(true, 'components.mesh', { meshes: meshes.map((component) => component.mesh) }, 'Observed mesh components have assigned assets; asset internals are not validated.');
  }
  const dt = secondsBetween(current, previous);
  if (!dt) return unknown('Need increasing, paused Sequencer samples from the same project, level, sequence and frame rate.');
  const before = resolve(previous, actor.path);
  if (!before.actor) return unknown('The same actor path is missing from the previous sample.');
  if (c.type === 'max_speed') {
    if (!isVector(actor.location) || !isVector(before.actor.location)) return unknown('Sample locations are unavailable.');
    const speed = distance(actor.location, before.actor.location) / dt;
    return result(speed <= c.max_cm_s, 'location', { speed_cm_s: speed, seconds: dt, max_cm_s: c.max_cm_s }, 'Average speed between samples; motion between samples is not verified.');
  }
  if (!isVector(actor.rotation) || !isVector(before.actor.rotation)) return unknown('Sample rotations are unavailable.');
  const a = cameraAxes(actor.rotation), b = cameraAxes(before.actor.rotation);
  const trace = a.reduce((sum, axis, i) => sum + axis.reduce((dot, v, j) => dot + v * b[i][j], 0), 0);
  const angle = Math.acos(Math.max(-1, Math.min(1, (trace - 1) / 2))) * 180 / Math.PI;
  return result(angle <= c.max_degrees + 1e-8, 'rotation', { step_degrees: angle, max_degrees: c.max_degrees, seconds: dt }, 'Shortest orientation difference; full turns between samples are not observable.');
}

export function verifyScene(current, previous, { request, criteria }) {
  validateCriteria(request, criteria);
  const checks = criteria.map((criterion) => ({ id: criterion.id, type: criterion.type, reason: criterion.reason,
    target: criterion.actor, frame: current.timeline?.frame ?? null,
    previous_frame: previous?.timeline?.frame ?? null, ...evaluate(criterion, current, previous) }));
  const counts = { pass: 0, fail: 0, unknown: 0 };
  for (const check of checks) counts[check.status]++;
  // Several criteria may disagree about the same actor. Never pick one fix
  // implicitly; even a passing constraint could be broken by another's repair.
  const actorCounts = new Map();
  for (const check of checks) if (check.actor) actorCounts.set(check.actor, (actorCounts.get(check.actor) || 0) + 1);
  for (const check of checks) {
    if (check.repair && (actorCounts.get(check.actor) > 1 || criteria.some((c) => ['distance', 'separated'].includes(c.type)))) {
      delete check.repair;
      check.repair_note = 'Coupled constraints require planning; no automatic location repair offered.';
    }
  }
  const report = { schema_version: 1, request, snapshot: current.id, previous: previous?.id ?? null,
    project: current.project, level: current.level, revision: current.revision,
    status: counts.fail ? 'fail' : counts.unknown ? 'incomplete' : 'pass', counts, checks,
    scope: 'Only the listed deterministic criteria at the sampled state. This is not a visual-quality or complete-animation approval.',
    next: counts.unknown ? 'Capture the missing evidence; do not count unknown checks as passed.'
      : counts.fail ? 'Repair targeted failures, capture a fresh observation, then rerun every criterion.' : 'Review rendered frames against the creative brief; validate the complete timeline before final export.' };
  if (JSON.stringify(report).length > 56000) throw new BridgeError('report_too_large', 'Use fewer criteria per report to preserve complete structured evidence.');
  return report;
}
