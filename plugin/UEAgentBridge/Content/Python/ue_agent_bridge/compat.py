"""Thin, version-tolerant wrappers over the editor scripting API (UE 5.0+)."""
import os

import unreal

from .registry import BridgeError

_subsystems = {}


def _editor_subsystem(name):
    s = _subsystems.get(name)
    if s is not None:
        return s
    cls = getattr(unreal, name, None)
    if cls is None:
        return None
    try:
        s = unreal.get_editor_subsystem(cls)
    except Exception:
        s = None
    if s is not None:
        _subsystems[name] = s
    return s


def actor_subsystem():
    s = _editor_subsystem("EditorActorSubsystem")
    if s is None:
        raise BridgeError("unsupported", "EditorActorSubsystem is unavailable (UE 5.0+ with Editor Scripting Utilities required)")
    return s


def editor_subsystem():
    return _editor_subsystem("UnrealEditorSubsystem")


def level_subsystem():
    return _editor_subsystem("LevelEditorSubsystem")


def asset_editor_subsystem():
    return _editor_subsystem("AssetEditorSubsystem")


def editor_world():
    s = editor_subsystem()
    if s is not None:
        return s.get_editor_world()
    return unreal.EditorLevelLibrary.get_editor_world()


def game_world():
    s = editor_subsystem()
    if s is not None and hasattr(s, "get_game_world"):
        try:
            return s.get_game_world()
        except Exception:
            return None
    return None


def level_path():
    try:
        w = editor_world()
        return w.get_path_name() if w is not None else None
    except Exception:
        return None


def all_actors():
    return list(actor_subsystem().get_all_level_actors())


def selected_actors():
    return list(actor_subsystem().get_selected_level_actors())


def console(cmd, world=None):
    unreal.SystemLibrary.execute_console_command(world or editor_world(), cmd)


def asset_tools():
    return unreal.AssetToolsHelpers.get_asset_tools()


def asset_registry():
    return unreal.AssetRegistryHelpers.get_asset_registry()


def is_pie():
    s = level_subsystem()
    if s is None:
        return False
    try:
        return bool(s.is_in_play_in_editor())
    except Exception:
        return False


def invalidate_viewports():
    s = level_subsystem()
    try:
        if s is not None and hasattr(s, "editor_invalidate_viewports"):
            s.editor_invalidate_viewports()
    except Exception:
        pass


def camera():
    s = editor_subsystem()
    if s is None:
        return None, None
    try:
        loc, rot = s.get_level_viewport_camera_info()
        return loc, rot
    except Exception:
        return None, None


def set_camera(location, rotation):
    s = editor_subsystem()
    if s is None:
        raise BridgeError("unsupported", "UnrealEditorSubsystem unavailable")
    s.set_level_viewport_camera_info(location, rotation)
    invalidate_viewports()


def full_path(p):
    try:
        p = unreal.Paths.convert_relative_path_to_full(p)
    except Exception:
        p = os.path.abspath(p)
    return os.path.normpath(p)


def project_paths():
    def safe(fn):
        try:
            return full_path(fn())
        except Exception:
            return None

    return {
        "project_file": safe(unreal.Paths.get_project_file_path),
        "project_dir": safe(unreal.Paths.project_dir),
        "saved_dir": safe(unreal.Paths.project_saved_dir),
        "content_dir": safe(unreal.Paths.project_content_dir),
        "log_dir": safe(unreal.Paths.project_log_dir),
        "engine_dir": safe(unreal.Paths.engine_dir),
    }


def engine_version():
    try:
        return str(unreal.SystemLibrary.get_engine_version())
    except Exception:
        return "unknown"


class _NullContext(object):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def transaction(label):
    T = getattr(unreal, "ScopedEditorTransaction", None)
    if T is None:
        return _NullContext()
    try:
        return T(label)
    except Exception:
        return _NullContext()


def undo(count=1):
    for _ in range(max(1, int(count))):
        console("TRANSACTION UNDO")


