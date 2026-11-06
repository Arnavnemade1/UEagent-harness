"""Hybrid Film: Unreal Engine plate provider (runs inside Unreal, usually as a headless commandlet).

Reads the job written by `hfilm ue plates` (env HFILM_JOB) and:
  1. loads the map, exports HOLDOUTS (proxies of plate geometry the new actors can pass behind)
     and the SUN (direction / colour / intensity), plus the ground height,
  2. deletes the HIDE actors (things the film will re-create, e.g. players and the ball) and saves
     the result as a separate plates map (the original map is never modified),
  3. creates one CineCamera per shot keyed every frame from the film's camera, a LevelSequence
     with camera cuts, and a Movie Render Queue config,
  4. writes prepared.json for the render step.

World conversion (film <-> Unreal): film is metres, +Y up, right-handed; Unreal is centimetres,
+Z up, left-handed. ue = (x, z, y) * 100. Holdout matrices map Unreal local axes X, Z, Y to film
local axes x, y, z (so Unreal's basic cylinder, whose axis is local Z, becomes a +Y cylinder).
"""
import json
import math
import os

import unreal

JOB = json.load(open(os.environ["HFILM_JOB"]))
OUT = JOB["outDir"]
EAL = unreal.EditorAssetLibrary
LSU = unreal.EditorLoadingAndSavingUtils
ACT = unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
BASIC = {"/Engine/BasicShapes/Cube": "box", "/Engine/BasicShapes/Cylinder": "cylinder", "/Engine/BasicShapes/Sphere": "sphere", "/Engine/BasicShapes/Plane": "plane"}
log = []


def note(msg):
    log.append(msg)
    unreal.log("HFILM " + msg)


def V(x, y, z):
    return unreal.Vector(float(x), float(y), float(z))


def matches(actor, patterns):
    folder = str(actor.get_folder_path())
    label = actor.get_actor_label()
    for p in patterns:
        if p.startswith("tag:"):
            if actor.actor_has_tag(p[4:]):
                return True
        elif folder == p or folder.startswith(p.rstrip("/") + "/") or label == p:
            return True
    return False


# ------------------------------------------------------------------------------------ holdouts
def film_matrix(tf, center, size):
    """Film column-major 4x4 for a unit shape mapped onto local box (center, size in cm) under tf."""
    q, s, t = tf.rotation, tf.scale3d, tf.translation

    def img(v):  # local vector -> world (cm), with scale
        return q.rotate_vector(V(v.x * s.x, v.y * s.y, v.z * s.z))

    ax = img(V(size.x, 0, 0))
    ay = img(V(0, size.y, 0))
    az = img(V(0, 0, size.z))
    c = img(center)
    p = V(t.x + c.x, t.y + c.y, t.z + c.z)
    f = lambda v: (v.x / 100.0, v.z / 100.0, v.y / 100.0)  # Unreal (cm) -> film (m)
    cx, cy, cz = f(ax), f(az), f(ay)                         # film local x,y,z <- Unreal local X,Z,Y
    px, py, pz = f(p)
    return [cx[0], cx[1], cx[2], 0, cy[0], cy[1], cy[2], 0, cz[0], cz[1], cz[2], 0, px, py, pz, 1]


def export_holdouts(actors):
    grid = JOB.get("grid") or {}
    out = []
    for a in actors:
        if not matches(a, JOB.get("holdouts", [])):
            continue
        for comp in a.get_components_by_class(unreal.StaticMeshComponent):
            mesh = comp.get_editor_property("static_mesh")
            if not mesh or not comp.is_visible():
                continue
            path = mesh.get_path_name().split(".")[0]
            shape = BASIC.get(path, "box")
            if shape == "box" and path not in BASIC:
                bb = mesh.get_bounding_box()
                center = V((bb.min.x + bb.max.x) / 2, (bb.min.y + bb.max.y) / 2, (bb.min.z + bb.max.z) / 2)
                size = V(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z)
            else:
                center, size = V(0, 0, 0), V(100, 100, 100)
            mats = [str(m.get_path_name()) for m in comp.get_materials() if m]
            g = None
            if grid.get("material") and any(grid["material"] in m for m in mats):
                g = {"cell": grid.get("cell", 0.1), "line": grid.get("line", 0.064)}
            if isinstance(comp, unreal.InstancedStaticMeshComponent):
                tfs = []
                for i in range(comp.get_instance_count()):
                    r = comp.get_instance_transform(i, True)
                    tfs.append(r[1] if isinstance(r, tuple) and isinstance(r[0], bool) else (r[0] if isinstance(r, tuple) else r))
            else:
                tfs = [comp.get_world_transform()]
            for tf in tfs:
                h = {"shape": shape, "matrix": [round(v, 5) for v in film_matrix(tf, center, size)], "source": a.get_actor_label()}
                if g:
                    h["grid"] = g
                out.append(h)
    return out


