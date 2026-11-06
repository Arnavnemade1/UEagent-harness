import { INTENT_GUIDANCE } from './intent.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { findProject } from './discovery.mjs';
import { CLI_PATH, loadConfig, readJson, which, writeJsonAtomic } from './util.mjs';

export const COPILOT_PROMPT = 'You are a copilot running inside the user\'s open Unreal Editor, invoked from its Agents menu. '
  + 'Act on the live editor through the "unreal" MCP tools (start with ue_status if you need context). '
  + INTENT_GUIDANCE + ' '
  + 'Verify changes (read-backs, ue_logs, ue_screenshot when visual). Keep the final reply short: what you changed and anything the user must do.';

const tomlStr = (s) => (s.includes("'") ? JSON.stringify(s) : `'${s}'`);

function sessionsFile(projectFile) { return path.join(path.dirname(projectFile), 'Saved', 'UEAgentBridge', 'ask_sessions.json'); }

/**
 * Run Claude Code or Codex headless against the editor and stream normalized events:
 * {t:"session"|"text"|"tool"|"final"|"error", v}
 */
export async function ask({ agent = 'claude', project, prompt, promptFile, cont = false, format = 'text', model }) {
  const out = (t, v) => {
    if (format === 'ndjson') process.stdout.write(JSON.stringify({ t, v }) + '\n');
    else if (t === 'text') process.stdout.write(`${v}\n`);
    else if (t === 'tool') process.stdout.write(`  → ${v}\n`);
    else if (t === 'error') process.stderr.write(`error: ${v}\n`);
  };
  let text = prompt;
  if (promptFile) {
    text = fs.readFileSync(promptFile, 'utf8');
    try { fs.unlinkSync(promptFile); } catch { /* temp file */ }
  }
  if (!text || !text.trim()) { out('error', 'empty prompt'); return 2; }
  const projectFile = findProject({ explicit: project });
  if (!projectFile) { out('error', 'no Unreal project found'); return 2; }
  const projectDir = path.dirname(projectFile);
  const cfg = loadConfig();
  const node = cfg.node && fs.existsSync(cfg.node) ? cfg.node : process.execPath;
  const sessions = readJson(sessionsFile(projectFile), {}) || {};
  const env = { ...process.env, UE_AGENT_PROJECT: projectFile };
  let bin;
  let args;

  if (agent === 'claude') {
    bin = cfg.claude && fs.existsSync(cfg.claude) ? cfg.claude : which('claude');
    const mcp = { mcpServers: { unreal: { command: node, args: [CLI_PATH, 'mcp'], env: { UE_AGENT_PROJECT: projectFile, UE_AGENT_CLIENT: 'claude-code@editor' } } } };
    args = ['-p', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--mcp-config', JSON.stringify(mcp),
      '--permission-mode', 'acceptEdits', '--allowedTools', 'mcp__unreal', '--append-system-prompt', COPILOT_PROMPT];
    if (model) args.push('--model', model);
    if (cont && sessions.claude) args.push('--resume', sessions.claude);
  } else if (agent === 'codex') {
    bin = cfg.codex && fs.existsSync(cfg.codex) ? cfg.codex : which('codex');
    const conf = [
      `mcp_servers.unreal.command=${tomlStr(node)}`,
      `mcp_servers.unreal.args=[${tomlStr(CLI_PATH)}, "mcp"]`,
      `mcp_servers.unreal.env={UE_AGENT_PROJECT=${tomlStr(projectFile)}, UE_AGENT_CLIENT="codex@editor"}`,
      'mcp_servers.unreal.tool_timeout_sec=1800',
      // headless: nobody can answer approval prompts, and the user invoked this from the editor
      'mcp_servers.unreal.default_tools_approval_mode="approve"',
    ].flatMap((c) => ['-c', c]);
    args = ['exec', '--skip-git-repo-check', '-C', projectDir, '-s', 'workspace-write', ...conf];
    if (model) args.push('-m', model);
    if (cont && sessions.codex) args.push('resume', '--json', sessions.codex, '-');
    else args.push('--json', '-');
    text = `${COPILOT_PROMPT}\n\n${text}`;
  } else {
    out('error', `unknown agent ${agent} (claude or codex)`);
    return 2;
  }
  if (!bin) { out('error', `${agent} CLI not found; install it or run \`ue-agent setup\` from a shell where it is on PATH`); return 2; }

  const child = spawn(bin, args, { cwd: projectDir, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  child.stdin.end(text);
  let final = '';
  let lastText = '';
  let buf = '';
  let errText = '';
  const save = (id) => {
    if (!id) return;
    sessions[agent] = id;
    try { writeJsonAtomic(sessionsFile(projectFile), sessions); } catch { /* ignore */ }
  };
  const onEvent = (ev) => {
    if (agent === 'claude') {
      if (ev.type === 'system' && ev.subtype === 'init') save(ev.session_id);
      else if (ev.type === 'assistant') {
        for (const c of ev.message?.content || []) {
          if (c.type === 'text' && c.text?.trim()) { out('text', c.text.trim()); lastText = c.text.trim(); }
          if (c.type === 'tool_use') out('tool', c.name.replace(/^mcp__unreal__/, ''));
        }
      } else if (ev.type === 'result') {
        save(ev.session_id);
        final = ev.result || lastText;
        if (ev.is_error) out('error', ev.result || ev.subtype || 'agent error');
      }
      return;
    }
    // codex --json events
    const item = ev.item || {};
    if (ev.type === 'thread.started') save(ev.thread_id);
    else if (ev.type === 'item.started' && item.type === 'mcp_tool_call') out('tool', item.tool || item.name || 'tool');
    else if (ev.type === 'item.completed' && item.type === 'agent_message' && item.text) { out('text', item.text); lastText = item.text; }
    else if (ev.type === 'item.completed' && item.type === 'error') out('error', item.message || 'error');
    else if (ev.type === 'turn.failed' || ev.type === 'error') out('error', ev.error?.message || ev.message || 'turn failed');
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try { onEvent(JSON.parse(line)); } catch { /* non-JSON noise */ }
    }
  });
  child.stderr.on('data', (d) => { errText = (errText + d).slice(-4000); });
  const code = await new Promise((resolve) => {
    child.on('close', resolve);
    child.on('error', (e) => { errText += String(e); resolve(-1); });
  });
  if (!final) final = lastText;
  if (final) out('final', final);
  if (code !== 0 && !final) out('error', errText.trim().split('\n').slice(-5).join('\n') || `${agent} exited with ${code}`);
  return code ?? 1;
}
