# External media, quality and resource limits

Use `ue_film command: "ingest"` or the CLI to stage external models, textures, environment
maps and JSON motion/tracking data. Transfers are bounded, optionally checksum-pinned and
published without overwriting existing assets. Each import gets a `.source.json` provenance
record with its SHA-256 digest. Scripts and archives are not imported or executed.

```sh
hfilm ingest https://example.com/character.glb -o assets/character.glb --sha256 <expected-digest>
hfilm ingest /exports/lighting.exr -o assets/lighting.exr
hfilm preflight film.mjs --quality preview --memory 2 --json
hfilm render film.mjs --quality preview --memory 2 --timeout 10
hfilm render film.mjs --quality final --memory 4 --timeout 60
```

`ingest` accepts GLB/glTF, PNG/JPEG/WebP, Radiance HDR, EXR and JSON. The default transfer
limit is 256 MiB, configurable up to 1 GiB, with a 60-second transfer timeout. JSON parsing
is capped at 16 MiB. glTF dependencies must already be staged beneath the model directory;
remote and escaping references fail preflight. Draco, Meshopt and KTX2 compressed models
need conversion to an uncompressed export for this renderer. A film `.mjs` is trusted
executable scene code; use `.json` for declarative inputs.

Preflight launches no browser or Unreal process. It checks all plate paths, media headers,
glTF dependencies and bounded numeric settings, then estimates render allocations from
buffers, asset sizes, decoded image dimensions and track samples. Images with different plate
resolutions produce resampling warnings. Header checks do not prove that every pixel decodes;
the preview remains the next validation step. Embedded PNG/JPEG/WebP texture dimensions are inspected inside GLB containers without loading
the full model. Driver and geometry allocations still make memory estimates approximate. Reports
list at most 64 inputs and explicitly flag omitted entries.

Primitive materials accept `map`, `normalMap`, `roughnessMap`, `metalnessMap`, `aoMap`,
`emissiveMap` and `alphaMap`. Color and emissive maps use sRGB; the other channels remain
linear data. `normalScale: [1,-1]` supports flipping a normal map's green channel when needed.
`alphaTest` defaults to 0.5 when an alpha map is supplied. HDR and EXR environments provide
image-based lighting. Exported glTF materials retain their existing loader support.

| Profile | Maximum resolution | Samples | Maximum shadow map |
| --- | --- | --- | --- |
| preview | 960×540 | 4 | 1024 |
| balanced | 1920×1080 | 16 | 2048 |
| final | 3840×2160 | 32 | 4096 |

Profiles preserve aspect ratio, timing and frame range, and never upscale the authored
resolution. An explicit samples override takes precedence. Omitting the profile preserves
authored settings. Reports expose the selected settings and changes. Excessive estimates
fail before GPU startup; the system does not silently degrade quality or rerun a failed job.
The bake is limited to 250,000 combined camera/actor frame samples; split longer projects
into shots. Lowering samples reduces render time, not the size of accumulation buffers.

Browser workers default to at most 4 GiB, or one quarter of physical memory on smaller
machines. Unreal plate workers default to 7 GiB. Runtime sampling uses process-tree RSS;
Unreal on macOS prefers physical footprint, with an explicit RSS fallback. Critical macOS
memory pressure, exceeded process limits, timeouts or repeated monitor failures stop the
owned worker. These are sampled guards, not an OS reservation or a guarantee against a
brief spike. GPU/driver allocations may not be fully attributed to a process. A browser job
that ends before the first sample reports a null peak rather than claiming zero memory use.

MP4 encoding streams bounded chunks to disk instead of retaining the movie in RAM. The
previous output stays intact until the replacement passes container and encoded-frame-count
checks and is atomically renamed. Interrupted transfers clean up temporary outputs. MP4
metadata is written at the end of the file; playback starts after the finished file is
available. Frame exports validate their expected dimensions and propagate write failures.

Unreal plates require successful preparation and renderer exits plus every expected image,
with matching dimensions and valid container markers. Resume identity includes cameras,
frame rate, rendering options, project path and source/configuration file metadata. Changed
inputs require a new render. Resume is conservative; touching a source asset can invalidate
it. Generated outputs belonging to this job are excluded. An active editor bridge for the
same project prevents a second worker from rewriting generated assets. Job leases serialize
writers to a project or final movie path. Plate cleanup targets this job's files only.

Tests cover bounded transfers, checksums, missing middle frames, bad model dependencies,
quality planning, memory/timeout/disconnect cleanup, atomic output and resume invalidation.
Small real Chrome renders verify compositing pixels, external emissive-map color and MP4
sample counts. These changes have not been revalidated with a live Unreal plate render or
on Windows/Linux. They improve input fidelity and reliability; final realism still depends
on source assets, lighting, animation and rendered-image review.
