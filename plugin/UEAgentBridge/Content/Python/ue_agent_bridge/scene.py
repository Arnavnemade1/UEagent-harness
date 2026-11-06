"""Actor lookup with one level scan per call, wildcard targets and batch references."""
import fnmatch
import math

import unreal

from . import compat
from .registry import BridgeError, suggest
from .values import num, rot_json, vec_json


class Scene(object):
    """Caches the level's actor list for the duration of one call."""

    def __init__(self):
        self._actors = None
        self.refs = {}  # "$0" -> [actors] produced by earlier ops in a batch
        self.mutated = False  # True once an undoable engine change was recorded

    def actors(self):
        if self._actors is None:
            self._actors = [a for a in compat.all_actors() if a is not None]
        return self._actors

    def added(self, actor):
        if self._actors is not None:
            self._actors.append(actor)

    def removed(self, actor):
        if self._actors is not None:
            try:
                self._actors.remove(actor)
            except ValueError:
                pass

    def resolve(self, target, many=True, allow_empty=False):
        """Resolve a target spec into a list of actors.

        target: "$N" (result of op N in this batch) | "@selected" | actor path |
                label | label wildcard ("Wall_*") | {"class": ..., "name": ..., "tag": ...} | list of these
        """
        if isinstance(target, (list, tuple)):
            out = []
            for t in target:
                for a in self.resolve(t, True, allow_empty):
                    if a not in out:
                        out.append(a)
            return self._check(out, target, many, allow_empty)
        if isinstance(target, dict):
            return self._check(self.query(target), target, many, allow_empty)
        if not isinstance(target, str) or not target.strip():
            raise BridgeError("bad_args", "target must be a label, path, '$N', '@selected' or a filter object")
        t = target.strip()
        if t.startswith("$"):
            if t not in self.refs:
                raise BridgeError("bad_ref", "%s refers to an op that has not produced actors (refs available: %s)" % (t, ", ".join(sorted(self.refs)) or "none"))
            return self._check(list(self.refs[t]), t, many, allow_empty)
        if t.lower() in ("@selected", "@selection", "selected"):
            return self._check(compat.selected_actors(), t, many, allow_empty)
        if ":" in t and "." in t:
            try:
                obj = unreal.find_object(None, t)
            except Exception:
                obj = None
            if obj is not None and isinstance(obj, unreal.Actor):
                return [obj]
            raise BridgeError("not_found", "no actor at path '%s'" % t)
        acts = self.actors()
        if any(ch in t for ch in "*?["):
            pat = t.lower()
            out = [a for a in acts if fnmatch.fnmatchcase(label(a).lower(), pat) or fnmatch.fnmatchcase(a.get_name().lower(), pat)]
            return self._check(out, t, True, allow_empty)
        exact = [a for a in acts if label(a) == t]
        if not exact:
            exact = [a for a in acts if a.get_name() == t]
        if not exact:
            low = t.lower()
            exact = [a for a in acts if label(a).lower() == low or a.get_name().lower() == low]
        if len(exact) > 1 and not many:
            raise BridgeError(
                "ambiguous",
                "%d actors are labelled '%s'; use a path or a wildcard" % (len(exact), t),
                candidates=[a.get_path_name() for a in exact[:10]],
            )
        return self._check(exact, t, many, allow_empty)

    def one(self, target):
        acts = self.resolve(target, many=False)
        if len(acts) != 1:
            raise BridgeError("ambiguous", "target %r matched %d actors; expected exactly one" % (target, len(acts)), candidates=[label(a) for a in acts[:10]])
        return acts[0]

    def _check(self, out, target, many, allow_empty):
        if not out and not allow_empty:
            labels = [label(a) for a in self.actors()]
            raise BridgeError("not_found", "no actor matches %r" % (target,), suggestions=suggest(str(target), labels))
        return out

    def query(self, f):
        """Filter actors: class, name (wildcard on label/name), tag, folder, selected, near, radius."""
        acts = compat.selected_actors() if f.get("selected") else self.actors()
        cls_name = f.get("class")
        name = f.get("name")
        tag = f.get("tag")
        folder = f.get("folder")
        near = f.get("near")
        radius = float(f.get("radius") or 0)
        cls = None
        if cls_name:
            try:
                from .values import resolve_class

                cls = resolve_class(cls_name)
            except BridgeError:
                cls = None
        out = []
        pat = name.lower() if isinstance(name, str) else None
        if pat and not any(ch in pat for ch in "*?["):
            pat = "*" + pat + "*"
        center = None
        if near is not None:
            from .values import to_vector

            if isinstance(near, str):
                center = self.one(near).get_actor_location()
            else:
                center = to_vector(near, "near")
            if radius <= 0:
                radius = 1000.0
        for a in acts:
            if cls is not None:
                if not _is_a(a, cls):
                    continue
            elif cls_name:
                if cls_name.lower() not in a.get_class().get_name().lower():
                    continue
            if pat and not (fnmatch.fnmatchcase(label(a).lower(), pat) or fnmatch.fnmatchcase(a.get_name().lower(), pat)):
                continue
            if tag and not any(str(t).lower() == str(tag).lower() for t in tags(a)):
                continue
            if folder and not str(folder_of(a) or "").lower().startswith(str(folder).lower()):
                continue
            if center is not None:
                d = a.get_actor_location() - center
                if math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z) > radius:
                    continue
            out.append(a)
        return out


