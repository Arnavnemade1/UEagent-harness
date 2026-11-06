"""In-memory stand-in for Unreal Editor's `unreal` Python module (test double).

Implements the subset of the editor scripting API the bridge uses, with the same
names/signatures, an undo buffer, dirty packages, a UE-format log file, a slate
tick and an on-disk Content folder. It is NOT a renderer or a full engine.
"""
import copy as _copy
import math
import os
import struct
import time
import zlib

# ------------------------------------------------------------------ fake runtime state

_S = {
    "project_dir": None, "name": "FakeGame", "ticks": {}, "next_handle": 1, "shutdown": [],
    "undo": [], "redo": [], "txn": None, "selected": [], "assets": {}, "dirty": set(),
    "world": None, "pie": False, "pie_pending": 0, "pie_world": None, "camera": None,
    "pending_files": [], "log_file": None, "frame": 0, "game_view": False, "menus": {},
}


def _fake_init(project_dir, name="FakeGame"):
    _S["project_dir"] = os.path.abspath(project_dir)
    _S["name"] = name
    for d in ("Saved/Logs", "Content/Maps"):
        os.makedirs(os.path.join(project_dir, d), exist_ok=True)
    _S["log_file"] = os.path.join(project_dir, "Saved", "Logs", name + ".log")
    open(_S["log_file"], "w").close()
    _S["world"] = World("Main", "/Game/Maps/Main")
    _S["camera"] = (Vector(-800, 0, 400), _rot(-20, 0, 0))
    _write_log("LogInit", "Display", "Fake editor started")


def _fake_tick(dt=1.0 / 120):
    _S["frame"] += 1
    if _S["pie_pending"]:
        _S["pie_pending"] -= 1
        if _S["pie_pending"] == 0:
            _S["pie"] = True
            _S["pie_world"] = World("UEDPIE_0_Main", "/Game/Maps/UEDPIE_0_Main")
            _write_log("LogPlayLevel", "Display", "PIE: play in editor started")
            _write_log("LogScript", "Warning", "Accessed None trying to read property Door (fake gameplay warning)")
    for path, data, due in list(_S["pending_files"]):
        if _S["frame"] >= due:
            with open(path, "wb") as f:
                f.write(data)
            _S["pending_files"].remove((path, data, due))
    for fn in list(_S["ticks"].values()):
        fn(dt)


def _fake_shutdown():
    for fn in _S["shutdown"]:
        fn()


def _write_log(cat, sev, msg):
    if not _S["log_file"]:
        return
    t = time.time()
    stamp = time.strftime("%Y.%m.%d-%H.%M.%S", time.localtime(t)) + ":%03d" % int((t % 1) * 1000)
    with open(_S["log_file"], "a") as f:
        f.write("[%s][%3d]%s: %s%s\n" % (stamp, _S["frame"] % 1000, cat, (sev + ": ") if sev and sev != "Log" else "", msg))


def log(msg):
    _write_log("LogPython", "Log", str(msg))


def log_warning(msg):
    _write_log("LogPython", "Warning", str(msg))


def log_error(msg):
    _write_log("LogPython", "Error", str(msg))


def register_slate_post_tick_callback(fn):
    h = _S["next_handle"]
    _S["next_handle"] += 1
    _S["ticks"][h] = fn
    return h


def unregister_slate_post_tick_callback(h):
    _S["ticks"].pop(h, None)


def register_python_shutdown_callback(fn):
    _S["shutdown"].append(fn)


# ------------------------------------------------------------------ undo buffer

class ScopedEditorTransaction(object):
    def __init__(self, description):
        self.description = str(description)

    def __enter__(self):
        _S["txn"] = {"desc": self.description, "undo": []}
        return self

    def __exit__(self, *exc):
        t, _S["txn"] = _S["txn"], None
        if t and t["undo"]:  # empty transactions are discarded, like UE
            _S["undo"].append(t)
            _S["redo"] = []
        return False


def _record(fn):
    if _S["txn"] is not None:
        _S["txn"]["undo"].append(fn)


def _undo():
    if not _S["undo"]:
        return
    t = _S["undo"].pop()
    for fn in reversed(t["undo"]):
        fn()
    _S["redo"].append(t)
    _write_log("LogEditorTransaction", "Log", "Undo %s" % t["desc"])


# ------------------------------------------------------------------ values

class StructBase(object):
    _fields = ()

    def __init__(self, *args, **kw):
        for i, f in enumerate(self._fields):
            setattr(self, f, args[i] if i < len(args) else kw.get(f, 0.0))

    def copy(self):
        return _copy.copy(self)

    def export_text(self):
        return "(%s)" % ",".join("%s=%s" % (f.upper() if len(f) == 1 else f.capitalize(), getattr(self, f)) for f in self._fields)

    def get_editor_property(self, n):
        if n in self._fields:
            return getattr(self, n)
        raise Exception("no property %s" % n)

    def set_editor_property(self, n, v, *_):
        if n not in self._fields:
            raise Exception("no property %s" % n)
        setattr(self, n, v)

    def __eq__(self, o):
        return type(self) is type(o) and all(getattr(self, f) == getattr(o, f) for f in self._fields)

    def __repr__(self):
        return "<%s %s>" % (type(self).__name__, self.export_text())


class Vector(StructBase):
    _fields = ("x", "y", "z")

    def __init__(self, x=0.0, y=0.0, z=0.0):
        self.x, self.y, self.z = float(x), float(y), float(z)

    def __add__(self, o):
        return Vector(self.x + o.x, self.y + o.y, self.z + o.z)

    def __sub__(self, o):
        return Vector(self.x - o.x, self.y - o.y, self.z - o.z)

    def __mul__(self, s):
        return Vector(self.x * s, self.y * s, self.z * s)


