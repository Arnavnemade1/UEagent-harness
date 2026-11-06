"""Level actor ops: find, and batched edits that are one undo step and verified by read-back."""
import unreal

from . import compat, scene, values
from .registry import BridgeError, op


@op("find_actors")
def find_actors(ctx, a):
    sc = scene.Scene()
    flt = {k: a.get(k) for k in ("class", "name", "tag", "folder", "selected", "near", "radius")}
    acts = sc.query(flt)
    limit = max(1, min(int(a.get("limit", 50)), 1000))
    detail = bool(a.get("detail", False))
    sel = set(x.get_path_name() for x in compat.selected_actors())
    if a.get("near") is not None:
        center = values.to_vector(a.get("near")) if not isinstance(a.get("near"), str) else sc.one(a.get("near")).get_actor_location()

        def dist(x):
            d = x.get_actor_location() - center
            return d.x * d.x + d.y * d.y + d.z * d.z

        acts.sort(key=dist)
    rows = [scene.row(x, detail, sel) for x in acts[:limit]]
    return {"total": len(acts), "returned": len(rows), "actors": rows}


def _load_mesh(path):
    p = path
    if p.lower() in ("cube", "sphere", "cylinder", "cone", "plane"):
        p = "/Engine/BasicShapes/" + p.capitalize()
    mesh = values.resolve_object(p)
    if mesh is None:
        raise BridgeError("not_found", "mesh '%s' not found (basic shapes: cube, sphere, cylinder, cone, plane)" % path)
    return mesh


def _mesh_component(actor):
    for cls_name in ("StaticMeshComponent",):
        cls = getattr(unreal, cls_name, None)
        if cls is None:
            continue
        try:
            c = actor.get_component_by_class(cls)
            if c is not None:
                return c
        except Exception:
            pass
    return None


def _apply_common(sc, actor, o, ctx):
    """Fields shared by spawn and set. Returns list of touched field names."""
    touched = []
    root = None
    try:
        root = actor.get_editor_property("root_component")
    except Exception:
        pass
    sc.mutated = True
    try:
        actor.modify()
        if root is not None:
            root.modify()
    except Exception:
        pass
    if o.has("location") or o.has("offset"):
        loc = values.to_vector(o.get("location"), "location") if o.has("location") else actor.get_actor_location()
        if o.has("offset"):
            loc = loc + values.to_vector(o.get("offset"), "offset")
        actor.set_actor_location(loc, False, False)
        touched.append("location")
    if o.has("rotation") or o.has("rotate_by"):
        rot = values.to_rotator(o.get("rotation")) if o.has("rotation") else actor.get_actor_rotation()
        if o.has("rotate_by"):
            d = values.to_rotator(o.get("rotate_by"), "rotate_by")
            r = unreal.Rotator()
            r.pitch, r.yaw, r.roll = rot.pitch + d.pitch, rot.yaw + d.yaw, rot.roll + d.roll
            rot = r
        actor.set_actor_rotation(rot, False)
        touched.append("rotation")
    if o.has("scale"):
        actor.set_actor_scale3d(values.to_vector(o.get("scale"), "scale"))
        touched.append("scale")
    if o.has("label"):
        actor.set_actor_label(str(o.get("label")))
        touched.append("label")
    if o.has("mesh"):
        comp = _mesh_component(actor)
        if comp is None:
            raise BridgeError("bad_target", "%s has no StaticMeshComponent for 'mesh'" % scene.label(actor))
        comp.modify()
        comp.set_static_mesh(_load_mesh(str(o.get("mesh"))))
        touched.append("mesh")
    if o.has("material") or o.has("materials"):
        comp = _mesh_component(actor)
        if comp is None:
            raise BridgeError("bad_target", "%s has no mesh component for materials" % scene.label(actor))
        mats = o.get("materials") if o.has("materials") else [o.get("material")]
        comp.modify()
        for i, m in enumerate(mats):
            if m is None:
                continue
            mat = values.resolve_object(str(m))
            if mat is None:
                raise BridgeError("not_found", "material '%s' not found" % m)
            comp.set_material(i, mat)
        touched.append("materials")
    if o.has("folder"):
        actor.set_folder_path(str(o.get("folder")))
        touched.append("folder")
    if o.has("tags"):
        actor.set_editor_property("tags", [str(t) for t in o.get("tags")])
        touched.append("tags")
    if o.has("hidden"):
        try:
            actor.set_is_temporarily_hidden_in_editor(values.to_bool(o.get("hidden")))
        except Exception:
            values.set_path(actor, "hidden", values.to_bool(o.get("hidden")))
        touched.append("hidden")
    props = o.get("properties")
    if props:
        if not isinstance(props, dict):
            raise BridgeError("bad_args", "properties must be an object of {path: value}")
        readback = {}
        for path, value in props.items():
            readback[path] = values.set_path(actor, path, value)
        touched.append("properties")
        return touched, readback
    return touched, None


