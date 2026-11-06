## Unreal Editor bridge (ue-agent-harness)

This project's Unreal Editor is connected to coding agents through the **unreal** MCP server
(plugin `Plugins/UEAgentBridge`). The editor is live and shared with the user, and possibly
with other agents.

**Workflow**
1. Call `ue_status` first. It shows the open level, the user's selection, the camera, unsaved
   work, new log errors, and whether C++ needs rebuilding. "This" or "the selected thing"
   means the user's current selection.
2. Batch your work. `ue_edit_actors` and `ue_edit_assets` take many ops per call and run as a
   single undo step. Use `ue_python` for anything the structured tools don't cover; it has the
   full `unreal` API and its variables persist between calls.
3. Verify before you say you're done:
   - Tool results are read back from the engine, so check them.
   - Use `ue_screenshot` to look at visual changes.
   - Run `ue_logs` with `severity: "error"` and `since: "last"` after changes.
   - Run `ue_play` with `duration_s` to smoke-test gameplay.
   - After editing `.h`, `.cpp` or `.Build.cs` files, run `ue_build` and fix every diagnostic.
4. Respect the user. Tool results can end with an `[engine sync]` digest of what the user or
   other agents changed. Don't overwrite or undo their work. `ue_undo` only reverts the most
   recent transaction, which might not be yours.
5. Save deliberately. Asset ops save by default. Levels need `ue_save` (or ask the user first).

**Conventions:** units are centimetres and degrees. `rotation` is `[pitch, yaw, roll]`. Assets
are `/Game/Folder/Name`. An actor target can be a label, a wildcard (`Wall_*`), `@selected`, an
actor path, or `$N` (the actors created by op N in the same batch).

**C++:** put game code in `Source/<Module>/`. On Windows, `ue_build` hot-patches through Live
Coding. On macOS and Linux it needs `restart_editor: true`, which saves, closes the editor,
compiles, relaunches it and reconnects. If the editor isn't running, `ue_launch` starts it.
