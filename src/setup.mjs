import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findProject } from './discovery.mjs';
import { listTools } from './tools.mjs';
import { CLI_PATH, PLUGIN_DIR, readJson, ROOT, saveConfig, VERSION, which } from './util.mjs';

const MD_BEGIN = '<!-- ue-agent-harness:begin -->';
const MD_END = '<!-- ue-agent-harness:end -->';
const TOML_BEGIN = '# >>> ue-agent-harness >>>';
const TOML_END = '# <<< ue-agent-harness <<<';
const REQUIRED_PLUGINS = ['PythonScriptPlugin', 'EditorScriptingUtilities', 'UEAgentBridge'];

function backupOnce(file) {
  const bak = `${file}.ue-agent.bak`;
  if (fs.existsSync(file) && !fs.existsSync(bak)) fs.copyFileSync(file, bak);
}

/** Replace (or append) a marked block in a text file. block=null removes it. */
export function upsertBlock(file, begin, end, block) {
  const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const re = new RegExp(`\\n?${begin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${end.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`);
  let next;
  if (block === null) next = prev.replace(re, '\n').replace(/\n{3,}$/, '\n');
  else {
    const body = `${begin}\n${block.trim()}\n${end}\n`;
    next = re.test(prev) ? prev.replace(re, (m) => (m.startsWith('\n') ? '\n' : '') + body) : `${prev}${prev && !prev.endsWith('\n') ? '\n' : ''}${prev ? '\n' : ''}${body}`;
  }
  if (next === prev) return false;
  if (block === null && !next.trim()) { fs.unlinkSync(file); return true; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next);
  return true;
}

function isOurPlugin(dir) {
  const up = readJson(path.join(dir, 'UEAgentBridge.uplugin'));
  return up?.CreatedBy === 'ue-agent-harness';
}

function installPlugin(projectDir, copy, report) {
  const dest = path.join(projectDir, 'Plugins', 'UEAgentBridge');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let st = null;
  try { st = fs.lstatSync(dest); } catch { /* missing */ }
  if (st) {
    if (st.isSymbolicLink()) {
      if (!copy && fs.realpathSync(dest) === fs.realpathSync(PLUGIN_DIR)) { report.push('plugin: already linked'); return; }
      fs.unlinkSync(dest);
    } else if (isOurPlugin(dest)) {
      fs.rmSync(dest, { recursive: true, force: true });
    } else {
      throw new Error(`${dest} exists and is not the UEAgentBridge plugin; move it away first`);
    }
  }
  if (copy) {
    fs.cpSync(PLUGIN_DIR, dest, { recursive: true, filter: (src) => !src.includes('__pycache__') });
    report.push(`plugin: copied to ${dest}`);
  } else {
    fs.symlinkSync(PLUGIN_DIR, dest, process.platform === 'win32' ? 'junction' : 'dir');
    report.push(`plugin: linked ${dest} -> ${PLUGIN_DIR} (no copy; updates with the harness)`);
  }
}

function enablePlugins(projectFile, report) {
  const raw = fs.readFileSync(projectFile, 'utf8');
  const json = JSON.parse(raw);
  json.Plugins = json.Plugins || [];
  let changed = false;
  for (const name of REQUIRED_PLUGINS) {
    const hit = json.Plugins.find((p) => p.Name === name);
    if (!hit) { json.Plugins.push({ Name: name, Enabled: true }); changed = true; } else if (!hit.Enabled) { hit.Enabled = true; changed = true; }
  }
  if (changed) {
    backupOnce(projectFile);
    fs.writeFileSync(projectFile, JSON.stringify(json, null, '\t') + '\n');
    report.push(`.uproject: enabled ${REQUIRED_PLUGINS.join(', ')}`);
  } else report.push('.uproject: plugins already enabled');
}

function mcpEntry(projectFile) {
  return { command: process.execPath, args: [CLI_PATH, 'mcp'], env: { UE_AGENT_PROJECT: projectFile } };
}

/** Claude Code permission rules for the bridge tools (ue_python keeps its prompt unless trusted). */
function claudeAllowRules(trustPython) {
  if (trustPython) return ['mcp__unreal'];
  return listTools().filter((t) => t.name !== 'ue_python').map((t) => `mcp__unreal__${t.name}`);
}

const isOurRule = (r) => r === 'mcp__unreal' || String(r).startsWith('mcp__unreal__');

