import fs from 'node:fs';
import path from 'node:path';
import { HOME_DIR, pidAlive, readJson, samePath } from './util.mjs';

function chooseProject(candidates) {
  const unique = candidates.filter((p, i) => p && !candidates.slice(0, i).some((q) => samePath(p, q)));
  if (unique.length > 1) {
    const error = new Error(`Multiple Unreal projects match. Set UE_AGENT_PROJECT or pass --project to choose explicitly: ${unique.join(', ')}`);
    error.code = 'ambiguous_project';
    error.data = { projects: unique };
    throw error;
  }
  return unique[0] || null;
}

function projectsIn(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.uproject'))
      .map((entry) => path.join(dir, entry.name)).sort();
  } catch { return []; }
}

/** Resolve the user's project without silently choosing a different editor. */
export function findProject({ explicit, cwd = process.cwd() } = {}) {
  const given = explicit || process.env.UE_AGENT_PROJECT;
  if (given) {
    const p = path.resolve(cwd, given);
    if (p.toLowerCase().endsWith('.uproject')) {
      try { if (fs.statSync(p).isFile()) return p; } catch { /* report below */ }
    } else {
      const hit = chooseProject(projectsIn(p));
      if (hit) return hit;
    }
    const error = new Error(`Unreal project not found at ${p}. Correct --project or UE_AGENT_PROJECT before continuing.`);
    error.code = 'project_not_found';
    throw error;
  }
  let dir = path.resolve(cwd);
  for (;;) {
    const hit = chooseProject(projectsIn(dir));
    if (hit) return hit;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  let subdirs = [];
  try { subdirs = fs.readdirSync(cwd, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')); } catch { /* ignore */ }
  const child = chooseProject(subdirs.flatMap((d) => projectsIn(path.join(cwd, d.name))));
  if (child) return child;
  return chooseProject(listInstances().map((instance) => instance.project));
}

export function projectInfo(projectFile) {
  if (!projectFile) return null;
  const dir = path.dirname(projectFile);
  const name = path.basename(projectFile, path.extname(projectFile));
  const json = readJson(projectFile, {}) || {};
  return {
    file: projectFile,
    dir,
    name,
    engineAssociation: json.EngineAssociation || null,
    modules: (json.Modules || []).map((m) => m.Name),
    hasSource: fs.existsSync(path.join(dir, 'Source')),
  };
}

export function bridgeFile(projectFile) {
  return path.join(path.dirname(projectFile), 'Saved', 'UEAgentBridge', 'bridge.json');
}

/** Live editor instances, newest first. Stale entries (dead pids) are removed. */
export function listInstances() {
  const dir = path.join(HOME_DIR, 'instances');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const n of names) {
    const file = path.join(dir, n);
    const info = readJson(file);
    if (!info || !pidAlive(info.pid)) {
      try { fs.unlinkSync(file); } catch { /* ignore */ }
      continue;
    }
    out.push(info);
  }
  return out.sort((a, b) => (b.started || 0) - (a.started || 0));
}

/** Connection info for the editor that has `projectFile` open (or the newest editor). */
export function findBridge(projectFile) {
  if (projectFile) {
    const info = readJson(bridgeFile(projectFile));
    if (info && pidAlive(info.pid)) return info;
    const inst = listInstances().find((i) => samePath(i.project, projectFile));
    if (inst) return inst;
    return null;
  }
  const live = listInstances();
  const project = chooseProject(live.map((instance) => instance.project));
  return live.find((instance) => samePath(instance.project, project)) || null;
}
