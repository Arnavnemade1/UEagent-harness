"""UE Agent Bridge: lets coding agents drive the Unreal Editor.

Runs entirely inside the editor's embedded Python. Network I/O is non-blocking
and is pumped from the Slate tick, so every engine call happens on the game
thread and nothing needs compiling.
"""
import os

import unreal

VERSION = "1.0.0"

_ATTR = "_ue_agent_bridge_server"  # stored on the unreal module so reloads find it


def _is_commandlet():
    try:
        cmd = unreal.SystemLibrary.get_command_line().lower()
    except Exception:
        return False
    return "-run=" in cmd or ("-nullrhi" in cmd and "-unattended" in cmd)


def get_server():
    return getattr(unreal, _ATTR, None)


def start(port=None, token=None):
    """Start (or restart) the bridge. Safe to call repeatedly."""
    if _is_commandlet():
        return None
    old = get_server()
    if old is not None:
        try:
            old.stop()
        except Exception:
            pass
    from . import server as _server
    from . import ops_core, ops_actors, ops_assets, ops_editor, ops_blueprint, ops_transfer  # noqa: F401 (register ops)

    if port is None:
        env_port = os.environ.get("UE_AGENT_BRIDGE_PORT")
        port = int(env_port) if env_port and env_port.isdigit() else None
    srv = _server.BridgeServer(port=port, token=token)
    srv.start()
    setattr(unreal, _ATTR, srv)
    try:
        from . import menu

        menu.install(srv)
    except Exception as exc:
        unreal.log_warning("[UEAgentBridge] Agents menu unavailable: %s" % exc)
    return srv


def stop():
    srv = get_server()
    if srv is not None:
        srv.stop()
        setattr(unreal, _ATTR, None)


def status():
    srv = get_server()
    return srv.describe() if srv else {"running": False}
