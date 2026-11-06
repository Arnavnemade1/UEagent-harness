import fs from 'node:fs';
import { INTENT_GUIDANCE } from './intent.mjs';
import { ObservationStore } from './scene-intelligence.mjs';
import { verifyScene } from './verification.mjs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BridgeClient, BridgeError, NOT_RUNNING_HINT } from './bridge.mjs';
import { build, findEngine, launchEditor, lastBuild, newestSourceChange } from './build.mjs';
import { findProject, projectInfo } from './discovery.mjs';
import { DiskWatcher, Journal } from './journal.mjs';
import { logSize, readLog } from './logs.mjs';
import { sleep, truncate, VERSION } from './util.mjs';

const MAX_TEXT = 60000;
const vec = (d) => ({ type: 'array', items: { type: 'number' }, description: d });
const str = (d) => ({ type: 'string', description: d });
const num = (d) => ({ type: 'number', description: d });
const bool = (d) => ({ type: 'boolean', description: d });
const obj = (d) => ({ type: 'object', description: d, additionalProperties: true });
const ro = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const rw = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const destructive = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

export const INSTRUCTIONS = `Live bridge into the user's running Unreal Editor (shared with the user and possibly other agents).
${INTENT_GUIDANCE}
- Start with ue_status: level, selection, camera, unsaved work, recent errors.
- Prefer batched structured tools (ue_edit_actors/ue_edit_assets take many ops per call). Use ue_python for anything else (full \`unreal\` API, runs on the game thread).
- Each mutating call is ONE undo step labelled with your name (Edit > Undo History); ue_undo reverts it. Batches roll back on failure.
- Verify your work: results are read back from the engine; use ue_screenshot to look, ue_logs severity=error after changes, ue_build after editing C++.
- For production tasks, preserve the creative brief and turn it into explicit criteria with reasons. Capture only relevant actors with ue_observe, then ue_verify. Unknown evidence is not a pass. Check rendered images separately for appearance and occlusion; compare paused Sequencer samples for motion. Reobserve and reverify after repairs, with a fixed iteration budget (default 3).
- Results may end with an [engine sync] digest of what the user/other agents changed since your last call. Respect their edits; don't undo them.
Units: centimetres, degrees. rotation = [pitch, yaw, roll]. Asset paths like /Game/Folder/Asset. Actor targets: label, wildcard (Wall_*), @selected, path, or $N (actors from op N of the same batch).`;

