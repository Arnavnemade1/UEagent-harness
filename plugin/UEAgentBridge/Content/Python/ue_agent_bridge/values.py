"""Convert between JSON values and Unreal values, and read/write properties by path.

Conventions used everywhere in the bridge:
  location / vector  -> [x, y, z]          (cm)
  rotation           -> [pitch, yaw, roll] (degrees)
  scale              -> [x, y, z] or a single number
  color              -> [r, g, b] or [r, g, b, a] (0..1 floats; >1 allowed for emissive)
  object references  -> path strings ("/Game/Foo/Bar" or an actor path)
"""
import re

import unreal

from . import compat
from .registry import BridgeError, suggest

_TYPES = None


def _t(name):
    global _TYPES
    if _TYPES is None:
        _TYPES = {}
    if name not in _TYPES:
        _TYPES[name] = getattr(unreal, name, None)
    return _TYPES[name]


def _is(v, name):
    t = _t(name)
    return t is not None and isinstance(v, t)


def num(x, nd=3):
    try:
        f = float(x)
    except Exception:
        return x
    if f != f or f in (float("inf"), float("-inf")):
        return str(f)
    r = round(f, nd)
    if r == int(r) and abs(r) < 1e15:
        return int(r)
    return r


def vec_json(v):
    return [num(v.x), num(v.y), num(v.z)]


def rot_json(r):
    return [num(r.pitch), num(r.yaw), num(r.roll)]


def to_json(v, depth=0):
    """Best-effort conversion of any Unreal/Python value into compact JSON."""
    if v is None or isinstance(v, (bool, str)):
        return v
    if isinstance(v, int) and not _is(v, "EnumBase"):
        return v
    if isinstance(v, float):
        return num(v, 4)
    if depth > 6:
        return str(v)
    if _is(v, "Vector"):
        return vec_json(v)
    if _is(v, "Rotator"):
        return rot_json(v)
    if _is(v, "Vector2D"):
        return [num(v.x), num(v.y)]
    if _is(v, "Vector4"):
        return [num(v.x), num(v.y), num(v.z), num(v.w)]
    if _is(v, "LinearColor"):
        return [num(v.r), num(v.g), num(v.b), num(v.a)]
    if _is(v, "Color"):
        return [int(v.r), int(v.g), int(v.b), int(v.a)]
    if _is(v, "Quat"):
        return [num(v.x, 5), num(v.y, 5), num(v.z, 5), num(v.w, 5)]
    if _is(v, "Transform"):
        try:
            return {
                "location": vec_json(v.translation),
                "rotation": rot_json(v.rotation.rotator()),
                "scale": vec_json(v.scale3d),
            }
        except Exception:
            return str(v)
    if _is(v, "Name") or _is(v, "Text"):
        return str(v)
    if _is(v, "EnumBase"):
        return getattr(v, "name", str(v))
    if _is(v, "Object"):
        try:
            return v.get_path_name()
        except Exception:
            return str(v)
    if isinstance(v, dict) or _is(v, "Map"):
        out = {}
        for i, (k, val) in enumerate(v.items()):
            if i >= 100:
                out["..."] = "%d more" % (len(v) - 100)
                break
            out[str(to_json(k, depth + 1))] = to_json(val, depth + 1)
        return out
    if isinstance(v, (list, tuple, set, frozenset)) or _is(v, "Array") or _is(v, "Set") or _is(v, "FixedArray"):
        items = list(v)
        out = [to_json(x, depth + 1) for x in items[:200]]
        if len(items) > 200:
            out.append("... %d more" % (len(items) - 200))
        return out
    if _is(v, "StructBase"):
        try:
            return v.export_text()
        except Exception:
            return str(v)
    return str(v)


# ---------------------------------------------------------------- JSON -> Unreal

def _seq(value, n, what):
    if isinstance(value, dict):
        return value
    if isinstance(value, (int, float)):
        return [value] * n
    if isinstance(value, (list, tuple)) and len(value) >= n:
        return [float(x) for x in value]
    raise BridgeError("bad_value", "%s must be %d numbers, got %r" % (what, n, value))