class Vector2D(StructBase):
    _fields = ("x", "y")


class Vector4(StructBase):
    _fields = ("x", "y", "z", "w")


class Quat(StructBase):
    _fields = ("x", "y", "z", "w")

    def rotator(self):
        return getattr(self, "_rot", Rotator())


class Rotator(StructBase):
    # NOTE: like the real API the positional order is (roll, pitch, yaw)
    _fields = ("roll", "pitch", "yaw")

    def __init__(self, roll=0.0, pitch=0.0, yaw=0.0):
        self.roll, self.pitch, self.yaw = float(roll), float(pitch), float(yaw)

    def quaternion(self):
        q = Quat(0, 0, 0, 1)
        q._rot = self
        return q


def _rot(p, y, r):
    return Rotator(roll=r, pitch=p, yaw=y)


class LinearColor(StructBase):
    _fields = ("r", "g", "b", "a")

    def __init__(self, r=0.0, g=0.0, b=0.0, a=1.0):
        self.r, self.g, self.b, self.a = float(r), float(g), float(b), float(a)


class Color(StructBase):
    _fields = ("b", "g", "r", "a")


class Transform(StructBase):
    def __init__(self):
        self.translation = Vector()
        self.rotation = Quat(0, 0, 0, 1)
        self.scale3d = Vector(1, 1, 1)


class Name(str):
    pass


class Text(str):
    def is_empty(self):
        return len(self) == 0


class Array(list):
    pass


class Map(dict):
    pass


class Set(set):
    pass


class FixedArray(list):
    pass


class EnumBase(object):
    def __init__(self, name, value):
        self.name = name
        self.value = value

    def __eq__(self, o):
        return isinstance(o, EnumBase) and type(o) is type(self) and o.value == self.value

    def __hash__(self):
        return hash((type(self).__name__, self.value))

    def __repr__(self):
        return "<%s.%s>" % (type(self).__name__, self.name)

    def __str__(self):
        return "%s.%s" % (type(self).__name__, self.name)


def _enum(name, members):
    cls = type(name, (EnumBase,), {})
    for i, m in enumerate(members):
        setattr(cls, m, cls(m, i))
    return cls


ComponentMobility = _enum("ComponentMobility", ["STATIC", "STATIONARY", "MOVABLE"])
AttachmentRule = _enum("AttachmentRule", ["KEEP_RELATIVE", "KEEP_WORLD", "SNAP_TO_TARGET"])
DetachmentRule = _enum("DetachmentRule", ["KEEP_RELATIVE", "KEEP_WORLD"])
BlendMode = _enum("BlendMode", ["BLEND_OPAQUE", "BLEND_MASKED", "BLEND_TRANSLUCENT", "BLEND_ADDITIVE"])
MaterialProperty = _enum("MaterialProperty", ["MP_BASE_COLOR", "MP_METALLIC", "MP_SPECULAR", "MP_ROUGHNESS", "MP_EMISSIVE_COLOR", "MP_OPACITY", "MP_NORMAL", "MP_AMBIENT_OCCLUSION"])
MaterialSamplerType = _enum("MaterialSamplerType", ["SAMPLERTYPE_COLOR", "SAMPLERTYPE_NORMAL"])
PropertyAccessChangeNotifyMode = _enum("PropertyAccessChangeNotifyMode", ["DEFAULT", "NEVER", "ALWAYS"])
AppMsgType = _enum("AppMsgType", ["OK", "YES_NO"])
MultiBlockType = _enum("MultiBlockType", ["MENU_ENTRY", "TOOL_BAR_BUTTON"])
ToolMenuStringCommandType = _enum("ToolMenuStringCommandType", ["COMMAND", "PYTHON", "CUSTOM"])
BlueprintStatus = _enum("BlueprintStatus", ["BS_UNKNOWN", "BS_DIRTY", "BS_ERROR", "BS_UP_TO_DATE"])
FBXImportType = _enum("FBXImportType", ["FBXIT_STATIC_MESH", "FBXIT_SKELETAL_MESH"])


# ------------------------------------------------------------------ objects

def _doc_for(cls):
    lines = []
    for n, (t, v) in cls.__dict__.get("_props", {}).items():
        lines.append("- ``%s`` (%s):  [Read-Write] %s: fake property" % (n, t, n.replace("_", " ").title()))
    return "Fake %s\n\n**Editor Properties:** (see get_editor_property/set_editor_property)\n\n%s" % (cls.__name__, "\n".join(lines))


class _Meta(type):
    def __init__(cls, name, bases, ns):
        super().__init__(name, bases, ns)
        if "_props" in ns:
            cls.__doc__ = _doc_for(cls)


class _ObjectBase(object):
    pass


_counter = {}


def _unique(base):
    _counter[base] = _counter.get(base, -1) + 1
    return "%s_%d" % (base, _counter[base])


