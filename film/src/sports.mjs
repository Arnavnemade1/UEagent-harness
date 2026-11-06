// Sports toolkit: turn real tracking data into believable film actors.
//
//   loadSkillCorner()  real match: players and ball at 10 fps + possession events (SkillCorner open data)
//   playerTracks()     smoothed, continuous player paths (seconds -> metres), gaps bridged
//   physicalBall()     a ball that only moves when someone touches it: rolling passes decelerate,
//                      lofted passes follow gravity, dribbles are pushed ahead of the carrier, shots
//                      fly to where the tracked ball crossed the line and die in the net
//   locomotion()       idle / walk / jog / sprint blended from real speed, stride-matched, with turns
//   touchPose()        procedural kick / first-touch / dribble poses (additive bone rotations)
//
// Units: match time in seconds, positions in metres in the data's pitch frame (origin at the centre
// spot, x along the length, y across, z up). `toFilm` maps that frame to film space (+Y up).
import fs from 'node:fs';
import path from 'node:path';

export const G = 9.81;
export const BALL_RADIUS = 0.11;
export const toFilm = ([x, y, z = 0]) => [x, z, y];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const hyp = (x, y) => Math.hypot(x, y);
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// ------------------------------------------------------------------ loading

function readCsv(file) {
  const text = fs.readFileSync(file, 'utf8');
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const [head, ...data] = rows;
  return data.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((k, i) => [k, r[i]])));
}

const truthy = (v) => v === true || v === 'True' || v === 'true' || v === '1';

/**
 * Load a window of a SkillCorner open-data match (https://github.com/SkillCorner/opendata, MIT;
 * SkillCorner asks to be credited). Files: <id>_match.json, <id>_tracking_extrapolated.jsonl,
 * <id>_dynamic_events.csv in `dir`. `from`/`to` are tracking frames (10 fps). Returns a
 * provider-neutral match object that the other helpers consume.
 */
export function loadSkillCorner({ dir, id, from = 0, to = Infinity }) {
  const f = (suffix) => path.join(dir, `${id}_${suffix}`);
  const meta = JSON.parse(fs.readFileSync(f('match.json'), 'utf8'));
  const fps = 10;
  const lines = fs.readFileSync(f('tracking_extrapolated.jsonl'), 'utf8').split('\n');
  const frames = [];
  for (let i = Math.max(0, from); i < Math.min(lines.length, to); i++) {
    if (!lines[i]) continue;
    const fr = JSON.parse(lines[i]);
    const b = fr.ball_data || {};
    frames.push({
      frame: fr.frame, period: fr.period, t: fr.frame / fps,
      ball: b.x == null ? null : [b.x, b.y, b.z ?? BALL_RADIUS], ballDetected: !!b.is_detected,
      possession: { player: fr.possession?.player_id ?? null, group: fr.possession?.group ?? null },
      players: new Map((fr.player_data || []).map((p) => [p.player_id, [p.x, p.y]])),
    });
  }
  const home = meta.home_team.id;
  const players = new Map(meta.players.map((p) => [p.id, {
    id: p.id, team: p.team_id === home ? 'home' : 'away', number: p.number, name: p.short_name,
    role: p.player_role?.acronym || '', gk: p.player_role?.acronym === 'GK',
  }]));
  const events = fs.existsSync(f('dynamic_events.csv')) ? readCsv(f('dynamic_events.csv'))
    .filter((e) => e.event_type === 'player_possession' && +e.frame_end >= from - 50 && +e.frame_start <= to + 50)
    .map((e) => ({
      type: e.event_type, player: +e.player_id, team: +e.team_id === home ? 'home' : 'away',
      start: +e.frame_start / fps, end: +e.frame_end / fps, endType: e.end_type || null,
      highPass: truthy(e.high_pass), leadToGoal: truthy(e.lead_to_goal), period: +e.period,
    })).sort((a, b) => a.start - b.start) : [];
  return {
    provider: 'skillcorner', id, fps, from: from / fps, to: Math.min(to, lines.length) / fps,
    pitch: { length: meta.pitch_length, width: meta.pitch_width },
    teams: { home: { id: home, name: meta.home_team.short_name, side: meta.home_team_side }, away: { id: meta.away_team.id, name: meta.away_team.short_name } },
    players, frames, events,
  };
}

// ------------------------------------------------------------------ player paths

/**
 * Smoothed continuous paths for every player in the window. Gaps (player not in a frame) are bridged
 * linearly; outside the data the path holds its last position. Returns Map id -> { at(t), vel(t), last }.
 */