def to_vector(value, what="vector"):
    if _is(value, "Vector"):
        return value
    s = _seq(value, 3, what)
    if isinstance(s, dict):
        g = lambda k: float(s.get(k, s.get(k.upper(), 0.0)))
        return unreal.Vector(g("x"), g("y"), g("z"))
    return unreal.Vector(s[0], s[1], s[2])


def to_rotator(value, what="rotation"):
    if _is(value, "Rotator"):
        return value
    if isinstance(value, (int, float)):
        value = [0.0, float(value), 0.0]  # a single number means yaw
    s = _seq(value, 3, what + " [pitch, yaw, roll]")
    r = unreal.Rotator()
    if isinstance(s, dict):
        r.pitch = float(s.get("pitch", 0.0))
        r.yaw = float(s.get("yaw", 0.0))
        r.roll = float(s.get("roll", 0.0))
    else:
        r.pitch, r.yaw, r.roll = s[0], s[1], s[2]
    return r


def to_linear_color(value, what="color"):
    if _is(value, "LinearColor"):
        return value
    if isinstance(value, str):
        h = value.lstrip("#")
        if len(h) in (6, 8):
            vals = [int(h[i:i + 2], 16) / 255.0 for i in range(0, len(h), 2)]
            value = vals
    if isinstance(value, dict):
        return unreal.LinearColor(float(value.get("r", 0)), float(value.get("g", 0)), float(value.get("b", 0)), float(value.get("a", 1)))
    if isinstance(value, (list, tuple)) and len(value) in (3, 4):
        v = [float(x) for x in value] + ([1.0] if len(value) == 3 else [])
        return unreal.LinearColor(v[0], v[1], v[2], v[3])
    raise BridgeError("bad_value", "%s must be [r,g,b(,a)] in 0..1 or '#rrggbb', got %r" % (what, value))


def to_color(value):
    lc = to_linear_color(value)
    c = unreal.Color()
    vals = [lc.r, lc.g, lc.b, lc.a]
    scale = 1.0 if all(x > 1.0 or x == 0 for x in vals) and any(x > 1.0 for x in vals) else 255.0
    c.r, c.g, c.b, c.a = [int(max(0, min(255, round(x * scale)))) for x in vals]
    return c


def to_bool(value):
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "on")
    return bool(value)


