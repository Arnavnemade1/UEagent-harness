import path from 'node:path';
import { lastBuild, newestSourceChange } from './build.mjs';
import { findBridge, findProject, projectInfo } from './discovery.mjs';

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  try { return JSON.parse(data || '{}'); } catch { return {}; }
}

/**
 * Claude Code Stop hook: if Claude edited C++ that the running editor hasn't compiled,
 * ask it (once) to build before handing control back. Fails open and is fast.
 */
export async function claudeStopHook() {
  const input = await readStdin();
  if (input.stop_hook_active) return 0;
  const projectFile = findProject({ cwd: input.cwd || process.cwd() });
  const info = projectFile && projectInfo(projectFile);
  if (!info?.hasSource) return 0;
  const src = newestSourceChange(info.dir);
  if (!src.time) return 0;
  const lb = lastBuild(info.dir);
  const bridge = findBridge(projectFile);
  const baseline = Math.max(lb?.ok ? lb.time : 0, (bridge?.started || 0) * 1000);
  if (!baseline || src.time <= baseline) return 0;
  const rel = path.relative(info.dir, src.file);
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: `C++ source changed (${rel}) after the editor last compiled. Run ue_build (restart_editor: true on macOS/Linux if the editor is open) and fix any diagnostics, or tell the user why the build can't run here.`,
  }));
  return 0;
}