function configureClaude(projectFile, { hooks, autoApprove, trustPython }, report) {
  const projectDir = path.dirname(projectFile);
  // Project-level .mcp.json works for every Claude Code account/config dir (CLAUDE_CONFIG_DIR),
  // unlike `claude mcp add --scope local`, which only writes the active config.
  const mcpFile = path.join(projectDir, '.mcp.json');
  const mj = readJson(mcpFile, {}) || {};
  mj.mcpServers = { ...(mj.mcpServers || {}), unreal: mcpEntry(projectFile) };
  fs.writeFileSync(mcpFile, JSON.stringify(mj, null, 2) + '\n');
  report.push(`claude code: registered MCP server "unreal" in ${mcpFile} (all Claude accounts)`);
  // drop a local-scope duplicate left by older versions of this tool (only if one exists)
  const configs = [process.env.CLAUDE_CONFIG_DIR && path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json'), path.join(os.homedir(), '.claude.json')].filter(Boolean);
  const claude = which('claude');
  if (claude && configs.some((f) => readJson(f)?.projects?.[projectDir]?.mcpServers?.unreal)) {
    try { execFileSync(claude, ['mcp', 'remove', '--scope', 'local', 'unreal'], { cwd: projectDir, stdio: 'ignore' }); } catch { /* none */ }
    report.push('claude code: removed the old local-scope entry (superseded by .mcp.json)');
  }
  const file = path.join(projectDir, '.claude', 'settings.local.json');
  const original = readJson(file, null);
  const j = JSON.parse(JSON.stringify(original || {}));
  const kept = (j.permissions?.allow || []).filter((r) => !isOurRule(r));
  j.enabledMcpjsonServers = [...new Set([...(j.enabledMcpjsonServers || []), 'unreal'])]; // pre-approve .mcp.json entry
  if (autoApprove) {
    j.permissions = { ...(j.permissions || {}), allow: [...kept, ...claudeAllowRules(trustPython)] };
    report.push(`claude code: editor tools pre-approved${trustPython ? ' (including ue_python)' : '; ue_python still asks (use --trust-python to allow)'}`);
  } else if (j.permissions?.allow) {
    j.permissions.allow = kept;
  }
  if (hooks) {
    const cmd = `"${process.execPath}" "${CLI_PATH}" hook claude-stop`;
    j.hooks = j.hooks || {};
    const stop = (j.hooks.Stop || []).filter((g) => !(g.hooks || []).some((h) => String(h.command).includes('hook claude-stop')));
    stop.push({ hooks: [{ type: 'command', command: cmd, timeout: 15 }] });
    j.hooks.Stop = stop;
    report.push('claude code: Stop hook installed (asks Claude to build if it left C++ uncompiled)');
  }
  if (JSON.stringify(j) !== JSON.stringify(original || {})) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n');
  }
}

export function codexConfigPath() {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
}

function tomlString(s) { return JSON.stringify(s); }

function configureCodex({ autoApprove, trustPython }, report) {
  const file = codexConfigPath();
  const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const withoutOurs = prev.replace(new RegExp(`${TOML_BEGIN}[\\s\\S]*?${TOML_END}`), '');
  if (/^\s*\[mcp_servers\.unreal[\].]/m.test(withoutOurs) || /^\s*mcp_servers\.unreal\./m.test(withoutOurs)) {
    report.push(`codex: ${file} already defines mcp_servers.unreal (not managed by this tool); left unchanged`);
    return;
  }
  const block = [
    '[mcp_servers.unreal]',
    `command = ${tomlString(process.execPath)}`,
    `args = [${tomlString(CLI_PATH)}, "mcp"]`,
    'startup_timeout_sec = 20',
    'tool_timeout_sec = 1800',
    ...(autoApprove ? ['default_tools_approval_mode = "approve"'] : []),
    ...(autoApprove && !trustPython ? ['', '[mcp_servers.unreal.tools.ue_python]', 'approval_mode = "prompt"'] : []),
  ].join('\n');
  backupOnce(file);
  if (upsertBlock(file, TOML_BEGIN, TOML_END, block)) report.push(`codex: added [mcp_servers.unreal] to ${file} (project picked from the working directory)`);
  else report.push('codex: already configured');
}

function writeDocs(projectDir, report) {
  const section = fs.readFileSync(path.join(ROOT, 'templates', 'AGENTS.section.md'), 'utf8');
  const agents = path.join(projectDir, 'AGENTS.md');
  if (upsertBlock(agents, MD_BEGIN, MD_END, section)) report.push(`docs: updated ${agents} (read by Codex)`);
  const claudeMd = path.join(projectDir, 'CLAUDE.md');
  if (upsertBlock(claudeMd, MD_BEGIN, MD_END, '@AGENTS.md')) report.push(`docs: ${claudeMd} imports AGENTS.md (read by Claude Code)`);
}