export function playerTracks(match, { sigma = 1.2 } = {}) {
  const { frames, fps } = match;
  const ids = new Set();
  for (const fr of frames) for (const id of fr.players.keys()) ids.add(id);
  const n = frames.length, t0 = frames[0].t;
  const k = Math.ceil(sigma * 3), w = Array.from({ length: 2 * k + 1 }, (_, i) => Math.exp(-((i - k) ** 2) / (2 * sigma * sigma)));
  const out = new Map();
  for (const id of ids) {
    const xs = new Float64Array(n).fill(NaN), ys = new Float64Array(n).fill(NaN);
    frames.forEach((fr, i) => { const p = fr.players.get(id); if (p) { xs[i] = p[0]; ys[i] = p[1]; } });
    let first = -1, last = -1;
    for (let i = 0; i < n; i++) if (!Number.isNaN(xs[i])) { if (first < 0) first = i; last = i; }
    if (first < 0) continue;
    for (let i = 0; i < n; i++) {            // bridge gaps, hold the ends
      if (!Number.isNaN(xs[i])) continue;
      let a = i - 1; while (a >= 0 && Number.isNaN(xs[a])) a--;
      let b = i + 1; while (b < n && Number.isNaN(xs[b])) b++;
      if (a < 0) { xs[i] = xs[b]; ys[i] = ys[b]; } else if (b >= n) { xs[i] = xs[a]; ys[i] = ys[a]; } else { const u = (i - a) / (b - a); xs[i] = lerp(xs[a], xs[b], u); ys[i] = lerp(ys[a], ys[b], u); }
    }
    const sx = new Float64Array(n), sy = new Float64Array(n);
    for (let i = 0; i < n; i++) {             // gaussian smoothing (edge-normalised)
      let s = 0, ax = 0, ay = 0;
      for (let j = -k; j <= k; j++) { const q = i + j; if (q < 0 || q >= n) continue; s += w[j + k]; ax += xs[q] * w[j + k]; ay += ys[q] * w[j + k]; }
      sx[i] = ax / s; sy[i] = ay / s;
    }
    const cr = (p0, p1, p2, p3, u) => 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (-p0 + 3 * p1 - 3 * p2 + p3) * u * u * u);
    const at = (t) => {
      const fi = clamp((t - t0) * fps, 0, n - 1), i = Math.min(n - 2, Math.floor(fi)), u = fi - i;
      const g = (arr, j) => arr[clamp(j, 0, n - 1)];
      return [cr(g(sx, i - 1), g(sx, i), g(sx, i + 1), g(sx, i + 2), u), cr(g(sy, i - 1), g(sy, i), g(sy, i + 1), g(sy, i + 2), u)];
    };
    const vel = (t) => { const h = 0.05, a = at(t - h), b = at(t + h); return [(b[0] - a[0]) / (2 * h), (b[1] - a[1]) / (2 * h)]; };
    out.set(id, { id, at, vel, first: frames[first].t, last: frames[last].t });
  }
  return out;
}

// ------------------------------------------------------------------ the ball

function rollingSegment(p0, p1, t0, t1, decel) {
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1], D = hyp(dx, dy), T = Math.max(1e-3, t1 - t0);
  let a = decel, v0 = D / T + a * T / 2;
  if (v0 - a * T < 0.2 && D > 0) { v0 = 2 * D / T; a = v0 / T; }     // just reaches it, stopping
  const ux = D ? dx / D : 0, uy = D ? dy / D : 0;
  return { t0, t1, kind: 'roll', speed: v0, at: (t) => { const s = t - t0; const d = clamp(v0 * s - a * s * s / 2, 0, D); return [p0[0] + ux * d, p0[1] + uy * d, lerp(p0[2], p1[2], clamp(s / T, 0, 1))]; } };
}

function flightSegment(p0, p1, t0, t1, drag) {
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1], D = hyp(dx, dy), T = Math.max(1e-3, t1 - t0);
  let a = Math.min(drag, D / (T * T)), v0 = D / T + a * T / 2;   // air drag slows it a little
  const vz = (p1[2] - p0[2] + G * T * T / 2) / T;
  const ux = D ? dx / D : 0, uy = D ? dy / D : 0;
  return { t0, t1, kind: 'flight', speed: v0, apex: p0[2] + vz * vz / (2 * G), at: (t) => { const s = clamp(t - t0, 0, T); const d = v0 * s - a * s * s / 2; return [p0[0] + ux * d, p0[1] + uy * d, Math.max(BALL_RADIUS, p0[2] + vz * s - G * s * s / 2)]; } };
}

/**
 * A physically plausible ball built from touches. Each possession event gives a first touch at its
 * start and a release (pass / shot / clearance) at its end; between them the carrier dribbles (the
 * ball is pushed ahead to where he will be at the next touch). Between players the ball rolls with
 * grass friction or, for high passes / balls the tracking saw in the air, flies under gravity.
 * Shots that cross the goal line in the tracking go there and die in the net.
 * Returns { at(t) -> [x,y,z], touches: [{ t, player, kind, dir: [x,y], power, header }], segments }.
 */
