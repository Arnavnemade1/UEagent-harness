"""Bounded, read-only scene evidence. Never loads assets or captures render buffers."""
import json
import math
import os
import time

import unreal

from . import compat, scene, values
from .registry import BridgeError, op

MAX_BYTES = 44000  # leave room for framing evidence and MCP metadata
MAX_COMPONENTS = 12


def _read(fn):
    try:
        return fn()
    except Exception:
        return None


def _path(obj):
    return obj.get_path_name() if obj is not None else None


def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _camera(sc, target, projection):
    if target == "@viewport":
        loc, rot = compat.camera()
        out = {"source": "editor_viewport", "location": values.vec_json(loc) if loc else None,
               "rotation": values.rot_json(rot) if rot else None, "projection": "perspective" if projection else None}
    else:
        actor = sc.one(target)
        if not any(candidate.get_path_name() == actor.get_path_name() for candidate in sc.actors()):
            raise BridgeError("bad_args", "camera is not in the observed world")
        cls = getattr(unreal, "CameraComponent", None)
        comp = actor.get_component_by_class(cls) if cls else None
        if comp is None:
            raise BridgeError("bad_args", "camera must have a CameraComponent")
        # Component transforms include offsets from the owning actor.
        out = {"source": "camera_component", "path": actor.get_path_name(),
               "location": _read(lambda: values.vec_json(comp.get_world_location())),
               "rotation": _read(lambda: values.rot_json(comp.get_world_rotation())),
               "projection": _read(lambda: str(comp.get_editor_property("projection_mode"))),
               "hfov": _read(lambda: float(comp.get_editor_property("field_of_view"))),
               "aspect": _read(lambda: float(comp.get_editor_property("aspect_ratio")))}
        offset = _read(lambda: comp.get_editor_property("off_center_projection_offset"))
        if offset is not None and (abs(offset.x) > 1e-6 or abs(offset.y) > 1e-6):
            out["projection"] = "unsupported_off_center"
    if projection is not None:
        if target != "@viewport":
            raise BridgeError("bad_args", "projection overrides are only allowed for @viewport")
        if not isinstance(projection, dict) or set(projection) != {"hfov", "aspect"}:
            raise BridgeError("bad_args", "projection requires hfov and aspect")
        hfov, aspect = projection["hfov"], projection["aspect"]
        if not _number(hfov) or not 1 < hfov < 179 or not _number(aspect) or not 0.1 <= aspect <= 10:
            raise BridgeError("bad_args", "projection needs finite hfov (1..179 degrees) and aspect (0.1..10)")
        out.update(projection)
        out["calibration"] = "caller_supplied"
    return out


def _components(actor, bones):
    comps = list(actor.get_components_by_class(unreal.ActorComponent))
    result = []
    for comp in comps[:MAX_COMPONENTS]:
        item = {"path": comp.get_path_name(), "class": comp.get_class().get_name()}
        if isinstance(comp, getattr(unreal, "StaticMeshComponent", ())):
            item["mesh_kind"] = "static"
            item["mesh"] = _read(lambda: _path(comp.get_editor_property("static_mesh")))
            item["mesh_assigned"] = _read(lambda: comp.get_editor_property("static_mesh") is not None)
        elif isinstance(comp, getattr(unreal, "SkinnedMeshComponent", ())):
            item["mesh_kind"] = "skinned"
            getter = getattr(comp, "get_skinned_asset", None)
            if getter is None:
                getter = lambda: comp.get_editor_property("skeletal_mesh")
            item["mesh"] = _read(lambda: _path(getter()))
            item["mesh_assigned"] = _read(lambda: getter() is not None)
            if bones:
                poses = []
                for bone in bones:
                    exists = _read(lambda: comp.get_bone_index(bone) >= 0)
                    poses.append({"bone": bone, "exists": exists,
                                  "location": _read(lambda: values.vec_json(comp.get_socket_location(bone))) if exists else None,
                                  "rotation": _read(lambda: values.rot_json(comp.get_socket_rotation(bone))) if exists else None})
                item["bones_world"] = poses
        if hasattr(comp, "get_num_materials"):
            count = _read(lambda: comp.get_num_materials())
            item["material_count"] = count
            if count is not None:
                item["materials"] = [_read(lambda: _path(comp.get_material(i))) for i in range(min(count, 8))]
        if isinstance(comp, getattr(unreal, "LightComponent", ())):
            item["light"] = {"intensity": _read(lambda: float(comp.get_editor_property("intensity"))),
                             "color": _read(lambda: values.to_json(comp.get_editor_property("light_color")))}
        result.append(item)
    return result, len(comps)


