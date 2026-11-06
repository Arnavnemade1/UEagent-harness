"""Narrow repairs with optimistic concurrency checks on the editor thread."""
import os

import unreal

from . import compat, scene, values
from .ops_observe import _number
from .registry import BridgeError, op


def _vector(value):
    return isinstance(value, list) and len(value) == 3 and all(_number(v) for v in value)


def _same(a, b):
    return all(abs(x - y) <= 0.0001 for x, y in zip(a, b))


@op("repair_locations", mutating=True, label="repair verified actor locations")
def repair_locations(ctx, a):
    compat.require_no_pie("repairing static actor locations")
    if a.require("bridge_instance") != {"pid": os.getpid(), "started": ctx.server.started_at}:
        raise BridgeError("stale_observation", "editor bridge restarted; observe and verify again")
    if a.require("project") != ctx.server.paths.get("project_file") or a.require("level") != compat.level_path():
        raise BridgeError("stale_observation", "project or level changed; observe and verify again")
    revision = a.require("revision")
    if not isinstance(revision, int) or isinstance(revision, bool) or revision != ctx.server.rev:
        raise BridgeError("stale_observation", "editor revision changed; observe and verify again")
    lib = getattr(unreal, "LevelSequenceEditorBlueprintLibrary", None)
    if lib is not None:
        try:
            sequence = lib.get_current_level_sequence()
        except Exception:
            raise BridgeError("unsupported", "cannot establish whether Sequencer controls these actors")
        if sequence is not None:
            raise BridgeError("sequence_active", "repair animation keys explicitly; static location repairs are disabled while Sequencer is open")
    repairs = a.require("repairs")
    if not isinstance(repairs, list) or not 1 <= len(repairs) <= 16:
        raise BridgeError("bad_args", "repairs must contain 1..16 location repairs")
    sc = scene.Scene()
    actors = {actor.get_path_name(): actor for actor in sc.actors()}
    pending, seen = [], set()
    # Validate the entire batch before modifying any actor. The transport pump
    # serializes operations and prevents nested Slate calls from reentering it.
    for repair in repairs:
        if not isinstance(repair, dict) or set(repair) != {"operation", "target", "location", "precondition"}:
            raise BridgeError("bad_args", "invalid repair fields")
        target, location, before = repair["target"], repair["location"], repair["precondition"]
        if repair["operation"] != "set_location" or not isinstance(target, str) or not _vector(location):
            raise BridgeError("bad_args", "only finite set_location repairs are supported")
        if not isinstance(before, dict) or set(before) != {"location", "rotation", "scale", "parent"} or not all(_vector(before[k]) for k in ("location", "rotation", "scale")):
            raise BridgeError("bad_args", "repair needs complete observed transform preconditions")
        if target in seen:
            raise BridgeError("bad_args", "multiple repairs target the same actor")
        seen.add(target)
        actor = actors.get(target)
        if actor is None:
            raise BridgeError("stale_observation", "actor no longer exists in this world: %s" % target)
        parent = actor.get_attach_parent_actor()
        parent_path = parent.get_path_name() if parent else None
        if (not _same(values.vec_json(actor.get_actor_location()), before["location"])
                or not _same(values.rot_json(actor.get_actor_rotation()), before["rotation"])
                or not _same(values.vec_json(actor.get_actor_scale3d()), before["scale"])
                or parent_path != before["parent"]):
            raise BridgeError("stale_observation", "actor changed since observation: %s" % target)
        pending.append((actor, location))
    # Moving a parent also moves attached children. Do not silently invalidate
    # another repair's preconditions, or affect actors outside the repair set.
    parent_paths = set()
    for actor in sc.actors():
        parent = actor.get_attach_parent_actor()
        if parent:
            parent_paths.add(parent.get_path_name())
    if seen.intersection(parent_paths):
        raise BridgeError("coupled_actors", "a target has attached children; plan the hierarchy edit explicitly")
    changed = False
    try:
        results = []
        for actor, location in pending:
            actor.modify()
            root = actor.get_editor_property("root_component")
            if root:
                root.modify()
            changed = True
            actor.set_actor_location(values.to_vector(location), False, False)
            actual = values.vec_json(actor.get_actor_location())
            if not _same(actual, location):
                raise RuntimeError("engine did not apply the requested location: %s" % actor.get_path_name())
            results.append({"path": actor.get_path_name(), "location": actual})
        ctx.summary = "repaired %d actor location(s); verified by read-back" % len(results)
        return {"repaired": results, "requires_reverification": True}
    except Exception as exc:
        raise BridgeError("repair_failed", str(exc), rollback=changed)