export function physicalBall(match, tracks, { rolling = 1.1, drag = 1.0, foot = 0.32, goalDepth = 2.0, netGoals = true } = {}) {
  const { frames, events, pitch } = match;
  const halfL = pitch.length / 2;
  const ballData = (t) => {   // tracked ball (detected frames) nearest to t
    let best = null, bd = 1e9;
    for (const fr of frames) { if (!fr.ball || !fr.ballDetected) continue; const d = Math.abs(fr.t - t); if (d < bd) { bd = d; best = fr; } }
    return bd <= 0.15 ? best.ball : null;
  };
  const maxZ = (ta, tb) => { let m = 0; for (const fr of frames) if (fr.t > ta && fr.t < tb && fr.ballDetected && fr.ball) m = Math.max(m, fr.ball[2]); return m; };
  const evs = events.filter((e) => tracks.has(e.player) && e.end >= match.from - 1 && e.start <= match.to + 1);

  // 1. touches
  const touches = [];
  for (const e of evs) {
    const tr = tracks.get(e.player);
    const one = e.end - e.start < 0.15;
    if (!one) touches.push({ t: e.start, player: e.player, kind: 'receive', ev: e });
    if (!one && e.end - e.start > 0.7) {      // dribble touches, quicker when running faster
      let t = e.start + 0.45;
      while (t < e.end - 0.3) {
        touches.push({ t, player: e.player, kind: 'dribble', ev: e });
        const v = hyp(...tr.vel(t));
        t += clamp(0.95 - 0.09 * v, 0.38, 0.9);
      }
    }
    const endKind = e.endType === 'shot' ? 'shot' : e.endType === 'clearance' ? 'clearance' : e.endType === 'pass' ? 'pass' : 'touch';
    touches.push({ t: e.end, player: e.player, kind: endKind, ev: e, high: e.highPass });
  }
  touches.sort((a, b) => a.t - b.t);

  // 2. where the ball is at each touch: at the foot, on the side it travels to / arrives from
  const footPoint = (tc, i) => {
    const tr = tracks.get(tc.player), p = tr.at(tc.t);
    const nb = touches[i + 1], pb = touches[i - 1];
    let dir = null;
    if (nb && nb.player !== tc.player) { const q = tracks.get(nb.player).at(nb.t); dir = [q[0] - p[0], q[1] - p[1]]; }
    if (!dir && pb && pb.player !== tc.player) { const q = tracks.get(pb.player).at(pb.t); dir = [q[0] - p[0], q[1] - p[1]]; }
    if (!dir || hyp(...dir) < 0.1) dir = tr.vel(tc.t);
    if (hyp(...dir) < 0.1) dir = [1, 0];
    const d = hyp(...dir);
    const seen = ballData(tc.t), header = !!(seen && seen[2] > 1.5 && hyp(seen[0] - p[0], seen[1] - p[1]) < 2.5);
    tc.header = header;
    return [p[0] + (dir[0] / d) * (header ? 0.15 : foot), p[1] + (dir[1] / d) * (header ? 0.15 : foot), header ? clamp(seen[2], 1.6, 2.6) : BALL_RADIUS];
  };
  touches.forEach((tc, i) => { tc.pos = footPoint(tc, i); });

  // 3. segments
  const segments = [];
  for (let i = 0; i < touches.length; i++) {
    const a = touches[i], b = touches[i + 1];
    if (a.kind === 'shot') {
      // where did the tracked ball reach the goal mouth? (broadcast tracking loses depth right at the
      // line, so take the first point within 1.3 m of it and project the rest at the shot's speed)
      let cross = null;
      for (const fr of frames) {
        if (fr.t <= a.t || fr.t > a.t + 2.5 || !fr.ball) continue;
        if (Math.abs(fr.ball[0]) >= halfL - 1.3) { cross = fr; break; }
      }
      if (cross && netGoals && Math.abs(cross.ball[1]) < 3.66 && (a.ev?.leadToGoal || Math.abs(cross.ball[0]) >= halfL - 0.3)) {
        const side = Math.sign(cross.ball[0]);
        const line = [side * halfL, cross.ball[1], clamp(cross.ball[2], BALL_RADIUS, 2.25)];
        const travelled = hyp(cross.ball[0] - a.pos[0], cross.ball[1] - a.pos[1]), v = travelled / Math.max(0.1, cross.t - a.t);
        const tLine = Math.max(a.t + 0.25, cross.t + (halfL - Math.abs(cross.ball[0])) / Math.max(5, v));
        const seg = (line[2] > 0.5 ? flightSegment : rollingSegment)(a.pos, line, a.t, tLine, line[2] > 0.5 ? drag : 0.3);
        segments.push(seg);
        // into the net: carries on to the back netting, drops, rolls back a touch and stays
        const back = [side * (halfL + goalDepth - 0.25), line[1] * 1.02, Math.max(BALL_RADIUS, line[2] * 0.7)];
        const tBack = tLine + clamp(goalDepth / Math.max(8, seg.speed * 0.7), 0.08, 0.3);
        segments.push(flightSegment(line, back, tLine, tBack, 0));
        const rest = [side * (halfL + goalDepth - 0.6), line[1] * 1.02, BALL_RADIUS];
        segments.push(flightSegment(back, rest, tBack, tBack + 0.35, 0));
        segments.push({ t0: tBack + 0.35, t1: Infinity, kind: 'rest', at: () => rest });
        a.goal = true;
        a.goalAt = tLine;
        break;
      }
    }
    if (!b) { segments.push({ t0: a.t, t1: Infinity, kind: 'rest', at: () => a.pos }); break; }
    const D = hyp(b.pos[0] - a.pos[0], b.pos[1] - a.pos[1]), T = b.t - a.t;
    const seenHigh = maxZ(a.t, b.t) > 1.4;
    const lofted = a.player !== b.player && (a.high || seenHigh || a.kind === 'clearance' || a.header || b.header || (D > 30 && D / T < 22));
    if (!lofted) { segments.push(rollingSegment(a.pos, b.pos, a.t, b.t, a.player === b.player ? 1.6 : rolling)); continue; }
    const fly = flightSegment(a.pos, b.pos, a.t, b.t, drag), seen = maxZ(a.t, b.t);
    if (seen > 0.8 && fly.apex > seen * 1.7 && T > 1.2 && !b.header) {
      // the tracking saw a lower ball: fly to that height, land, then run on along the grass
      const Tf = clamp(Math.sqrt(8 * seen / G), 0.5, T * 0.8), frac = clamp((Tf / T) * 1.2, 0.3, 0.88);
      const land = [lerp(a.pos[0], b.pos[0], frac), lerp(a.pos[1], b.pos[1], frac), BALL_RADIUS];
      segments.push(flightSegment(a.pos, land, a.t, a.t + Tf, drag), rollingSegment(land, b.pos, a.t + Tf, b.t, rolling));
    } else segments.push(fly);
  }
  // before the first touch: the tracked ball (detected or extrapolated), else waiting at the first touch
  const first = touches[0];
  const before = (t) => {
    let best = null, bd = 1e9;
    for (const fr of frames) { if (!fr.ball) continue; const d = Math.abs(fr.t - t); if (d < bd) { bd = d; best = fr; } }
    return best && bd < 0.3 ? [best.ball[0], best.ball[1], Math.max(BALL_RADIUS, best.ball[2])] : first ? first.pos : [0, 0, BALL_RADIUS];
  };
  for (let i = 0; i < touches.length; i++) {      // kick strength + direction for animation
    const a = touches[i], s = segments.find((g) => g.t0 === a.t);
    a.power = clamp(((s?.speed ?? 3) - 3) / 22, 0.15, 1);
    const q = s ? s.at(a.t + 0.2) : a.pos;
    a.dir = [q[0] - a.pos[0], q[1] - a.pos[1]];
  }
  const at = (t) => {
    if (!first || t < first.t) return before(t);
    for (let i = segments.length - 1; i >= 0; i--) if (t >= segments[i].t0) return segments[i].at(t);
    return before(t);
  };
  return { at, touches: touches.map(({ ev, ...x }) => x), segments, goals: touches.filter((x) => x.goal).map((x) => ({ t: x.goalAt, shot: x.t, player: x.player })) };
}