class Object(_ObjectBase, metaclass=_Meta):
    _props = {}

    def __init__(self, name=None, outer=None):
        self._name = name or _unique(type(self).__name__)
        self._outer = outer
        vals = {}
        for k in reversed(type(self).__mro__):
            for n, (t, v) in k.__dict__.get("_props", {}).items():
                vals[n] = _copy.copy(v)
        self._values = vals

    def __getattr__(self, name):  # real UE exposes editor properties as attributes too
        vals = self.__dict__.get("_values")
        if vals is not None and name in vals:
            return vals[name]
        raise AttributeError("'%s' object has no attribute '%s'" % (type(self).__name__, name))

    def get_name(self):
        return self._name

    def get_path_name(self):
        return getattr(self, "_path", None) or ("/Script/Fake.%s" % self._name)

    def get_class(self):
        return Class(type(self))

    @classmethod
    def static_class(cls):
        return Class(cls)

    def _package(self):
        return None

    def modify(self, always_mark_dirty=True):
        snap = _copy.copy(self._values)
        extra = self._snapshot()
        _record(lambda: (self._values.update(snap), self._restore(extra)))
        pkg = self._package()
        if pkg:
            _S["dirty"].add(pkg)
        return True

    def _snapshot(self):
        return None

    def _restore(self, s):
        pass

    def get_editor_property(self, name):
        if name in self._values:
            return self._values[name]
        raise Exception("Failed to find property '%s' for attribute '%s' on '%s'" % (name, name, type(self).__name__))

    def set_editor_property(self, name, value, notify_mode=None):
        if name not in self._values:
            raise Exception("Failed to find property '%s' on '%s'" % (name, type(self).__name__))
        cur = self._values[name]
        if isinstance(cur, bool) and not isinstance(value, bool):
            raise TypeError("expected bool for %s" % name)
        if isinstance(cur, float) and not isinstance(value, (int, float)):
            raise TypeError("expected float for %s" % name)
        if isinstance(cur, StructBase) and not isinstance(value, type(cur)):
            raise TypeError("expected %s for %s" % (type(cur).__name__, name))
        if notify_mode != PropertyAccessChangeNotifyMode.NEVER:
            self.modify()
        self._values[name] = value


class Class(Object):
    def __init__(self, pytype):
        Object.__init__(self, pytype.__name__)
        self._t = pytype

    def get_name(self):
        return getattr(self._t, "_class_name", self._t.__name__)

    def get_path_name(self):
        return getattr(self._t, "_class_path", "/Script/Engine.%s" % self._t.__name__)

    def is_child_of(self, other):
        o = other._t if isinstance(other, Class) else other
        return issubclass(self._t, o)

    def __eq__(self, o):
        return isinstance(o, Class) and o._t is self._t

    def __hash__(self):
        return hash(self._t)


class ActorComponent(Object):
    _props = {}

    def _package(self):
        return self._outer._package() if self._outer is not None else None


class SceneComponent(ActorComponent):
    _props = {"relative_location": ("Vector", Vector()), "mobility": ("ComponentMobility", ComponentMobility.STATIC), "visible": ("bool", True)}


class PrimitiveComponent(SceneComponent):
    _props = {"cast_shadow": ("bool", True), "override_materials": ("Array[MaterialInterface]", [])}

    def is_visible(self):
        return bool(self._values.get("visible", True))


class StaticMeshComponent(PrimitiveComponent):
    _props = {"static_mesh": ("StaticMesh", None)}

    def __init__(self, *a, **k):
        PrimitiveComponent.__init__(self, *a, **k)
        self._materials = []

    def set_static_mesh(self, m):
        self.modify()
        self._values["static_mesh"] = m
        return True

    def set_material(self, i, m):
        self.modify()
        while len(self._materials) <= i:
            self._materials.append(None)
        self._materials[i] = m

    def get_materials(self):
        return list(self._materials)

    def get_material(self, i):
        return self._materials[i] if i < len(self._materials) else None

    def get_num_materials(self):
        return max(1, len(self._materials))

    def _snapshot(self):
        return list(self._materials)

    def _restore(self, s):
        self._materials = s


class LightComponent(SceneComponent):
    _props = {"intensity": ("float", 5000.0), "light_color": ("Color", Color(255, 255, 255, 255)), "cast_shadows": ("bool", True)}


class PointLightComponent(LightComponent):
    _props = {"attenuation_radius": ("float", 1000.0)}


class Actor(Object):
    _props = {"tags": ("Array[Name]", []), "hidden": ("bool", False), "root_component": ("SceneComponent", None), "can_be_damaged": ("bool", True)}
    _components = (("DefaultSceneRoot", SceneComponent),)

    def __init__(self, name=None, world=None):
        Object.__init__(self, name)
        self._world = world
        self._label = self._name
        self._loc = Vector()
        self._rot = Rotator()
        self._scale = Vector(1, 1, 1)
        self._folder = ""
        self._parent = None
        self._comps = []
        for cname, ccls in self._components:
            c = ccls(cname, self)
            self._comps.append(c)
        if self._comps:
            self._values["root_component"] = self._comps[0]

    def _package(self):
        return self._world.get_package_name() if self._world else None

    def get_path_name(self):
        w = self._world
        return "%s.%s:PersistentLevel.%s" % (w._pkg, w._name, self._name) if w else self._name

    def _snapshot(self):
        return (_copy.copy(self._loc), _copy.copy(self._rot), _copy.copy(self._scale), self._label, self._folder, self._parent)

    def _restore(self, s):
        self._loc, self._rot, self._scale, self._label, self._folder, self._parent = s

    def get_actor_label(self):
        return self._label

    def set_actor_label(self, label):
        self.modify()
        self._label = str(label)

    def get_actor_location(self):
        return _copy.copy(self._loc)

    def get_actor_rotation(self):
        return _copy.copy(self._rot)

    def get_actor_scale3d(self):
        return _copy.copy(self._scale)

    def set_actor_location(self, loc, sweep, teleport):
        self._loc = _copy.copy(loc)
        _S["dirty"].add(self._package())
        return True

    def set_actor_rotation(self, rot, teleport):
        self._rot = _copy.copy(rot)
        return True

    def set_actor_scale3d(self, s):
        self._scale = _copy.copy(s)

    def get_folder_path(self):
        return Name(self._folder or "None")

    def set_folder_path(self, p):
        self.modify()
        self._folder = str(p)

    def get_components_by_class(self, cls):
        return [c for c in self._comps if isinstance(c, cls)]

    def get_component_by_class(self, cls):
        cs = self.get_components_by_class(cls)
        return cs[0] if cs else None

    def attach_to_actor(self, parent, socket, lr, rr, sr, weld):
        self.modify()
        self._parent = parent
        return True

    def detach_from_actor(self, lr, rr, sr):
        self.modify()
        self._parent = None

    def get_attach_parent_actor(self):
        return self._parent

    def get_actor_bounds(self, only_colliding):
        e = Vector(50 * self._scale.x, 50 * self._scale.y, 50 * self._scale.z)
        return self.get_actor_location(), e

    def is_hidden_ed(self):
        return bool(self._values.get("hidden"))

    def set_is_temporarily_hidden_in_editor(self, h):
        self.modify()
        self._values["hidden"] = bool(h)


