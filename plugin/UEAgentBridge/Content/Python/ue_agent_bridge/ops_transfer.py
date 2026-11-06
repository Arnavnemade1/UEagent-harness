"""File <-> asset transfer: import files from disk (meshes, textures, audio, .uasset) and export assets."""
import os
import shutil

import unreal

from . import compat
from .registry import BridgeError, op

IMPORTABLE = {
    ".fbx", ".obj", ".gltf", ".glb", ".usd", ".usda", ".usdc", ".usdz", ".abc",
    ".png", ".jpg", ".jpeg", ".tga", ".bmp", ".exr", ".hdr", ".psd", ".tif", ".tiff", ".dds",
    ".wav", ".ogg", ".flac", ".aif", ".aiff", ".mp3",
    ".ttf", ".otf", ".csv", ".json",
}
RAW_ASSETS = {".uasset", ".umap"}

EXPORT_EXT = {
    "Texture2D": ".png", "TextureCube": ".hdr", "StaticMesh": ".fbx", "SkeletalMesh": ".fbx",
    "AnimSequence": ".fbx", "SoundWave": ".wav", "World": ".t3d",
}


def _expand(files):
    out = []
    for f in files:
        p = os.path.abspath(os.path.expanduser(str(f)))
        if os.path.isdir(p):
            for root, _, names in os.walk(p):
                for n in sorted(names):
                    ext = os.path.splitext(n)[1].lower()
                    if ext in IMPORTABLE or ext in RAW_ASSETS:
                        out.append(os.path.join(root, n))
        else:
            out.append(p)
    return out


def _content_dir_for(game_path, content_dir):
    rel = game_path[len("/Game"):].lstrip("/")
    return os.path.join(content_dir, *rel.split("/")) if rel else content_dir


@op("import_files", mutating=True, transact=False, timeout=1800.0, label=lambda a: "import %d file(s)" % len(a.get("files") or []))
def import_files(ctx, a):
    files = a.require("files")
    files = files if isinstance(files, list) else [files]
    dest = compat.norm_asset_path(a.get("destination", "/Game/Imported"))
    if not dest.startswith("/Game"):
        raise BridgeError("bad_args", "destination must be under /Game")
    replace = bool(a.get("replace", True))
    save = bool(a.get("save", True))
    opts = a.get("options") or {}
    paths = _expand(files)
    if not paths:
        raise BridgeError("bad_args", "no importable files found in %s" % files)
    missing = [p for p in paths if not os.path.isfile(p)]
    if missing:
        raise BridgeError("not_found", "files not found: %s" % ", ".join(missing[:10]))
    content_dir = ctx.server.paths.get("content_dir")
    tasks = []
    raw = []
    for p in paths:
        ext = os.path.splitext(p)[1].lower()
        if ext in RAW_ASSETS:
            raw.append(p)
            continue
        if ext not in IMPORTABLE:
            ctx.warn("skipped unsupported file type: %s" % p)
            continue
        t = unreal.AssetImportTask()
        t.set_editor_property("filename", p)
        t.set_editor_property("destination_path", dest)
        t.set_editor_property("replace_existing", replace)
        t.set_editor_property("automated", True)
        t.set_editor_property("save", save)
        name = opts.get("name")
        if name and len(paths) == 1:
            t.set_editor_property("destination_name", str(name))
        if ext == ".fbx" and opts:
            ui = unreal.FbxImportUI()
            if "skeletal" in opts:
                ui.set_editor_property("import_as_skeletal", bool(opts["skeletal"]))
                ui.set_editor_property("mesh_type_to_import", unreal.FBXImportType.FBXIT_SKELETAL_MESH if opts["skeletal"] else unreal.FBXImportType.FBXIT_STATIC_MESH)
            for k in ("import_materials", "import_textures", "import_animations"):
                if k in opts:
                    ui.set_editor_property(k, bool(opts[k]))
            if "combine_meshes" in opts:
                ui.static_mesh_import_data.set_editor_property("combine_meshes", bool(opts["combine_meshes"]))
            t.set_editor_property("options", ui)
        tasks.append(t)
    results = []
    if tasks:
        with unreal.ScopedSlowTask(len(tasks), "Agent %s importing %d file(s)" % (ctx.agent, len(tasks))) as slow:
            slow.make_dialog(False)
            slow.enter_progress_frame(0)
            compat.asset_tools().import_asset_tasks(tasks)
        for t in tasks:
            objs = [str(x) for x in (t.get_editor_property("imported_object_paths") or [])]
            results.append({"file": t.get_editor_property("filename"), "assets": [compat.norm_asset_path(o) for o in objs], "ok": bool(objs)})
    if raw:
        target_dir = _content_dir_for(dest, content_dir)
        os.makedirs(target_dir, exist_ok=True)
        for p in raw:
            out = os.path.join(target_dir, os.path.basename(p))
            if os.path.exists(out) and not replace:
                results.append({"file": p, "ok": False, "error": "exists"})
                continue
            shutil.copy2(p, out)
            results.append({"file": p, "assets": [dest + "/" + os.path.splitext(os.path.basename(p))[0]], "ok": True, "copied": True})
        try:
            compat.asset_registry().scan_paths_synchronous([dest], True)
        except Exception:
            pass
    failed = [r for r in results if not r.get("ok")]
    ctx.summary = "imported %d file(s) into %s" % (len(results) - len(failed), dest)
    res = {"destination": dest, "imported": len(results) - len(failed), "results": results}
    if failed:
        res["failed"] = len(failed)
        res["hint"] = "check the logs tool (category LogInterchange/LogFbx/LogAssetTools) for importer errors"
    return res


@op("export_assets", timeout=900.0)
def export_assets(ctx, a):
    assets = a.require("assets")
    assets = assets if isinstance(assets, list) else [assets]
    directory = os.path.abspath(os.path.expanduser(str(a.require("directory"))))
    os.makedirs(directory, exist_ok=True)
    fmt = a.get("format")
    results = []
    for p in assets:
        obj = compat.load_asset(p)
        cls = obj.get_class().get_name()
        ext = ("." + fmt.lstrip(".")) if fmt else EXPORT_EXT.get(cls, ".t3d" if cls == "World" else ".copy")
        out = os.path.join(directory, obj.get_name() + ext)
        task = unreal.AssetExportTask()
        task.set_editor_property("object", obj)
        task.set_editor_property("filename", out)
        task.set_editor_property("automated", True)
        task.set_editor_property("prompt", False)
        task.set_editor_property("replace_identical", True)
        ok = bool(unreal.Exporter.run_asset_export_task(task))
        ok = ok and os.path.exists(out)
        results.append({"asset": obj.get_path_name(), "file": out if ok else None, "ok": ok, "bytes": os.path.getsize(out) if ok else 0})
    return {"directory": directory, "results": results}