const TOOLS = [
  {
    name: 'ue_status',
    title: 'Editor status',
    description: 'Snapshot of the live editor: project, engine, open level, selected actors/assets, viewport camera, play-in-editor state, unsaved packages, new log errors since you last looked, and whether C++ needs a rebuild. Works (with less detail) when the editor is not running.',
    inputSchema: { type: 'object', properties: {} },
    annotations: ro,
  },
  {
    name: 'ue_python',
    title: 'Run Python in the editor',
    description: 'Execute Python inside the Unreal Editor (game thread, full `unreal` module) for anything the structured tools do not cover; prefer ue_find_actors/ue_inspect for reading state (faster, verified). Variables persist between calls in your session. The value of the last expression is returned (like a REPL) plus anything printed. Helpers: actors(pattern), actor(label), selected(), asset(path), vec(x,y,z), rot(pitch,yaw,roll), to_json(v). The whole call is one undo step. Long-running loops are aborted after timeout_s.',
    inputSchema: { type: 'object', properties: { code: str('Python source. Multi-line OK.'), timeout_s: num('Abort after this many seconds (default 120, 0 = no limit).') }, required: ['code'] },
    annotations: destructive,
  },
  {
    name: 'ue_console',
    title: 'Console commands',
    description: 'Run editor console commands (e.g. "stat fps", "r.ScreenPercentage 50", "viewmode wireframe"). Output goes to the log; read it with ue_logs.',
    inputSchema: { type: 'object', properties: { commands: { type: 'array', items: { type: 'string' } }, pie: bool('Run in the play-in-editor world instead of the editor world.') }, required: ['commands'] },
    annotations: destructive,
  },
  {
    name: 'ue_find_actors',
    title: 'Find actors',
    description: 'List actors in the open level with transforms. Filters combine. Returns label, class, location [x,y,z], rotation [pitch,yaw,roll] and scale when non-default. detail=true adds components, meshes, materials, bounds and attachment.',
    inputSchema: {
      type: 'object',
      properties: {
        name: str('Label/name filter; wildcards * ? allowed, plain text = substring.'),
        class: str('Class filter, e.g. StaticMeshActor, PointLight, or a blueprint path /Game/BP_Door.'),
        tag: str('Actor tag.'), folder: str('World Outliner folder prefix.'),
        selected: bool('Only the user\'s current selection.'),
        near: vec('Point [x,y,z]; sorts by distance and filters by radius.'),
        near_actor: str('Use this actor\'s location as the "near" point.'),
        radius: num('Radius in cm for near/near_actor (default 1000).'),
        limit: num('Max actors returned (default 50).'), detail: bool('Include components/materials/bounds.'),
      },
    },
    annotations: ro,
  },
  {
    name: 'ue_observe',
    title: 'Observe scene evidence',
    description: 'Read a bounded scene snapshot: exact actor identities, transforms, world bounds, attachments, optional meshes/materials/lights/requested bone poses, camera framing and current Sequencer playhead. No asset loads, rendering or timeline edits. Returns a session snapshot id for ue_verify. Frustum inclusion does not establish occlusion or visual quality. Default viewport FOV is unknown; choose a camera actor or supply calibrated viewport projection. At most 64 actors, 12 components per actor, 16 requested bones; partial coverage is explicit. Cache retains up to 32 snapshots within 1 MiB.',
    inputSchema: { type: 'object', properties: {
      targets: { type: 'array', maxItems: 64, items: str('Exact actor path or unique label. No wildcards.') },
      filter: obj('Alternative to targets: class, name, tag, folder, selected filters.'),
      limit: { type: 'integer', minimum: 1, maximum: 64, default: 32 },
      components: bool('Include up to 12 component summaries per actor (default false).'),
      bones: { type: 'array', maxItems: 16, items: str('Specific bone name; world-space evaluated pose, not reference pose.') },
      camera: str('Camera actor path/label, or @viewport (default). Does not move the viewport.'),
      projection: obj('For @viewport only: {hfov: horizontal degrees, aspect: width/height}. Caller-calibrated; no assumed lens.'),
    } },
    annotations: ro,
  },
  {
    name: 'ue_verify',
    title: 'Verify scene criteria',
    description: 'Check captured scene evidence against explicit criteria derived from the original request. Each check reports pass/fail/unknown with exact actor paths, sampled frame, property and measurements. Supports exists, location, distance, separated (AABB only), in_frame (no occlusion), mesh_assigned, max_speed and rotation_step. Temporal checks require two paused, increasing samples of the same Sequencer timeline. Returns guarded location repair proposals only for uncoupled static editor positions. No rendering, evaluation model or editor mutation. A report passing these criteria does not approve visual quality or the full animation.',
    inputSchema: { type: 'object', properties: {
      snapshot: str('Current ue_observe snapshot id from this session.'),
      previous: str('Optional earlier observation id for temporal checks.'),
      request: str('Original creative brief, including constraints (max 4000 characters).'),
      criteria: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'object', properties: {
        id: str('Unique check identifier.'), reason: str('How this criterion serves the original request.'),
        type: { type: 'string', enum: ['exists', 'location', 'distance', 'separated', 'in_frame', 'mesh_assigned', 'max_speed', 'rotation_step'] },
        actor: str('Exact actor path or unique label; no wildcards.'), other: str('Second actor for distance/separated.'),
        expected: vec('Required world location [x,y,z] in cm for location.'), tolerance_cm: num('Required nonnegative location tolerance.'),
        min_cm: num('Minimum distance between actor origins.'), max_cm: num('Maximum distance between actor origins.'),
        fully_inside: bool('in_frame: require whole bounds inside frame (default true).'),
        max_cm_s: num('Maximum average speed between samples.'), max_degrees: num('Maximum orientation change between samples (0..180).'),
      }, required: ['id', 'reason', 'type', 'actor'], additionalProperties: false } },
    }, required: ['snapshot', 'request', 'criteria'], additionalProperties: false },
    annotations: ro,
  },
  {
    name: 'ue_repair',
    title: 'Repair verified static locations',
    description: 'Apply only deterministic static-location repairs derived from ue_verify criteria, as one undoable batch. Pass the same snapshot, original request and criteria. Recomputes the plan from retained evidence; refuses unknown checks, coupled constraints, active Sequencer/PIE, changed level/revision/transforms or targets with attached children. Does not repair animation keys or guess compositions. No automatic retry. Reobserve and reverify all criteria afterwards; use a fixed iteration budget.',
    inputSchema: { type: 'object', properties: {
      snapshot: str('ue_observe snapshot used by the verification report.'),
      request: str('Same original creative request passed to ue_verify.'),
      criteria: { type: 'array', minItems: 1, maxItems: 16, items: obj('Same criteria objects as ue_verify; only uncoupled failed location checks can be repaired.') },
    }, required: ['snapshot', 'request', 'criteria'], additionalProperties: false },
    annotations: rw,
  },
  {
    name: 'ue_edit_actors',
    title: 'Edit actors (batched)',
    description: 'Apply a batch of actor operations as ONE undo step; if any op fails the whole batch is rolled back (atomic=true). Every result is read back from the engine. Ops:\n'
      + '- spawn {class|asset|mesh, label, location, rotation, scale, properties, material, folder, tags, attach_to}. mesh accepts cube/sphere/cylinder/cone/plane or a StaticMesh path.\n'
      + '- set {target, location|offset, rotation|rotate_by, scale, label, mesh, material|materials, properties, folder, tags, hidden}\n'
      + '- delete {target} · duplicate {target, count, offset, label} · select {target, add} · deselect {} · attach {target, parent, socket} · detach {target}\n'
      + 'properties: {"path": value} where path may go through components and structs, e.g. {"LightComponent.intensity": 5000, "mobility": "Movable", "StaticMeshComponent.cast_shadow": false}. target: label, wildcard, @selected, actor path, or "$N" for actors produced by op N.',
    inputSchema: {
      type: 'object',
      properties: {
        ops: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['spawn', 'set', 'delete', 'duplicate', 'select', 'deselect', 'attach', 'detach'] },
              target: str('Actor label, wildcard, @selected, path or $N.'),
              class: str('Actor class for spawn (PointLight, CameraActor, /Game/BP_X).'),
              asset: str('Asset to place (StaticMesh, Blueprint, ...).'),
              mesh: str('Static mesh path or basic shape name.'),
              label: str('Outliner label.'),
              location: vec('[x,y,z] cm'), rotation: vec('[pitch,yaw,roll] degrees'), scale: vec('[x,y,z] (or one number)'),
              offset: vec('Relative move [x,y,z] (set) or spacing (duplicate).'), rotate_by: vec('Relative rotation [pitch,yaw,roll].'),
              material: str('Material path for slot 0.'), materials: { type: 'array', items: { type: 'string' } },
              properties: obj('{"Component.property": value}'),
              folder: str('Outliner folder.'), tags: { type: 'array', items: { type: 'string' } },
              attach_to: str('Parent actor (spawn).'), parent: str('Parent actor (attach).'), socket: str('Socket name.'),
              count: num('Copies (duplicate).'), add: bool('Add to selection instead of replacing it.'), hidden: bool('Hide in editor.'),
            },
            required: ['op'],
          },
        },
        atomic: bool('Roll back the whole batch if any op fails (default true).'),
      },
      required: ['ops'],
    },
    annotations: destructive,
  },
  {
    name: 'ue_inspect',
    title: 'Inspect object',
    description: 'Read editable properties of an actor, component, asset or class defaults. With property="a.b.c" returns a single value. Use filter to narrow long property lists. Shows the class chain and (for actors/blueprints) components.',
    inputSchema: {
      type: 'object',
      properties: {
        target: str('Actor label/path, asset path (/Game/...), or class name (PointLight) for class defaults.'),
        component: str('Inspect this component of the actor instead.'),
        property: str('Return just this property path.'),
        filter: str('Substring filter on property names/docs.'), limit: num('Max properties (default 60).'),
      },
      required: ['target'],
    },
    annotations: ro,
  },
  {
    name: 'ue_find_assets',
    title: 'Find assets',
    description: 'Search the asset registry (fast, no loading). Filter by folder, class (StaticMesh, Material, Texture2D, Blueprint, SoundWave, World, ...) and name. include=["dependencies","referencers"] for up to 25 results.',
    inputSchema: {
      type: 'object',
      properties: {
        path: str('Folder (default /Game). /Engine/BasicShapes has primitive meshes.'), class: str('Asset class (subclasses included).'),
        name: str('Name filter; wildcards allowed.'), recursive: bool('Search subfolders (default true).'), limit: num('Default 100.'),
        include: { type: 'array', items: { type: 'string', enum: ['dependencies', 'referencers'] } },
      },
    },
    annotations: ro,
  },
  {
    name: 'ue_edit_assets',
    title: 'Edit assets (batched)',
    description: 'Create and modify assets; saved to disk by default (save:false to skip). Ops:\n'
      + '- create {type, path, parent, properties, parameters, if_exists}: type = Material | MaterialInstance (parent=material, parameters={scalar,vector,texture,switch}) | Blueprint (parent=class) | WidgetBlueprint | Level | DataAsset | DataTable (parent=row struct) | Folder | Enum | Struct | ... path = full asset path /Game/Folder/Name.\n'
      + '- pbr_material {path, base_color, metallic, roughness, specular, emissive, emissive_strength, normal, opacity, two_sided} (+ *_texture variants taking texture paths): builds a working material graph.\n'
      + '- material_params {path, scalar, vector, texture, switch} on a material instance.\n'
      + '- set {path, properties} · duplicate {source, dest} · rename {source, dest} (move) · delete {path, force} (refuses if referenced unless force) · open {path} (opens its editor for the user) · save {path} · reimport {path}.',
    inputSchema: {
      type: 'object',
      properties: {
        ops: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['create', 'pbr_material', 'material_params', 'set', 'duplicate', 'rename', 'delete', 'open', 'save', 'reimport'] },
              type: str('Asset type for create.'), path: str('/Game/Folder/Name'), source: str('Source asset path.'), dest: str('Destination asset path.'),
              parent: str('Parent material/class/struct.'), properties: obj('{"property.path": value}'), parameters: obj('Material instance parameters.'),
              base_color: vec('Color [r,g,b] 0-1.'), base_color_texture: str('Texture path for base color.'),
              emissive: vec('Emissive color [r,g,b].'), emissive_texture: str('Emissive texture path.'), emissive_strength: num('Multiplier for emissive color.'),
              metallic: num('0-1'), metallic_texture: str('Texture path.'), roughness: num('0-1'), roughness_texture: str('Texture path.'),
              specular: num('0-1'), opacity: num('0-1 (makes the material translucent)'), opacity_texture: str('Texture path.'),
              normal: str('Normal map texture path.'), ambient_occlusion_texture: str('AO texture path.'),
              two_sided: bool('Two-sided material.'),
              scalar: obj('{name: number}'), vector: obj('{name: [r,g,b,a]}'), texture: obj('{name: texture path}'), switch: obj('{name: bool}'),
              if_exists: { type: 'string', enum: ['error', 'skip', 'replace'] }, force: bool('Delete even if referenced.'), save: bool('Save after the op (default true).'),
            },
            required: ['op'],
          },
        },
      },
      required: ['ops'],
    },
    annotations: destructive,
  },
  {
    name: 'ue_blueprint',
    title: 'Blueprint',
    description: 'Create/edit a Blueprint class and compile it. ops: add_component {class, name, parent, properties}, add_variable {name, type (bool|int|float|string|name|text|vector|rotator|transform|color|<Class>|<type>[]), default}, set_default {property, value} (class defaults), component_property {component, property, value}, compile. Compiles automatically when needed and reports status plus the component tree. For graph logic, write C++ or use ue_python.',
    inputSchema: {
      type: 'object',
      properties: {
        path: str('/Game/Folder/BP_Name'),
        create: obj('Create if missing: {"parent": "Actor" | "Pawn" | "Character" | class path}'),
        ops: { type: 'array', items: { type: 'object', properties: { op: { type: 'string', enum: ['add_component', 'add_variable', 'set_default', 'component_property', 'compile'] } }, required: ['op'], additionalProperties: true } },
        save: bool('Save after editing (default true).'),
      },
      required: ['path'],
    },
    annotations: rw,
  },
  {
    name: 'ue_import',
    title: 'Import files',
    description: 'Import files from disk into the project as assets (fbx/obj/gltf/glb/usd, png/jpg/tga/exr/hdr/psd, wav/ogg/flac, ttf/otf). Folders are imported recursively. .uasset/.umap files are copied straight into Content and registered. Returns the created asset paths.',
    inputSchema: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'string' }, description: 'Absolute file or folder paths.' },
        destination: str('Content folder (default /Game/Imported).'),
        replace: bool('Overwrite existing assets (default true).'), save: bool('Save imported assets (default true).'),
        options: obj('FBX options: {skeletal, import_materials, import_textures, import_animations, combine_meshes, name}'),
      },
      required: ['files'],
    },
    annotations: destructive,
  },
  {
    name: 'ue_export',
    title: 'Export assets',
    description: 'Export assets to files on disk (textures→png, meshes→fbx, sounds→wav, levels→t3d; override with format).',
    inputSchema: { type: 'object', properties: { assets: { type: 'array', items: { type: 'string' } }, directory: str('Output folder (absolute).'), format: str('File extension, e.g. obj, png, fbx.') }, required: ['assets', 'directory'] },
    annotations: rw,
  },
  {
    name: 'ue_screenshot',
    title: 'Viewport screenshot',
    description: 'Capture the active level viewport (or the game view during play-in-editor) and return the image so you can see the result of your changes. Optionally frame actors first (target) or set the camera. save_to copies the PNG to a path.',
    inputSchema: {
      type: 'object',
      properties: {
        width: num('Default 1280.'), height: num('Default 720.'),
        target: str('Frame these actors first (label, wildcard, @selected).'),
        camera: obj('{"location": [x,y,z], "rotation": [pitch,yaw,roll]}'),
        pitch: num('Camera pitch when framing a target (default -25).'), yaw: num('Camera yaw when framing.'), distance: num('Camera distance when framing.'),
        save_to: str('Also copy the PNG to this absolute path.'),
      },
    },
    annotations: ro,
  },
  {
    name: 'ue_editor',
    title: 'Editor UI',
    description: 'Drive the editor UI for the user. actions: camera {location, rotation} (get/set viewport camera) · focus {target, pitch, yaw, distance} (select + frame) · open_asset {path} · close_asset_editors · browse {path} (show in Content Browser) · open_level {path} · new_level {path} · save_level · view_mode {mode: lit|unlit|wireframe|detail_lighting|lighting_only|shader_complexity|collision|path_tracing} · game_view {enabled} · notify {message} (on-screen + log message to the user).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['camera', 'focus', 'open_asset', 'close_asset_editors', 'browse', 'open_level', 'new_level', 'save_level', 'view_mode', 'game_view', 'notify'] },
        target: str('Actors for focus.'), path: str('Asset/level path.'), location: vec('[x,y,z]'), rotation: vec('[pitch,yaw,roll]'),
        mode: str('View mode.'), enabled: bool('For game_view.'), message: str('For notify.'),
        pitch: num('Focus pitch.'), yaw: num('Focus yaw.'), distance: num('Focus distance.'),
        save_first: bool('open_level: save unsaved work first (default true).'),
      },
      required: ['action'],
    },
    annotations: rw,
  },
  {
    name: 'ue_play',
    title: 'Play in editor',
    description: 'Start/stop Play-In-Editor (or Simulate) to test gameplay. With duration_s it plays for that long, optionally grabs a screenshot mid-play, stops, and returns errors/warnings logged during the run.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'simulate', 'stop', 'status'] },
        duration_s: num('Play this long then stop (start/simulate).'),
        screenshot: bool('Capture the game view before stopping (needs duration_s).'),
      },
      required: ['action'],
    },
    annotations: rw,
  },
  {
    name: 'ue_logs',
    title: 'Editor log',
    description: 'Read the editor Output Log. Defaults to warnings+errors. since="last" returns only lines newer than your previous ue_logs call (use after making changes to check for new errors).',
    inputSchema: {
      type: 'object',
      properties: {
        severity: { type: 'string', enum: ['error', 'warning', 'all'] },
        category: str('Log category substring, e.g. Blueprint, PIE, Python, LiveCoding.'),
        contains: str('Text filter.'), lines: num('Max lines (default 60).'),
        since: str('"last" (only lines newer than your previous ue_logs call) or a cursor number from a previous result.'),
      },
    },
    annotations: ro,
  },
  {
    name: 'ue_sync',
    title: 'Sync / watch changes',
    description: 'Journal of engine changes (by the user, other agents and on disk) since a revision. wait_s > 0 long-polls until something changes — use it to watch what the user does next ("select the door I mean").',
    inputSchema: { type: 'object', properties: { since: num('Revision (default: your last sync).'), wait_s: num('Wait up to this long for a change (max 120).') } },
    annotations: ro,
  },
  {
    name: 'ue_undo',
    title: 'Undo / redo',
    description: 'Undo or redo editor transactions. Each agent call is a single labelled transaction. Note the undo stack is shared with the user: check ue_status.last_agent_transaction / the sync digest so you only undo your own work.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['undo', 'redo'] }, count: num('Default 1.') } },
    annotations: destructive,
  },
  {
    name: 'ue_save',
    title: 'Save',
    description: 'Save unsaved work. Default saves all dirty levels and assets (and reports what was saved and what is still unsaved). paths saves specific assets; level_only saves just the current level.',
    inputSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } }, level_only: bool('Only the current level.') } },
    annotations: rw,
  },
  {
    name: 'ue_build',
    title: 'Compile C++',
    description: 'Compile the project\'s C++ and return structured diagnostics (file, line, message). Windows + running editor: Live Coding. Otherwise UnrealBuildTool; on macOS/Linux a running editor must be restarted to load new code — pass restart_editor:true to save, close, build, relaunch and reconnect automatically. Call after editing .h/.cpp/.Build.cs files.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['auto', 'ubt', 'livecoding'] },
        restart_editor: bool('Allow saving + restarting the running editor (macOS/Linux).'),
        configuration: { type: 'string', enum: ['Development', 'DebugGame', 'Debug'] },
      },
    },
    annotations: destructive,
  },
  {
    name: 'ue_film',
    title: 'Hybrid Film (UE plates + three.js)',
    description: 'Film-quality video without a heavy Unreal render: Unreal renders the static world once ("plates": empty set from the film\'s cameras, plus holdouts, sun and the transforms of hidden actors), and three.js renders the moving actors in headless Chrome with motion blur, depth of field and soft shadows, composited over the plates. A film is a JS module (film.mjs) describing cameras/actors/motion. Commands: doctor; inspect {model} (clip ground speeds); bake/render {film}; plates {film, map, hide, holdouts, grid, ground}. plates runs a separate headless Unreal (writes /Game/HFilm assets, never modifies the source map) and takes minutes; render is seconds to minutes. See film/README.md.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['doctor', 'inspect', 'bake', 'render', 'plates'] },
        film: str('Path to film.mjs / film.json (bake, render, plates).'),
        model: str('Path to a .glb (inspect).'),
        map: str('plates: Unreal map path, e.g. /Game/Maps/Level.'),
        hide: str('plates: comma list of outliner folders / actor labels / tag:Name to remove from the plates (the film re-creates them).'),
        holdouts: str('plates: comma list of folders/labels whose geometry the new actors can pass behind (also casts shadows on them).'),
        grid: str('plates: material name whose meshes are see-through grids (e.g. a net material).'),
        ground: str('plates: actor label whose top is the ground plane for the shadow catcher.'),
        name: str('plates: shot name (default: film file name).'),
        preset: str('plates: optional Movie Render Queue config asset to start from.'),
        frames: str('render/bake: start:end (end exclusive).'),
        samples: num('render: sub-frame samples per frame (default from the film, usually 16-32).'),
        out: str('render: output .mp4 path.'),
        resume: { type: 'boolean', description: 'plates: continue an interrupted plate render from the last plate on disk (cameras must be unchanged).' },
      },
      required: ['command'],
    },
    annotations: rw,
  },
  {
    name: 'ue_launch',
    title: 'Launch editor',
    description: 'Start Unreal Editor for this project if it is not running and wait until the bridge is connected.',
    inputSchema: { type: 'object', properties: { wait_s: num('Max seconds to wait (default 240).') } },
    annotations: rw,
  },
];

