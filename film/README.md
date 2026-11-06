# Hybrid Film

**Film-quality video from code, without a heavy renderer.** Unreal Engine (or any renderer) supplies
the light. three.js supplies the motion.

The expensive part of a shot, a photoreal environment with global illumination, rarely changes between
takes. The part that does change, the choreography of characters, props and cameras, is cheap to draw.
Hybrid Film splits them:

| | rendered by | when |
|---|---|---|
| Environment ("plates"): empty set from the film's own cameras | Unreal Engine (Movie Render Queue, headless) | once per camera move |
| Holdouts (geometry the actors pass behind), sun, ground | exported from the Unreal level | same run |
| Actors: characters, props, the ball | three.js in headless Chrome, **film mode** | every take, in seconds |
| Final composite and H.264 MP4 | the same Chrome page (WebCodecs) | same run |

With no Unreal at all it is still a pure three.js film renderer: write a scene in code, preview it
live, render it at film quality.

## Why it doesn't look like "three.js"

Real-time WebGL looks cheap because it has to finish a frame in 16 ms. A video doesn't. Every output
frame is the average of N sub-frames (16–32), and each sub-frame jitters four things:

- **sub-pixel position**: true anti-aliasing;
- **time inside the shutter** (default 180°): real motion blur, never across camera cuts;
- **position on the lens aperture**, with the focus plane held fixed: physically based depth of field from `focalLength` and `fStop`;
- **position on the sun's disc**: soft shadows with physically sized penumbrae.

It all accumulates in float buffers, gets AgX tone mapping (or ACES or Neutral), is dithered before
encoding, and is composited:

- **Holdouts** are depth-only stand-ins for plate geometry. Players disappear behind goalposts and walls.
  *Grid holdouts* (`--grid M_Net`) occlude only along a net's strands.
- **The shadow catcher adds only new shadows.** A full shadow mask (actors + plate geometry) minus a
  static-only mask is darkened onto the plate. Actor shadows never double-darken areas the plate
  already has in shadow.
- **Plate geometry shadows the actors.** A player who runs into a stand's shadow darkens.

## Install

```bash
cd film && npm install        # three.js + mp4-muxer (~30 MB)
node bin/hfilm.mjs doctor     # Node >= 22, Chrome/Chromium/Edge, GPU WebGL2, H.264 encoder, Unreal (optional)
```

`doctor` on an Apple M4: `ANGLE Metal Renderer: Apple M4`, float render targets, hardware H.264.
Set `HFILM_CHROME` to use a specific Chromium-based browser and `UE_ROOT` for a non-default Unreal install.

## Quick start (no Unreal)

```bash
node bin/hfilm.mjs preview examples/basic/film.mjs   # live player + scrubber; tick "film quality" on any frame
node bin/hfilm.mjs render  examples/basic/film.mjs   # -> examples/basic/out/film.mp4
node bin/hfilm.mjs init my-film                       # scaffold a new film from the basic template
```

A film is a JavaScript module. Every value can be a constant or a function of the frame. That's the
three.js way of animating, but evaluated deterministically and rendered offline:

```js
export default ({ anim }) => {
  const { keys, arc, smooth, handheld } = anim;
  const ball = (f) => arc([-6, 0.25, 0], [2, 0.25, 0], 1.5, Math.min(1, f / 60));
  const follow = smooth(ball, 0, 120, 5);                 // camera operator lag, in frames
  return {
    fps: 30, size: [1280, 720], frames: [0, 120],
    render: { samples: 24, shutter: 0.5, toneMapping: 'agx' },
    sun: { elevation: 35, azimuth: 30, intensity: 3, softness: 2 },
    camera: handheld((f) => ({ position: [0, 1.6, 7], target: follow(f), focalLength: 50, fStop: 2 })),
    actors: [
      { id: 'ball', model: { primitive: 'sphere', radius: 0.25, material: { color: '#c22' } }, transform: (f) => ({ position: ball(f) }) },
      { id: 'hero', model: 'assets/character.glb', transform: (f) => ({ position: [0, 0, 0], yaw: f }),
        animation: (f) => [{ clip: 'Walk', time: f / 30 }] },
    ],
  };
};
```

## Film reference

World units: metres, +Y up, right-handed (glTF / three.js). `anim.ue` converts from and to Unreal (cm, +Z up).

