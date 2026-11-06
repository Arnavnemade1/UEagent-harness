"""Blueprint ops: create, add components/variables, set defaults, compile (with status)."""
import unreal

from . import compat, values
from .registry import BridgeError, op


def _subobject_lib():
    sds = None
    cls = getattr(unreal, "SubobjectDataSubsystem", None)
    if cls is not None:
        try:
            sds = unreal.get_engine_subsystem(cls)
        except Exception:
            sds = None
    if sds is None:
        raise BridgeError("unsupported", "SubobjectDataSubsystem unavailable (UE 5.0+ required for component editing)")
    return sds, unreal.SubobjectDataBlueprintFunctionLibrary


def _handles(bp):
    sds, lib = _subobject_lib()
    return sds, lib, list(sds.k2_gather_subobject_data_for_blueprint(bp))


def _handle_name(lib, h):
    try:
        return str(lib.get_variable_name(lib.get_data(h)))
    except Exception:
        return ""


def _find_handle(bp, name):
    sds, lib, hs = _handles(bp)
    low = name.lower()
    for h in hs:
        if _handle_name(lib, h).lower() == low:
            return h
    return None


def components(bp):
    try:
        sds, lib, hs = _handles(bp)
    except BridgeError:
        return []
    out = []
    for h in hs:
        try:
            obj = lib.get_object(lib.get_data(h))
            out.append({"name": _handle_name(lib, h), "class": obj.get_class().get_name() if obj else "?"})
        except Exception:
            pass
    return out


def _add_component(bp, o):
    sds, lib, hs = _handles(bp)
    if not hs:
        raise BridgeError("failed", "blueprint has no root subobject")
    parent = hs[0]
    if o.has("parent"):
        parent = _find_handle(bp, str(o.get("parent")))
        if parent is None:
            raise BridgeError("not_found", "component '%s' not in blueprint" % o.get("parent"), components=components(bp))
    cls = values.resolve_class(o.require("class"))
    params = unreal.AddNewSubobjectParams()
    params.set_editor_property("parent_handle", parent)
    params.set_editor_property("new_class", cls)
    params.set_editor_property("blueprint_context", bp)
    handle, reason = sds.add_new_subobject(params)
    try:
        failed = not reason.is_empty()
    except Exception:
        failed = bool(str(reason))
    if failed:
        raise BridgeError("failed", "could not add %s: %s" % (o.get("class"), reason))
    name = o.get("name")
    if name:
        sds.rename_subobject(handle, unreal.Text(str(name)))
    comp = lib.get_object(lib.get_data(handle))
    readback = {}
    for k, v in (o.get("properties") or {}).items():
        readback[k] = values.set_path(comp, k, v)
    return {"op": "add_component", "name": _handle_name(lib, handle), "class": comp.get_class().get_name() if comp else None, "properties": readback or None}


_PIN_ALIASES = {"float": ["real", "float", "double"], "double": ["real", "double"], "integer": ["int"], "boolean": ["bool"], "str": ["string"]}
_STRUCTS = {"vector": "Vector", "rotator": "Rotator", "transform": "Transform", "color": "LinearColor", "linearcolor": "LinearColor", "vector2d": "Vector2D"}


def _pin_type(spec):
    BEL = unreal.BlueprintEditorLibrary
    t = str(spec).strip()
    low = t.lower()
    if low.endswith("[]"):
        return BEL.get_array_type(_pin_type(t[:-2]))
    if low in _STRUCTS:
        return BEL.get_struct_type(getattr(unreal, _STRUCTS[low]).static_struct())
    for name in _PIN_ALIASES.get(low, [low]):
        try:
            pt = BEL.get_basic_type_by_name(name)
            if pt is not None and str(pt.get_editor_property("pin_category")) not in ("", "None"):
                return pt
        except Exception:
            pass
    cls = values.resolve_class(t)
    if isinstance(cls, type):
        return BEL.get_object_reference_type(cls)
    raise BridgeError("bad_args", "unknown variable type '%s' (bool, int, float, string, name, text, vector, rotator, transform, color, <Class>, <type>[])" % spec)