// ------------------------------------------------------------------ session

export class Session {
  constructor({ project, clientName = 'agent' } = {}) {
    this.project = findProject({ explicit: project });
    this.clientName = clientName;
    this.bridge = new BridgeClient({ project: this.project, clientName, subscribe: true });
    this.journal = new Journal();
    this.observations = new ObservationStore();
    this.disk = new DiskWatcher(this.journal);
    this.cursorRev = 0;
    this.cursorT = Date.now();
    this.syncRev = 0;
    this.logCursor = null;
    this.statusLogCursor = null;
    this.bridge.on('change', (ev) => this.journal.add(ev));
    this.bridge.on('restart', () => { this.journal.reset(); this.observations.clear(); this.cursorRev = 0; this.syncRev = 0; });
    this.bridge.on('connect', (info) => {
      if (!this.project && info.project) this.project = info.project;
      if (this.cursorRev > (info.rev || 0)) this.cursorRev = 0;
      this._watchDisk();
    });
    this._watchDisk();
  }

  setClientName(name) { this.clientName = name; this.bridge.clientName = name; }

  start() { this.bridge.startBackground(); }

  _watchDisk() {
    if (this.project && !this.disk.watchers.length) this.disk.start(path.dirname(this.project));
  }

  close() { this.disk.stop(); this.observations.clear(); this.bridge.close(); }