class StaticMeshActor(Actor):
    _props = {"static_mesh_component": ("StaticMeshComponent", None)}
    _components = (("StaticMeshComponent0", StaticMeshComponent),)

    def __init__(self, *a, **k):
        Actor.__init__(self, *a, **k)
        self._values["static_mesh_component"] = self._comps[0]


class Light(Actor):
    _props = {"light_component": ("LightComponent", None)}


class PointLight(Light):
    _props = {"point_light_component": ("PointLightComponent", None)}
    _components = (("LightComponent0", PointLightComponent),)

    def __init__(self, *a, **k):
        Actor.__init__(self, *a, **k)
        self._values["light_component"] = self._comps[0]
        self._values["point_light_component"] = self._comps[0]


class CameraActor(Actor):
    _props = {"auto_activate_for_player": ("bool", False)}


class PlayerStart(Actor):
    _props = {}


class World(Object):
    def __init__(self, name, pkg):
        Object.__init__(self, name)
        self._pkg = pkg
        self._path = "%s.%s" % (pkg, name)
        self.actors = []

    def get_package_name(self):
        return self._pkg


# ------------------------------------------------------------------ assets

class _Asset(Object):
    def _package(self):
        return getattr(self, "_pkg", None)


class StaticMesh(_Asset):
    _props = {"lod_group": ("Name", Name("None"))}


class Texture(_Asset):
    _props = {"srgb": ("bool", True)}


class Texture2D(Texture):
    _props = {}


class SoundWave(_Asset):
    _props = {"volume": ("float", 1.0)}


class MaterialInterface(_Asset):
    _props = {}


class Material(MaterialInterface):
    _props = {"two_sided": ("bool", False), "blend_mode": ("BlendMode", BlendMode.BLEND_OPAQUE)}

    def __init__(self, *a, **k):
        MaterialInterface.__init__(self, *a, **k)
        self.expressions = []
        self.connections = {}


class MaterialInstanceConstant(MaterialInterface):
    _props = {"parent": ("MaterialInterface", None)}

    def __init__(self, *a, **k):
        MaterialInterface.__init__(self, *a, **k)
        self.params = {}


class MaterialExpression(Object):
    _props = {}


class MaterialExpressionConstant(MaterialExpression):
    _props = {"r": ("float", 0.0)}


class MaterialExpressionConstant3Vector(MaterialExpression):
    _props = {"constant": ("LinearColor", LinearColor())}


class MaterialExpressionTextureSample(MaterialExpression):
    _props = {"texture": ("Texture", None), "sampler_type": ("MaterialSamplerType", MaterialSamplerType.SAMPLERTYPE_COLOR)}


class Blueprint(_Asset):
    _props = {"parent_class": ("Class", None), "status": ("BlueprintStatus", BlueprintStatus.BS_DIRTY)}

    def __init__(self, *a, **k):
        _Asset.__init__(self, *a, **k)
        self.subobjects = []
        self.variables = {}
        self._gen = None


class WidgetBlueprint(Blueprint):
    _props = {}


class DataAsset(_Asset):
    _props = {}


class PrimaryDataAsset(DataAsset):
    _props = {}


class UserWidget(Object):
    _props = {}


class Factory(Object):
    _props = {}


class MaterialFactoryNew(Factory):
    _props = {}


class MaterialInstanceConstantFactoryNew(Factory):
    _props = {"initial_parent": ("MaterialInterface", None)}


class BlueprintFactory(Factory):
    _props = {"parent_class": ("Class", None)}


class WorldFactory(Factory):
    _props = {}


class _EditorPerformanceSettings(Object):
    # UE 5.8 does not expose this class to Python: reachable only via load_class, native property names
    _props = {"bThrottleCPUWhenNotForeground": ("bool", True)}
    _class_name = "EditorPerformanceSettings"
    _class_path = "/Script/UnrealEd.EditorPerformanceSettings"


_HIDDEN_CLASSES = {"EditorPerformanceSettings": _EditorPerformanceSettings}


_DEFAULTS = {}


def get_default_object(cls):
    if isinstance(cls, Class):
        cls = cls._t
    if cls not in _DEFAULTS:
        o = cls("Default__%s" % cls.__name__)
        _DEFAULTS[cls] = o
    return _DEFAULTS[cls]