def _actor(actor, include_components, bones):
    out = {"path": actor.get_path_name(), "label": scene.label(actor), "class": actor.get_class().get_name(),
           "location": values.vec_json(actor.get_actor_location()), "rotation": values.rot_json(actor.get_actor_rotation()),
           "scale": values.vec_json(actor.get_actor_scale3d()),
           "parent": _read(lambda: _path(actor.get_attach_parent_actor())),
           "hidden_editor": _read(lambda: bool(actor.is_hidden_ed())),
           "hidden_game": _read(lambda: bool(actor.get_editor_property("hidden")))}
    bounds = _read(lambda: actor.get_actor_bounds(False))
    out["bounds"] = {"center": values.vec_json(bounds[0]), "extent": values.vec_json(bounds[1])} if bounds else None
    if include_components:
        out["components"], out["component_count"] = _components(actor, bones)
    return out


def _timeline():
    lib = getattr(unreal, "LevelSequenceEditorBlueprintLibrary", None)
    if lib is None or compat.is_pie():
        return None
    seq = _read(lambda: lib.get_current_level_sequence())
    if seq is None:
        return None
    def capture():
        rate = unreal.MovieSceneSequenceExtensions.get_display_rate(seq)
        frame = int(lib.get_current_time())  # root sequence, display-rate frames
        return {"sequence": seq.get_path_name(), "frame": frame,
                "rate": {"numerator": int(rate.numerator), "denominator": int(rate.denominator)},
                "source": "sequencer_playhead", "playing": bool(lib.is_playing())}
    return _read(capture)


@op("observe")
def observe(ctx, a):
    targets = a.get("targets", [])
    flt = a.get("filter", {})
    limit = a.get("limit", 32)
    include = a.get("components", False)
    bones = a.get("bones", [])
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 64:
        raise BridgeError("bad_args", "limit must be an integer from 1 to 64")
    if not isinstance(include, bool):
        raise BridgeError("bad_args", "components must be a boolean")
    for key, names, maximum in (("targets", targets, 64), ("bones", bones, 16)):
        if not isinstance(names, list) or len(names) > maximum or any(not isinstance(t, str) or not t or len(t) > 2048 for t in names):
            raise BridgeError("bad_args", "%s must be a list of at most %d nonempty strings" % (key, maximum))
    if not isinstance(flt, dict) or set(flt) - {"class", "name", "tag", "folder", "selected"}:
        raise BridgeError("bad_args", "filter supports class, name, tag, folder, selected")
    if targets and flt:
        raise BridgeError("bad_args", "use targets or filter, not both")
    if any(not isinstance(v, bool) if k == "selected" else not isinstance(v, str) or len(v) > 2048 for k, v in flt.items()):
        raise BridgeError("bad_args", "filter fields must be strings (selected is a boolean)")
    sc = scene.Scene()
    missing = []
    acts = []
    if targets:
        world_paths = set(actor.get_path_name() for actor in sc.actors())
        for target in targets:
            # Literal identity only: a wildcard returning one actor today is not
            # a durable identity for verification or a future repair.
            if target.startswith(("@", "$")) or any(c in target for c in "*?["):
                raise BridgeError("bad_args", "targets require exact actor paths or unique labels; use filter for groups")
            try:
                actor = sc.one(target)
                if actor.get_path_name() not in world_paths:
                    missing.append(target)
                    continue
                if actor not in acts:
                    acts.append(actor)
            except BridgeError as exc:
                if exc.code != "not_found":
                    raise
                missing.append(target)
    else:
        acts = sc.query(flt)
    acts.sort(key=lambda actor: actor.get_path_name())
    out = {"schema_version": 1, "project": ctx.server.paths.get("project_file"),
           "bridge_instance": {"pid": os.getpid(), "started": ctx.server.started_at},
           "level": compat.level_path(), "world": "pie" if compat.is_pie() else "editor",
           "revision": ctx.server.rev, "captured_at": time.time(), "timeline": _timeline(),
           "camera": _camera(sc, a.get("camera", "@viewport"), a.get("projection")),
           "scope": {"targets": targets, "filter": flt}, "missing_targets": missing,
           "actors": [], "unreadable": [],
           "capabilities": {"rgb": "use ue_screenshot separately; capture is not synchronized",
                            "depth": False, "segmentation": False, "occlusion": False,
                            "skeletal_pose": "requested bones only; current evaluated pose",
                            "temporal": "sampled state only; no timeline evaluation is performed"}}
    used = len(json.dumps(out, ensure_ascii=True)) + 1024
    if used > 12000:
        raise BridgeError("bad_args", "observation selectors exceed the metadata budget; use fewer exact paths")
    for actor in acts[:limit]:
        try:
            row = _actor(actor, include or bool(bones), bones)
            encoded = json.dumps(row, ensure_ascii=True, allow_nan=False)
        except Exception:
            out["unreadable"].append(actor.get_path_name())
            continue
        if used + len(encoded) > MAX_BYTES:
            break
        out["actors"].append(row)
        used += len(encoded)
    out["coverage"] = {"matched": len(acts), "returned": len(out["actors"]),
                       "complete": len(out["actors"]) == len(acts), "max_bytes": MAX_BYTES}
    return out