def _spawn(sc, o, ctx):
    loc = values.to_vector(o.get("location", [0, 0, 0]), "location")
    rot = values.to_rotator(o.get("rotation", [0, 0, 0]))
    subsys = compat.actor_subsystem()
    actor = None
    if o.has("asset"):
        obj = values.resolve_object(str(o.get("asset")))
        if obj is None:
            raise BridgeError("not_found", "asset '%s' not found" % o.get("asset"))
        if isinstance(obj, getattr(unreal, "Blueprint", ())):
            cls = values.resolve_class(str(o.get("asset")))
            actor = subsys.spawn_actor_from_class(cls, loc, rot)
        else:
            actor = subsys.spawn_actor_from_object(obj, loc, rot)
    else:
        cls_name = o.get("class") or ("StaticMeshActor" if o.has("mesh") else None)
        if not cls_name:
            raise BridgeError("bad_args", "spawn needs 'class', 'asset' or 'mesh'")
        cls = values.resolve_class(cls_name)
        actor = subsys.spawn_actor_from_class(cls, loc, rot)
    if actor is None:
        raise BridgeError("spawn_failed", "engine refused to spawn %s" % (o.get("asset") or o.get("class")))
    sc.mutated = True
    sc.added(actor)
    # location/rotation were applied at spawn; apply everything else
    for k in ("location", "rotation"):
        o.raw().pop(k, None)
    if o.has("attach_to"):
        parent = sc.one(o.get("attach_to"))
        actor.attach_to_actor(parent, str(o.get("socket", "")), unreal.AttachmentRule.KEEP_WORLD, unreal.AttachmentRule.KEEP_WORLD, unreal.AttachmentRule.KEEP_WORLD, False)
    _apply_common(sc, actor, o, ctx)
    return [actor]


def _duplicate(sc, o, ctx):
    src = sc.resolve(o.require("target"))
    count = max(1, min(int(o.get("count", 1)), 500))
    step = values.to_vector(o.get("offset", [0, 0, 0]), "offset")
    subsys = compat.actor_subsystem()
    out = []
    for n in range(1, count + 1):
        for s in src:
            dup = subsys.duplicate_actor(s, None, step * float(n)) if hasattr(subsys, "duplicate_actor") else None
            if dup is None:
                dups = subsys.duplicate_actors([s], None, step * float(n))
                dup = dups[0] if dups else None
            if dup is None:
                raise BridgeError("duplicate_failed", "could not duplicate %s" % scene.label(s))
            sc.mutated = True
            sc.added(dup)
            out.append(dup)
    if o.has("label"):
        base = str(o.get("label"))
        for i, d in enumerate(out):
            d.set_actor_label(base if len(out) == 1 else "%s_%d" % (base, i + 1))
    return out