/**
 * Continue player paths past the end of the data with simple, physical steering (limited
 * acceleration, slowing on arrival). `plan(id)` returns legs [{ start (s), target: [x,y], speed }]:
 * from each leg's start the player heads for its target. Returns a new Map with the same interface.
 */
export function extendTracks(tracks, { from, to, plan, accel = 2.5, step = 1 / 60 }) {
  const out = new Map();
  for (const [id, tr] of tracks) {
    const legs = (plan(id) || []).slice().sort((a, b) => a.start - b.start);
    const n = Math.max(2, Math.ceil((to - from) / step) + 1);
    const X = new Float64Array(n), Y = new Float64Array(n);
    let [x, y] = tr.at(from), [vx, vy] = tr.vel(from);
    for (let i = 0; i < n; i++) {
      const t = from + i * step;
      const leg = legs.filter((l) => l.start <= t).pop();
      let dvx = -vx, dvy = -vy;                       // default: come to a stop
      if (leg) {
        const dx = leg.target[0] - x, dy = leg.target[1] - y, d = hyp(dx, dy);
        const sp = Math.min(leg.speed, d * 1.2);        // arrive gently
        if (d > 0.05) { dvx = (dx / d) * sp - vx; dvy = (dy / d) * sp - vy; }
      }
      const dv = hyp(dvx, dvy), lim = accel * step;
      if (dv > lim) { dvx *= lim / dv; dvy *= lim / dv; }
      vx += dvx; vy += dvy; x += vx * step; y += vy * step;
      X[i] = x; Y[i] = y;
    }
    const sample = (t) => { const fi = clamp((t - from) / step, 0, n - 1), i = Math.min(n - 2, Math.floor(fi)), u = fi - i; return [lerp(X[i], X[i + 1], u), lerp(Y[i], Y[i + 1], u)]; };
    const at = (t) => (t <= from ? tr.at(t) : sample(t));
    const vel = (t) => { const h = 0.05, a = at(t - h), b = at(t + h); return [(b[0] - a[0]) / (2 * h), (b[1] - a[1]) / (2 * h)]; };
    out.set(id, { ...tr, at, vel, last: to });
  }
  return out;
}

