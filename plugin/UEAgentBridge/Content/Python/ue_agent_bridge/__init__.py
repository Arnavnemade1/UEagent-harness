"""UE Agent Bridge: lets coding agents drive the Unreal Editor.

Runs entirely inside the editor's embedded Python. Network I/O is non-blocking
and is pumped from the Slate tick, so every engine call happens on the game
thread and nothing needs compiling.
"""
import os
import re

import unreal

VERSION = "1.0.0"

_ATTR = "_ue_agent_bridge_server"  # stored on the unreal module so reloads find it


def _is_commandlet():
    try:
        cmd = unreal.SystemLibrary.get_command_line().lower()
    except Exception:
        return False
    # Standalone MRQ uses -game. It loads Python plugins too, but has no editor
    # world: registering the editor's Slate/watch callbacks there can crash.
    # Match switches, not project/directory names containing e.g. "-game".
    switches = re.findall(r'(?:^|\s)-(\w+)(?==|\s|$)', cmd)
    return ("run" in switches or "game" in switches or "server" in switches
            or ("nullrhi" in switches and "unattended" in switches))


def get_server():
    return getattr(unreal, _ATTR, None)


def start(port=None, token=None):
    """Start (or restart) the bridge. Safe to call repeatedly."""
    if os.environ.get("UE_AGENT_BRIDGE_DISABLE", "").lower() in ("1", "true", "yes") or _is_commandlet():
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


_MODULE_ORDER = ("registry", "compat", "values", "scene", "watch", "server", "ops_core", "ops_actors",
                 "ops_assets", "ops_editor", "ops_blueprint", "ops_transfer", "menu")


def _reload_modules():
    import importlib
    import sys

    for n in _MODULE_ORDER:  # dependency order: ops re-register into the fresh registry
        m = sys.modules.get(__name__ + "." + n)
        if m is not None:
            importlib.reload(m)
    importlib.reload(sys.modules[__name__])


def restart(reload_code=True):
    """Restart the bridge on the next editor tick, optionally picking up new plugin code.

    Deferred so it is safe to call from inside a bridge call (the reply is sent first).
    """
    holder = {}

    def _go(_dt):
        unreal.unregister_slate_post_tick_callback(holder["h"])
        try:
            if reload_code:
                _reload_modules()
            import ue_agent_bridge as pkg

            pkg.start()
        except Exception as exc:
            unreal.log_error("[UEAgentBridge] restart failed: %s" % exc)

    holder["h"] = unreal.register_slate_post_tick_callback(_go)
    return True


def stop():
    srv = get_server()
    if srv is not None:
        srv.stop()
        setattr(unreal, _ATTR, None)


def status():
    srv = get_server()
    return srv.describe() if srv else {"running": False}