def _do_op(sc, o, ctx, index):
    kind = o.require("op")
    if kind == "spawn":
        acts = _spawn(sc, o, ctx)
        return acts, {"op": "spawn", "actor": scene.row(acts[0])}
    if kind == "set":
        acts = sc.resolve(o.require("target"))
        rows = []
        for x in acts:
            touched, readback = _apply_common(sc, x, o, ctx)
            if not touched:
                raise BridgeError("bad_args", "set op #%d changes nothing (give location, rotation, scale, label, mesh, material, properties, ...)" % index)
            r = scene.row(x)
            if readback:
                r["properties"] = readback
            rows.append(r)
        return acts, {"op": "set", "count": len(rows), "actors": rows[:25]}
    if kind == "delete":
        acts = sc.resolve(o.require("target"))
        subsys = compat.actor_subsystem()
        labels = [scene.label(x) for x in acts]
        for x in acts:
            sc.removed(x)
        sc.mutated = True
        if hasattr(subsys, "destroy_actors"):
            subsys.destroy_actors(acts)
        else:
            for x in acts:
                subsys.destroy_actor(x)
        return [], {"op": "delete", "deleted": labels}
    if kind == "duplicate":
        dups = _duplicate(sc, o, ctx)
        return dups, {"op": "duplicate", "count": len(dups), "actors": [scene.row(d) for d in dups[:25]]}
    if kind == "select":
        acts = sc.resolve(o.require("target"))
        subsys = compat.actor_subsystem()
        if o.get("add"):
            for x in acts:
                subsys.set_actor_selection_state(x, True)
        else:
            subsys.set_selected_level_actors(acts)
        return acts, {"op": "select", "selected": [scene.label(x) for x in acts[:50]]}
    if kind == "deselect":
        compat.actor_subsystem().select_nothing()
        return [], {"op": "deselect"}
    if kind == "attach":
        child = sc.resolve(o.require("target"))
        parent = sc.one(o.require("parent"))
        rule = unreal.AttachmentRule.KEEP_WORLD
        sc.mutated = True
        for c in child:
            c.attach_to_actor(parent, str(o.get("socket", "")), rule, rule, rule, False)
        return child, {"op": "attach", "parent": scene.label(parent), "children": [scene.label(c) for c in child]}
    if kind == "detach":
        acts = sc.resolve(o.require("target"))
        rule = unreal.DetachmentRule.KEEP_WORLD
        sc.mutated = True
        for x in acts:
            x.detach_from_actor(rule, rule, rule)
        return acts, {"op": "detach", "actors": [scene.label(x) for x in acts]}
    raise BridgeError("bad_args", "unknown op '%s' (spawn, set, delete, duplicate, select, deselect, attach, detach)" % kind)


def _edit_label(a):
    ops = a.get("ops") or []
    kinds = []
    for o in ops:
        k = o.get("op", "?") if isinstance(o, dict) else "?"
        if k not in kinds:
            kinds.append(k)
    return "edit actors (%d op%s: %s)" % (len(ops), "" if len(ops) == 1 else "s", ", ".join(kinds))


@op("edit_actors", mutating=True, label=_edit_label)
def edit_actors(ctx, a):
    ops = a.require("ops")
    if not isinstance(ops, list) or not ops:
        raise BridgeError("bad_args", "ops must be a non-empty list")
    compat.require_no_pie("editing level actors")
    atomic = bool(a.get("atomic", True))
    sc = scene.Scene()
    results = []
    for i, raw in enumerate(ops):
        o = ctx.args(raw, "ops[%d]" % i)
        try:
            acts, res = _do_op(sc, o, ctx, i)
        except BridgeError as exc:
            exc.rollback = atomic and sc.mutated
            exc.message = "ops[%d] (%s) failed: %s" % (i, raw.get("op") if isinstance(raw, dict) else "?", exc.message)
            exc.data["completed_ops"] = len(results)
            if not atomic:
                exc.data["results"] = results
            raise
        except Exception as exc:
            err = BridgeError("op_failed", "ops[%d] (%s) failed: %s: %s" % (i, raw.get("op") if isinstance(raw, dict) else "?", type(exc).__name__, exc))
            err.rollback = atomic and sc.mutated
            err.data["completed_ops"] = len(results)
            raise err
        sc.refs["$%d" % i] = acts
        results.append(res)
    kinds = {}
    for r in results:
        kinds[r["op"]] = kinds.get(r["op"], 0) + 1
    ctx.summary = ", ".join("%s x%d" % (k, v) for k, v in kinds.items())
    compat.invalidate_viewports()
    return {"results": results, "undo": "one undo step reverts this whole batch"}