def export_sun(actors):
    for a in actors:
        if isinstance(a, unreal.DirectionalLight):
            comp = a.get_component_by_class(unreal.DirectionalLightComponent)
            fwd = a.get_actor_forward_vector()          # direction the light travels
            col = comp.get_editor_property("light_color")
            sun = {
                "direction": [round(-fwd.x, 5), round(-fwd.z, 5), round(-fwd.y, 5)],  # toward the light, film axes
                "color": "#%02x%02x%02x" % (col.r, col.g, col.b),
                "unrealIntensity": comp.get_editor_property("intensity"),
                "temperature": comp.get_editor_property("temperature") if comp.get_editor_property("use_temperature") else None,
                "elevation": round(math.degrees(math.asin(max(-1, min(1, -fwd.z)))), 2),
                "source": a.get_actor_label(),
            }
            return sun
    return None


def ground_height(actors):
    label = JOB.get("ground")
    if not label:
        return 0.0
    for a in actors:
        if a.get_actor_label() == label:
            origin, extent = a.get_actor_bounds(False)
            return round((origin.z + extent.z) / 100.0, 4)
    note("ground actor %s not found; using 0" % label)
    return 0.0


# ------------------------------------------------------------------------------------ cameras
def ue_rot(q):
    """Film quaternion of a camera (looks down -Z, up +Y) -> Unreal rotator."""
    x, y, z, w = q

    def rot(v):  # rotate vector v by quaternion
        vx, vy, vz = v
        tx = 2 * (y * vz - z * vy)
        ty = 2 * (z * vx - x * vz)
        tz = 2 * (x * vy - y * vx)
        return (vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx))

    f = rot((0, 0, -1))
    u = rot((0, 1, 0))
    return unreal.MathLibrary.make_rot_from_xz(V(f[0], f[2], f[1]), V(u[0], u[2], u[1]))


def binding_id(seq, binding):
    for fn in (lambda: seq.get_binding_id(binding),
               lambda: unreal.MovieSceneSequenceExtensions.get_portable_binding_id(seq, seq, binding),
               lambda: seq.make_binding_id(binding, unreal.MovieSceneObjectBindingSpace.LOCAL)):
        try:
            bid = fn()
            if bid is not None:
                return bid
        except Exception:
            continue
    raise RuntimeError("could not make a camera binding id")


def editor_world():
    try:
        return unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()
    except Exception:
        return unreal.EditorLevelLibrary.get_editor_world()


def export_hidden(hidden):
    """Transforms of the actors removed from the plates, so the film can re-create them in place."""
    out = []
    for a in hidden:
        p = a.get_actor_location()
        r = a.get_actor_rotation()
        fwd = a.get_actor_forward_vector()
        out.append({"label": a.get_actor_label(), "folder": str(a.get_folder_path()), "class": a.get_class().get_name(),
                    "position": [round(p.x / 100.0, 4), round(p.z / 100.0, 4), round(p.y / 100.0, 4)],
                    "forward": [round(fwd.x, 5), round(fwd.z, 5), round(fwd.y, 5)],
                    "unreal": {"location": [p.x, p.y, p.z], "rotation": [r.pitch, r.yaw, r.roll]},
                    "tags": [str(t) for t in a.tags]})
    return out


def cine_component(actor):
    """The CineCameraComponent of an actor or of a spawnable template (getters differ between the two)."""
    for get in (lambda: actor.get_cine_camera_component(), lambda: actor.get_editor_property("cine_camera_component"),
                lambda: actor.get_component_by_class(unreal.CineCameraComponent),
                lambda: (actor.get_components_by_class(unreal.CineCameraComponent) or [None])[0]):
        try:
            c = get()
            if c:
                return c
        except Exception:
            continue
    raise RuntimeError("no CineCameraComponent on %s" % actor)


