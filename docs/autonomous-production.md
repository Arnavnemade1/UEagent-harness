# Autonomous production: first P0 slice

The target is a single agent that constructs, evaluates, corrects and exports a ten-second
animation on a local Unreal installation. Verification develops alongside animation.
This increment supplies bounded observations, deterministic checks and guarded static
placement repairs. It does **not** establish the autonomous animation or final-render milestone.

## Evidence and intent

Keep the original creative request and constraints. Derive explicit criteria with a reason
for each one; do not substitute an easier technical check for the requested visual outcome.
For example, “the character is visible” needs a rendered-image review for occlusion and
appearance as well as a geometric camera-framing check. The harness carries the brief into
verification reports; the agent still interprets natural language and subjective quality.

`ue_observe` reads the current evaluated world without changing selection, moving cameras,
seeking Sequencer, loading assets or allocating render targets:

```json
{
  "targets": ["Cube"],
  "components": true
}
```

The result includes a session-local `id`, project/level/bridge instance, revision, capture
clock, exact actor paths, transforms, world AABBs, attachment paths, visibility flags and
coverage. Optional components include assigned meshes, up to eight material slots, light
intensity/color and explicitly requested skeletal bones in world space. An open Sequencer
provides its root playhead and rational display rate when its APIs are available.

Use `filter` (`class`, `name`, `tag`, `folder`, `selected`) for groups, or exact `targets` for
verification. Filters and targets are mutually exclusive. A missing explicit target is
reported separately from a target omitted because of a limit or an API failure.

Choose `camera: "ShotCamera"` to read the camera component's world transform and lens.
For `@viewport`, lens values are unknown unless the caller supplies calibrated
`projection: {"hfov":90,"aspect":1.7777777778}`. These values must match the actual viewport.
Framing supports centred perspective projections and reports `inside`, `intersects`,
`outside` or `unknown`. The test is conservative, uses world AABBs, and has no far clipping
plane. It does not establish occlusion, final pixel visibility, lens distortion or composition.
Orthographic and off-centre projections remain unknown.

Bounds: 32 actors by default, maximum 64, 12 components per actor, 16 requested bone names.
Evidence is capped before returning JSON; omitted actor/component coverage is explicit.
The MCP session retains at most 32 snapshots within a 1 MiB serialized-data budget. Old
snapshots are evicted; restart clears the cache. No image buffers are cached. An observation
still enumerates the loaded actor list to select matches; it does not stream unloaded World
Partition cells or describe individual instanced-mesh instances.

## Verify, repair, verify again

Use the snapshot id and explicit criteria:

```json
{
  "snapshot": "<ue_observe id>",
  "request": "Place the cube at [100,200,50] cm.",
  "criteria": [{
    "id": "cube-position",
    "type": "location",
    "actor": "Cube",
    "expected": [100,200,50],
    "tolerance_cm": 0.1,
    "reason": "Match the user's requested prop position."
  }]
}
```

Pass that object to `ue_verify`. Reports include each criterion's status, actor, property,
sampled frame and measurements. `unknown` never counts as a pass. Empty criteria, misspelled
fields, invalid limits and ambiguous labels fail validation or produce incomplete evidence.
Prefer exact paths returned by observation when labels are ambiguous.

| Type | Meaning | Parameters beyond id/type/actor/reason |
| --- | --- | --- |
| `exists` | Required actor is present | None |
| `location` | World origin within tolerance | `expected`, `tolerance_cm` |
| `distance` | Distance between actor origins | `other`, `min_cm` and/or `max_cm` |
| `separated` | World AABBs do not overlap | `other`; overlap does not prove mesh collision |
| `in_frame` | Bounds inside/intersect camera frustum | `fully_inside` defaults to true |
| `mesh_assigned` | Observed mesh components have assets | Capture with `components:true`; no asset-internal validation |
| `max_speed` | Average displacement per second | `max_cm_s`, plus top-level `previous` snapshot id |
| `rotation_step` | Shortest orientation change | `max_degrees`, plus top-level `previous` snapshot id |

Temporal checks require paused, increasing samples from the same project, level, bridge,
sequence and frame rate. They do not infer animation time from wall-clock latency. They
cannot detect motion between samples, full revolutions, evaluated bone discontinuities,
intermediate clipping, camera-cut coverage or animation-track validity. Capture additional
frames and inspect rendered output; do not treat endpoint checks as complete film validation.

For an uncoupled static location failure, pass the same object to `ue_repair`. It recomputes
the proposal from retained evidence, checks project/level/bridge identity and revision, then
checks every target's live transform and parent on the editor thread before editing. It
refuses PIE, an open Sequencer, targets with attached children, unknown criteria and coupled
constraints. It makes one undoable transaction, reads back results, and rolls back an engine
failure. It never blindly retries. It does not edit animation keys, move cameras to guessed
positions, or invent replacement assets.

After a repair, capture again and rerun **all** criteria. Use at most three attempts by
default, stop on repeated failures or no improvement, and report the remaining issue. Passing
criteria proves only those checks at those samples. Keep screenshots and subjective review
separate: `ue_screenshot` is currently a separate, unsynchronized capture.

## Roadmap and acceptance gates

| Phase | Current increment | Still required |
| --- | --- | --- |
| P0 scene intelligence | Selective spatial evidence, component summaries, conservative framing, requested bones, sampled timeline | Synchronized RGB/depth/segmentation, occlusion, instance-level detail, persistent temporal graph |
| P0 verification | Deterministic reports, explicit unknowns, static placement repair and reevaluation | Multimodal evaluator, calibrated visual rubric, precise collisions, animation-specific repairs |
| P0 animation | Read current Sequencer sample; standalone renderer startup guard | Structured sequence/track/key/camera-cut tools, animation blending/retargeting, preview/final MRQ controller |
| P1 orchestration | Existing shared editor journal and serialized mutations | Durable production plan/DAG, checkpoints, role scheduling, shot invalidation and recovery |
| P1 optimization | Bounded agent guidance and guarded placement corrections | Automated experiment comparison, convergence history, full-timeline checks and rollback ownership |
| P2 production | Existing Hybrid Film path remains available | Unified request-to-video pipeline, cross-shot consistency, resumable resource-managed renders and benchmarks |

The next acceptance fixture should create a ten-second, 30 fps sequence with one moving
subject, a directed camera and lighting. Check actor identity/placement and sampled motion,
render a small set of low-resolution frames, seed a visible defect, detect and repair it,
then export all 300 frames and validate the assembled artifact. Measure process footprint,
pressure and completion; begin with one editor or render worker and the local memory cap.
Only after this fixture passes in real Unreal should M3 be called complete or agent fleets
be expanded. M5 (30 seconds/multiple shots) and M6 (three minutes) remain future gates.

## Validation status

Automated tests exercise the real MCP and bridge code against the fake engine: selective
observations, component offsets and bone API failures, byte/count eviction, seeded placement/
framing/mesh/motion defects, frame-rate and angle wrapping, static correction, stale edits,
undo and rollback after an injected engine failure. The startup test excludes `-game`,
`-server`, commandlets and explicit disable requests from editor callback registration.

Run without launching Unreal:

```sh
node --test --test-concurrency=1 --test-timeout=120000 test/*.test.mjs
```

This increment has not been validated in a live Unreal Editor. The earlier hardware results
in the README predate these tools. No live project/plugin installation or render settings
were changed while implementing them. Reload/install and test in an isolated scene before
using automatic corrections on production content.