def _add_variable(bp, o):
    BEL = unreal.BlueprintEditorLibrary
    if not hasattr(BEL, "add_member_variable"):
        raise BridgeError("unsupported", "adding variables needs UE 5.1+; use the python tool instead")
    name = str(o.require("name"))
    ok = BEL.add_member_variable(bp, name, _pin_type(o.require("type")))
    if not ok:
        raise BridgeError("failed", "could not add variable %s (does it already exist?)" % name)
    return {"op": "add_variable", "name": name, "type": o.get("type"), "default_pending": o.has("default")}


def _compile(bp):
    BEL = unreal.BlueprintEditorLibrary
    BEL.compile_blueprint(bp)
    status = None
    try:
        status = str(bp.get_editor_property("status"))
    except Exception:
        pass
    res = {"op": "compile", "status": status or "compiled"}
    if status and ("ERROR" in status.upper()):
        res["error"] = True
    return res


def _cdo(bp):
    cls = unreal.EditorAssetLibrary.load_blueprint_class(bp.get_path_name().split(".")[0])
    if cls is None:
        raise BridgeError("failed", "blueprint has no generated class yet; compile it first")
    return unreal.get_default_object(cls)


@op("blueprint", mutating=True, label=lambda a: "blueprint %s" % a.get("path"))
def blueprint(ctx, a):
    p = compat.norm_asset_path(a.require("path"))
    created = False
    if not compat.asset_exists(p):
        if not a.has("create"):
            raise BridgeError("not_found", "%s does not exist (pass create: {parent: 'Actor'} to create it)" % p)
        c = ctx.args(a.get("create"), "create")
        folder, _, name = p.rpartition("/")
        factory = unreal.BlueprintFactory()
        factory.set_editor_property("parent_class", values.resolve_class(c.get("parent", "Actor")))
        bp = compat.asset_tools().create_asset(name, folder, unreal.Blueprint, factory)
        if bp is None:
            raise BridgeError("create_failed", "could not create blueprint %s" % p)
        created = True
    else:
        bp = compat.load_asset(p)
        a.get("create")
    if not isinstance(bp, unreal.Blueprint):
        raise BridgeError("bad_target", "%s is a %s, not a Blueprint" % (p, bp.get_class().get_name()))
    results = []
    defaults_after = []
    needs_compile = created
    for i, raw in enumerate(a.get("ops") or []):
        o = ctx.args(raw, "ops[%d]" % i)
        kind = o.require("op")
        try:
            if kind == "add_component":
                results.append(_add_component(bp, o))
                needs_compile = True
            elif kind == "add_variable":
                results.append(_add_variable(bp, o))
                needs_compile = True
                if o.has("default"):
                    defaults_after.append((o.get("name"), o.get("default")))
            elif kind == "set_default":
                defaults_after.append((o.require("property"), o.get("value")))
            elif kind == "component_property":
                h = _find_handle(bp, str(o.require("component")))
                if h is None:
                    raise BridgeError("not_found", "component '%s' not in blueprint" % o.get("component"), components=components(bp))
                _, lib = _subobject_lib()
                comp = lib.get_object(lib.get_data(h))
                results.append({"op": "component_property", "component": o.get("component"), "value": values.set_path(comp, o.require("property"), o.get("value"))})
                needs_compile = True
            elif kind == "compile":
                needs_compile = True
            else:
                raise BridgeError("bad_args", "unknown op '%s' (add_component, add_variable, set_default, component_property, compile)" % kind)
        except BridgeError as exc:
            exc.message = "ops[%d] (%s) failed: %s" % (i, kind, exc.message)
            exc.data["completed"] = results
            raise
    compiled = None
    if needs_compile or defaults_after:
        compiled = _compile(bp)
    if defaults_after:
        cdo = _cdo(bp)
        for prop, val in defaults_after:
            results.append({"op": "set_default", "property": prop, "value": values.set_path(cdo, prop, val)})
        compiled = _compile(bp)
    if a.get("save", True):
        unreal.EditorAssetLibrary.save_loaded_asset(bp, False)
    ctx.summary = "%s %s" % ("created" if created else "edited", p)
    return {"path": p, "created": created, "results": results, "compile": compiled, "components": components(bp)}
