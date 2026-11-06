"""Core ops: editor context, change journal, Python execution, console, undo, save."""
import ast
import io
import sys
import time
import traceback

import unreal

from . import compat, scene, values
from .registry import BridgeError, op


@op("status")
def status(ctx, a):
    """Snapshot of what the user is looking at, so agents can act like copilots."""
    srv = ctx.server
    out = {
        "project": srv.paths.get("project_file"),
        "engine": compat.engine_version(),
        "python": sys.version.split()[0],
        "rev": srv.rev,
        "level": compat.level_path(),
        "pie": "running" if compat.is_pie() else "stopped",
        "agents": [c.name for c in srv.clients.values() if c.authed],
    }
    try:
        sel = compat.selected_actors()
        out["selection"] = {"count": len(sel), "actors": [scene.row(x) for x in sel[:20]]}
    except Exception as exc:
        out["selection"] = {"error": str(exc)}
    try:
        lib = getattr(unreal, "EditorUtilityLibrary", None)
        assets = lib.get_selected_assets() if lib else []
        if assets:
            out["selected_assets"] = [x.get_path_name() for x in assets[:20]]
    except Exception:
        pass
    loc, rot = compat.camera()
    if loc is not None:
        out["camera"] = {"location": values.vec_json(loc), "rotation": values.rot_json(rot)}
    dirty = compat.dirty_packages()
    out["unsaved"] = {"count": len(dirty), "packages": sorted(dirty)[:20]}
    if srv.last_txn:
        out["last_agent_transaction"] = srv.last_txn
    out["background_throttle"] = {"controlled": srv.throttle.controlled, "disabled_for_agents": srv.throttle.disabled_by_us}
    return out


@op("changes")
def changes(ctx, a):
    return ctx.server.changes_since(int(a.get("since", 0)), int(a.get("limit", 200)))


# ------------------------------------------------------------------ python

class _Tee(object):
    """Captures agent prints while still echoing them to the Output Log."""

    def __init__(self, orig, limit):
        self.orig = orig
        self.buf = io.StringIO()
        self.limit = limit
        self.size = 0
        self.truncated = False

    def write(self, s):
        if self.size < self.limit:
            self.buf.write(s[: self.limit - self.size])
            self.size += len(s)
        else:
            self.truncated = True
        try:
            self.orig.write(s)
        except Exception:
            pass
        return len(s)

    def flush(self):
        try:
            self.orig.flush()
        except Exception:
            pass

    def getvalue(self):
        v = self.buf.getvalue()
        return v + ("\n...[output truncated]" if self.truncated else "")


def _helpers(ctx):
    sc = scene.Scene

    def actors(pattern="*"):
        """Actors whose label matches a wildcard pattern."""
        return sc().resolve(pattern, many=True, allow_empty=True)

    def actor(target):
        return sc().one(target)

    def selected():
        return compat.selected_actors()

    def asset(path):
        return compat.load_asset(path)

    return {
        "unreal": unreal,
        "actors": actors,
        "actor": actor,
        "selected": selected,
        "asset": asset,
        "vec": lambda x=0.0, y=0.0, z=0.0: unreal.Vector(x, y, z),
        "rot": lambda pitch=0.0, yaw=0.0, roll=0.0: values.to_rotator([pitch, yaw, roll]),
        "to_json": values.to_json,
        "editor_world": compat.editor_world,
        "actor_subsystem": compat.actor_subsystem,
    }


def _watchdog(timeout):
    """Profile hook that aborts runaway agent code (infinite loops would freeze the editor)."""
    deadline = time.monotonic() + timeout
    state = [0]

    def prof(frame, event, arg):
        state[0] += 1
        if state[0] & 255 == 0 and time.monotonic() > deadline:
            raise TimeoutError("agent code exceeded %.0fs (pass timeout to raise the limit)" % timeout)

    return prof


@op("python", mutating=True, label=lambda a: "Python: %s" % (str(a.get("code", "")).strip().splitlines() or [""])[0][:60])
def python(ctx, a):
    code = a.require("code")
    timeout = float(a.get("timeout", 120))
    limit = int(a.get("max_output", 20000))
    ns = ctx.client.namespace
    if ns is None:
        ns = {"__name__": "__agent__", "__builtins__": __builtins__}
        ns.update(_helpers(ctx))
        ctx.client.namespace = ns
    try:
        tree = ast.parse(code, filename="<agent>", mode="exec")
    except SyntaxError as exc:
        raise BridgeError("syntax_error", "%s (line %s)" % (exc.msg, exc.lineno), text=(exc.text or "").rstrip())
    expr = None
    if tree.body and isinstance(tree.body[-1], ast.Expr):
        expr = ast.Expression(body=tree.body.pop().value)
    out = _Tee(sys.stdout, limit)
    err = _Tee(sys.stderr, limit)
    old_out, old_err, old_prof = sys.stdout, sys.stderr, sys.getprofile()
    sys.stdout, sys.stderr = out, err
    if timeout > 0:
        sys.setprofile(_watchdog(timeout))
    value = None
    failure = None
    try:
        exec(compile(tree, "<agent>", "exec"), ns)
        if expr is not None:
            value = eval(compile(expr, "<agent>", "eval"), ns)
    except BaseException as exc:  # includes SystemExit / KeyboardInterrupt from agent code
        failure = exc
        tb = traceback.extract_tb(exc.__traceback__)
        frames = [f for f in tb if f.filename == "<agent>"] or tb[-3:]
        trace = "".join(traceback.format_list(frames)) + "".join(traceback.format_exception_only(type(exc), exc))
    finally:
        sys.setprofile(old_prof)
        sys.stdout, sys.stderr = old_out, old_err
    stdout = out.getvalue()
    stderr = err.getvalue()
    if failure is not None:
        raise BridgeError(
            "python_error",
            "%s: %s" % (type(failure).__name__, failure),
            traceback=trace.strip(),
            stdout=stdout[-4000:] or None,
            note="changes made before the error (if any) form one undo step",
        )
    res = {}
    if stdout:
        res["stdout"] = stdout
    if stderr:
        res["stderr"] = stderr
    if value is not None:
        res["result"] = values.to_json(value)
    ctx.summary = "ran Python (%d lines)" % (code.count("\n") + 1)
    return res