def _register_asset(obj, path):
    obj._pkg = path
    obj._path = "%s.%s" % (path, path.rsplit("/", 1)[-1])
    obj._name = path.rsplit("/", 1)[-1]
    _S["assets"][path] = obj
    _S["dirty"].add(path)
    return obj


def _content_file(path, ext=".uasset"):
    if path.startswith("/Game/"):
        return os.path.join(_S["project_dir"], "Content", *path[len("/Game/"):].split("/")) + ext
    return None


def _save(path):
    f = _content_file(path, ".umap" if isinstance(_S["assets"].get(path), World) else ".uasset")
    if f:
        os.makedirs(os.path.dirname(f), exist_ok=True)
        with open(f, "wb") as fh:
            fh.write(b"\xc1\x83\x2a\x9e fake uasset " + path.encode())
    _S["dirty"].discard(path)


def _seed_engine_assets():
    for n in ("Cube", "Sphere", "Cylinder", "Cone", "Plane"):
        m = StaticMesh(n)
        m._pkg = "/Engine/BasicShapes/" + n
        m._path = "%s.%s" % (m._pkg, n)
        _S["assets"][m._pkg] = m
    base = Material("WorldGridMaterial")
    base._pkg = "/Engine/EngineMaterials/WorldGridMaterial"
    base._path = base._pkg + ".WorldGridMaterial"
    _S["assets"][base._pkg] = base


_seed_engine_assets()


class EditorAssetLibrary(object):
    @staticmethod
    def does_asset_exist(path):
        return path.split(".")[0] in _S["assets"]

    @staticmethod
    def load_asset(path):
        return _S["assets"].get(path.split(".")[0])

    @staticmethod
    def load_blueprint_class(path):
        bp = _S["assets"].get(path.split(".")[0])
        if not isinstance(bp, Blueprint):
            return None
        if bp._gen is None:
            parent = bp.get_editor_property("parent_class")
            ptype = parent._t if isinstance(parent, Class) else (parent or Actor)
            gen = type(bp._name + "_C", (ptype,), {"_class_name": bp._name + "_C", "_class_path": bp._path + "_C", "_props": {v: ("var", None) for v in bp.variables}})
            bp._gen = Class(gen)
        return bp._gen

    @staticmethod
    def save_asset(path, only_if_is_dirty=True):
        if path not in _S["assets"]:
            return False
        _save(path)
        return True

    @staticmethod
    def save_loaded_asset(obj, only_if_is_dirty=True):
        _save(obj._pkg)
        return True

    @staticmethod
    def delete_asset(path):
        if _S["assets"].pop(path, None) is None:
            return False
        f = _content_file(path)
        if f and os.path.exists(f):
            os.remove(f)
        _S["dirty"].discard(path)
        return True

    @staticmethod
    def duplicate_asset(src, dst):
        o = _S["assets"].get(src)
        if o is None or dst in _S["assets"]:
            return None
        n = _copy.copy(o)
        n._values = _copy.copy(o._values)
        _register_asset(n, dst)
        _save(dst)
        return n

    @staticmethod
    def rename_asset(src, dst):
        o = _S["assets"].pop(src, None)
        if o is None:
            return False
        f = _content_file(src)
        if f and os.path.exists(f):
            os.remove(f)
        _register_asset(o, dst)
        _save(dst)
        return True

    @staticmethod
    def make_directory(path):
        f = _content_file(path, "")
        os.makedirs(f, exist_ok=True)
        return True

    @staticmethod
    def does_directory_exist(path):
        f = _content_file(path, "")
        return bool(f) and os.path.isdir(f)

    @staticmethod
    def delete_directory(path):
        import shutil

        for p in [p for p in _S["assets"] if p.startswith(path + "/")]:
            _S["assets"].pop(p)
        shutil.rmtree(_content_file(path, ""), ignore_errors=True)
        return True

    @staticmethod
    def list_assets(path, recursive=True, include_folder=False):
        return [p for p in _S["assets"] if p.startswith(path + "/")]

    @staticmethod
    def sync_browser_to_objects(paths):
        return None


class AssetTools(object):
    def create_asset(self, name, path, cls, factory):
        full = "%s/%s" % (path, name)
        if full in _S["assets"]:
            return None
        obj = cls(name)
        if isinstance(factory, BlueprintFactory):
            obj.set_editor_property("parent_class", factory.get_editor_property("parent_class"))
            obj.subobjects = [{"name": "DefaultSceneRoot", "obj": SceneComponent("DefaultSceneRoot")}]
        if isinstance(factory, MaterialInstanceConstantFactoryNew):
            obj._values["parent"] = factory.get_editor_property("initial_parent")
        _register_asset(obj, full)
        return obj

    def import_asset_tasks(self, tasks):
        for t in tasks:
            fn = t.get_editor_property("filename")
            ext = os.path.splitext(fn)[1].lower()
            cls = {".png": Texture2D, ".jpg": Texture2D, ".wav": SoundWave, ".fbx": StaticMesh, ".obj": StaticMesh}.get(ext)
            if cls is None or not os.path.exists(fn):
                _write_log("LogAssetTools", "Error", "Failed to import '%s'" % fn)
                continue
            name = t.get_editor_property("destination_name") or os.path.splitext(os.path.basename(fn))[0]
            full = "%s/%s" % (t.get_editor_property("destination_path"), name)
            obj = cls(name)
            obj._values["asset_import_data"] = _ImportData(fn)
            _register_asset(obj, full)
            if t.get_editor_property("save"):
                _save(full)
            t._values["imported_object_paths"] = [obj._path]