/** Celebration: both arms thrown up over [t0, t1] (additive pose, eases in and out). */
export function armsUpPose(t, t0, t1, { bones = {} } = {}) {
  const w = smoothstep(t0, t0 + 0.25, t) * (1 - smoothstep(t1 - 0.35, t1, t));
  if (w <= 0) return {};
  const B = { armL: 'upperarm_l', armR: 'upperarm_r', foreL: 'lowerarm_l', foreR: 'lowerarm_r', ...bones };
  return { [B.armL]: [0, 0, 145 * w], [B.armR]: [0, 0, -145 * w], [B.foreL]: [0, 0, 20 * w], [B.foreR]: [0, 0, -20 * w] };
}

/** Sum several additive poses. */
export function addPoses(...poses) {
  const out = {};
  for (const p of poses) for (const [k, v] of Object.entries(p || {})) { const o = out[k] || (out[k] = [0, 0, 0]); o[0] += v[0]; o[1] += v[1]; o[2] += v[2]; }
  return out;
}

// ------------------------------------------------------------------ locomotion

/**
 * Locomotion from a track. `clips` maps gait -> { clip, dur, stride } (stride = metres per clip
 * cycle): idle, walk, jog, run, sprint (forward) and optionally back, left, right (moving while
 * facing elsewhere). Players run facing where they go; below `faceBall` m/s they keep facing
 * `look(t)` (e.g. the ball) and backpedal or side-step instead. `aim` pulls the body toward a
 * direction around kicks. Also returns body lean from acceleration and turning.
 * heading(t) is the film yaw in radians (0 = +film z = +data y).
 */
export function locomotion(track, { t0, t1, clips, look = null, aim = null, step = 1 / 60, seed = 0, faceBall = 3.2, turnRate = 9 }) {
  const n = Math.max(2, Math.ceil((t1 - t0) / step) + 1);
  const H = new Float64Array(n), PH = new Float64Array(n), V = new Float64Array(n), REL = new Float64Array(n), PITCH = new Float64Array(n), ROLL = new Float64Array(n);
  let heading = null, phase = (seed * 0.37) % 1, pv = 0, pitch = 0, roll = 0;
  const directional = !!(clips.back || clips.left || clips.right);
  for (let i = 0; i < n; i++) {
    const t = t0 + i * step, [vx, vy] = track.vel(t), v = hyp(vx, vy), p = track.at(t);
    const velYaw = v > 0.05 ? Math.atan2(vx, vy) : null;
    let lookYaw = null;
    if (look) { const q = look(t); if (q && hyp(q[0] - p[0], q[1] - p[1]) > 0.3) lookYaw = Math.atan2(q[0] - p[0], q[1] - p[1]); }
    let want;
    if (velYaw != null && v > 1.0 && (!directional || lookYaw == null || v > faceBall)) want = velYaw;
    else if (velYaw != null && v > 0.6 && directional && lookYaw != null) {
      // moving slowly while watching the ball: face it unless it is roughly where we're going anyway
      const d = Math.abs(Math.atan2(Math.sin(velYaw - lookYaw), Math.cos(velYaw - lookYaw)));
      want = d > 0.9 ? lookYaw : velYaw;
    } else want = lookYaw ?? heading ?? velYaw ?? 0;
    const pull = aim ? aim(t) : null;      // { dir: [x,y], w }
    if (pull && pull.w > 0) {
      const ay = Math.atan2(pull.dir[0], pull.dir[1]);
      let d = ay - want; d = Math.atan2(Math.sin(d), Math.cos(d)); want += d * pull.w;
    }
    if (heading == null) heading = want;
    let dA = want - heading; dA = Math.atan2(Math.sin(dA), Math.cos(dA));
    const turn = dA * clamp((v > 1 ? turnRate : 4) * step, 0, 1);
    heading += turn;
    const rel = velYaw == null ? 0 : Math.atan2(Math.sin(velYaw - heading), Math.cos(velYaw - heading));
    const stride = gaitStride(clips, v, rel);
    phase += (Math.max(v, 0.9) * step) / stride;
    // lean: forward with speed and acceleration, sideways into turns (degrees, low-passed)
    const vf = v * Math.cos(rel), acc = (vf - pv) / step; pv = vf;
    const omega = turn / step;
    pitch += (clamp(1.2 * Math.max(0, vf) + 1.6 * clamp(acc, -4, 4), -7, 13) - pitch) * clamp(6 * step, 0, 1);
    roll += (clamp(-omega * v * 2.6, -16, 16) - roll) * clamp(8 * step, 0, 1);
    H[i] = heading; PH[i] = phase; V[i] = v; REL[i] = rel; PITCH[i] = pitch; ROLL[i] = roll;
  }
  const sample = (arr, t) => { const fi = clamp((t - t0) / step, 0, n - 1), i = Math.min(n - 2, Math.floor(fi)); return lerp(arr[i], arr[i + 1], fi - i); };
  const sampleAngle = (arr, t) => { const fi = clamp((t - t0) / step, 0, n - 1), i = Math.min(n - 2, Math.floor(fi)); let d = arr[i + 1] - arr[i]; d = Math.atan2(Math.sin(d), Math.cos(d)); return arr[i] + d * (fi - i); };
  return {
    heading: (t) => sample(H, t), speed: (t) => sample(V, t), lean: (t) => ({ pitch: sample(PITCH, t), roll: sample(ROLL, t) }),
    clips: (t) => {
      const v = sample(V, t), ph = sample(PH, t), rel = sampleAngle(REL, t), w = gaitWeights(clips, v, rel), list = [];
      if (w.idle > 0 && clips.idle) list.push({ clip: clips.idle.clip, time: ((t + seed * 0.41) % clips.idle.dur + clips.idle.dur) % clips.idle.dur, weight: w.idle });
      for (const g of GAITS) if (w[g] > 1e-3 && clips[g]) list.push({ clip: clips[g].clip, time: (((ph + (g === 'back' || g === 'left' || g === 'right' ? 0 : 0)) % 1 + 1) % 1) * clips[g].dur, weight: w[g] });
      return list;
    },
  };
}