export function setup({ project, copy = false, claude = true, codex = true, hooks = true, docs = true, autoApprove = true, trustPython = false } = {}) {
  const projectFile = findProject({ explicit: project });
  if (!projectFile || !projectFile.endsWith('.uproject')) throw new Error('No .uproject found. Pass the project: ue-agent setup /path/to/MyGame.uproject');
  const projectDir = path.dirname(projectFile);
  const report = [`project: ${projectFile}`];
  installPlugin(projectDir, copy, report);
  enablePlugins(projectFile, report);
  saveConfig({ version: VERSION, node: process.execPath, cli: CLI_PATH, claude: which('claude'), codex: which('codex') });
  report.push('config: ~/.ue-agent-harness/config.json (paths used by the in-editor Agents menu)');
  if (claude) configureClaude(projectFile, { hooks, autoApprove, trustPython }, report);
  if (codex) configureCodex({ autoApprove, trustPython }, report);
  if (docs) writeDocs(projectDir, report);
  return { projectFile, report };
}

export function uninstall({ project, codex = true } = {}) {
  const projectFile = findProject({ explicit: project });
  if (!projectFile) throw new Error('No .uproject found.');
  const projectDir = path.dirname(projectFile);
  const report = [];
  const dest = path.join(projectDir, 'Plugins', 'UEAgentBridge');
  try {
    const st = fs.lstatSync(dest);
    if (st.isSymbolicLink()) fs.unlinkSync(dest);
    else if (isOurPlugin(dest)) fs.rmSync(dest, { recursive: true, force: true });
    report.push('plugin removed');
  } catch { /* none */ }
  try {
    const j = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
    const before = (j.Plugins || []).length;
    j.Plugins = (j.Plugins || []).filter((p) => p.Name !== 'UEAgentBridge');
    if (j.Plugins.length !== before) { fs.writeFileSync(projectFile, JSON.stringify(j, null, '\t') + '\n'); report.push('.uproject: removed UEAgentBridge entry'); }
  } catch { /* ignore */ }
  const claude = which('claude');
  if (claude) { try { execFileSync(claude, ['mcp', 'remove', '--scope', 'local', 'unreal'], { cwd: projectDir, stdio: 'ignore' }); report.push('claude code: removed MCP server'); } catch { /* none */ } }
  const mcpFile = path.join(projectDir, '.mcp.json');
  const mj = readJson(mcpFile);
  if (mj?.mcpServers?.unreal?.args?.includes?.(CLI_PATH)) {
    delete mj.mcpServers.unreal;
    fs.writeFileSync(mcpFile, JSON.stringify(mj, null, 2) + '\n');
    report.push('claude code: removed .mcp.json entry');
  }
  const settings = path.join(projectDir, '.claude', 'settings.local.json');
  const sj = readJson(settings);
  if (sj) {
    if (sj.hooks?.Stop) {
      sj.hooks.Stop = sj.hooks.Stop.filter((g) => !(g.hooks || []).some((h) => String(h.command).includes('hook claude-stop')));
      if (!sj.hooks.Stop.length) delete sj.hooks.Stop;
      if (!Object.keys(sj.hooks).length) delete sj.hooks;
      report.push('claude code: removed Stop hook');
    }
    if (sj.enabledMcpjsonServers) {
      sj.enabledMcpjsonServers = sj.enabledMcpjsonServers.filter((n) => n !== 'unreal');
      if (!sj.enabledMcpjsonServers.length) delete sj.enabledMcpjsonServers;
    }
    if (sj.permissions?.allow) {
      sj.permissions.allow = sj.permissions.allow.filter((r) => !isOurRule(r));
      if (!sj.permissions.allow.length) delete sj.permissions.allow;
      if (!Object.keys(sj.permissions).length) delete sj.permissions;
    }
    if (Object.keys(sj).length) fs.writeFileSync(settings, JSON.stringify(sj, null, 2) + '\n');
    else fs.unlinkSync(settings);
  }
  if (codex && upsertBlock(codexConfigPath(), TOML_BEGIN, TOML_END, null)) report.push('codex: removed mcp_servers.unreal');
  for (const f of ['AGENTS.md', 'CLAUDE.md']) if (upsertBlock(path.join(projectDir, f), MD_BEGIN, MD_END, null)) report.push(`docs: removed section from ${f}`);
  return report;
}
