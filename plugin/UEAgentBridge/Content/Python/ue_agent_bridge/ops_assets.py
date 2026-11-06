"""Content Browser ops: search assets and batched asset edits (create, move, materials...)."""
import fnmatch
import os

import unreal

from . import compat, values
from .registry import BridgeError, op

EAL = None


def _eal():
    global EAL
    if EAL is None:
        EAL = unreal.EditorAssetLibrary
    return EAL


def _split(path):
    p = compat.norm_asset_path(path)
    folder, _, name = p.rpartition("/")
    if not folder or not name:
        raise BridgeError("bad_args", "'%s' is not a full asset path like /Game/Folder/Name" % path)
    return p, folder, name


@op("find_assets")
def find_assets(ctx, a):
    path = compat.norm_asset_path(a.get("path", "/Game"))
    recursive = bool(a.get("recursive", True))
    limit = max(1, min(int(a.get("limit", 100)), 2000))
    cls = a.get("class")
    name = a.get("name")
    include = a.get("include") or []
    compat.require_no_pie("asset search")
    reg = compat.asset_registry()
    kw = {"package_paths": [path], "recursive_paths": recursive}
    if cls:
        pycls = values.resolve_class(cls)
        tlap = compat.class_path(pycls)
        if tlap is not None:
            kw["class_paths"] = [tlap]
        else:
            kw["class_names"] = [getattr(pycls, "__name__", str(cls))]
        kw["recursive_classes"] = True
    # UE 5.8: ARFilter fields can't be set with set_editor_property, only via the constructor
    flt = unreal.ARFilter(**kw)
    assets = list(reg.get_assets(flt))
    if name:
        pat = str(name).lower()
        if not any(ch in pat for ch in "*?["):
            pat = "*" + pat + "*"
        assets = [x for x in assets if fnmatch.fnmatchcase(str(x.asset_name).lower(), pat)]
    assets.sort(key=lambda x: str(x.package_name))
    rows = []
    for x in assets[:limit]:
        r = {"path": str(x.package_name), "class": compat.asset_class_name(x)}
        if include and len(assets) <= 25:
            opts = unreal.AssetRegistryDependencyOptions()
            if "dependencies" in include:
                r["dependencies"] = [str(d) for d in (reg.get_dependencies(x.package_name, opts) or [])][:50]
            if "referencers" in include:
                r["referencers"] = [str(d) for d in (reg.get_referencers(x.package_name, opts) or [])][:50]
        rows.append(r)
    res = {"total": len(assets), "returned": len(rows), "assets": rows}
    if not assets and path != "/Game":
        res["hint"] = "nothing under %s; try path '/Game' or a different class/name filter" % path
    return res


# ------------------------------------------------------------------ create

_FACTORIES = {
    "material": ("Material", "MaterialFactoryNew"),
    "materialinstance": ("MaterialInstanceConstant", "MaterialInstanceConstantFactoryNew"),
    "materialinstanceconstant": ("MaterialInstanceConstant", "MaterialInstanceConstantFactoryNew"),
    "materialfunction": ("MaterialFunction", "MaterialFunctionFactoryNew"),
    "blueprint": ("Blueprint", "BlueprintFactory"),
    "widgetblueprint": ("WidgetBlueprint", "WidgetBlueprintFactory"),
    "level": ("World", "WorldFactory"),
    "world": ("World", "WorldFactory"),
    "dataasset": ("DataAsset", "DataAssetFactory"),
    "datatable": ("DataTable", "DataTableFactory"),
    "physicalmaterial": ("PhysicalMaterial", "PhysicalMaterialFactoryNew"),
    "soundcue": ("SoundCue", "SoundCueFactoryNew"),
    "enum": ("UserDefinedEnum", "EnumFactory"),
    "struct": ("UserDefinedStruct", "StructureFactory"),
    "curvefloat": ("CurveFloat", "CurveFloatFactory"),
}