const GAITS = ['walk', 'jog', 'run', 'sprint', 'back', 'left', 'right'];
function gaitWeights(clips, v, rel = 0) {
  // direction lobes in the body frame (forward / back / left / right)
  let f = Math.max(0, Math.cos(rel)), b = Math.max(0, -Math.cos(rel)), l = Math.max(0, Math.sin(rel)), r = Math.max(0, -Math.sin(rel));
  if (!clips.back) { f += b; b = 0; }
  if (!clips.left) { f += l; l = 0; }
  if (!clips.right) { f += r; r = 0; }
  const tot = f + b + l + r || 1; f /= tot; b /= tot; l /= tot; r /= tot;
  const moving = smoothstep(0.25, 0.9, v);
  const walk = clips.walk ? 1 - smoothstep(2.0, 3.0, v) : 0;
  const runAll = 1 - walk;
  const sprint = clips.sprint ? smoothstep(5.4, 7.0, v) * runAll : 0;
  const run = clips.run ? smoothstep(3.6, 4.8, v) * (runAll - sprint) : 0;
  const jog = runAll - sprint - run;
  // backpedal / side-step only at walking-to-jogging speeds
  const dirOK = 1 - smoothstep(3.5, 4.5, v);
  const back = b * dirOK, left = l * dirOK, right = r * dirOK, fwd = 1 - back - left - right;
  return { idle: 1 - moving, walk: moving * fwd * walk, jog: moving * fwd * jog, run: moving * fwd * run, sprint: moving * fwd * sprint, back: moving * back, left: moving * left, right: moving * right };
}

function gaitStride(clips, v, rel = 0) {
  const w = gaitWeights(clips, v, rel), s = (g) => clips[g]?.stride ?? 1;
  let tot = 0, acc = 0;
  for (const g of GAITS) if (w[g] > 0 && clips[g]) { tot += w[g]; acc += w[g] * s(g); }
  return tot < 1e-3 ? s(clips.walk ? 'walk' : 'jog') : acc / tot;
}

// ------------------------------------------------------------------ layering clips

/** A one-shot clip overlay: starts at `start` (seconds), fades in/out. Returns { w, list } or null. */
export function oneShot(t, { clip, start, duration, rate = 1, offset = 0, fadeIn = 0.2, fadeOut = 0.3, peak = 1, hold = false }) {
  const end = start + (duration - offset) / rate;
  if (t < start - fadeIn || (!hold && t > end)) return null;
  const w = peak * smoothstep(start - fadeIn, start, t) * (hold ? 1 : 1 - smoothstep(end - fadeOut, end, t));
  return w > 1e-3 ? { w, list: [{ clip, time: clamp(offset + (t - start) * rate, 0, duration), weight: 1 }] } : null;
}