| field | meaning |
|---|---|
| `fps`, `size: [w, h]`, `frames: [start, end)` | timing and resolution; end is exclusive |
| `cuts: [frame, …]` | camera cuts: no interpolation or motion blur across them |
| `render` | `samples` (16), `shutter` (0.5 = 180°), `toneMapping` (`agx`, `aces`, `neutral`, `none`), `exposure`, `dof`, `bitrate` |
| `camera: (f) => ({…})` | `position`, `target` (or `quaternion`), `up`, `fov` (vertical°) or `focalLength` (mm) + `sensorWidth` (36), `focusDistance` (m; defaults to the target distance), `fStop` |
| `actors: [{…}]` | `id`; `model`: `'file.glb'` or `{ primitive: sphere \| box \| cylinder \| plane, …, material }`; `tint: { MaterialName \| '*': '#hex' }`; `transform: (f) => ({ position, yaw \| rotation [x,y,z]° \| quaternion, scale })`; `animation: (f) => [{ clip, time, weight }]` (blend any clips); `visible: (f) => bool`; `castShadow`, `receiveShadow` |
| `sun` | `direction` (toward the light) or `elevation` + `azimuth`; `color`, `intensity`, `softness` (degrees), `shadowMapSize` |
| `ambient` | hemisphere fill: `sky`, `ground`, `intensity`; `fromPlate: true` samples the plate |
| `environment` | `{ hdri: 'sky.hdr', intensity, background, rotation }` image-based lighting |
| `plate` | `{ frames: 'plates/Shot.{frame:4}.jpeg', offset }`: per-frame background images |
| `holdouts` | JSON file or array of `{ shape: box \| cylinder \| sphere \| plane, matrix \| position/rotation/scale, grid? }` |
| `shadowCatcher` | `{ y, opacity, tint }` (plate mode), or `false` |
| `grade` | `{ gain: [r, g, b], saturation }` for the rendered layer, to match the plate |
| `background` | colour behind a non-plate film, or `null` for transparent |

Motion helpers (`anim`): `keys` (Catmull-Rom, linear or hold keyframes with per-key easing), `ease`,
`arc`, `smooth` (critically damped follow with an exact lag in frames), `handheld`, `lookAt`, `yaw`,
`noise`, `kelvin`, `ue.pos / ue.toUE / ue.dir / ue.quat`. A film module also receives `json(path,
fallback)` and `THREE`.

## Hybrid with Unreal Engine

```bash
hfilm ue plates film.mjs --project MyGame.uproject --map /Game/Maps/Stadium \
  --hide "Players,Ball"                 # outliner folders, actor labels or tag:Name: the film re-creates these
  --holdouts "Goals,Boards,Roof"        # what actors can pass behind, which also shadows them
  --grid M_Net --ground Pitch           # see-through net material; ground actor for the shadow catcher
  [--preset /Game/Cinematics/MRQ_Final] [--memory 9] [--name shot] [--skip-render]
```

Two headless Unreal runs, and your map is never modified:

1. **Prepare** (commandlet):
   - exports holdouts (Unreal basic shapes become exact proxies, other meshes oriented bounding boxes),
     the sun (direction, colour, temperature), the ground height, the transforms of the hidden actors
     (`hidden.json`, so the film can re-create them in place) and actor counts per folder;
   - saves a separate plates map without the hidden actors;
   - creates one CineCamera per shot, keyed every frame from the film's camera (focal length, focus and
     f-stop carried over), with a LevelSequence and camera cuts, plus a Movie Render Queue config.
2. **Render** (game-mode MRQ): plates go to `plates/<name>/`, and the provider stops Unreal if it
   exceeds `--memory` GB.

The film then reads `plates/<name>/plates.json` (see `examples/soccer-goal/film.mjs`). Change the
choreography and only `hfilm render` runs again. Change a camera and re-run `plates`.
`--skip-render` refreshes holdouts and sun without re-rendering.

**Plates from anything else:** Blender, real footage with a solved camera, or a still. Give `plate`
any numbered image sequence and make the film's camera match it.

## Measured (Apple M4, 16 GB)

| | time | memory |
|---|---|---|
| `examples/basic`: 150 frames, 24 samples, 720p | 7.6 s total | |
| `examples/soccer-goal` plates: 180 frames, Unreal stadium, empty set | ~3 min (incl. ~1 min prepare) | Unreal well under the 9 GB cap |
| `examples/soccer-goal` composite: 22 skinned players + ball, 24 samples, 720p | **28 s** (111 ms/frame) | ~2 GB (Chrome + Node) |
| for comparison, the same stadium rendered fully in Unreal with players | ~1 h for 2100 frames | 7–14 GB, editor crashes on skinned-mesh edits |

## For agents

Every command takes `--json` and prints one JSON object (`{ ok, … }` or `{ ok: false, error }`).
Errors name the field and what was expected. Through the UE agent harness the same features are the
MCP tool `ue_film` (`doctor`, `inspect`, `bake`, `render`, `plates`), with the project filled in from
the session.

`hfilm inspect model.glb` lists every clip with its duration and natural ground speed, measured
from planted-foot motion. Drive the clip rate as `speed / groundSpeed` and feet stop sliding.

## Limitations

- Lighting is matched, not simulated. The sun comes from Unreal; set the fill (`ambient` or an HDRI) and
  `exposure` by eye, using `preview` with film quality on. Plate GI does not bounce onto actors.
- Holdouts are basic shapes or oriented boxes. Arbitrary meshes occlude as their bounding box (fine for
  posts, boards and walls; coarse for organic shapes).
- Characters are whatever glTF you bring. The soccer example uses the CC0 Quaternius mannequin
  (`node examples/soccer-goal/fetch-assets.mjs`).
- Video only: add audio in your editor. The Palmier pipeline next to this repo does commentary and crowd.

MIT. Example assets: see `examples/soccer-goal/assets/LICENSE-assets.txt` (CC0).
