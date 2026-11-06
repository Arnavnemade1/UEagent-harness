"""Editor UI ops: viewport camera, focus, open editors/levels, screenshots and Play-In-Editor."""
import glob
import math
import os
import time

import unreal

from . import compat, scene, values
from .registry import BridgeError, op

_VIEW_MODES = {
    "lit": "lit", "unlit": "unlit", "wireframe": "wireframe", "detail_lighting": "lit_detaillighting",
    "lighting_only": "lightingonly", "light_complexity": "lightcomplexity", "shader_complexity": "shadercomplexity",
    "collision": "collisionpawn", "path_tracing": "pathtracing",
}


def _norm_deg(a):
    """The editor never wraps viewport yaw (it can read -851); report -180..180."""
    return ((float(a) + 180.0) % 360.0) - 180.0


def _camera_json():
    loc, rot = compat.camera()
    if loc is None:
        return None
    return {"location": values.vec_json(loc), "rotation": [values.num(_norm_deg(rot.pitch)), values.num(_norm_deg(rot.yaw)), values.num(_norm_deg(rot.roll))]}


def _forward(rot):
    p, y = math.radians(rot.pitch), math.radians(rot.yaw)
    return unreal.Vector(math.cos(p) * math.cos(y), math.cos(p) * math.sin(y), math.sin(p))


