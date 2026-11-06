// Hybrid example: an Unreal Engine stadium (plates) + three.js players and ball (film mode).
//
//   1. node fetch-assets.mjs                                  (CC0 rigged mannequin, ~7 MB)
//   2. hfilm ue plates film.mjs --project <AgentSandbox.uproject> --map /Game/Soccer/Maps/Stadium \
//        --hide "Soccer/Players,Ball,Soccer/Highlights" \
//        --holdouts "Soccer/Pitch/Goal_West,Soccer/Pitch/Goal_East,Soccer/Stadium/Boards,Soccer/Pitch/CornerFlags" \
//        --grid M_Net --ground Pitch --name goal
//   3. hfilm render film.mjs
//
// Step 2 renders the empty stadium from THIS file's cameras and writes plates/goal/{plates,holdouts,hidden,...}.
// Change the choreography and only step 3 re-runs (seconds per take, ~1 GB RAM). Change a camera: re-run 2.
export default ({ anim, json, THREE }) => {
  const { ue, smooth, handheld, kelvin } = anim;
  const FPS = 30, L = 5250, W = 3400;            // Unreal cm, half pitch length / width
  const START = 1120, END = 1300;                 // the build-up, through ball, finish and goal
  const plates = json('plates/goal/plates.json', null);
  const hidden = json('plates/goal/hidden.json', { actors: [] }).actors;

  // ---------------------------------------------------------------- ball (Unreal cm, action frames)
  const BALL = [
    [0, 0, 0, 11, 0], [150, 0, 0, 11, 0], [172, -850, 280, 11, 0], [235, 1800, -2600, 11, 650],
    [300, 2400, -2700, 11, 0], [360, 3300, -2500, 11, 0], [402, 4550, 250, 160, 380], [412, 4520, 260, 185, 0],
    [470, 1500, 1800, 11, 900], [505, 1150, 2050, 11, 0], [560, -250, 1500, 11, 0], [600, -1500, 900, 11, 0],
    [650, -2600, 400, 11, 0], [710, -3500, -600, 11, 0], [748, -4100, -300, 11, 120], [772, -5120, 130, 120, 0],
    [778, -5050, 160, 90, 0], [820, -4300, 1600, 11, 260], [850, -3900, 1800, 11, 0], [920, -2000, 2200, 11, 0],
    [980, -300, 1500, 11, 0], [1050, 1200, 600, 11, 0], [1100, 2200, 200, 11, 0], [1150, 3000, -800, 11, 0],
    [1210, 4300, -500, 11, 60], [1255, 4520, -440, 11, 0], [1262, 4560, -430, 11, 90], [1284, 5330, 150, 175, 0],
    [1296, 5440, 130, 60, 0], [1310, 5420, 110, 11, 0], [2000, 5430, 100, 11, 0],
  ];
  const ballUE = (f) => {
    for (let i = 0; i < BALL.length - 1; i++) {
      const [f0, x0, y0, z0, h] = BALL[i], [f1, x1, y1, z1] = BALL[i + 1];
      if (f >= f0 && f <= f1) { const t = f1 === f0 ? 0 : (f - f0) / (f1 - f0); return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, z0 + (z1 - z0) * t + 4 * h * t * (1 - t)]; }
    }
    return BALL[BALL.length - 1].slice(1, 4);
  };
  const ball = (f) => ue.pos(ballUE(f));

  // ---------------------------------------------------------------- team simulation (port of soccer_match.py)
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const possession = (f) => (f >= 560 && f < 760 ? 'White' : f >= 760 ? 'Red' : f >= 405 ? 'White' : 'Red');
  const players = hidden.filter((a) => /^(Red|White)_/.test(a.label)).map((a) => ({
    label: a.label, team: a.label.startsWith('Red_') ? 'Red' : 'White', gk: a.label.includes('_GK_'),
    anchor: [a.unreal.location[0], a.unreal.location[1]], p: [a.unreal.location[0], a.unreal.location[1]], track: [],
  }));
  const scorer = players.find((p) => p.label.startsWith('Red_ST_10'));
  for (let f = 0; f <= END + 2; f++) {
    const [bx, by] = ballUE(f);
    const poss = possession(f);
    const targets = new Map(), speeds = new Map();
    for (const team of ['Red', 'White']) {
      const d = team === 'Red' ? 1 : -1, has = poss === team;
      const sx = clamp(bx * 0.55 + (has ? 450 : -350) * d, -2700, 2700), sy = by * 0.3;
      for (const p of players.filter((q) => q.team === team)) {
        if (p.gk) { targets.set(p, [-d * (L - 130), clamp(by * 0.18, -320, 320)]); speeds.set(p, 420); continue; }
        const [ax, ay] = p.anchor;
        targets.set(p, [clamp(f >= 150 ? ax * 0.85 + sx : ax, -L + 300, L - 300), clamp(f >= 150 ? ay * 0.9 + sy : ay, -W + 150, W - 150)]);
        speeds.set(p, f >= 150 ? 480 : 0);
      }
      if (f >= 150) {
        const out = players.filter((q) => q.team === team && !q.gk).sort((a, b) => Math.hypot(a.p[0] - bx, a.p[1] - by) - Math.hypot(b.p[0] - bx, b.p[1] - by));
        if (has) {
          const carrier = team === 'Red' && f >= 1140 && f <= 1265 && scorer ? scorer : out[0];
          targets.set(carrier, [bx - d * 85, by - 25]); speeds.set(carrier, 820);
        } else for (const q of out.slice(0, 2)) { targets.set(q, [bx - d * 140, by]); speeds.set(q, 700); }
      }
    }
    for (const p of players) {
      const [tx, ty] = targets.get(p), dx = tx - p.p[0], dy = ty - p.p[1], dd = Math.hypot(dx, dy);
      const mv = Math.min(dd, speeds.get(p) / FPS);
      if (dd > 1e-3) { p.p[0] += (dx / dd) * mv; p.p[1] += (dy / dd) * mv; }
      p.track.push([p.p[0], p.p[1]]);
    }
  }

  // ---------------------------------------------------------------- animation from motion (no foot sliding)
  // natural ground speeds measured with `hfilm inspect assets/ual_mannequin.glb`
  const JOG = { clip: 'Jog_Fwd_Loop', dur: 0.933, speed: 4.25 }, SPRINT = { clip: 'Sprint_Loop', dur: 0.667, speed: 4.5 };
  const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const rigs = players.map((p, idx) => {
    const pos = (f) => ue.pos([...p.track[clamp(f, 0, p.track.length - 1)], 0]);
    const vel = (f) => { const a = pos(f - 2), b = pos(f + 2); return [(b[0] - a[0]) * FPS / 4, (b[2] - a[2]) * FPS / 4]; };
    const yaw = new Map(), anim = new Map();
    let heading = null, phase = (idx * 0.37) % 1, idleT = idx * 0.41;
    for (let f = 0; f <= END; f++) {
      const [vx, vz] = vel(f), v = Math.hypot(vx, vz);
      const b = ball(f), here = pos(f);
      const want = v > 0.6 ? Math.atan2(vx, vz) : Math.atan2(b[0] - here[0], b[2] - here[2]);
      if (heading == null) heading = want;
      let dA = want - heading; dA = Math.atan2(Math.sin(dA), Math.cos(dA));
      heading += dA * (v > 0.6 ? 0.35 : 0.12);                     // turn smoothly, faster when running
      yaw.set(f, heading);
      const wRun = smoothstep(0.4, 2.2, v), wSprint = smoothstep(5.0, 7.0, v) * wRun;
      const cycle = (JOG.speed * JOG.dur) * (1 - wSprint / Math.max(wRun, 1e-6)) + (SPRINT.speed * SPRINT.dur) * (wSprint / Math.max(wRun, 1e-6));
      phase += (Math.max(v, 1.2) / FPS) / cycle;
      idleT += 1 / FPS;
      const list = [];
      if (wRun < 1) list.push({ clip: 'Idle_Loop', time: idleT % 2.5, weight: 1 - wRun });
      if (wRun - wSprint > 0) list.push({ clip: JOG.clip, time: (phase % 1) * JOG.dur, weight: wRun - wSprint });
      if (wSprint > 0) list.push({ clip: SPRINT.clip, time: (phase % 1) * SPRINT.dur, weight: wSprint });
      anim.set(f, list);
    }
    return { p, pos, yaw, anim };
  });

  // keeper dive: White keeper launches to his left as the shot comes in
  const keeper = rigs.find((r) => r.p.label.startsWith('White_GK'));
  const dive = (f) => clamp((f - 1268) / 14, 0, 1);

  // ---------------------------------------------------------------- ball spin (rolls without slipping)
  const R = 0.11, ballRot = new Map();
  const q = new THREE.Quaternion(), dq = new THREE.Quaternion(), axis = new THREE.Vector3();
  for (let f = 0; f <= END; f++) {
    const a = ball(f - 1), b = ball(f), dx = b[0] - a[0], dz = b[2] - a[2], dd = Math.hypot(dx, dz);
    if (dd > 1e-5) { axis.set(dz, 0, -dx).normalize(); dq.setFromAxisAngle(axis, dd / R); q.premultiply(dq); }
    ballRot.set(f, q.toArray());
  }

  // ---------------------------------------------------------------- cameras (three broadcast shots)
  const follow = smooth((f) => ball(f), START - 30, END + 1, 5);
  const carrierFollow = smooth((f) => { const b = ball(f), s = scorer ? ue.pos([...scorer.track[f], 0]) : b; return [(b[0] + s[0]) / 2, 1.0, (b[2] + s[2]) / 2]; }, START - 30, END + 1, 4);
  const lerp3 = (a, b, t) => a.map((v, i) => v + (b[i] - v) * clamp(t, 0, 1));
  const camera = handheld((f) => {
    if (f < 1200) {   // A: broadcast gantry wide, pans and gently zooms with the play
      const t = (f - START) / 80, tg = follow(f);
      return { position: ue.pos([2600, -4250, 1150]), target: [tg[0] + 2, 0.4, tg[2]], focalLength: 28 + 10 * t, fStop: 8 };
    }
    if (f < 1262) {   // B: low tracking telephoto alongside the striker
      const t = (f - 1200) / 62, tg = carrierFollow(f);
      const pos = ue.pos(lerp3([3650, -2750, 95], [4350, -2700, 95], t));
      return { position: pos, target: tg, focalLength: 85, fStop: 2.8, focusDistance: Math.hypot(tg[0] - pos[0], tg[2] - pos[2]) };
    }
    // C: reverse angle from behind the net as the shot flies in
    const tg = follow(f);
    return { position: ue.pos([6080, -350, 235]), target: [tg[0], Math.max(0.9, tg[1]), tg[2]], focalLength: 30, fStop: 5.6, focusDistance: 9 };
  }, { amount: 0.08, speed: 0.5 });

  const kit = { Red: '#a3121b', White: '#e9e9ec', RedGK: '#e2a100', WhiteGK: '#0d8a4c' };
  return {
    fps: FPS, size: [1280, 720], frames: [START, END], cuts: [1200, 1262],
    render: { samples: 24, shutter: 0.5, toneMapping: 'agx', exposure: 1.15 },
    plate: plates ? { frames: plates.usage.plate.frames, offset: plates.usage.plate.offset } : null,
    holdouts: plates ? plates.usage.holdouts : null,
    sun: plates?.sun ? { direction: plates.sun.direction, color: plates.sun.temperature ? kelvin(plates.sun.temperature) : plates.sun.color, intensity: 3.2, softness: 0.8 } : { elevation: 30, azimuth: 40, intensity: 3.2 },
    ambient: { sky: '#a7b6d4', ground: '#7d8a4c', intensity: 1.6 },   // golden-hour sky fill + grass bounce
    shadowCatcher: { y: plates?.groundY ?? 0, opacity: 0.62, tint: '#3a4660' },
    camera,
    actors: [
      ...rigs.map((r) => ({
        id: r.p.label, model: 'assets/ual_mannequin.glb',
        tint: { M_Main: kit[r.p.team + (r.p.gk ? 'GK' : '')], M_Joints: '#2a2c31' },
        transform: (f) => {
          const pos = r.pos(f);
          if (r === keeper && f >= 1268) {   // dive: lateral launch, lift and roll
            const t = dive(f), side = 1;
            return { position: [pos[0], (plates?.groundY ?? 0) + 0.55 * Math.sin(Math.PI * Math.min(1, t * 1.1)), pos[2] + side * 1.6 * t], rotation: [0, THREE.MathUtils.radToDeg(r.yaw.get(f)), -side * 78 * t] };
          }
          return { position: [pos[0], plates?.groundY ?? 0, pos[2]], yaw: THREE.MathUtils.radToDeg(r.yaw.get(f)) };
        },
        animation: (f) => (r === keeper && f >= 1266 ? [{ clip: 'Jump_Start', time: clamp((f - 1266) / FPS, 0, 1.2), weight: 1 }] : r.anim.get(f)),
      })),
      { id: 'ball', model: { primitive: 'sphere', radius: R, material: { map: 'assets/ball.png', roughness: 0.45, clearcoat: 0.3 } },
        transform: (f) => ({ position: ball(f), quaternion: ballRot.get(f) }) },
    ],
  };
};