@op("console", mutating=True, transact=False, label=lambda a: "console: %s" % a.get("commands"))
def console(ctx, a):
    cmds = a.require("commands")
    if isinstance(cmds, str):
        cmds = [cmds]
    world = compat.game_world() if a.get("pie") else None
    done = []
    for c in cmds:
        compat.console(str(c), world)
        done.append(str(c))
    ctx.summary = "console: " + "; ".join(done)[:120]
    return {"executed": done, "note": "console output goes to the Output Log; read it with the logs tool"}


@op("undo", mutating=True, transact=False, label=lambda a: "%s x%s" % (a.get("action", "undo"), a.get("count", 1)))
def undo(ctx, a):
    action = a.get("action", "undo")
    count = int(a.get("count", 1))
    before = ctx.server.last_txn
    if action == "redo":
        compat.redo(count)
    elif action == "undo":
        compat.undo(count)
    else:
        raise BridgeError("bad_args", "action must be 'undo' or 'redo'")
    ctx.summary = "%s x%d" % (action, count)
    return {"done": action, "count": count, "last_agent_transaction_before": before}


@op("save", mutating=True, transact=False, label="save")
def save(ctx, a):
    paths = a.get("paths")
    before = set(compat.dirty_packages())
    saved = []
    failed = []
    if paths:
        for p in paths:
            np = compat.norm_asset_path(p)
            try:
                ok = unreal.EditorAssetLibrary.save_asset(np, False)
            except Exception:
                ok = False
            (saved if ok else failed).append(np)
    elif a.get("level_only"):
        ls = compat.level_subsystem()
        ok = bool(ls.save_current_level()) if ls else False
        (saved if ok else failed).append(compat.level_path())
    else:
        compat.save_dirty(True, True)
    after = set(compat.dirty_packages())
    if not paths and not a.get("level_only"):
        saved = sorted(before - after)
    ctx.summary = "saved %d package(s)" % len(saved)
    res = {"saved": saved[:100], "still_unsaved": sorted(after)[:50]}
    if failed:
        res["failed"] = failed
    return res


# ------------------------------------------------------------------ inspect

def _resolve_any(target):
    """Actor (label/path/$sel) -> asset path -> class name (class default object)."""
    t = str(target).strip()
    looks_asset = t.startswith("/Game") or t.startswith("/Engine") or t.startswith("/Script") or t.lower().endswith(".uasset")
    if not looks_asset or ":" in t:
        try:
            return scene.Scene().one(t), "actor"
        except BridgeError as exc:
            if exc.code == "ambiguous" or looks_asset:
                raise
            actor_err = exc
    if looks_asset:
        if t.startswith("/Script"):
            cls = values.resolve_class(t)
            return unreal.get_default_object(cls), "class_default"
        return compat.load_asset(t), "asset"
    try:
        cls = values.resolve_class(t)
        return unreal.get_default_object(cls), "class_default"
    except BridgeError:
        raise actor_err


def _class_chain(obj):
    chain = []
    try:
        chain.append(obj.get_class().get_name())
    except Exception:
        pass
    for k in type(obj).__mro__:
        n = k.__name__
        if n in ("_ObjectBase", "_WrapperBase", "object") or n in chain:
            continue
        chain.append(n)
    return chain[:10]


@op("inspect")
def inspect(ctx, a):
    obj, kind = _resolve_any(a.require("target"))
    if a.has("component"):
        if kind != "actor":
            raise BridgeError("bad_args", "component only applies to actors")
        comp = values.find_component(obj, str(a.get("component")))
        if comp is None:
            raise BridgeError("not_found", "component '%s' not found" % a.get("component"), components=[c["name"] for c in scene.row(obj, True).get("components", [])])
        obj, kind = comp, "component"
    if a.has("property"):
        prop = str(a.get("property"))
        return {"object": obj.get_path_name(), "property": prop, "value": values.to_json(values.get_path(obj, prop))}
    flt = str(a.get("filter", "")).lower()
    limit = max(1, min(int(a.get("limit", 60)), 400))
    props = values.list_properties(obj)
    if flt:
        props = [p for p in props if flt in p["name"].lower() or flt in p["doc"].lower()]
    rows = []
    for p in props[:limit]:
        r = {"name": p["name"], "type": p["type"]}
        if p["access"] == "ro":
            r["read_only"] = True
        try:
            v = values.to_json(obj.get_editor_property(p["name"]))
            if isinstance(v, str) and len(v) > 200:
                v = v[:200] + "..."
            if isinstance(v, list) and len(v) > 20:
                v = v[:20] + ["... %d more" % (len(v) - 20)]
            r["value"] = v
        except Exception:
            r["value"] = "<unreadable>"
        rows.append(r)
    res = {"object": obj.get_path_name(), "kind": kind, "class_chain": _class_chain(obj), "properties": rows, "total_properties": len(props)}
    if kind == "actor":
        res["actor"] = scene.row(obj, True)
    elif kind == "asset" and isinstance(obj, getattr(unreal, "Blueprint", ())):
        from . import ops_blueprint

        res["components"] = ops_blueprint.components(obj)
    if len(props) > limit:
        res["hint"] = "showing %d of %d properties; pass filter or a larger limit" % (limit, len(props))
    return res