def focus_on(actors, pitch=None, yaw=None, distance=None):
    lo = [1e18, 1e18, 1e18]
    hi = [-1e18, -1e18, -1e18]
    for a in actors:
        try:
            origin, extent = a.get_actor_bounds(False)
        except Exception:
            origin, extent = a.get_actor_location(), unreal.Vector(50, 50, 50)
        for i, k in enumerate("xyz"):
            o, e = getattr(origin, k), abs(getattr(extent, k))
            lo[i] = min(lo[i], o - e)
            hi[i] = max(hi[i], o + e)
    center = unreal.Vector((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2)
    radius = max(50.0, math.sqrt(sum((hi[i] - lo[i]) ** 2 for i in range(3))) / 2)
    _, cur = compat.camera()
    rot = unreal.Rotator()
    rot.pitch = float(pitch) if pitch is not None else -25.0
    rot.yaw = _norm_deg(float(yaw) if yaw is not None else (cur.yaw if cur is not None else 0.0))
    rot.roll = 0.0
    dist = float(distance) if distance else radius * 2.6
    loc = center - _forward(rot) * dist
    compat.set_camera(loc, rot)
    return {"location": values.vec_json(loc), "rotation": values.rot_json(rot), "center": values.vec_json(center), "radius": values.num(radius)}


@op("editor")
def editor(ctx, a):
    action = a.require("action")
    if action == "camera":
        if a.has("location") or a.has("rotation"):
            loc, rot = compat.camera()
            compat.set_camera(
                values.to_vector(a.get("location")) if a.has("location") else loc,
                values.to_rotator(a.get("rotation")) if a.has("rotation") else rot,
            )
        return {"camera": _camera_json()}
    if action == "focus":
        acts = scene.Scene().resolve(a.require("target"))
        if a.get("select", True):
            compat.actor_subsystem().set_selected_level_actors(acts)
        return {"focused": [scene.label(x) for x in acts[:20]], "camera": focus_on(acts, a.get("pitch"), a.get("yaw"), a.get("distance"))}
    if action == "open_asset":
        paths = a.require("path")
        paths = paths if isinstance(paths, list) else [paths]
        assets = [compat.load_asset(p) for p in paths]
        compat.asset_editor_subsystem().open_editor_for_assets(assets)
        return {"opened": [x.get_path_name() for x in assets]}
    if action == "close_asset_editors":
        compat.asset_editor_subsystem().close_all_asset_editors()
        return {"closed": True}
    if action == "browse":
        paths = a.require("path")
        paths = paths if isinstance(paths, list) else [paths]
        unreal.EditorAssetLibrary.sync_browser_to_objects([compat.norm_asset_path(p) for p in paths])
        return {"browsed": paths}
    if action in ("open_level", "new_level"):
        p = compat.norm_asset_path(a.require("path"))
        ls = compat.level_subsystem()
        if compat.dirty_packages() and action == "open_level" and not a.get("discard_unsaved", False):
            if a.get("save_first", True):
                compat.save_dirty(True, True)
        ok = ls.load_level(p) if action == "open_level" else ls.new_level(p)
        if not ok:
            raise BridgeError("failed", "%s %s failed" % (action, p))
        return {"level": compat.level_path()}
    if action == "save_level":
        ok = compat.level_subsystem().save_current_level()
        return {"saved": bool(ok), "level": compat.level_path()}
    if action == "view_mode":
        mode = str(a.require("mode")).lower()
        compat.console("viewmode %s" % _VIEW_MODES.get(mode, mode))
        return {"view_mode": mode}
    if action == "game_view":
        compat.level_subsystem().editor_set_game_view(values.to_bool(a.get("enabled", True)))
        return {"game_view": values.to_bool(a.get("enabled", True))}
    if action == "notify":
        msg = str(a.require("message"))
        unreal.log("[Agent %s] %s" % (ctx.agent, msg))
        try:
            unreal.SystemLibrary.print_string(compat.editor_world(), "[%s] %s" % (ctx.agent, msg), True, True, unreal.LinearColor(0.3, 0.8, 1.0, 1.0), float(a.get("seconds", 6)))
        except Exception:
            pass
        return {"shown": msg}
    raise BridgeError("bad_args", "unknown action '%s' (camera, focus, open_asset, close_asset_editors, browse, open_level, new_level, save_level, view_mode, game_view, notify)" % action)


# ------------------------------------------------------------------ screenshot

def _prune(folder, keep):
    try:
        files = sorted(glob.glob(os.path.join(folder, "*.png")), key=os.path.getmtime)
        for f in files[:-keep]:
            os.remove(f)
    except Exception:
        pass


@op("screenshot", timeout=40.0)
def screenshot(ctx, a):
    w = max(64, min(int(a.get("width", 1280)), 3840))
    h = max(64, min(int(a.get("height", 720)), 2160))
    folder = os.path.join(ctx.server.bridge_dir, "screenshots")
    os.makedirs(folder, exist_ok=True)
    _prune(folder, int(a.get("keep", 10)))
    stem = "shot_%d_%d" % (int(time.time() * 1000), ctx.client.cid if ctx.client else 0)
    path = os.path.join(folder, stem + ".png")
    if a.has("target"):
        acts = scene.Scene().resolve(a.get("target"))
        focus_on(acts, a.get("pitch"), a.get("yaw"), a.get("distance"))
        yield 0.05
    elif a.has("camera"):
        cam = ctx.args(a.get("camera"), "camera")
        loc, rot = compat.camera()
        compat.set_camera(
            values.to_vector(cam.get("location")) if cam.has("location") else loc,
            values.to_rotator(cam.get("rotation")) if cam.has("rotation") else rot,
        )
        yield 0.05
    compat.invalidate_viewports()
    started = time.time()
    method = "automation"
    try:
        unreal.AutomationLibrary.take_high_res_screenshot(w, h, path)
    except Exception:
        method = "console"
        compat.console('HighResShot %dx%d filename="%s"' % (w, h, path), compat.game_world() if compat.is_pie() else None)
    default_dir = os.path.join(ctx.server.paths.get("saved_dir") or "", "Screenshots")
    deadline = time.monotonic() + float(a.get("timeout", 25))
    found, last_size = None, -1
    while True:
        cands = glob.glob(os.path.join(folder, stem + "*"))
        if not cands:
            # some engine versions ignore absolute names and write into Saved/Screenshots
            cands = [f for f in glob.glob(os.path.join(default_dir, "**", "*.png"), recursive=True) if os.path.getmtime(f) >= started - 1]
        if cands:
            f = max(cands, key=os.path.getmtime)
            size = os.path.getsize(f)
            if size > 0 and size == last_size:
                found = f
                break
            last_size = size
        if time.monotonic() > deadline:
            raise BridgeError("timeout", "screenshot not written within timeout (is the editor window minimised?)", method=method)
        compat.invalidate_viewports()
        yield 0.04
    return {"path": found, "width": w, "height": h, "bytes": os.path.getsize(found), "camera": _camera_json(), "pie": compat.is_pie()}


# ------------------------------------------------------------------ play in editor

def _pie_state():
    gw = compat.game_world() if compat.is_pie() else None
    return {"state": "running" if compat.is_pie() else "stopped", "world": gw.get_path_name() if gw is not None else None}


@op("play", timeout=900.0)
def play(ctx, a):
    action = a.get("action", "status")
    ls = compat.level_subsystem()
    if action == "status":
        return _pie_state()
    if ls is None:
        raise BridgeError("unsupported", "LevelEditorSubsystem unavailable")
    if action == "stop":
        if compat.is_pie():
            ls.editor_request_end_play()
            deadline = time.monotonic() + 30
            while compat.is_pie():
                if time.monotonic() > deadline:
                    raise BridgeError("timeout", "PIE did not stop")
                yield 0.05
        return _pie_state()
    if action not in ("start", "simulate"):
        raise BridgeError("bad_args", "action must be start, simulate, stop or status")
    if not compat.is_pie():
        if action == "simulate":
            ls.editor_play_simulate()
        elif hasattr(ls, "editor_request_begin_play"):
            ls.editor_request_begin_play()
        else:
            ls.editor_play_simulate()
            ctx.warn("this engine version cannot start PIE from Python; started Simulate instead")
        deadline = time.monotonic() + float(a.get("start_timeout", 60))
        while not compat.is_pie():
            if time.monotonic() > deadline:
                raise BridgeError("timeout", "PIE did not start (check the Output Log for compile errors)")
            yield 0.05
    started = time.time()
    duration = float(a.get("duration", 0))
    if duration > 0:
        end = time.monotonic() + duration
        while time.monotonic() < end and compat.is_pie():
            yield 0.1
        if a.get("stop_after", True) and compat.is_pie():
            ls.editor_request_end_play()
            deadline = time.monotonic() + 30
            while compat.is_pie() and time.monotonic() < deadline:
                yield 0.05
    st = _pie_state()
    st["started_at"] = started
    return st
