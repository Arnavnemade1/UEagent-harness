import fs from 'node:fs';
import path from 'node:path';
import { BridgeClient } from './bridge.mjs';
import { findEngine, toolchainProblem } from './build.mjs';
import { bridgeFile, findBridge, findProject, projectInfo } from './discovery.mjs';
import { codexConfigPath } from './setup.mjs';
import { CLI_PATH, PLUGIN_DIR, readJson, VERSION, which } from './util.mjs';

const pct = (arr, p) => arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))];

export async function doctor({ project, bench = 50 } = {}) {
  const rows = [];
  const add = (status, label, detail = '') => rows.push({ status, label, detail });
  const major = Number(process.versions.node.split('.')[0]);
  add(major >= 20 ? 'ok' : 'fail', `Node ${process.versions.node}`, major >= 20 ? '' : 'Node 20+ required');
  add('ok', `harness ${VERSION}`, CLI_PATH);

  const projectFile = findProject({ explicit: project });
  if (!projectFile) {
    add('fail', 'Unreal project', 'none found (run from the project folder or pass --project)');
    return rows;
  }
  const info = projectInfo(projectFile);
  add('ok', 'project', projectFile);

  const pluginDest = path.join(info.dir, 'Plugins', 'UEAgentBridge');
  let pluginState = 'missing';
  try {
    const st = fs.lstatSync(pluginDest);
    pluginState = st.isSymbolicLink() ? `linked -> ${fs.realpathSync(pluginDest)}` : 'copied';
  } catch { /* missing */ }
  add(pluginState === 'missing' ? 'fail' : 'ok', 'plugin UEAgentBridge', pluginState === 'missing' ? 'run: ue-agent setup' : pluginState);
  const up = readJson(projectFile, {});
  const enabled = new Set((up.Plugins || []).filter((p) => p.Enabled).map((p) => p.Name));
  const missing = ['PythonScriptPlugin', 'EditorScriptingUtilities'].filter((n) => !enabled.has(n));
  add(missing.length ? 'fail' : 'ok', 'required engine plugins', missing.length ? `not enabled: ${missing.join(', ')}` : 'Python + Editor Scripting enabled');

  const engine = findEngine(projectFile);
  add(engine ? 'ok' : 'warn', `engine ${info.engineAssociation || '?'}`, engine || 'not found on this machine (install it, or set UE_ENGINE_DIR)');
  if (info.hasSource) {
    const tc = toolchainProblem();
    add(tc ? 'warn' : 'ok', 'C++ toolchain', tc || 'ready');
  }

  const disc = findBridge(projectFile);
  if (!disc) {
    add('warn', 'editor', `not running (no live ${path.relative(info.dir, bridgeFile(projectFile))}); start it to finish the check`);
  } else {
    const client = new BridgeClient({ project: projectFile, clientName: 'doctor', subscribe: false });
    try {
      const t0 = Date.now();
      const hello = await client.connect();
      add('ok', 'bridge connection', `port ${disc.port}, pid ${hello.pid}, UE ${hello.engine_version}, Python ${hello.python}, ${Date.now() - t0} ms to connect`);
      if (hello.version !== VERSION) add('warn', 'version', `plugin ${hello.version} vs harness ${VERSION}: restart the editor to load the current plugin`);
      const pings = [];
      for (let i = 0; i < bench; i++) pings.push(await client.ping());
      const p50 = pct(pings, 0.5);
      add(p50 < 60 ? 'ok' : 'warn', `round-trip latency (${bench} pings)`, `p50 ${p50.toFixed(2)} ms · p95 ${pct(pings, 0.95).toFixed(2)} ms · max ${Math.max(...pings).toFixed(2)} ms`
        + (p50 < 60 ? '' : ' (editor is ticking slowly: background throttling not lifted; run `ue-agent reload` or update the plugin)'));
      const calls = [];
      for (let i = 0; i < Math.min(bench, 20); i++) {
        const t = process.hrtime.bigint();
        await client.call('status', {});
        calls.push(Number(process.hrtime.bigint() - t) / 1e6);
      }
      add('ok', 'status call latency', `p50 ${pct(calls, 0.5).toFixed(2)} ms · p95 ${pct(calls, 0.95).toFixed(2)} ms`);
      const t1 = process.hrtime.bigint();
      await Promise.all(Array.from({ length: 50 }, () => client.call('changes', { since: 0, limit: 1 })));
      add('ok', 'pipelined throughput', `50 calls in ${(Number(process.hrtime.bigint() - t1) / 1e6).toFixed(1)} ms`);
    } catch (e) {
      add('fail', 'bridge connection', `${e.code || ''} ${e.message}`);
    } finally {
      client.close();
    }
  }

  const claude = which('claude');
  const mcpJson = readJson(path.join(info.dir, '.mcp.json'));
  const local = readJson(path.join(info.dir, '.claude', 'settings.local.json')) || {};
  const shared = readJson(path.join(info.dir, '.claude', 'settings.json')) || {};
  const approved = [local, shared].some((x) => x.enableAllProjectMcpServers || (x.enabledMcpjsonServers || []).includes('unreal'));
  const configDirs = [process.env.CLAUDE_CONFIG_DIR, path.join(process.env.HOME || '', '.claude')].filter(Boolean);
  const localScope = configDirs.some((d) => {
    const j = readJson(path.join(d, '.claude.json')) || readJson(path.join(path.dirname(d), '.claude.json'));
    return !!j?.projects?.[info.dir]?.mcpServers?.unreal;
  });
  const claudeOk = (mcpJson?.mcpServers?.unreal && approved) || localScope;
  add(claudeOk ? 'ok' : 'warn', 'Claude Code', claudeOk
    ? `MCP server "unreal" ${mcpJson?.mcpServers?.unreal ? 'in .mcp.json (pre-approved)' : 'in local config'}${claude ? '' : ' (claude CLI not on PATH)'}`
    : mcpJson?.mcpServers?.unreal ? '.mcp.json has "unreal" but it is not approved: run ue-agent setup' : 'not configured: run ue-agent setup');
  const codexCfg = fs.existsSync(codexConfigPath()) ? fs.readFileSync(codexConfigPath(), 'utf8') : '';
  const codexOk = /\[mcp_servers\.unreal\]/.test(codexCfg);
  add(codexOk ? 'ok' : 'warn', 'Codex', codexOk ? `configured in ${codexConfigPath()}` : 'not configured: run ue-agent setup');
  const rss = process.memoryUsage().rss / 1048576;
  add('ok', 'harness memory', `${rss.toFixed(0)} MB RSS per agent connection; plugin ${(dirSize(PLUGIN_DIR) / 1024).toFixed(0)} KB on disk`);
  return rows;
}

function dirSize(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) n += dirSize(p); else n += fs.statSync(p).size;
  }
  return n;
}

export function printRows(rows) {
  const icon = { ok: '✓', warn: '!', fail: '✗' };
  for (const r of rows) process.stdout.write(`${icon[r.status]} ${r.label}${r.detail ? `  —  ${r.detail}` : ''}\n`);
  return rows.some((r) => r.status === 'fail') ? 1 : 0;
}