/** Blend overlays (in order, later on top) over a base clip list; weights stay normalised. */
export function layer(base, ...overlays) {
  let list = base;
  for (const ov of overlays) {
    if (!ov || !(ov.w > 0)) continue;
    list = [...list.map((x) => ({ ...x, weight: x.weight * (1 - ov.w) })), ...ov.list.map((x) => ({ ...x, weight: x.weight * ov.w }))];
  }
  return list.filter((x) => x.weight > 1e-3);
}

/**
 * Real kick motion for touches: each pass/shot/clearance plays a captured kick (by foot) aligned so
 * the capture's contact frame lands on the touch. `clips` = { R: [{clip, contact, duration}], L: [...] }.
 * Softer passes blend less of the full kick in.
 */
export function kickOverlay(t, touches, clips, { kinds = ['pass', 'shot', 'clearance', 'cross', 'touch'], minPower = 0, seed = 0 } = {}) {
  let best = null;
  touches.forEach((tc, i) => {
    if (!kinds.includes(tc.kind) || (tc.power ?? 1) < minPower) return;
    const set = clips[tc.foot || 'R'];
    if (!set?.length) return;
    const k = set[(i * 7 + seed) % set.length];
    const pw = tc.kind === 'shot' ? 1 : 0.6 + 0.4 * clamp(tc.power ?? 0.6, 0, 1);
    const ov = oneShot(t, { clip: k.clip, start: tc.t - Math.min(0.55, k.contact), offset: k.contact - Math.min(0.55, k.contact), duration: Math.min(k.duration, k.contact + 0.75), fadeIn: 0.22, fadeOut: 0.35, peak: pw });
    if (ov && (!best || ov.w > best.w)) best = ov;
  });
  return best;
}

/**
 * Head, neck and upper spine turn toward a target (additive pose, universal bone names).
 * `heading` = film yaw (radians); `pos` = [x, y] data metres; `target` = [x, y, z] data metres.
 */
export function lookPose({ heading, pos, target, eye = 1.65, weight = 1, maxYaw = 80 }) {
  if (!target || weight <= 0) return {};
  const dx = target[0] - pos[0], dy = target[1] - pos[1], d = Math.max(0.3, hyp(dx, dy));
  let yaw = Math.atan2(dx, dy) - heading;
  yaw = Math.atan2(Math.sin(yaw), Math.cos(yaw)) * 180 / Math.PI;
  // beyond reach (ball behind) the head comes back toward forward instead of snapping across
  const reach = Math.abs(yaw) > maxYaw + 40 ? 0 : clamp(yaw, -maxYaw, maxYaw);
  const pitch = clamp(-Math.atan2((target[2] ?? 0) - eye, d) * 180 / Math.PI, -25, 40) * weight;   // + = look down
  const y = reach * weight;
  return { spine_02: [0, y * 0.1, 0], spine_03: [pitch * 0.1, y * 0.15, 0], neck_01: [pitch * 0.35, y * 0.3, 0], Head: [pitch * 0.55, y * 0.45, 0] };
}

/** Hands on head (a near miss, a goal conceded): additive pose with fades. */
export function handsOnHeadPose(t, t0, t1) {
  const w = smoothstep(t0, t0 + 0.4, t) * (1 - smoothstep(t1 - 0.5, t1, t));
  if (w <= 0) return {};
  // upper arms up and out to ~40 degrees above horizontal, slightly forward; forearms fold in over the head
  return { upperarm_l: [-18 * w, 0, 128 * w], upperarm_r: [-18 * w, 0, -128 * w], lowerarm_l: [-10 * w, 0, 112 * w], lowerarm_r: [-10 * w, 0, -112 * w], neck_01: [14 * w, 0, 0], Head: [8 * w, 0, 0] };
}

/** Hands on hips (waiting, tired): additive pose with fades. */
export function handsOnHipsPose(t, t0, t1) {
  const w = smoothstep(t0, t0 + 0.5, t) * (1 - smoothstep(t1 - 0.5, t1, t));
  if (w <= 0) return {};
  return { upperarm_l: [12 * w, 0, 40 * w], upperarm_r: [12 * w, 0, -40 * w], lowerarm_l: [0, 70 * w, 0], lowerarm_r: [0, -70 * w, 0] };
}

// ------------------------------------------------------------------ touches as poses

const keyed = (keys, t) => {   // [[t, v], ...] smooth interpolation
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 0; i < keys.length - 1; i++) {
    const [ta, va] = keys[i], [tb, vb] = keys[i + 1];
    if (t <= tb) { const u = (t - ta) / (tb - ta); return va + (vb - va) * u * u * (3 - 2 * u); }
  }
  return keys[keys.length - 1][1];
};