def _make_factory(typ, o):
    key = typ.replace("_", "").replace(" ", "").lower()
    cls_name, fac_name = _FACTORIES.get(key, (typ, o.get("factory")))
    if not fac_name:
        for cand in (typ + "FactoryNew", typ + "Factory"):
            if hasattr(unreal, cand):
                fac_name = cand
                break
    asset_cls = getattr(unreal, cls_name, None)
    fac_cls = getattr(unreal, fac_name, None) if fac_name else None
    if asset_cls is None or fac_cls is None:
        raise BridgeError("unsupported", "don't know how to create '%s'; pass type and factory class names" % typ, known=sorted(_FACTORIES))
    factory = fac_cls()
    parent = o.get("parent")
    if key in ("blueprint", "widgetblueprint"):
        pcls = values.resolve_class(parent or ("UserWidget" if key == "widgetblueprint" else "Actor"))
        factory.set_editor_property("parent_class", pcls)
    elif key in ("materialinstance", "materialinstanceconstant") and parent:
        pm = values.resolve_object(parent)
        if pm is None:
            raise BridgeError("not_found", "parent material '%s' not found" % parent)
        factory.set_editor_property("initial_parent", pm)
    elif key == "dataasset":
        factory.set_editor_property("data_asset_class", values.resolve_class(parent or "PrimaryDataAsset"))
    elif key == "datatable":
        if not parent:
            raise BridgeError("bad_args", "DataTable needs parent = row struct path")
        st = values.resolve_object(parent)
        if st is None:
            try:
                st = unreal.load_object(None, parent)
            except Exception:
                st = None
        if st is None:
            raise BridgeError("not_found", "row struct '%s' not found" % parent)
        factory.set_editor_property("struct", st)
    return asset_cls, factory


def _create(o, ctx):
    typ = o.require("type")
    if typ.lower() == "folder":
        p = compat.norm_asset_path(o.require("path"))
        _eal().make_directory(p)
        return {"op": "create", "folder": p}
    p, folder, name = _split(o.require("path"))
    if compat.asset_exists(p):
        mode = o.get("if_exists", "error")
        if mode == "skip":
            return {"op": "create", "path": p, "existed": True}
        if mode == "replace":
            _eal().delete_asset(p)
        else:
            raise BridgeError("exists", "%s already exists (if_exists: 'skip' or 'replace')" % p)
    asset_cls, factory = _make_factory(typ, o)
    asset = compat.asset_tools().create_asset(name, folder, asset_cls, factory)
    if asset is None:
        raise BridgeError("create_failed", "engine could not create %s at %s" % (typ, p))
    readback = _set_props(asset, o.get("properties"))
    if typ.lower() in ("materialinstance", "materialinstanceconstant") and o.get("parameters"):
        _mi_params(asset, ctx.args(o.get("parameters"), "parameters"))
    if o.get("save", True):
        _eal().save_loaded_asset(asset, False)
    r = {"op": "create", "path": p, "class": asset.get_class().get_name()}
    if readback:
        r["properties"] = readback
    return r


def _set_props(asset, props):
    if not props:
        return None
    if not isinstance(props, dict):
        raise BridgeError("bad_args", "properties must be an object")
    try:
        asset.modify()
    except Exception:
        pass
    return {k: values.set_path(asset, k, v) for k, v in props.items()}


# ------------------------------------------------------------------ materials

def _mi_params(mi, p):
    MEL = unreal.MaterialEditingLibrary
    done = {}
    for k, v in (p.get("scalar") or {}).items():
        MEL.set_material_instance_scalar_parameter_value(mi, k, float(v))
        done[k] = v
    for k, v in (p.get("vector") or {}).items():
        MEL.set_material_instance_vector_parameter_value(mi, k, values.to_linear_color(v))
        done[k] = v
    for k, v in (p.get("texture") or {}).items():
        tex = values.resolve_object(v)
        if tex is None:
            raise BridgeError("not_found", "texture '%s' not found" % v)
        MEL.set_material_instance_texture_parameter_value(mi, k, tex)
        done[k] = v
    for k, v in (p.get("switch") or {}).items():
        MEL.set_material_instance_static_switch_parameter_value(mi, k, values.to_bool(v))
        done[k] = v
    MEL.update_material_instance(mi)
    return done