def redo(count=1):
    for _ in range(max(1, int(count))):
        console("TRANSACTION REDO")


def set_property_quiet(obj, name, value):
    """Set a property without PostEditChange (so config objects are not re-saved to disk)."""
    modes = getattr(unreal, "PropertyAccessChangeNotifyMode", None)
    never = getattr(modes, "NEVER", None) if modes is not None else None
    if never is not None:
        try:
            obj.set_editor_property(name, value, never)
            return
        except TypeError:
            pass
    obj.set_editor_property(name, value)


def dirty_packages():
    utils = getattr(unreal, "EditorLoadingAndSavingUtils", None)
    out = []
    if utils is None:
        return out
    for fn in ("get_dirty_map_packages", "get_dirty_content_packages"):
        try:
            out.extend(p.get_name() for p in getattr(utils, fn)())
        except Exception:
            pass
    return out


def save_dirty(maps=True, content=True):
    return bool(unreal.EditorLoadingAndSavingUtils.save_dirty_packages(maps, content))


# ---------------------------------------------------------------- assets

def norm_asset_path(p):
    """Accept /Game/X, /Game/X.X, Content/X.uasset, X, Class'/Game/X.X' -> /Game/X (package path)."""
    if p is None:
        raise BridgeError("bad_args", "asset path is required")
    s = str(p).strip().strip('"')
    if "'" in s:  # export text form: StaticMesh'/Game/X.X'
        parts = s.split("'")
        if len(parts) >= 2 and parts[1].startswith("/"):
            s = parts[1]
    s = s.replace("\\", "/")
    low = s.lower()
    if low.endswith(".uasset") or low.endswith(".umap"):
        s = s.rsplit(".", 1)[0]
        idx = s.find("Content/")
        if idx >= 0:
            s = "/Game/" + s[idx + len("Content/"):]
    elif s.startswith("Content/"):
        s = "/Game/" + s[len("Content/"):]
    if not s.startswith("/"):
        s = "/Game/" + s
    last = s.rsplit("/", 1)[-1]
    if "." in last:  # /Game/X.X -> /Game/X
        pkg_name, obj_name = last.split(".", 1)
        if obj_name.split(":")[0] == pkg_name:
            s = s[: len(s) - len(last)] + pkg_name
    return s.rstrip("/") or "/Game"


def asset_exists(path):
    try:
        return bool(unreal.EditorAssetLibrary.does_asset_exist(path))
    except Exception:
        return False


def load_asset(path, required=True):
    p = norm_asset_path(path)
    if not asset_exists(p):
        if required:
            raise BridgeError("not_found", "asset '%s' does not exist" % p)
        return None
    obj = unreal.EditorAssetLibrary.load_asset(p)
    if obj is None and required:
        raise BridgeError("load_failed", "asset '%s' exists but could not be loaded" % p)
    return obj


def asset_class_name(asset_data):
    try:
        return str(asset_data.asset_class_path.asset_name)
    except Exception:
        pass
    try:
        return str(asset_data.asset_class)
    except Exception:
        return "?"


def object_path(asset_data):
    return "%s.%s" % (asset_data.package_name, asset_data.asset_name)


def class_path(cls):
    """unreal python class -> TopLevelAssetPath (UE 5.1+) or None."""
    TLAP = getattr(unreal, "TopLevelAssetPath", None)
    if TLAP is None:
        return None
    try:
        # python wrapper types expose static_class(); UClass instances (e.g. blueprint
        # generated classes) must use their own path - calling static_class() on an
        # instance would return /Script/CoreUObject.Class
        path = cls.static_class().get_path_name() if isinstance(cls, type) else cls.get_path_name()
    except Exception:
        return None
    pkg, _, name = path.partition(".")
    try:
        return TLAP(pkg, name)
    except Exception:
        t = TLAP()
        t.set_editor_property("package_name", pkg)
        t.set_editor_property("asset_name", name)
        return t
