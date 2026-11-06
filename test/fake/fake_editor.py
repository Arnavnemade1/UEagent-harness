"""Runs the real UEAgentBridge plugin code against the fake `unreal` module.

Usage: python3 test/fake/fake_editor.py <project_dir> [--fps 60] [--port 0]
stdin commands simulate the user working in the editor:
  select <label>[,<label>...]   change the selection
  move <label> <x> <y> <z>      user drags an actor (dirties the level)
  error <message>               write an Error line to the log
  quit
"""
import argparse
import os
import select
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(ROOT, "plugin", "UEAgentBridge", "Content", "Python"))

import unreal  # noqa: E402  (the fake)


def seed():
    w = unreal._S["world"]
    floor = unreal.StaticMeshActor("Floor", w)
    floor._label = "Floor"
    floor._scale = unreal.Vector(20, 20, 1)
    floor._comps[0]._values["static_mesh"] = unreal.EditorAssetLibrary.load_asset("/Engine/BasicShapes/Plane")
    cube = unreal.StaticMeshActor("Cube", w)
    cube._label = "Cube"
    cube._loc = unreal.Vector(0, 0, 50)
    cube._comps[0]._values["static_mesh"] = unreal.EditorAssetLibrary.load_asset("/Engine/BasicShapes/Cube")
    light = unreal.PointLight("PointLight", w)
    light._label = "KeyLight"
    light._loc = unreal.Vector(200, 200, 300)
    start = unreal.PlayerStart("PlayerStart", w)
    start._label = "PlayerStart"
    w.actors.extend([floor, cube, light, start])
    unreal._S["dirty"].clear()


def handle(line):
    parts = line.strip().split()
    if not parts:
        return True
    cmd = parts[0]
    acts = {a.get_actor_label(): a for a in unreal._S["world"].actors}
    if cmd == "select":
        names = " ".join(parts[1:]).split(",") if len(parts) > 1 else []
        unreal._S["selected"] = [acts[n.strip()] for n in names if n.strip() in acts]
    elif cmd == "move" and parts[1] in acts:
        a = acts[parts[1]]
        a._loc = unreal.Vector(*map(float, parts[2:5]))
        unreal._S["dirty"].add(unreal._S["world"]._pkg)
    elif cmd == "error":
        unreal._write_log("LogBlueprint", "Error", " ".join(parts[1:]))
    elif cmd == "quit":
        return False
    print("ACK " + cmd, flush=True)
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("project_dir")
    ap.add_argument("--fps", type=float, default=60.0)
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--name", default="FakeGame")
    args = ap.parse_args()
    unreal._fake_init(args.project_dir, args.name)
    seed()
    import ue_agent_bridge

    srv = ue_agent_bridge.start(port=args.port)
    print("READY %d %d" % (srv.port, os.getpid()), flush=True)
    frame = 1.0 / args.fps
    try:
        while True:
            t0 = time.monotonic()
            unreal._fake_tick(frame)
            r, _, _ = select.select([sys.stdin], [], [], 0)
            if r:
                line = sys.stdin.readline()
                if not line or not handle(line):
                    break
            dt = time.monotonic() - t0
            if dt < frame:
                time.sleep(frame - dt)
    finally:
        unreal._fake_shutdown()


if __name__ == "__main__":
    main()