def _pbr(o, ctx):
    """Build (or rebuild) a simple PBR material from constants and/or textures."""
    MEL = unreal.MaterialEditingLibrary
    p, folder, name = _split(o.require("path"))
    if compat.asset_exists(p):
        mat = compat.load_asset(p)
        if not isinstance(mat, unreal.Material):
            raise BridgeError("bad_target", "%s is a %s, not a Material" % (p, mat.get_class().get_name()))
        MEL.delete_all_material_expressions(mat)
    else:
        mat = compat.asset_tools().create_asset(name, folder, unreal.Material, unreal.MaterialFactoryNew())
        if mat is None:
            raise BridgeError("create_failed", "could not create material %s" % p)
    y = [0]

    def node(cls, **props):
        e = MEL.create_material_expression(mat, cls, -400, y[0])
        y[0] += 160
        for k, v in props.items():
            e.set_editor_property(k, v)
        return e

    def feed(key, prop, scalar=False, normal=False):
        v = o.get(key)
        if v is None:
            return
        if isinstance(v, str) and not v.startswith("#"):
            tex = values.resolve_object(v)
            if tex is None:
                raise BridgeError("not_found", "texture '%s' not found for %s" % (v, key))
            e = node(unreal.MaterialExpressionTextureSample, texture=tex)
            if normal:
                e.set_editor_property("sampler_type", unreal.MaterialSamplerType.SAMPLERTYPE_NORMAL)
            out = "R" if scalar else "RGB"
            MEL.connect_material_property(e, out if not normal else "RGB", prop)
        elif scalar:
            e = node(unreal.MaterialExpressionConstant, r=float(v))
            MEL.connect_material_property(e, "", prop)
        else:
            c = values.to_linear_color(v, key)
            if key == "emissive":
                s = float(o.get("emissive_strength", 1.0))
                c = unreal.LinearColor(c.r * s, c.g * s, c.b * s, c.a)
            e = node(unreal.MaterialExpressionConstant3Vector, constant=c)
            MEL.connect_material_property(e, "", prop)

    MP = unreal.MaterialProperty
    feed("base_color", MP.MP_BASE_COLOR)
    feed("metallic", MP.MP_METALLIC, scalar=True)
    feed("roughness", MP.MP_ROUGHNESS, scalar=True)
    feed("specular", MP.MP_SPECULAR, scalar=True)
    feed("emissive", MP.MP_EMISSIVE_COLOR)
    feed("normal", MP.MP_NORMAL, normal=True)
    feed("ambient_occlusion", MP.MP_AMBIENT_OCCLUSION, scalar=True)
    if o.has("opacity"):
        mat.set_editor_property("blend_mode", unreal.BlendMode.BLEND_TRANSLUCENT)
        feed("opacity", MP.MP_OPACITY, scalar=True)
    if o.has("two_sided"):
        mat.set_editor_property("two_sided", values.to_bool(o.get("two_sided")))
    try:
        MEL.layout_material_expressions(mat)
    except Exception:
        pass
    MEL.recompile_material(mat)
    if o.get("save", True):
        _eal().save_loaded_asset(mat, False)
    return {"op": "pbr_material", "path": p, "expressions": y[0] // 160}


# ------------------------------------------------------------------ batch

def _referencers(path):
    try:
        reg = compat.asset_registry()
        refs = reg.get_referencers(path, unreal.AssetRegistryDependencyOptions()) or []
        return [str(r) for r in refs if str(r) != path]
    except Exception:
        return []


def _do(o, ctx):
    kind = o.require("op")
    E = _eal()
    if kind == "create":
        return _create(o, ctx)
    if kind == "pbr_material":
        return _pbr(o, ctx)
    if kind in ("duplicate", "rename", "move"):
        src = compat.norm_asset_path(o.require("source"))
        dst = compat.norm_asset_path(o.require("dest"))
        if not compat.asset_exists(src):
            raise BridgeError("not_found", "%s does not exist" % src)
        if compat.asset_exists(dst):
            raise BridgeError("exists", "%s already exists" % dst)
        ok = E.duplicate_asset(src, dst) if kind == "duplicate" else E.rename_asset(src, dst)
        if not ok:
            raise BridgeError("failed", "%s %s -> %s failed" % (kind, src, dst))
        if kind == "duplicate" and o.get("save", True):
            E.save_asset(dst, False)
        return {"op": kind, "source": src, "dest": dst, "verified": compat.asset_exists(dst)}
    if kind == "delete":
        p = compat.norm_asset_path(o.require("path"))
        if E.does_directory_exist(p) and not compat.asset_exists(p):
            if not o.get("force"):
                n = len(E.list_assets(p, True, False))
                if n:
                    raise BridgeError("not_empty", "folder %s contains %d assets; pass force: true to delete it" % (p, n))
            E.delete_directory(p)
            return {"op": "delete", "folder": p}
        if not compat.asset_exists(p):
            raise BridgeError("not_found", "%s does not exist" % p)
        refs = _referencers(p)
        if refs and not o.get("force"):
            raise BridgeError("referenced", "%s is used by %d package(s); pass force: true to delete anyway" % (p, len(refs)), referencers=refs[:20])
        if not E.delete_asset(p):
            raise BridgeError("failed", "could not delete %s" % p)
        return {"op": "delete", "path": p, "verified": not compat.asset_exists(p)}
    if kind == "set":
        asset = compat.load_asset(o.require("path"))
        readback = _set_props(asset, o.require("properties"))
        if isinstance(asset, getattr(unreal, "Material", ())):
            unreal.MaterialEditingLibrary.recompile_material(asset)
        if o.get("save", True):
            E.save_loaded_asset(asset, False)
        return {"op": "set", "path": asset.get_path_name(), "properties": readback}
    if kind == "material_params":
        mi = compat.load_asset(o.require("path"))
        done = _mi_params(mi, o)
        if o.get("save", True):
            E.save_loaded_asset(mi, False)
        return {"op": "material_params", "path": mi.get_path_name(), "set": done}
    if kind == "open":
        asset = compat.load_asset(o.require("path"))
        compat.asset_editor_subsystem().open_editor_for_assets([asset])
        return {"op": "open", "path": asset.get_path_name()}
    if kind == "save":
        p = compat.norm_asset_path(o.require("path"))
        return {"op": "save", "path": p, "ok": bool(E.save_asset(p, False))}
    if kind == "reimport":
        asset = compat.load_asset(o.require("path"))
        try:
            src = asset.get_editor_property("asset_import_data").get_first_filename()
        except Exception:
            src = None
        if not src or not os.path.exists(src):
            raise BridgeError("no_source", "no source file on disk for %s (%s)" % (asset.get_path_name(), src))
        p, folder, name = _split(asset.get_path_name())
        t = unreal.AssetImportTask()
        for k, v in (("filename", src), ("destination_path", folder), ("destination_name", name), ("replace_existing", True), ("automated", True), ("save", True)):
            t.set_editor_property(k, v)
        compat.asset_tools().import_asset_tasks([t])
        return {"op": "reimport", "path": p, "source": src}
    raise BridgeError("bad_args", "unknown op '%s' (create, pbr_material, duplicate, rename, delete, set, material_params, open, save, reimport)" % kind)


@op("edit_assets", mutating=True, label=lambda a: "edit assets (%d ops)" % len(a.get("ops") or []))
def edit_assets(ctx, a):
    ops = a.require("ops")
    if not isinstance(ops, list) or not ops:
        raise BridgeError("bad_args", "ops must be a non-empty list")
    results = []
    for i, raw in enumerate(ops):
        o = ctx.args(raw, "ops[%d]" % i)
        try:
            results.append(_do(o, ctx))
        except BridgeError as exc:
            exc.message = "ops[%d] (%s) failed: %s" % (i, raw.get("op") if isinstance(raw, dict) else "?", exc.message)
            exc.data["completed"] = results
            raise
        except Exception as exc:
            raise BridgeError("op_failed", "ops[%d] failed: %s: %s" % (i, type(exc).__name__, exc), completed=results)
    ctx.summary = ", ".join("%s %s" % (r.get("op"), r.get("path") or r.get("dest") or r.get("folder") or "") for r in results)[:200]
    return {"results": results}
