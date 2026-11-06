// Pure three.js film (no Unreal): a ball bounces, rolls into a stack of crates and knocks
// the top one off. Shows film-mode AA, motion blur, depth of field and soft sun shadows.
// Render:  hfilm render examples/basic/film.mjs      Preview:  hfilm preview examples/basic/film.mjs
export default ({ anim }) => {
  const { keys, arc, smooth, handheld, ease } = anim;
  const fps = 30;
  // ball: three bounces, then rolls into the crates (all motion is just code)
  const bounces = [[0, [-6, 0.25, 0]], [22, [-3.6, 0.25, 0.3], 2.2], [40, [-1.8, 0.25, 0.5], 1.1], [54, [-0.6, 0.25, 0.6], 0.45], [70, [1.5, 0.25, 0.6], 0], [80, [2.13, 0.25, 0.55], 0]];
  const ball = (f) => {
    for (let i = 0; i < bounces.length - 1; i++) {
      const [f0, p0] = bounces[i], [f1, p1, h] = bounces[i + 1];
      if (f <= f1) return arc(p0, p1, h, (f - f0) / (f1 - f0));
    }
    return bounces[bounces.length - 1][1];
  };
  const travelled = (f) => { let d = 0; for (let g = 1; g <= f; g++) { const a = ball(g - 1), b = ball(g); d += Math.hypot(b[0] - a[0], b[2] - a[2]); } return d; };
  const top = keys([[78, [2.9, 1.25, 0.55]], [86, [3.4, 1.0, 0.45], 'out'], [98, [4.3, 0.25, 0.3], 'in'], [120, [4.7, 0.25, 0.25], 'out']]);
  const topSpin = keys([[78, 0], [98, 80, 'in'], [120, 92, 'out']]);
  const follow = smooth((f) => ball(Math.min(f, 80)), 0, 150, 5);
  return {
    fps, size: [1280, 720], frames: [0, 150],
    render: { samples: 24, shutter: 0.5, toneMapping: 'agx', exposure: 1.1 },
    background: '#d9dde4',
    sun: { elevation: 38, azimuth: 35, color: '#fff1dc', intensity: 3.2, softness: 2.5 },
    ambient: { sky: '#cfdcf0', ground: '#6b6358', intensity: 1.4 },
    camera: handheld((f) => {
      const t = ease.inOut(Math.min(1, f / 150));
      const target = follow(f);
      return { position: [-4.5 + 7.5 * t, 1.5 - 0.4 * t, 6.5 - 1.5 * t], target: [target[0] + 0.4, 0.3 + 0.3 * target[1], target[2]], focalLength: 40, fStop: 2.0 };
    }, { amount: 0.05 }),
    actors: [
      { id: 'floor', model: { primitive: 'box', size: [40, 0.2, 40], material: { color: '#9aa0a8', roughness: 0.85 } }, transform: { position: [0, -0.1, 0] } },
      { id: 'wall', model: { primitive: 'box', size: [40, 8, 0.2], material: { color: '#c9ccd2', roughness: 0.9 } }, transform: { position: [0, 4, -4] } },
      { id: 'ball', model: { primitive: 'sphere', radius: 0.25, material: { color: '#d4202c', roughness: 0.3, clearcoat: 1 } },
        transform: (f) => ({ position: ball(f), rotation: [0, 0, -travelled(f) / 0.25 * 57.2958] }) },
      { id: 'crate1', model: { primitive: 'box', size: [1, 1, 1], material: { color: '#b07a45', roughness: 0.7 } }, transform: { position: [2.9, 0.5, 0.55], yaw: 8 } },
      { id: 'crate2', model: { primitive: 'box', size: [0.5, 0.5, 0.5], material: { color: '#2f5d8a', roughness: 0.5 } },
        transform: (f) => ({ position: f < 78 ? [2.9, 1.25, 0.55] : top(f), rotation: [0, 0, f < 78 ? 0 : -topSpin(f)] }) },
      { id: 'cyl', model: { primitive: 'cylinder', radius: 0.35, height: 1.6, material: { color: '#e8e4da', roughness: 0.4 } }, transform: { position: [-2.5, 0.8, -1.6] } },
    ],
  };
};
