import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { parseDiagnostics } from '../src/build.mjs';
import { Journal } from '../src/journal.mjs';
import { parseLine, readLog } from '../src/logs.mjs';
import { upsertBlock } from '../src/setup.mjs';
import { CLI, makeProject } from './helpers.mjs';

const run = (proj, args, extraEnv = {}, input) => spawnSync(process.execPath, [CLI, ...args], {
  env: { ...process.env, HOME: proj.home, CODEX_HOME: path.join(proj.home, '.codex'), ...extraEnv }, encoding: 'utf8', input,
});

describe('build diagnostics', () => {
  it('parses clang, MSVC, UHT, linker and UBT errors', () => {
    const text = [
      '/proj/Source/Game/Door.cpp:42:7: error: use of undeclared identifier \'Angel\'',
      '/proj/Source/Game/Door.h:10:1: warning: unused variable \'x\' [-Wunused-variable]',
      'C:\\proj\\Source\\Game\\Door.cpp(42): error C2065: \'Angel\': undeclared identifier',
      '/proj/Source/Game/Door.h(12): Error: Missing \'*\' in Expected a pointer type',
      'ld: error: undefined symbol: ADoor::Open()',
      'Undefined symbols for architecture arm64:',
      'ERROR: Unable to build while Live Coding is active.',
      'Building 3 actions with 10 processes...',
    ].join('\n');
    const d = parseDiagnostics(text, '/proj');
    assert.equal(d.filter((x) => x.severity === 'error').length, 6);
    assert.deepEqual(d[0], { file: 'Source/Game/Door.cpp', line: 42, col: 7, severity: 'error', message: 'use of undeclared identifier \'Angel\'' });
    assert.ok(d.some((x) => x.code === 'C2065' && x.line === 42));
    assert.ok(d.some((x) => /Missing '\*'/.test(x.message) && x.line === 12));
    assert.equal(d[d.length - 1].severity, 'warning');
  });
});

describe('log parsing', () => {
  it('parses UE log lines, severities and continuation lines', () => {
    assert.deepEqual(parseLine('[2026.11.05-17.22.33:123][ 45]LogBlueprint: Error: Bad node'), { time: '2026.11.05-17.22.33:123', frame: 45, cat: 'LogBlueprint', sev: 'error', msg: 'Bad node' });
    assert.equal(parseLine('[2026.11.05-17.22.33:123][  0]LogTemp: hello').sev, 'log');
    const proj = makeProject();
    const logs = path.join(proj.dir, 'Saved', 'Logs');
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(path.join(logs, `${proj.name}.log`), [
      '[2026.11.05-17.22.33:123][  1]LogInit: Display: start',
      '[2026.11.05-17.22.34:000][  2]LogPython: Error: Traceback (most recent call last):',
      '  File "<agent>", line 1',
      'ZeroDivisionError: division by zero',
      '[2026.11.05-17.22.35:000][  3]LogTemp: Warning: careful',
    ].join('\n') + '\n');
    const r = readLog(proj.project, { severity: 'error' });
    assert.equal(r.matched, 1);
    assert.match(r.lines[0], /ZeroDivisionError/);
    assert.equal(readLog(proj.project, { severity: 'warning' }).matched, 2);
    const again = readLog(proj.project, { since: r.cursor, severity: 'all' });
    assert.equal(again.matched, 0);
    fs.rmSync(proj.root, { recursive: true, force: true });
  });
});

describe('log location', () => {
  it('finds the macOS editor log and prefers the folder the bridge reports', () => {
    const proj = makeProject('MacLogs');
    const code = `import { logFile } from ${JSON.stringify(path.resolve('src/logs.mjs'))}; console.log(logFile(process.argv[1]));`;
    const where = () => spawnSync(process.execPath, ['--input-type=module', '-e', code, proj.project], { env: { ...process.env, HOME: proj.home }, encoding: 'utf8' }).stdout.trim();
    if (process.platform === 'darwin') {
      const macDir = path.join(proj.home, 'Library', 'Logs', 'Unreal Engine', 'MacLogsEditor');
      fs.mkdirSync(macDir, { recursive: true });
      fs.writeFileSync(path.join(macDir, 'MacLogs.log'), '');
      assert.equal(fs.realpathSync(where()), fs.realpathSync(path.join(macDir, 'MacLogs.log')));
    }
    const reported = path.join(proj.root, 'custom-logs');
    fs.mkdirSync(reported, { recursive: true });
    fs.writeFileSync(path.join(reported, 'MacLogs.log'), '');
    const bj = path.join(proj.dir, 'Saved', 'UEAgentBridge');
    fs.mkdirSync(bj, { recursive: true });
    fs.writeFileSync(path.join(bj, 'bridge.json'), JSON.stringify({ log_dir: reported }));
    assert.equal(where(), path.join(reported, 'MacLogs.log'));
    fs.rmSync(proj.root, { recursive: true, force: true });
  });
});