class _ImportData(object):
    def __init__(self, f):
        self.f = f

    def get_first_filename(self):
        return self.f


class AssetToolsHelpers(object):
    _tools = AssetTools()

    @staticmethod
    def get_asset_tools():
        return AssetToolsHelpers._tools


class AssetImportTask(Object):
    _props = {"filename": ("str", ""), "destination_path": ("str", ""), "destination_name": ("str", ""), "replace_existing": ("bool", True),
              "automated": ("bool", False), "save": ("bool", False), "options": ("Object", None), "imported_object_paths": ("Array", [])}


class AssetExportTask(Object):
    _props = {"object": ("Object", None), "filename": ("str", ""), "automated": ("bool", False), "prompt": ("bool", True), "replace_identical": ("bool", False)}


class Exporter(object):
    @staticmethod
    def run_asset_export_task(task):
        with open(task.get_editor_property("filename"), "wb") as f:
            f.write(b"exported " + task.get_editor_property("object").get_path_name().encode())
        return True


class TopLevelAssetPath(StructBase):
    _fields = ("package_name", "asset_name")

    def __init__(self, package_name="", asset_name=""):
        self.package_name, self.asset_name = Name(package_name), Name(asset_name)


class ARFilter(StructBase):
    _fields = ("package_paths", "recursive_paths", "class_paths", "class_names", "recursive_classes")

    def __init__(self):
        self.package_paths, self.recursive_paths, self.class_paths, self.class_names, self.recursive_classes = [], False, [], [], False


class AssetData(object):
    def __init__(self, path, obj):
        self.package_name = Name(path)
        self.asset_name = Name(path.rsplit("/", 1)[-1])
        self.asset_class_path = TopLevelAssetPath("/Script/Engine", type(obj).__name__)


class AssetRegistryDependencyOptions(StructBase):
    _fields = ()


class AssetRegistry(object):
    def get_assets(self, flt):
        out = []
        cls_names = [str(c.asset_name) for c in flt.class_paths] + list(flt.class_names)
        for p, o in sorted(_S["assets"].items()):
            if not any(p == pp or p.startswith(pp.rstrip("/") + "/") for pp in flt.package_paths):
                continue
            if not flt.recursive_paths and any(p.rsplit("/", 1)[0] != pp.rstrip("/") for pp in flt.package_paths):
                continue
            if cls_names:
                names = [k.__name__ for k in type(o).__mro__] if flt.recursive_classes else [type(o).__name__]
                if not any(c in names for c in cls_names):
                    continue
            out.append(AssetData(p, o))
        return out

    def get_dependencies(self, pkg, opts):
        o = _S["assets"].get(str(pkg))
        deps = []
        if isinstance(o, MaterialInstanceConstant) and o.get_editor_property("parent"):
            deps.append(Name(o.get_editor_property("parent")._pkg))
        return deps

    def get_referencers(self, pkg, opts):
        out = []
        for p, o in _S["assets"].items():
            if isinstance(o, MaterialInstanceConstant) and o.get_editor_property("parent") is not None and o.get_editor_property("parent")._pkg == str(pkg):
                out.append(Name(p))
        return out

    def scan_paths_synchronous(self, paths, force_rescan=False):
        for root, _, files in os.walk(os.path.join(_S["project_dir"], "Content")):
            for f in files:
                if f.endswith(".uasset"):
                    rel = os.path.relpath(os.path.join(root, f), os.path.join(_S["project_dir"], "Content"))
                    p = "/Game/" + rel[:-7].replace(os.sep, "/")
                    if p not in _S["assets"]:
                        o = StaticMesh(p.rsplit("/", 1)[-1])
                        o._pkg, o._path = p, p + "." + p.rsplit("/", 1)[-1]
                        _S["assets"][p] = o


class AssetRegistryHelpers(object):
    _reg = AssetRegistry()

    @staticmethod
    def get_asset_registry():
        return AssetRegistryHelpers._reg


class MaterialEditingLibrary(object):
    @staticmethod
    def create_material_expression(mat, cls, x, y):
        e = cls()
        mat.expressions.append(e)
        return e

    @staticmethod
    def connect_material_property(expr, out, prop):
        expr._mat_prop = prop
        return True

    @staticmethod
    def delete_all_material_expressions(mat):
        mat.expressions = []

    @staticmethod
    def recompile_material(mat):
        _write_log("LogMaterial", "Display", "Recompiled %s" % mat.get_path_name())

    @staticmethod
    def layout_material_expressions(mat):
        pass

    @staticmethod
    def set_material_instance_scalar_parameter_value(mi, n, v):
        mi.params[n] = v
        return True

    set_material_instance_vector_parameter_value = set_material_instance_scalar_parameter_value
    set_material_instance_texture_parameter_value = set_material_instance_scalar_parameter_value
    set_material_instance_static_switch_parameter_value = set_material_instance_scalar_parameter_value

    @staticmethod
    def update_material_instance(mi):
        pass


# ------------------------------------------------------------------ blueprints

class SubobjectDataHandle(object):
    def __init__(self, bp, entry):
        self.bp, self.entry = bp, entry


class AddNewSubobjectParams(StructBase):
    _fields = ("parent_handle", "new_class", "blueprint_context")


