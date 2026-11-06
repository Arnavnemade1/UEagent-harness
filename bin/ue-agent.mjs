#!/usr/bin/env node
import { ask } from '../src/ask.mjs';
import { BridgeClient } from '../src/bridge.mjs';
import { build } from '../src/build.mjs';
import { findProject } from '../src/discovery.mjs';
import { doctor, printRows } from '../src/doctor.mjs';
import { claudeStopHook } from '../src/hooks.mjs';
import { readLog } from '../src/logs.mjs';
import { runMcpServer } from '../src/mcp.mjs';
import { setup, uninstall } from '../src/setup.mjs';
import { parseArgs, VERSION } from '../src/util.mjs';

const HELP = `ue-agent ${VERSION} — connect Claude Code / Codex to Unreal Editor

  ue-agent setup [Project.uproject] [--copy] [--no-claude] [--no-codex] [--no-hooks] [--no-docs]
                [--no-auto-approve] [--trust-python]
      Install the bridge plugin into the project and register the MCP server with both agents.
      Editor tools are pre-approved (every change is an undo step); ue_python keeps its
      approval prompt unless --trust-python.
  ue-agent doctor [--project P]      Check install, connectivity and latency
  ue-agent status [--project P]      Editor context as JSON
  ue-agent py "<python>"             Run Python in the editor
  ue-agent call <op> ['<json args>'] Call a bridge op directly
  ue-agent logs [--severity error|warning|all] [--lines N]
  ue-agent build [--restart-editor]  Compile C++ with diagnostics
  ue-agent ask --agent claude|codex "<request>" [--continue]
      Run an agent headless against the editor (used by the editor's Agents menu)
  ue-agent mcp [--project P]         MCP stdio server (what Claude Code / Codex launch)
  ue-agent uninstall [Project.uproject]
`;

async function withClient(args, fn) {
  const client = new BridgeClient({ project: findProject({ explicit: args.project }), clientName: 'cli', subscribe: false });
  try { return await fn(client); } finally { client.close(); }
}

const print = (v) => process.stdout.write(`${typeof v === 'string' ? v : JSON.stringify(v, null, 2)}\n`);

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  switch (cmd) {
    case 'mcp':
      runMcpServer({ project: args.project });
      return null;
    case 'setup': {
      const res = setup({
        project: args._[0] || args.project, copy: !!args.copy, claude: args.claude !== false, codex: args.codex !== false,
        hooks: args.hooks !== false, docs: args.docs !== false, claudeMode: args['claude-config'] || 'auto',
        autoApprove: args['auto-approve'] !== false, trustPython: !!args['trust-python'],
      });
      print(res.report.map((l) => `• ${l}`).join('\n'));
      print('\nNext: open (or restart) the project in Unreal Editor, then run `ue-agent doctor`.');
      return 0;
    }
    case 'uninstall':
      print(uninstall({ project: args._[0] || args.project, codex: args.codex !== false }).map((l) => `• ${l}`).join('\n') || 'nothing to remove');
      return 0;
    case 'doctor':
      return printRows(await doctor({ project: args.project, bench: Number(args.bench || 50) }));
    case 'status':
      return withClient(args, async (c) => { print((await c.call('status', {})).result); return 0; });
    case 'py':
    case 'python':
      return withClient(args, async (c) => {
        const r = (await c.call('python', { code: args._.join(' ') })).result;
        if (r.stdout) process.stdout.write(r.stdout);
        if (r.result !== undefined) print(r.result);
        return 0;
      });
    case 'call':
      return withClient(args, async (c) => {
        const r = await c.call(args._[0], args._[1] ? JSON.parse(args._[1]) : {}, { timeout: Number(args.timeout || 120) * 1000 });
        print(r.result);
        if (r.warnings) print({ warnings: r.warnings });
        return 0;
      });
    case 'logs': {
      const p = findProject({ explicit: args.project });
      const r = readLog(p, { severity: args.severity || 'warning', lines: Number(args.lines || 60), category: args.category, contains: args.contains });
      print(r.lines.join('\n') || '(no matching lines)');
      return 0;
    }
    case 'build': {
      const projectFile = findProject({ explicit: args.project });
      const bridge = new BridgeClient({ project: projectFile, clientName: 'cli-build', subscribe: false });
      try {
        const r = await build({ projectFile, bridge, mode: args.mode || 'auto', restartEditor: !!args['restart-editor'], onProgress: (m) => process.stderr.write(`${m}\n`) });
        print(r);
        return r.ok ? 0 : 1;
      } finally { bridge.close(); }
    }
    case 'ask':
      return ask({
        agent: args.agent || 'claude', project: args.project, prompt: args._.join(' '), promptFile: args['prompt-file'],
        cont: !!args.continue, format: args.format || 'text', model: args.model,
      });
    case 'hook':
      if (args._[0] === 'claude-stop') return claudeStopHook();
      print(`unknown hook ${args._[0]}`);
      return 2;
    case 'version':
    case '--version':
      print(VERSION);
      return 0;
    default:
      print(HELP);
      return cmd && cmd !== 'help' && cmd !== '--help' ? 2 : 0;
  }
}

main().then((code) => { if (code !== null && code !== undefined) process.exitCode = code; })
  .catch((e) => { process.stderr.write(`ue-agent: ${e.code ? `${e.code}: ` : ''}${e.message}\n`); process.exitCode = 1; });
