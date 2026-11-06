import fs from 'node:fs';
import path from 'node:path';
import { HOME_DIR, pidAlive, readJson, samePath } from './util.mjs';

function uprojectIn(dir) {
  try {
    const hits = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.uproject')).sort();
    return hits.length ? path.join(dir, hits[0]) : null;
  } catch { return null; }
}

/**
 * Find the .uproject to work on: explicit arg -> UE_AGENT_PROJECT -> walk up from cwd
 * -> one directory down from cwd -> most recently started live editor.
 */
export function findProject({ explicit, cwd = process.cwd() } = {}) {
  const given = explicit || process.env.UE_AGENT_PROJECT;
  if (given) {
    const p = path.resolve(cwd, given);
    if (p.toLowerCase().endsWith('.uproject') && fs.existsSync(p)) return p;
    const inDir = uprojectIn(p);
    if (inDir) return inDir;
  }
  let dir = path.resolve(cwd);
  for (;;) {
    const hit = uprojectIn(dir);
    if (hit) return hit;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  try {
    const subdirs = fs.readdirSync(cwd, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).slice(0, 64);
    for (const d of subdirs) {
      const hit = uprojectIn(path.join(cwd, d.name));
      if (hit) return hit;
    }
  } catch { /* ignore */ }
  const live = listInstances();
  return live.length ? live[0].project : null;
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
  return listInstances()[0] || null;
}