class SubobjectDataSubsystem(object):
    def k2_gather_subobject_data_for_blueprint(self, bp):
        return [SubobjectDataHandle(bp, e) for e in bp.subobjects]

    def add_new_subobject(self, params):
        bp = params.blueprint_context
        cls = params.new_class
        t = cls._t if isinstance(cls, Class) else cls
        e = {"name": _unique(t.__name__), "obj": t()}
        bp.subobjects.append(e)
        return SubobjectDataHandle(bp, e), Text("")

    def rename_subobject(self, handle, name):
        handle.entry["name"] = str(name)
        return True


class SubobjectDataBlueprintFunctionLibrary(object):
    @staticmethod
    def get_data(h):
        return h

    @staticmethod
    def get_object(d):
        return d.entry["obj"]

    @staticmethod
    def get_variable_name(d):
        return Name(d.entry["name"])


class EdGraphPinType(StructBase):
    _fields = ("pin_category",)


class BlueprintEditorLibrary(object):
    @staticmethod
    def compile_blueprint(bp):
        bp._values["status"] = BlueprintStatus.BS_UP_TO_DATE
        bp._gen = None
        _write_log("LogBlueprint", "Display", "Compiled %s" % bp.get_path_name())

    @staticmethod
    def get_basic_type_by_name(n):
        return EdGraphPinType(Name(n if n in ("bool", "int", "real", "string", "name", "text") else ""))

    @staticmethod
    def add_member_variable(bp, name, pin_type):
        if name in bp.variables:
            return False
        bp.variables[name] = pin_type
        return True


# ------------------------------------------------------------------ subsystems

class EditorActorSubsystem(object):
    def get_all_level_actors(self):
        return list(_S["world"].actors)

    def get_selected_level_actors(self):
        return [a for a in _S["selected"] if a in _S["world"].actors]

    def set_selected_level_actors(self, acts):
        _S["selected"] = list(acts)
        return True

    def set_actor_selection_state(self, a, sel):
        if sel and a not in _S["selected"]:
            _S["selected"].append(a)
        elif not sel and a in _S["selected"]:
            _S["selected"].remove(a)

    def select_nothing(self):
        _S["selected"] = []

    def _add(self, actor, loc, rot):
        actor._loc = _copy.copy(loc)
        actor._rot = _copy.copy(rot)
        w = _S["world"]
        w.actors.append(actor)
        _S["dirty"].add(w._pkg)
        _record(lambda: w.actors.remove(actor) if actor in w.actors else None)
        return actor

    def spawn_actor_from_class(self, cls, loc, rot=None, transient=False):
        t = cls._t if isinstance(cls, Class) else cls
        if not (isinstance(t, type) and issubclass(t, Actor)):
            return None
        return self._add(t(None, _S["world"]), loc, rot or Rotator())

    def spawn_actor_from_object(self, obj, loc, rot=None):
        if isinstance(obj, StaticMesh):
            a = StaticMeshActor(None, _S["world"])
            a._comps[0]._values["static_mesh"] = obj
            a._label = obj.get_name()
            return self._add(a, loc, rot or Rotator())
        return None

    def destroy_actors(self, acts):
        w = _S["world"]
        for a in list(acts):
            if a in w.actors:
                i = w.actors.index(a)
                w.actors.remove(a)
                _record(lambda a=a, i=i: w.actors.insert(i, a))
        _S["dirty"].add(w._pkg)
        return True

    def destroy_actor(self, a):
        return self.destroy_actors([a])

    def duplicate_actor(self, a, world=None, offset=None):
        n = type(a)(None, _S["world"])
        n._values = _copy.copy(a._values)
        n._scale = _copy.copy(a._scale)
        n._label = a._label
        return self._add(n, a._loc + (offset or Vector()), a._rot)


class UnrealEditorSubsystem(object):
    def get_editor_world(self):
        return _S["world"]

    def get_game_world(self):
        return _S["pie_world"] if _S["pie"] else None

    def get_level_viewport_camera_info(self):
        loc, rot = _S["camera"]
        return _copy.copy(loc), _copy.copy(rot)

    def set_level_viewport_camera_info(self, loc, rot):
        _S["camera"] = (_copy.copy(loc), _copy.copy(rot))


class LevelEditorSubsystem(object):
    def is_in_play_in_editor(self):
        return _S["pie"]

    def editor_request_begin_play(self):
        _S["pie_pending"] = 3

    def editor_play_simulate(self):
        _S["pie_pending"] = 3

    def editor_request_end_play(self):
        _S["pie"] = False
        _S["pie_world"] = None
        _write_log("LogPlayLevel", "Display", "PIE: play in editor ended")

    def editor_invalidate_viewports(self):
        pass

    def editor_set_game_view(self, v):
        _S["game_view"] = v

    def load_level(self, path):
        _S["world"] = World(path.rsplit("/", 1)[-1], path)
        _S["selected"] = []
        return True

    def new_level(self, path):
        return self.load_level(path)

    def save_current_level(self):
        _S["dirty"].discard(_S["world"]._pkg)
        f = _content_file(_S["world"]._pkg, ".umap")
        os.makedirs(os.path.dirname(f), exist_ok=True)
        open(f, "wb").write(b"fake umap")
        return True


class AssetEditorSubsystem(object):
    opened = []

    def open_editor_for_assets(self, assets):
        AssetEditorSubsystem.opened.extend(assets)

    def close_all_asset_editors(self):
        AssetEditorSubsystem.opened = []


_SUBS = {}


def get_editor_subsystem(cls):
    if cls not in _SUBS:
        _SUBS[cls] = cls()
    return _SUBS[cls]


get_engine_subsystem = get_editor_subsystem


# ------------------------------------------------------------------ misc libraries