  digest() {
    const d = this.journal.digest({ sinceRev: this.cursorRev, sinceT: this.cursorT, selfCid: this.bridge.info?.client_id, rev: this.bridge.rev });
    this.cursorRev = this.bridge.rev;
    this.cursorT = Date.now();
    return d;
  }

  async call(fn, args, timeout) {
    const r = await this.bridge.call(fn, args, { timeout });
    return r;
  }
}

// ------------------------------------------------------------------ helpers

function jsonText(v) { return JSON.stringify(v); }

function ok(session, result, { warnings, extra = [], digest = true } = {}) {
  let text = typeof result === 'string' ? result : jsonText(result);
  if (warnings?.length) text += `\nwarnings: ${warnings.join('; ')}`;
  text = truncate(text, MAX_TEXT);
  const content = [{ type: 'text', text }, ...extra];
  if (digest) {
    const d = session.digest();
    if (d) content.push({ type: 'text', text: d });
  }
  return { content };
}

function fail(session, err) {
  const code = err.code || 'error';
  const data = { ...(err.data || {}) };
  delete data.warnings;
  let text = `${code}: ${err.message}`;
  if (Object.keys(data).length) text += `\n${truncate(JSON.stringify(data), 8000)}`;
  if (err.data?.warnings?.length) text += `\nwarnings: ${err.data.warnings.join('; ')}`;
  const content = [{ type: 'text', text }];
  if (session?.bridge?.connected) {
    const d = session.digest();
    if (d) content.push({ type: 'text', text: d });
  }
  return { isError: true, content };
}