// degrees: leg swing forward (+) / back (-), knee flex, foot point, plant knee, spine lean, arm out
const MOVES = {
  kick: { span: [-0.42, 0.5], swing: [[-0.42, 0], [-0.13, -38], [0, 22], [0.13, 52], [0.5, 0]], knee: [[-0.42, 0], [-0.13, 95], [-0.02, 30], [0.08, 12], [0.28, 22], [0.5, 0]],
    point: [[-0.1, 0], [0, 28], [0.3, 0]], plant: [[-0.3, 0], [-0.05, 22], [0.18, 14], [0.45, 0]], lean: [[-0.3, 0], [0, 9], [0.45, 0]], arm: [[-0.35, 0], [0, 48], [0.5, 0]] },
  receive: { span: [-0.25, 0.4], swing: [[-0.25, 0], [-0.04, 28], [0.15, 10], [0.4, 0]], knee: [[-0.25, 0], [-0.04, 42], [0.15, 22], [0.4, 0]],
    point: [[-0.1, 0], [0, -10], [0.3, 0]], plant: [[-0.2, 0], [0, 14], [0.4, 0]], lean: [[-0.2, 0], [0, 5], [0.4, 0]], arm: [[-0.2, 0], [0, 18], [0.4, 0]] },
  dribble: { span: [-0.18, 0.24], swing: [[-0.18, 0], [-0.02, 24], [0.24, 0]], knee: [[-0.18, 0], [-0.08, 38], [0.02, 18], [0.24, 0]],
    point: [[-0.1, 0], [0, 12], [0.24, 0]], plant: [[-0.18, 0], [0, 8], [0.24, 0]], lean: [[-0.18, 0], [0, 3], [0.24, 0]], arm: [[-0.18, 0], [0, 8], [0.24, 0]] },
};

/** Which foot plays a touch: inside of the left foot for balls played to the right, else the right. */
export function footFor(touch, headingAt) {
  const yaw = headingAt(touch.t), d = touch.dir || [0, 0], L = hyp(...d);
  if (L < 1e-3) return 'R';
  const left = [Math.cos(yaw), -Math.sin(yaw)];              // character's left (+X) in data x,y via film yaw
  return (d[0] * left[0] + d[1] * left[1]) / L < -0.42 ? 'L' : 'R';
}

/**
 * Additive pose (film `pose` field) for a player's touches at time t. `touches` are this player's
 * touches ({ t, kind, power, foot }). Bone names default to the Rigify / Quaternius mannequin
 * (DEF-thigh.R ...); pass `bones` to map another rig.
 */
export function touchPose(t, touches, { bones = {}, kinds = null } = {}) {
  // universal bone names; the renderer maps them onto Rigify / Mixamo rigs too
  const B = { thighR: 'thigh_r', shinR: 'calf_r', footR: 'foot_r', thighL: 'thigh_l', shinL: 'calf_l', footL: 'foot_l', spine: 'spine_01', armL: 'upperarm_l', armR: 'upperarm_r', ...bones };
  const out = {};
  const add = (bone, x, y = 0, z = 0) => { const o = out[bone] || (out[bone] = [0, 0, 0]); o[0] += x; o[1] += y; o[2] += z; };
  for (const tc of touches) {
    if (tc.header || (kinds && !kinds.includes(tc.kind))) continue;
    const kind = tc.kind === 'receive' ? 'receive' : tc.kind === 'dribble' ? 'dribble' : 'kick';
    const m = MOVES[kind], tau = t - tc.t;
    if (tau < m.span[0] || tau > m.span[1]) continue;
    const p = kind === 'kick' ? 0.55 + 0.45 * (tc.power ?? 0.5) : 1;
    const R = (tc.foot || 'R') === 'R';
    const [thigh, shin, foot, pthigh, pshin, armOut, armIn] = R ? [B.thighR, B.shinR, B.footR, B.thighL, B.shinL, B.armL, B.armR] : [B.thighL, B.shinL, B.footL, B.thighR, B.shinR, B.armR, B.armL];
    add(thigh, -keyed(m.swing, tau) * p);        // actor-space X: negative swings the leg forward
    add(shin, keyed(m.knee, tau) * p);           // positive bends the knee (foot back)
    add(foot, keyed(m.point, tau) * p);          // positive points the toe
    add(pshin, keyed(m.plant, tau) * 0.8);
    add(pthigh, -keyed(m.plant, tau) * 0.5);
    add(B.spine, keyed(m.lean, tau) * p);
    const arm = keyed(m.arm, tau) * p;           // balance: the opposite arm swings out
    add(armOut, 0, 0, R ? arm : -arm);
    add(armIn, -arm * 0.35, 0, 0);
  }
  return out;
}