class _Pkg(object):
    def __init__(self, n):
        self.n = n

    def get_name(self):
        return self.n


class EditorLoadingAndSavingUtils(object):
    @staticmethod
    def get_dirty_map_packages():
        return [_Pkg(p) for p in sorted(_S["dirty"]) if p and p == _S["world"]._pkg]

    @staticmethod
    def get_dirty_content_packages():
        return [_Pkg(p) for p in sorted(_S["dirty"]) if p and p != _S["world"]._pkg]

    @staticmethod
    def save_dirty_packages(maps, content):
        for p in list(_S["dirty"]):
            if p == _S["world"]._pkg:
                if maps:
                    get_editor_subsystem(LevelEditorSubsystem).save_current_level()
            elif content and p in _S["assets"]:
                _save(p)
            elif content:
                _S["dirty"].discard(p)
        return True


class EditorUtilityLibrary(object):
    @staticmethod
    def get_selected_assets():
        return []


class SystemLibrary(object):
    @staticmethod
    def execute_console_command(world, cmd):
        c = cmd.strip()
        up = c.upper()
        if up == "TRANSACTION UNDO":
            _undo()
        elif up == "TRANSACTION REDO":
            pass
        elif up.startswith("HIGHRESSHOT"):
            AutomationLibrary._shot(c)
        _write_log("LogConsoleResponse", "Display", "Executed: %s" % c)

    @staticmethod
    def get_engine_version():
        return "5.6.1-fake+++UE5+Release-5.6"

    @staticmethod
    def get_command_line():
        return ""

    @staticmethod
    def print_string(world, text, to_screen=True, to_log=True, color=None, duration=2.0):
        _write_log("LogBlueprintUserMessages", "Log", text)

    @staticmethod
    def quit_editor():
        os._exit(0)


def _png(w, h):
    raw = b"".join(b"\x00" + bytes([40, 90, 160]) * w for _ in range(h))

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b"")


class AutomationLibrary(object):
    @staticmethod
    def take_high_res_screenshot(w, h, filename, *a, **k):
        _S["pending_files"].append((filename, _png(w, h), _S["frame"] + 3))
        return object()

    @staticmethod
    def _shot(cmd):
        pass


class EditorDialog(object):
    shown = []

    @staticmethod
    def show_message(title, msg, kind, *a):
        EditorDialog.shown.append((str(title), str(msg)))
        return kind


class ScopedSlowTask(object):
    def __init__(self, work, desc=""):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def make_dialog(self, can_cancel=False, allow_in_pie=False):
        pass

    def enter_progress_frame(self, work=1.0, desc=""):
        pass


class Paths(object):
    @staticmethod
    def project_dir():
        return _S["project_dir"] + "/"

    @staticmethod
    def project_saved_dir():
        return os.path.join(_S["project_dir"], "Saved") + "/"

    @staticmethod
    def project_content_dir():
        return os.path.join(_S["project_dir"], "Content") + "/"

    @staticmethod
    def project_log_dir():
        return os.path.join(_S["project_dir"], "Saved", "Logs") + "/"

    @staticmethod
    def engine_dir():
        return os.path.join(_S["project_dir"], "_FakeEngine", "Engine") + "/"

    @staticmethod
    def get_project_file_path():
        return os.path.join(_S["project_dir"], _S["name"] + ".uproject")

    @staticmethod
    def convert_relative_path_to_full(p):
        return os.path.abspath(p)


def find_object(outer, path):
    for a in _S["world"].actors:
        if a.get_path_name() == path:
            return a
    o = _S["assets"].get(path.split(".")[0])
    return o


def load_class(outer, path):
    name = path.rsplit(".", 1)[-1]
    if path.startswith("/Script/"):
        t = _HIDDEN_CLASSES.get(name) or globals().get(name)
        return Class(t) if isinstance(t, type) and issubclass(t, Object) else None
    if name.endswith("_C"):
        return EditorAssetLibrary.load_blueprint_class(path.split(".")[0])
    return None


def load_object(outer, path):
    return find_object(outer, path)


def load_asset(path):
    return EditorAssetLibrary.load_asset(path)


# ------------------------------------------------------------------ tool menus

class ToolMenuEntry(object):
    def __init__(self, name="", type=None, **kw):
        self.name = name
        self.label = ""
        self.cmd = None

    def set_label(self, l):
        self.label = str(l)

    def set_tool_tip(self, t):
        pass

    def set_string_command(self, kind, custom, cmd):
        self.cmd = cmd


class ToolMenu(object):
    def __init__(self, name):
        self.name = name
        self.entries = {}

    def get_name(self):
        return Name(self.name)

    def add_sub_menu(self, owner, section, name, label, tip=""):
        m = ToolMenu(self.name + "." + str(name))
        _S["menus"][m.name] = m
        return m

    def add_menu_entry(self, section, entry):
        self.entries[entry.name] = entry


class ToolMenus(object):
    @staticmethod
    def get():
        return ToolMenus

    @staticmethod
    def find_menu(name):
        if name == "LevelEditor.MainMenu" and name not in _S["menus"]:
            _S["menus"][name] = ToolMenu(name)
        return _S["menus"].get(name)

    @staticmethod
    def refresh_all_widgets():
        pass


class MathLibrary(object):
    @staticmethod
    def class_is_child_of(test_class, parent_class):
        t = test_class._t if isinstance(test_class, Class) else test_class
        p = parent_class._t if isinstance(parent_class, Class) else parent_class
        return isinstance(t, type) and isinstance(p, type) and issubclass(t, p)
