# Unreal runs every init_unreal.py found on its Python paths when the editor starts.
# This one starts the UE Agent Bridge so Claude Code / Codex can connect.
# Set UE_AGENT_BRIDGE_DISABLE=1 in the environment to keep it off.
import os

if os.environ.get("UE_AGENT_BRIDGE_DISABLE", "") not in ("1", "true", "yes"):
    try:
        import ue_agent_bridge

        ue_agent_bridge.start()
    except Exception as exc:  # never break editor startup
        try:
            import unreal

            unreal.log_error("[UEAgentBridge] failed to start: %s" % exc)
        except Exception:
            pass