def _is_a(actor, cls):
    """isinstance() for python wrapper types *and* UClass objects (e.g. blueprint classes)."""
    if isinstance(cls, type):
        return isinstance(actor, cls)
    try:
        return bool(unreal.MathLibrary.class_is_child_of(actor.get_class(), cls))
    except Exception:
        try:
            return actor.get_class().get_path_name() == cls.get_path_name()
        except Exception:
            return False


def label(a):
    try:
        return a.get_actor_label()
    except Exception:
        return a.get_name()


def tags(a):
    try:
        return list(a.get_editor_property("tags"))
    except Exception:
        return []


def folder_of(a):
    try:
        f = str(a.get_folder_path())
        return None if f in ("", "None") else f
    except Exception:
        return None


def row(a, detail=False, selected_set=None):
    """Compact description of an actor (verified by reading the live object)."""
    r = {"label": label(a), "class": a.get_class().get_name()}
    n = a.get_name()
    if n != r["label"]:
        r["name"] = n
    r["location"] = vec_json(a.get_actor_location())
    rot = a.get_actor_rotation()
    if abs(rot.pitch) + abs(rot.yaw) + abs(rot.roll) > 1e-4:
        r["rotation"] = rot_json(rot)
    sc = a.get_actor_scale3d()
    if abs(sc.x - 1) + abs(sc.y - 1) + abs(sc.z - 1) > 1e-4:
        r["scale"] = vec_json(sc)
    f = folder_of(a)
    if f:
        r["folder"] = f
    t = tags(a)
    if t:
        r["tags"] = [str(x) for x in t]
    if selected_set is not None and a.get_path_name() in selected_set:
        r["selected"] = True
    if detail:
        r["path"] = a.get_path_name()
        try:
            parent = a.get_attach_parent_actor()
            if parent is not None:
                r["attached_to"] = label(parent)
        except Exception:
            pass
        comps = []
        try:
            for c in a.get_components_by_class(unreal.ActorComponent):
                cd = {"name": c.get_name(), "class": c.get_class().get_name()}
                if isinstance(c, getattr(unreal, "StaticMeshComponent", ())):
                    try:
                        m = c.get_editor_property("static_mesh")
                        cd["mesh"] = m.get_path_name() if m else None
                        mats = c.get_materials() if hasattr(c, "get_materials") else []
                        if mats:
                            cd["materials"] = [x.get_path_name() if x else None for x in mats][:8]
                    except Exception:
                        pass
                comps.append(cd)
        except Exception:
            pass
        r["components"] = comps[:40]
        try:
            origin, extent = a.get_actor_bounds(False)
            r["bounds"] = {"center": vec_json(origin), "extent": vec_json(extent)}
        except Exception:
            pass
    return r