def build_sequence(cam):
    fps, start, end = JOB["fps"], JOB["start"], JOB["end"]
    name = JOB["name"]
    folder = JOB["assetDir"]
    seq_path = "%s/LS_HFilm_%s" % (folder, name)
    if EAL.does_asset_exist(seq_path):
        EAL.delete_asset(seq_path)
    seq = unreal.AssetToolsHelpers.get_asset_tools().create_asset("LS_HFilm_" + name, folder, unreal.LevelSequence, unreal.LevelSequenceFactoryNew())
    seq.set_display_rate(unreal.FrameRate(fps, 1))
    n = end - start
    seq.set_playback_start(0)       # plates are numbered 0..n-1; the film maps them back with an offset
    seq.set_playback_end(n)
    try:
        cut_track = seq.add_track(unreal.MovieSceneCameraCutTrack)
    except Exception:
        cut_track = seq.add_master_track(unreal.MovieSceneCameraCutTrack)
    cuts = sorted(set([start] + [c for c in JOB.get("cuts", []) if start < c < end] + [end]))
    aspect = JOB["width"] / float(JOB["height"])
    sensor_h = cam["sensorHeight"] * 1000.0
    for si in range(len(cuts) - 1):
        a, b = cuts[si], cuts[si + 1]
        # cameras live in the plates map (already saved under its final name, so bindings resolve at render time)
        actor = ACT.spawn_actor_from_class(unreal.CineCameraActor, V(0, 0, 0), unreal.Rotator(0, 0, 0))
        actor.set_actor_label("HFilm_%s_Shot%02d" % (name, si + 1))
        actor.set_folder_path("HFilm/" + name)
        cc = cine_component(actor)
        fb = cc.get_editor_property("filmback")
        fb.set_editor_property("sensor_width", sensor_h * aspect)
        fb.set_editor_property("sensor_height", sensor_h)
        cc.set_editor_property("filmback", fb)
        i0 = a - start
        fov = cam["fov"][i0]
        focal = (sensor_h / 2.0) / math.tan(math.radians(fov) / 2.0)
        cc.set_editor_property("current_focal_length", focal)
        fstops = cam.get("fstop")
        fsett = cc.get_editor_property("focus_settings")
        if fstops and fstops[i0] > 0:
            cc.set_editor_property("current_aperture", float(fstops[i0]))
            fsett.set_editor_property("focus_method", unreal.CameraFocusMethod.MANUAL)
            fsett.set_editor_property("manual_focus_distance", float(cam["focus"][i0]) * 100.0)
        else:
            fsett.set_editor_property("focus_method", unreal.CameraFocusMethod.DISABLE)
        cc.set_editor_property("focus_settings", fsett)
        binding = seq.add_possessable(actor)
        track = binding.add_track(unreal.MovieScene3DTransformTrack)
        sec = track.add_section()
        sec.set_range(a - start, b - start)
        ch = sec.get_all_channels()  # loc x,y,z, rot roll,pitch,yaw, scale x,y,z
        for f in range(a, b):
            i = f - start
            p = cam["position"][i]
            r = ue_rot(cam["quaternion"][i])
            fr = unreal.FrameNumber(i)
            for k, v in enumerate((p[0] * 100.0, p[2] * 100.0, p[1] * 100.0)):
                ch[k].add_key(fr, float(v))
            ch[3].add_key(fr, float(r.roll))
            ch[4].add_key(fr, float(r.pitch))
            ch[5].add_key(fr, float(r.yaw))
            for k in range(3):
                ch[6 + k].add_key(fr, 1.0)
        # focal length / focus that change inside the shot are keyed on the camera component
        fovs = cam["fov"][a - start:b - start]
        if max(fovs) - min(fovs) > 1e-3:
            comp_binding = seq.add_possessable(cc)
            comp_binding.set_parent(binding)
            ft = comp_binding.add_track(unreal.MovieSceneFloatTrack)  # focal length animated inside the shot
            ft.set_property_name_and_path("CurrentFocalLength", "CurrentFocalLength")
            fsec = ft.add_section()
            fsec.set_range(a - start, b - start)
            fch = fsec.get_all_channels()[0]
            for f in range(a, b):
                fv = cam["fov"][f - start]
                fch.add_key(unreal.FrameNumber(f - start), float((sensor_h / 2.0) / math.tan(math.radians(fv) / 2.0)))
        cut = cut_track.add_section()
        cut.set_range(a - start, b - start)
        cut.set_camera_binding_id(binding_id(seq, binding))
    EAL.save_loaded_asset(seq, False)
    note("sequence %s: %d frames, %d shots" % (seq_path, n, len(cuts) - 1))
    return seq_path