async function bridgeTool(session, fn, args, timeout = 60000) {
  const r = await session.call(fn, args, timeout);
  return ok(session, r.result, { warnings: r.warnings });
}

function needProject(session) {
  if (!session.project) {
    throw new BridgeError('no_project', 'No Unreal project found. Run the agent from the project folder, set UE_AGENT_PROJECT, or start the editor.');
  }
  return session.project;
}

function cppStatus(session) {
  const info = projectInfo(session.project);
  if (!info?.hasSource) return null;
  const src = newestSourceChange(info.dir);
  const lb = lastBuild(info.dir);
  const editorStarted = (session.bridge.info?.started || 0) * 1000;
  const baseline = Math.max(lb?.ok ? lb.time : 0, editorStarted);
  if (src.time && baseline && src.time > baseline) {
    return { needs_build: true, newest_change: path.relative(info.dir, src.file), hint: 'C++ changed since the editor loaded it; run ue_build' };
  }
  return lb ? { needs_build: false, last_build: { ok: lb.ok, at: new Date(lb.time).toISOString() } } : { needs_build: false };
}

// ------------------------------------------------------------------ handlers

const HANDLERS = {
  async ue_status(s) {
    const project = s.project ? projectInfo(s.project) : null;
    let st;
    try {
      st = (await s.call('status', {}, 15000)).result;
    } catch (e) {
      if (!['editor_not_running', 'connect_failed', 'connect_timeout', 'disconnected'].includes(e.code)) throw e;
      return ok(s, {
        editor: 'not running',
        project: project?.file || null,
        engine_association: project?.engineAssociation,
        hint: NOT_RUNNING_HINT,
        cpp: project ? cppStatus(s) : undefined,
        harness: VERSION,
      }, { digest: false });
    }
    const out = { editor: 'connected', harness: VERSION, ...st };
    if (s.project) {
      const since = s.statusLogCursor ?? Math.max(0, logSize(s.project) - 65536);
      const errs = readLog(s.project, { since, severity: 'error', lines: 5 });
      s.statusLogCursor = errs.cursor;
      if (errs.matched) out.new_log_errors = { count: errs.matched, latest: errs.lines };
      const cpp = cppStatus(s);
      if (cpp) out.cpp = cpp;
    }
    return ok(s, out);
  },

  ue_python: (s, a) => bridgeTool(s, 'python', { code: a.code, timeout: a.timeout_s ?? 120 }, ((a.timeout_s || 120) + 10) * 1000),
  ue_console: (s, a) => bridgeTool(s, 'console', { commands: a.commands, pie: a.pie }),

  ue_find_actors(s, a) {
    const args = { ...a };
    if (a.near_actor) { args.near = a.near_actor; delete args.near_actor; }
    return bridgeTool(s, 'find_actors', args);
  },

  ue_edit_actors: (s, a) => bridgeTool(s, 'edit_actors', a, 120000),
  async ue_observe(s, a) {
    const r = await s.call('observe', a, 30000);
    return ok(s, s.observations.add(r.result), { warnings: r.warnings });
  },
  ue_verify(s, a) {
    if (Object.keys(a).some((key) => !['snapshot', 'previous', 'request', 'criteria'].includes(key))) throw new BridgeError('bad_args', 'Unknown verification argument.');
    const current = s.observations.get(a.snapshot);
    const previous = a.previous === undefined ? null : s.observations.get(a.previous);
    return ok(s, verifyScene(current, previous, a));
  },
  async ue_repair(s, a) {
    if (Object.keys(a).some((key) => !['snapshot', 'request', 'criteria'].includes(key))) throw new BridgeError('bad_args', 'Unknown repair argument.');
    const current = s.observations.get(a.snapshot);
    const report = verifyScene(current, null, a);
    const failures = report.checks.filter((check) => check.status === 'fail');
    if (!failures.length || report.counts.unknown || failures.some((check) => !check.repair)) {
      throw new BridgeError('repair_unavailable', 'Only uncoupled failed static-location criteria with complete evidence can be repaired. Resolve missing evidence or plan other edits explicitly.');
    }
    const result = await s.call('repair_locations', { project: current.project, level: current.level, bridge_instance: current.bridge_instance, revision: current.revision, repairs: failures.map((check) => check.repair) }, 60000);
    return ok(s, result.result, { warnings: result.warnings });
  },
  ue_inspect: (s, a) => bridgeTool(s, 'inspect', a),
  ue_find_assets: (s, a) => bridgeTool(s, 'find_assets', a),
  ue_edit_assets(s, a) {
    // *_texture fields are a schema convenience; the bridge accepts a texture path in the base field
    const ops = (a.ops || []).map((o) => {
      const c = { ...o };
      for (const k of Object.keys(o)) {
        if (k.endsWith('_texture') && o[k]) { const base = k.slice(0, -8); if (c[base] === undefined) c[base] = o[k]; delete c[k]; }
      }
      return c;
    });
    return bridgeTool(s, 'edit_assets', { ...a, ops }, 300000);
  },
  ue_blueprint: (s, a) => bridgeTool(s, 'blueprint', a, 300000),
  ue_import: (s, a) => bridgeTool(s, 'import_files', a, 1800000),
  ue_export: (s, a) => bridgeTool(s, 'export_assets', a, 900000),

  async ue_screenshot(s, a) {
    const { save_to: saveTo, ...args } = a;
    const r = await s.call('screenshot', args, 45000);
    const shot = r.result;
    const data = fs.readFileSync(shot.path);
    if (saveTo) {
      fs.mkdirSync(path.dirname(path.resolve(saveTo)), { recursive: true });
      fs.copyFileSync(shot.path, path.resolve(saveTo));
      shot.saved_to = path.resolve(saveTo);
    }
    const extra = [];
    if (data.length <= 8 * 1024 * 1024) extra.push({ type: 'image', data: data.toString('base64'), mimeType: 'image/png' });
    else shot.note = 'image too large to inline; open the file path instead';
    return ok(s, shot, { warnings: r.warnings, extra });
  },

  ue_editor: (s, a) => bridgeTool(s, 'editor', a, 120000),

  async ue_play(s, a) {
    const startLog = s.project ? logSize(s.project) : 0;
    const dur = Number(a.duration_s || 0);
    let result;
    let extra = [];
    if ((a.action === 'start' || a.action === 'simulate') && dur > 0 && a.screenshot) {
      await s.call('play', { action: a.action }, 90000);
      await sleep(Math.max(0, dur * 1000 - 1500));
      try {
        const shot = (await s.call('screenshot', { width: 1280, height: 720 }, 45000)).result;
        extra = [{ type: 'image', data: fs.readFileSync(shot.path).toString('base64'), mimeType: 'image/png' }];
      } catch (e) { extra = [{ type: 'text', text: `screenshot failed: ${e.message}` }]; }
      result = (await s.call('play', { action: 'stop' }, 60000)).result;
    } else {
      result = (await s.call('play', { action: a.action, duration: dur }, (dur + 120) * 1000)).result;
    }
    if (s.project && a.action !== 'status') {
      const errs = readLog(s.project, { since: startLog, severity: 'warning', lines: 30 });
      result.log_during_play = { errors_and_warnings: errs.matched, lines: errs.lines };
    }
    return ok(s, result, { extra });
  },

  ue_logs(s, a) {
    const project = needProject(s);
    let since;
    if (a.since === 'last') since = s.logCursor ?? undefined;
    else if (a.since !== undefined && a.since !== null && a.since !== '') since = Number(a.since);
    const r = readLog(project, { since, severity: a.severity || 'warning', category: a.category, contains: a.contains, lines: a.lines || 60 });
    s.logCursor = r.cursor;
    return ok(s, r);
  },

  async ue_sync(s, a) {
    const since = a.since ?? s.syncRev;
    try { await s.bridge.connect(); } catch (e) { if (!s.journal.disk.length) throw e; }
    const wait = Math.min(Number(a.wait_s || 0), 120) * 1000;
    let res = s.bridge.connected ? (await s.call('changes', { since })).result : { rev: s.bridge.rev, changes: [] };
    if (!res.changes.length && wait > 0) {
      await s.journal.waitForChange(wait);
      if (s.bridge.connected) res = (await s.call('changes', { since })).result;
    }
    const self = s.bridge.info?.client_id;
    const changes = res.changes.map((e) => ({ rev: e.rev, kind: e.kind, by: e.cid === self ? 'you' : e.by, ...e.data }));
    s.syncRev = res.rev;
    const disk = s.journal.diskSince(s.syncT || 0).map((d) => `${d.area}: ${d.path}`);
    s.syncT = Date.now();
    return ok(s, { rev: res.rev, changes, truncated: res.truncated || undefined, disk: disk.length ? disk : undefined }, { digest: false });
  },

  ue_undo: (s, a) => bridgeTool(s, 'undo', { action: a.action || 'undo', count: a.count || 1 }),
  ue_save: (s, a) => bridgeTool(s, 'save', a, 300000),

  async ue_build(s, a, ctx) {
    const project = needProject(s);
    const res = await build({
      projectFile: project, bridge: s.bridge, mode: a.mode || 'auto', restartEditor: !!a.restart_editor,
      config: a.configuration || 'Development', onProgress: ctx.progress, signal: ctx.signal,
    });
    if (!res.ok) return { isError: true, content: [{ type: 'text', text: truncate(JSON.stringify(res), MAX_TEXT) }] };
    return ok(s, res);
  },

  async ue_film(s, a) {
    const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'film', 'bin', 'hfilm.mjs');
    if (!fs.existsSync(cli)) throw new BridgeError('film_missing', 'Hybrid Film is not installed next to the harness: expected film/bin/hfilm.mjs (run npm install in film/).');
    const need = (k) => { if (!a[k]) throw new BridgeError('bad_args', `ue_film ${a.command}: "${k}" is required`); return a[k]; };
    let args;
    switch (a.command) {
      case 'doctor': args = ['doctor']; break;
      case 'inspect': args = ['inspect', need('model')]; break;
      case 'bake': args = ['bake', need('film')]; break;
      case 'render': args = ['render', need('film')]; break;
      case 'plates': args = ['ue', 'plates', need('film'), '--project', needProject(s), '--map', need('map')]; break;
      default: throw new BridgeError('bad_args', `unknown ue_film command ${a.command}`);
    }
    for (const k of ['hide', 'holdouts', 'grid', 'ground', 'name', 'preset', 'frames', 'samples']) if (a[k] != null && a.command !== 'doctor') args.push(`--${k}`, String(a[k]));
    if (a.out) args.push('-o', a.out);
    if (a.resume && a.command === 'plates') args.push('--resume');
    args.push('--json');
    const timeout = a.command === 'plates' ? 3 * 3600e3 : a.command === 'render' ? 3600e3 : 300e3;
    const res = await new Promise((resolve) => execFile(process.execPath, [cli, ...args], { timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ err, stdout, stderr })));
    const line = String(res.stdout).trim().split('\n').filter((l) => l.startsWith('{')).pop();
    let out;
    try { out = JSON.parse(line); } catch { out = { ok: false, error: (res.err?.message || 'no output') + `\n${String(res.stderr).slice(-2000)}` }; }
    if (!out.ok) throw new BridgeError('film_failed', out.error || 'hfilm failed');
    return ok(s, out, { digest: false });
  },

  async ue_launch(s, a, ctx) {
    const project = needProject(s);
    try {
      const info = await s.bridge.connect();
      return ok(s, { already_running: true, pid: info.pid, engine: info.engine_version });
    } catch { /* launch below */ }
    const engine = findEngine(project);
    if (!engine) throw new BridgeError('engine_not_found', `No Unreal Engine install found for ${project}. Install the engine version in EngineAssociation or set UE_ENGINE_DIR.`);
    launchEditor(project, engine);
    ctx.progress?.('editor launching…');
    const info = await s.bridge.waitForEditor((a.wait_s || 240) * 1000, { onTick: () => ctx.progress?.('waiting for the editor bridge…') });
    return ok(s, { launched: true, pid: info.pid, engine: info.engine_version, project: info.project });
  },
};

export function listTools() { return TOOLS; }

export async function callTool(session, name, args = {}, ctx = {}) {
  const h = Object.hasOwn(HANDLERS, name) ? HANDLERS[name] : null;
  if (!h) return fail(session, new BridgeError('unknown_tool', `unknown tool ${name}`));
  try {
    return await h(session, args || {}, ctx);
  } catch (e) {
    return fail(session, e);
  }
}