def to_enum(enum_type, value):
    if isinstance(value, enum_type):
        return value
    members = [m for m in dir(enum_type) if m.isupper() and not m.startswith("_")]
    if isinstance(value, int):
        for m in members:
            ev = getattr(enum_type, m)
            try:
                if int(getattr(ev, "value", ev)) == value:
                    return ev
            except Exception:
                pass
    key = str(value).split("::")[-1].strip()
    cands = [key.upper(), re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", key).upper(), key.upper().replace(" ", "_")]
    for c in cands:
        if c in members:
            return getattr(enum_type, c)
        for m in members:  # allow dropping prefixes like BLEND_ / MP_
            if m.endswith("_" + c):
                return getattr(enum_type, m)
    raise BridgeError("bad_value", "'%s' is not a valid %s. Valid: %s" % (value, enum_type.__name__, ", ".join(members[:40])))


def resolve_object(s, want_class=False):
    """Path string -> UObject/UClass (asset, class or actor). Returns None if not found."""
    if not isinstance(s, str) or not s:
        return None
    s = s.strip()
    if ":" in s and "." in s:  # actor or subobject path
        try:
            return unreal.find_object(None, s)
        except Exception:
            return None
    if s.startswith("/Script/") or want_class or s.endswith("_C"):
        for cand in (s, s if s.endswith("_C") else s + "_C"):
            try:
                cls = unreal.load_class(None, cand)
                if cls is not None:
                    return cls
            except Exception:
                pass
        if s.startswith("/Script/"):
            return None
    try:
        p = compat.norm_asset_path(s)
    except BridgeError:
        return None
    if not compat.asset_exists(p):
        return None
    obj = unreal.EditorAssetLibrary.load_asset(p)
    if want_class and obj is not None and _is(obj, "Blueprint"):
        try:
            return unreal.EditorAssetLibrary.load_blueprint_class(p)
        except Exception:
            pass
    return obj


def coerce(value, current, name="value"):
    """Convert JSON ``value`` to the Unreal type of ``current`` (the property's present value)."""
    if value is None:
        return None
    if current is None:
        if isinstance(value, str) and (value.startswith("/") or value.endswith("_C")):
            obj = resolve_object(value)
            if obj is None:
                raise BridgeError("not_found", "cannot resolve '%s' for %s" % (value, name))
            return obj
        return value
    if _is(current, "EnumBase"):
        return to_enum(type(current), value)
    if isinstance(current, bool):
        return to_bool(value)
    if isinstance(current, int):
        return int(value)
    if isinstance(current, float):
        return float(value)
    if isinstance(current, str):
        return str(value)
    if _is(current, "Name") or _is(current, "Text"):
        return str(value)
    if _is(current, "Vector"):
        return to_vector(value, name)
    if _is(current, "Rotator"):
        return to_rotator(value, name)
    if _is(current, "Vector2D"):
        s = _seq(value, 2, name)
        return unreal.Vector2D(float(s[0]), float(s[1])) if not isinstance(s, dict) else unreal.Vector2D(float(s.get("x", 0)), float(s.get("y", 0)))
    if _is(current, "LinearColor"):
        return to_linear_color(value, name)
    if _is(current, "Color"):
        return to_color(value)
    if _is(current, "Object") or _is(current, "Class"):
        if _is(value, "Object"):
            return value
        obj = resolve_object(str(value), want_class=_is(current, "Class"))
        if obj is None:
            raise BridgeError("not_found", "cannot resolve '%s' for %s" % (value, name))
        return obj
    if _is(current, "Transform") and isinstance(value, dict):
        t = unreal.Transform()
        t.translation = to_vector(value.get("location", [0, 0, 0]))
        t.rotation = to_rotator(value.get("rotation", [0, 0, 0])).quaternion()
        t.scale3d = to_vector(value.get("scale", [1, 1, 1]))
        return t
    if _is(current, "StructBase"):
        if isinstance(value, dict):
            s = type(current)()
            try:
                s = current.copy()
            except Exception:
                pass
            for k, v in value.items():
                set_prop(s, k, v)
            return s
        if isinstance(value, str) and hasattr(current, "import_text"):
            s = type(current)()
            s.import_text(value)
            return s
        return value
    if isinstance(current, (list, tuple)) or _is(current, "Array") or _is(current, "Set"):
        if not isinstance(value, (list, tuple)):
            value = [value]
        items = list(current)
        proto = items[0] if items else None
        return [coerce(x, proto, name + "[]") for x in value]
    return value


# ---------------------------------------------------------------- property access

def name_variants(name):
    out = [name]
    s = name
    if len(s) > 1 and s[0] == "b" and s[1].isupper():
        s = s[1:]
    snake = re.sub(r"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])", "_", s).lower()
    for c in (snake, name.lower()):
        if c not in out:
            out.append(c)
    return out


_DOC_LINE = re.compile(r"-\s+``(\w+)``\s+\(([^)]*)\):\s+\[(Read-Write|Read-Only)\]\s*([^\n]*)")
_DESC_DOC = re.compile(r"^\(([^)]*)\):\s+\[(Read-Write|Read-Only)\]\s*(.*)", re.S)


def list_properties(obj):
    """Editor-visible properties of an object (parsed from the generated Python docs)."""
    cls = obj if isinstance(obj, type) else type(obj)
    seen = {}
    for k in getattr(cls, "__mro__", [cls]):
        doc = k.__dict__.get("__doc__") or ""
        for m in _DOC_LINE.finditer(doc):
            n = m.group(1)
            if n not in seen:
                seen[n] = {"name": n, "type": m.group(2), "access": "rw" if m.group(3) == "Read-Write" else "ro", "doc": m.group(4).strip()[:120]}
        for n, attr in k.__dict__.items():
            if n.startswith("_") or n in seen:
                continue
            d = getattr(attr, "__doc__", None)
            if not isinstance(d, str):
                continue
            m = _DESC_DOC.match(d.strip())
            if m:
                seen[n] = {"name": n, "type": m.group(1), "access": "rw" if m.group(2) == "Read-Write" else "ro", "doc": m.group(3).strip().split("\n")[0][:120]}
    return list(seen.values())


def get_prop(obj, name):
    """Return (resolved_name, value) for property ``name`` on ``obj``."""
    last = None
    for n in name_variants(name):
        try:
            return n, obj.get_editor_property(n)
        except Exception as exc:
            last = exc
    names = [p["name"] for p in list_properties(obj)]
    raise BridgeError(
        "no_property",
        "%s has no readable property '%s'%s" % (type(obj).__name__, name, (": " + str(last)) if names == [] else ""),
        suggestions=suggest(name, names),
    )


def set_prop(obj, name, value):
    n, current = get_prop(obj, name)
    v = coerce(value, current, n)
    try:
        obj.set_editor_property(n, v)
    except Exception as exc:
        raise BridgeError("set_failed", "could not set %s.%s: %s" % (type(obj).__name__, n, exc))
    try:
        return n, obj.get_editor_property(n)
    except Exception:
        return n, v


def find_component(actor, name):
    try:
        comps = list(actor.get_components_by_class(unreal.ActorComponent))
    except Exception:
        return None
    low = name.lower()
    if low in ("root", "rootcomponent", "root_component"):
        try:
            return actor.get_editor_property("root_component")
        except Exception:
            return comps[0] if comps else None
    for test in (
        lambda c: c.get_name() == name,
        lambda c: c.get_name().lower() == low,
        lambda c: c.get_class().get_name().lower() == low,
        lambda c: c.get_name().lower().startswith(low),
        lambda c: c.get_class().get_name().lower().startswith(low),
    ):
        for c in comps:
            try:
                if test(c):
                    return c
            except Exception:
                pass
    return None


def set_path(obj, path, value):
    """Set ``a.b.c`` where segments may be components (on actors), sub-objects or struct fields."""
    parts = path.split(".")
    target = obj
    for i, part in enumerate(parts[:-1]):
        if _is(target, "Actor"):
            comp = find_component(target, part)
            if comp is not None:
                target = comp
                continue
        n, cur = get_prop(target, part)
        if _is(cur, "Object"):
            target = cur
            continue
        if _is(cur, "StructBase"):
            set_path(cur, ".".join(parts[i + 1:]), value)
            try:
                target.set_editor_property(n, cur)
            except Exception as exc:
                raise BridgeError("set_failed", "could not write struct %s: %s" % (n, exc))
            return to_json(get_prop(target, n)[1])
        raise BridgeError("bad_path", "'%s' in '%s' is neither a component, object nor struct" % (part, path))
    if _is(target, "Actor") and len(parts) == 1:
        try:
            _, v = set_prop(target, parts[0], value)
            return to_json(v)
        except BridgeError as exc:
            # fall back to the root component for things like 'mobility'
            root = find_component(target, "root")
            if root is None or exc.code != "no_property":
                raise
            try:
                _, v = set_prop(root, parts[0], value)
                return to_json(v)
            except BridgeError:
                raise exc
    _, v = set_prop(target, parts[-1], value)
    return to_json(v)


def get_path(obj, path):
    target = obj
    parts = path.split(".")
    for i, part in enumerate(parts):
        if _is(target, "Actor") and i < len(parts) - 1:
            comp = find_component(target, part)
            if comp is not None:
                target = comp
                continue
        _, target = get_prop(target, part)
    return target


def resolve_class(name):
    """'PointLight', 'APointLight', '/Script/Engine.PointLight', '/Game/BP_Door' -> class."""
    if not isinstance(name, str):
        return name
    s = name.strip()
    if s.startswith("/"):
        obj = resolve_object(s, want_class=True)
        if obj is None:
            raise BridgeError("not_found", "class or blueprint '%s' not found" % s)
        return obj
    for cand in (s, s[1:] if len(s) > 1 and s[0] in "AU" and s[1].isupper() else None):
        if cand and isinstance(getattr(unreal, cand, None), type):
            return getattr(unreal, cand)
    for pkg in ("Engine", "CinematicCamera", "Niagara", "UMG"):
        try:
            cls = unreal.load_class(None, "/Script/%s.%s" % (pkg, s))
            if cls is not None:
                return cls
        except Exception:
            pass
    names = [n for n in dir(unreal) if n[:1].isupper()]
    raise BridgeError("not_found", "unknown class '%s'" % s, suggestions=suggest(s, names))