def build_config():
    folder = JOB["assetDir"]
    name = "MRQ_HFilm_" + JOB["name"]
    path = "%s/%s" % (folder, name)
    if EAL.does_asset_exist(path):
        EAL.delete_asset(path)
    if JOB.get("preset"):
        if not EAL.duplicate_asset(JOB["preset"], path):
            raise RuntimeError("could not duplicate preset " + JOB["preset"])
        cfg = EAL.load_asset(path)
    else:
        cfg = unreal.AssetToolsHelpers.get_asset_tools().create_asset(name, folder, unreal.MoviePipelinePrimaryConfig, unreal.MoviePipelinePrimaryConfigFactory())
        cfg.find_or_add_setting_by_class(unreal.MoviePipelineDeferredPassBase)
        aa = cfg.find_or_add_setting_by_class(unreal.MoviePipelineAntiAliasingSetting)
        aa.set_editor_property("temporal_sample_count", int(JOB.get("temporalSamples", 4)))
        aa.set_editor_property("engine_warm_up_count", 32)
        aa.set_editor_property("render_warm_up_count", 16)
        game = cfg.find_or_add_setting_by_class(unreal.MoviePipelineGameOverrideSetting)
        game.set_editor_property("cinematic_quality_settings", False)
    cfg.find_or_add_setting_by_class(unreal.MoviePipelineImageSequenceOutput_JPG)
    out = cfg.find_or_add_setting_by_class(unreal.MoviePipelineOutputSetting)
    out.set_editor_property("output_resolution", unreal.IntPoint(JOB["width"], JOB["height"]))
    out.set_editor_property("output_directory", unreal.DirectoryPath(OUT))
    out.set_editor_property("file_name_format", "{sequence_name}.{frame_number}")
    out.set_editor_property("zero_pad_frame_numbers", 4)
    first = int(JOB.get("renderStart") or 0)   # --resume: continue after the plates already on disk
    out.set_editor_property("use_custom_playback_range", first > 0)
    if first > 0:
        out.set_editor_property("custom_start_frame", first)
        out.set_editor_property("custom_end_frame", JOB["end"] - JOB["start"])
        note("resuming at plate %d" % first)
    out.set_editor_property("override_existing_output", True)
    if not EAL.save_loaded_asset(cfg, False):
        raise RuntimeError("could not save " + path)
    note("render config " + path)
    return path


def main():
    world = LSU.load_map(JOB["map"])
    if not world:
        raise RuntimeError("could not load map " + JOB["map"])
    actors = ACT.get_all_level_actors()
    folders = {}  # actor count per outliner folder: helps choose --hide / --holdouts
    for a in actors:
        f = str(a.get_folder_path()) or "(root)"
        folders[f] = folders.get(f, 0) + 1
    holdouts = export_holdouts(actors)
    sun = export_sun(actors)
    ground = ground_height(actors)
    json.dump({"holdouts": holdouts}, open(os.path.join(OUT, "holdouts.json"), "w"))
    hidden = [a for a in actors if matches(a, JOB.get("hide", []))]
    json.dump({"actors": export_hidden(hidden)}, open(os.path.join(OUT, "hidden.json"), "w"), indent=1)
    for a in hidden:
        ACT.destroy_actor(a)
    note("holdouts: %d proxies; hidden %d actors; ground %.3f m" % (len(holdouts), len(hidden), ground))
    # save-as FIRST: the editor world becomes the plates map, so camera bindings are made against it
    plate_map = "%s/%s_HFilmPlates_%s" % (JOB["assetDir"], JOB["map"].rsplit("/", 1)[-1], JOB["name"])
    if EAL.does_asset_exist(plate_map):
        EAL.delete_asset(plate_map)
    if not LSU.save_map(editor_world(), plate_map):
        raise RuntimeError("could not save plates map " + plate_map)
    world = editor_world()
    if not world.get_path_name().startswith(plate_map):
        world = LSU.load_map(plate_map)
    seq_path = build_sequence(JOB["camera"])
    cfg_path = build_config()
    if not LSU.save_map(editor_world(), plate_map):
        raise RuntimeError("could not save cameras into " + plate_map)
    note("plates map " + plate_map)
    json.dump({"ok": True, "folders": folders, "sequence": seq_path, "config": cfg_path, "plateMap": plate_map, "sun": sun, "groundY": ground,
               "holdoutCount": len(holdouts), "hidden": len(hidden), "log": log}, open(os.path.join(OUT, "prepared.json"), "w"), indent=1)


try:
    main()
except Exception as e:  # report to the caller instead of a silent commandlet exit
    import traceback
    json.dump({"ok": False, "error": str(e), "trace": traceback.format_exc(), "log": log}, open(os.path.join(OUT, "prepared.json"), "w"), indent=1)
    unreal.log_error("HFILM failed: %s" % e)
