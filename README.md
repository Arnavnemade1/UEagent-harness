# ue-agent-harness

Connects **Claude Code** and **Codex** to a running **Unreal Editor** so they work as copilots
inside it. Agents can see what you've selected, edit the level and assets, take screenshots,
play-test, build C++, and move files into and out of the project. The editor, every agent and
the files on disk share one change journal, so everyone knows what everyone else has changed.

- **Nothing to compile.** The editor plugin is pure Python and runs on stock UE 5.x. It doesn't
  need Xcode or Visual Studio.
- **No dependencies.** The agent side is plain Node (20+) with no `node_modules`. The whole
  harness is about 300 KB.
- **Fast.** One round trip takes about one editor frame. Agents batch many operations per call,
  and pipelined calls are processed within the same frame.

```
 Claude Code ──stdio MCP──▶ ue-agent mcp ─┐
                                          ├──TCP 127.0.0.1 (token, NDJSON)──▶ UEAgentBridge (Python, in the editor)
 Codex ───────stdio MCP──▶ ue-agent mcp ─┘          ▲  change events pushed back      │ game thread, Slate tick
                                                     └────────────────────────────────┘
 Unreal Editor ▸ Agents menu / ask_claude("…") ──▶ ue-agent ask ──▶ claude -p / codex exec ──▶ (same bridge)
```

## Install

Requirements: Unreal Engine 5.0+ (5.1+ recommended), Node 20+, and Claude Code and/or Codex.

```sh
git clone <this repo> ~/ue-agent-harness
node ~/ue-agent-harness/bin/ue-agent.mjs setup /path/to/MyGame/MyGame.uproject
# optional: `npm link` inside the repo puts `ue-agent` on your PATH
```

`setup` is idempotent and does the following:

| What | Where |
|---|---|
| Links the plugin (a symlink, so nothing is copied; use `--copy` to copy it instead) | `MyGame/Plugins/UEAgentBridge` |
| Enables `PythonScriptPlugin`, `EditorScriptingUtilities` and `UEAgentBridge` | `MyGame.uproject` (backed up once) |
| Registers the `unreal` MCP server for Claude Code, pre-approved for every Claude account and config folder | `.mcp.json` + `.claude/settings.local.json` |
| Pre-approves the editor tools for Claude Code, and adds a Stop hook that asks Claude to build when it leaves C++ uncompiled | `.claude/settings.local.json` |
| Registers `[mcp_servers.unreal]` for Codex, with a 30-minute tool timeout | `~/.codex/config.toml` (inside a marked block) |
| Writes agent guidance: workflow, verification and conventions | `AGENTS.md`, plus `CLAUDE.md` importing it |

Then open (or restart) the project in Unreal and run `ue-agent doctor`.

`ue-agent uninstall <project>` removes exactly what setup added. After updating the harness, `ue-agent reload` loads the
new plugin code into a running editor without restarting it.

**Approvals.** Every agent edit is one labelled undo step, so the editor tools are pre-approved.
`ue_python` still asks for approval each time, because it runs arbitrary code inside the editor
process, outside the agent's sandbox. Pass `--trust-python` to pre-approve it as well, or
`--no-auto-approve` to keep each agent's default prompts.

## Using it

### From your terminal or IDE (Claude Code / Codex)

Run `claude` or `codex` in the project folder and ask in plain language. For example: *"Line
the selected crates up along X, 150 apart, and give them a rusty material"*, or *"Add a
Door actor in C++ that swings open on overlap, build it and place one by the PlayerStart"*.

| Tool | What it does |
|---|---|
| `ue_status` | Open level, your selection, camera, unsaved packages, new log errors, whether C++ needs a build |
| `ue_find_actors` / `ue_inspect` | Query actors (filter by name, class, tag, folder, proximity); read any property of an actor, component, asset or class default |
| `ue_edit_actors` | Batched spawn, set, delete, duplicate, select, attach and detach. One undo step; rolls back if any op fails; results read back from the engine |
| `ue_find_assets` / `ue_edit_assets` | Asset registry search. Create materials, PBR material graphs, material instances, blueprints, levels, data assets and folders; duplicate, rename, delete (with a reference guard), set, save, reimport |
| `ue_blueprint` | Create a Blueprint, add components and variables, set defaults, compile |
| `ue_import` / `ue_export` | Bring fbx/obj/gltf/usd/png/exr/wav/... and raw `.uasset`/`.umap` files into Content; export assets to disk |
| `ue_screenshot` | Viewport or play-in-editor capture, returned as an image the agent can see; can frame given actors first |
| `ue_editor` | Drive the UI: camera, focus, open asset editors, Content Browser, open/new/save level, view modes, game view, on-screen notes |
| `ue_play` | Play-in-editor or Simulate for N seconds, optional mid-play screenshot, errors logged during the run |
| `ue_logs` | Filtered Output Log; `since: "last"` returns only new lines |
| `ue_build` | Compile C++ and return structured diagnostics (Live Coding on Windows; UBT elsewhere, with optional save → restart → reconnect) |
| `ue_python` / `ue_console` | Full `unreal` Python API (REPL-style, state persists between calls) and console commands |
| `ue_sync` / `ue_undo` / `ue_save` / `ue_launch` | Change journal and long-poll watching; undo/redo; save; start the editor |