describe('journal digest', () => {
  it('summarises other parties\' changes and skips the caller\'s own', () => {
    const j = new Journal();
    j.add({ rev: 1, kind: 'op', by: 'codex', cid: 2, data: { op: 'edit_actors', summary: 'spawn x3', ok: true } });
    j.add({ rev: 2, kind: 'op', by: 'claude-code', cid: 1, data: { op: 'python', summary: 'ran Python', ok: true } });
    j.add({ rev: 3, kind: 'selection', by: 'editor', cid: null, data: { count: 1, actors: ['Door (BP_Door_C)'] } });
    j.add({ rev: 4, kind: 'dirty', by: 'editor', cid: null, data: { modified: ['/Game/Maps/Main'], dirty_count: 1 } });
    const d = j.digest({ sinceRev: 0, sinceT: Date.now(), selfCid: 1, rev: 4 });
    assert.match(d, /codex: spawn x3/);
    assert.doesNotMatch(d, /ran Python/);
    assert.match(d, /user selection → Door/);
    assert.match(d, /\/Game\/Maps\/Main/);
    assert.equal(j.digest({ sinceRev: 4, sinceT: Date.now(), selfCid: 1, rev: 4 }), '');
  });
});

describe('setup / uninstall', () => {
  it('installs into a project idempotently and removes cleanly', () => {
    const proj = makeProject('SetupGame');
    const codexDir = path.join(proj.home, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, 'config.toml'), 'model = "x"\n\n[mcp_servers.other]\ncommand = "foo"\n');
    fs.writeFileSync(path.join(proj.dir, 'CLAUDE.md'), '# My project notes\n');
    let r = run(proj, ['setup', proj.project, '--claude-config', 'file']);
    assert.equal(r.status, 0, r.stderr);
    const link = path.join(proj.dir, 'Plugins', 'UEAgentBridge');
    assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.ok(fs.existsSync(path.join(link, 'Content', 'Python', 'init_unreal.py')));
    const up = JSON.parse(fs.readFileSync(proj.project, 'utf8'));
    for (const n of ['ModelingToolsEditorMode', 'PythonScriptPlugin', 'EditorScriptingUtilities', 'UEAgentBridge']) assert.ok(up.Plugins.some((p) => p.Name === n && p.Enabled), n);
    const mcp = JSON.parse(fs.readFileSync(path.join(proj.dir, '.mcp.json'), 'utf8'));
    assert.deepEqual(mcp.mcpServers.unreal.args, [CLI, 'mcp']);
    const hooks = JSON.parse(fs.readFileSync(path.join(proj.dir, '.claude', 'settings.local.json'), 'utf8'));
    assert.match(hooks.hooks.Stop[0].hooks[0].command, /hook claude-stop/);
    assert.ok(hooks.permissions.allow.includes('mcp__unreal__ue_edit_actors'));
    assert.ok(!hooks.permissions.allow.includes('mcp__unreal__ue_python'), 'python keeps its prompt by default');
    const toml = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8');
    assert.match(toml, /\[mcp_servers\.other\]/);
    assert.match(toml, /\[mcp_servers\.unreal\]\ncommand = ".*node.*"\nargs = \[".*ue-agent\.mjs", "mcp"\]\nstartup_timeout_sec = 20\ntool_timeout_sec = 1800\ndefault_tools_approval_mode = "approve"\n\n\[mcp_servers\.unreal\.tools\.ue_python\]\napproval_mode = "prompt"/);
    assert.match(fs.readFileSync(path.join(proj.dir, 'AGENTS.md'), 'utf8'), /ue_status/);
    assert.match(fs.readFileSync(path.join(proj.dir, 'CLAUDE.md'), 'utf8'), /# My project notes[\s\S]*@AGENTS\.md/);
    const cfg = JSON.parse(fs.readFileSync(path.join(proj.home, '.ue-agent-harness', 'config.json'), 'utf8'));
    assert.equal(cfg.cli, CLI);

    const snapshot = () => ['AGENTS.md', 'CLAUDE.md', '.mcp.json', 'SetupGame.uproject', '.claude/settings.local.json'].map((f) => fs.readFileSync(path.join(proj.dir, f), 'utf8')).join('|') + fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8');
    const before = snapshot();
    r = run(proj, ['setup', proj.project, '--claude-config', 'file']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(snapshot(), before, 'second setup must not change anything');

    r = run(proj, ['uninstall', proj.project]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!fs.existsSync(link));
    assert.ok(!fs.existsSync(path.join(proj.dir, 'AGENTS.md')));
    assert.equal(fs.readFileSync(path.join(proj.dir, 'CLAUDE.md'), 'utf8').trim(), '# My project notes');
    assert.equal(fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8').trim(), 'model = "x"\n\n[mcp_servers.other]\ncommand = "foo"');
    assert.ok(!JSON.parse(fs.readFileSync(path.join(proj.dir, '.mcp.json'), 'utf8')).mcpServers.unreal);
    assert.ok(!fs.existsSync(path.join(proj.dir, '.claude', 'settings.local.json')), 'settings file we created is removed');

    r = run(proj, ['setup', proj.project, '--claude-config', 'file', '--trust-python', '--no-hooks']);
    assert.equal(r.status, 0, r.stderr);
    const trusted = JSON.parse(fs.readFileSync(path.join(proj.dir, '.claude', 'settings.local.json'), 'utf8'));
    assert.deepEqual(trusted.permissions.allow, ['mcp__unreal']);
    assert.doesNotMatch(fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8'), /approval_mode = "prompt"/);
    fs.rmSync(proj.root, { recursive: true, force: true });
  });

  it('refuses to clobber a user-defined mcp_servers.unreal in Codex config', () => {
    const proj = makeProject('Clash');
    const codexDir = path.join(proj.home, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, 'config.toml'), '[mcp_servers.unreal]\ncommand = "mine"\n');
    const r = run(proj, ['setup', proj.project, '--claude-config', 'file', '--no-hooks']);
    assert.match(r.stdout, /already defines mcp_servers\.unreal/);
    assert.equal(fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf8'), '[mcp_servers.unreal]\ncommand = "mine"\n');
    fs.rmSync(proj.root, { recursive: true, force: true });
  });

  it('upsertBlock is stable when the file is only the block', () => {
    const proj = makeProject('Blk');
    const f = path.join(proj.dir, 'X.md');
    upsertBlock(f, '<!-- a -->', '<!-- b -->', 'hello');
    const one = fs.readFileSync(f, 'utf8');
    assert.equal(upsertBlock(f, '<!-- a -->', '<!-- b -->', 'hello'), false);
    assert.equal(fs.readFileSync(f, 'utf8'), one);
    fs.rmSync(proj.root, { recursive: true, force: true });
  });
});

describe('claude stop hook', () => {
  it('asks Claude once to build when C++ changed after the last compile', () => {
    const proj = makeProject('HookGame');
    const src = path.join(proj.dir, 'Source', 'HookGame');
    fs.mkdirSync(src, { recursive: true });
    const marker = path.join(proj.dir, 'Saved', 'UEAgentBridge');
    fs.mkdirSync(marker, { recursive: true });
    fs.writeFileSync(path.join(marker, 'last_build.json'), JSON.stringify({ time: Date.now() - 60000, ok: true }));
    fs.writeFileSync(path.join(src, 'Door.cpp'), '// changed');
    let r = run(proj, ['hook', 'claude-stop'], {}, JSON.stringify({ cwd: proj.dir, stop_hook_active: false }));
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, 'block');
    assert.match(out.reason, /Door\.cpp/);
    r = run(proj, ['hook', 'claude-stop'], {}, JSON.stringify({ cwd: proj.dir, stop_hook_active: true }));
    assert.equal(r.stdout, '');
    fs.writeFileSync(path.join(marker, 'last_build.json'), JSON.stringify({ time: Date.now() + 1000, ok: true }));
    r = run(proj, ['hook', 'claude-stop'], {}, JSON.stringify({ cwd: proj.dir }));
    assert.equal(r.stdout, '');
    fs.rmSync(proj.root, { recursive: true, force: true });
  });
});

describe('ask (editor → agent)', () => {
  const stub = (dir, name, lines) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, `#!/bin/sh\ncat > "${dir}/${name}.stdin"\necho "$@" > "${dir}/${name}.args"\n${lines.map((l) => `echo '${JSON.stringify(l)}'`).join('\n')}\n`);
    fs.chmodSync(f, 0o755);
    return f;
  };

  it('drives Claude Code headless and normalizes its stream', () => {
    const proj = makeProject('AskGame');
    const bin = path.join(proj.root, 'bin');
    fs.mkdirSync(bin);
    const claude = stub(bin, 'claude', [
      { type: 'system', subtype: 'init', session_id: 'sess-123' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Making it red.' }, { type: 'tool_use', name: 'mcp__unreal__ue_edit_actors', input: {} }] } },
      { type: 'result', subtype: 'success', result: 'Cube is red now.', session_id: 'sess-123' },
    ]);
    fs.mkdirSync(path.join(proj.home, '.ue-agent-harness'), { recursive: true });
    fs.writeFileSync(path.join(proj.home, '.ue-agent-harness', 'config.json'), JSON.stringify({ claude }));
    let r = run(proj, ['ask', '--agent', 'claude', '--project', proj.project, '--format', 'ndjson', 'make the cube red']);
    assert.equal(r.status, 0, r.stderr);
    const ev = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(ev, [{ t: 'text', v: 'Making it red.' }, { t: 'tool', v: 'ue_edit_actors' }, { t: 'final', v: 'Cube is red now.' }]);
    const args = fs.readFileSync(`${claude}.args`, 'utf8');
    assert.match(args, /--strict-mcp-config/);
    assert.match(args, /--allowedTools mcp__unreal/);
    assert.equal(fs.readFileSync(`${claude}.stdin`, 'utf8'), 'make the cube red');
    r = run(proj, ['ask', '--agent', 'claude', '--project', proj.project, '--continue', 'and bigger']);
    assert.match(fs.readFileSync(`${claude}.args`, 'utf8'), /--resume sess-123/);
    fs.rmSync(proj.root, { recursive: true, force: true });
  });

  it('drives Codex headless with MCP config overrides', () => {
    const proj = makeProject('AskCodex');
    const bin = path.join(proj.root, 'bin');
    fs.mkdirSync(bin);
    const codex = stub(bin, 'codex', [
      { type: 'thread.started', thread_id: 'th-9' },
      { type: 'item.started', item: { type: 'mcp_tool_call', server: 'unreal', tool: 'ue_status' } },
      { type: 'item.completed', item: { type: 'agent_message', text: 'Done.' } },
    ]);
    fs.mkdirSync(path.join(proj.home, '.ue-agent-harness'), { recursive: true });
    fs.writeFileSync(path.join(proj.home, '.ue-agent-harness', 'config.json'), JSON.stringify({ codex }));
    let r = run(proj, ['ask', '--agent', 'codex', '--project', proj.project, '--format', 'ndjson', 'status?']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.trim().split('\n').map((l) => JSON.parse(l)), [{ t: 'tool', v: 'ue_status' }, { t: 'text', v: 'Done.' }, { t: 'final', v: 'Done.' }]);
    const args = fs.readFileSync(`${codex}.args`, 'utf8');
    assert.match(args, /mcp_servers\.unreal\.args=\['.*ue-agent\.mjs', "mcp"\]/);
    assert.match(args, /--json -$/m);
    r = run(proj, ['ask', '--agent', 'codex', '--project', proj.project, '--continue', 'more']);
    assert.match(fs.readFileSync(`${codex}.args`, 'utf8'), /resume --json th-9 -/);
    fs.rmSync(proj.root, { recursive: true, force: true });
  });
});

describe('plugin python', () => {
  it('compiles on Python 3.9 (UE 5.0-5.3) syntax', () => {
    const dir = path.resolve('plugin/UEAgentBridge/Content/Python');
    const files = execFileSync('find', [dir, '-name', '*.py'], { encoding: 'utf8' }).trim().split('\n');
    const r = spawnSync('python3', ['-c', 'import ast,sys\nfor f in sys.argv[1:]: ast.parse(open(f).read(), f, feature_version=(3,9))', ...files], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  });
});