### From inside Unreal

- **Agents menu** (Level Editor main menu): *Ask Claude Code…*, *Ask Codex…*, *Continue
  Conversation…*, *Stop Agent*, *Bridge Status*, *Restart Bridge*. Your current level and
  selection are sent along with the request. Progress streams to the Output Log, and the reply
  pops up when the agent finishes.
- **Output Log, Python mode:** `ask_claude("make the selected light warmer")`,
  `ask_codex("...")`, `agent_continue("...")` and `agent_stop()`.

## How it stays in sync and verified

- **One journal.** The bridge keeps a revision counter. Every agent call is journalled and
  attributed (`codex: spawn x3`). Changes made in the editor are detected too: selection, level,
  play-in-editor state and unsaved packages. Disk changes under `Content/`, `Source/` and
  `Config/` are watched as well.
- **Automatic digest.** Each tool result ends with an `[engine sync]` note listing what the user
  or other agents changed since that agent's previous call, so agents don't work from stale
  state. `ue_sync wait_s=…` long-polls for the next change.
- **Verified results.** Every result is read back from the engine rather than echoed from the
  request. Batches are atomic: one undo transaction, rolled back on failure. Errors include
  close-match suggestions, and misspelled argument names are reported.
- **Build checks.** C++ edits are tracked against the last successful build. `ue_status` flags a
  stale build, and the Claude Stop hook asks Claude to build before it finishes.

## Performance and footprint

Measured on an Apple M4 with 16 GB of RAM:

| | |
|---|---|
| Round trip at 120 fps (sequential) | p50 ≈ 10 ms, p95 ≈ 11 ms (about one frame) |
| 200 pipelined calls | ≈ 25 ms in total |
| MCP server per agent | ≈ 50 MB RSS, 0% CPU when idle |
| Bridge inside the editor | Negligible. No threads; it polls only while agents are connected (selection 4 Hz, unsaved packages 1 Hz) |
| Disk | ≈ 300 KB. Screenshots are pruned to the latest 10 |

While agents are active, the bridge turns off the editor setting *Use Less CPU when in
Background*. Without that, a backgrounded editor ticks only a few times per second, and agent
calls would stall while you're in the terminal. The setting is restored 45 seconds after the
last call, and also on the next start if the editor crashed while it was off.

## Security

- The bridge listens on `127.0.0.1` only. Clients must send a random token stored in
  `Saved/UEAgentBridge/bridge.json` and `~/.ue-agent-harness/instances/` (both mode `0600`).
- `ue_python` and `ue_console` can do anything the editor can do. They keep approval prompts by
  default (see Install).
- To turn the bridge off for an editor session, set `UE_AGENT_BRIDGE_DISABLE=1`.

## Platform notes and limits

- **C++ on macOS and Linux:** Live Coding is Windows-only. `ue_build restart_editor:true` saves,
  closes the editor, runs UnrealBuildTool, relaunches and reconnects. Building on macOS needs the
  full **Xcode** app. Blueprint, Python and asset work need no toolchain.
- **Blueprint graphs:** node graph editing isn't exposed to Python. `ue_blueprint` covers
  components, variables, defaults and compiling. Put logic in C++ or use `ue_python`.
- **Screenshots:** these need the editor window to be on screen (not minimised).
- **Runaway Python:** `ue_python` aborts runaway code after `timeout_s`. A loop that never calls
  any function can't be interrupted from Python.

## Tested on real hardware

UE 5.8.4 (Launcher build) on macOS 26.5 with an Apple M4 and 16 GB of RAM, Xcode 26.1.1:

| | |
|---|---|
| Plugin startup | about 3 s, with no Python errors |
| Round trip, editor in the background | p50 ≈ 21 ms with throttling lifted (about 335 ms without it) |
| Pipelined calls | 50 calls in ≈ 24 ms |

Notes from that testing:

- **Editor log location:** macOS writes it to `~/Library/Logs/Unreal Engine/<Project>Editor/`, and the harness finds it there.
- **Required tools:** Unreal on macOS needs Xcode's Metal toolchain even for Blueprint-only projects. Run `xcodebuild -downloadComponent MetalToolchain`.

## Development

```sh
npm test   # 38 tests: real plugin code vs. a fake `unreal` module, MCP protocol, setup, hooks
python3 test/fake/fake_editor.py /tmp/FakeGame   # a fake editor you can point real agents at
```

The test engine (`test/fake/unreal.py`) mirrors the UE 5 editor scripting API, including its
undo buffer, dirty packages and log format. It is not Unreal itself. Real Claude Code and Codex
sessions were run against it through this harness, but the plugin has **not yet been run inside
a real Unreal Editor**. Run `ue-agent doctor` on first use.
