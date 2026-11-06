import fs from 'node:fs';
import path from 'node:path';

const SOURCE_EXT = new Set(['.h', '.hpp', '.cpp', '.cc', '.c', '.inl', '.cs']);
const ASSET_EXT = new Set(['.uasset', '.umap']);

/**
 * Keeps engine change events (pushed by the bridge) and on-disk changes, and turns
 * "what changed since you last looked" into a short digest appended to tool results.
 */
export class Journal {
  constructor({ max = 600 } = {}) {
    this.max = max;
    this.events = [];
    this.disk = [];
    this.waiters = new Set();
    this.sourceChangedAt = 0;
  }

  reset() { this.events = []; }

  add(ev) {
    this.events.push(ev);
    if (this.events.length > this.max) this.events.splice(0, this.events.length - this.max);
    this._wake();
  }

  addDisk(entry) {
    const last = this.disk[this.disk.length - 1];
    if (last && last.path === entry.path && entry.t - last.t < 2000) { last.t = entry.t; return; }
    this.disk.push(entry);
    if (this.disk.length > this.max) this.disk.splice(0, this.disk.length - this.max);
    if (entry.area === 'source') this.sourceChangedAt = entry.t;
    this._wake();
  }

  _wake() { for (const w of this.waiters) w(); this.waiters.clear(); }

  /** Resolve when something new arrives, or after `ms`. */
  waitForChange(ms) {
    return new Promise((resolve) => {
      const done = () => { clearTimeout(t); resolve(true); };
      const t = setTimeout(() => { this.waiters.delete(done); resolve(false); }, ms);
      this.waiters.add(done);
    });
  }

  eventsSince(rev, excludeCid) {
    return this.events.filter((e) => e.rev > rev && (excludeCid == null || e.cid !== excludeCid));
  }

  diskSince(t) { return this.disk.filter((d) => d.t > t); }

  /** Compact human summary of other parties' changes since a cursor. */
  digest({ sinceRev, sinceT, selfCid, rev }) {
    const evs = this.eventsSince(sinceRev, selfCid);
    const disk = this.diskSince(sinceT);
    if (!evs.length && !disk.length) return '';
    const lines = [];
    let selection = null;
    let level = null;
    let pie = null;
    const dirty = new Set();
    const saved = new Set();
    const ops = [];
    for (const e of evs) {
      const d = e.data || {};
      if (e.kind === 'selection') selection = d;
      else if (e.kind === 'level') level = d.path;
      else if (e.kind === 'pie') pie = d.state;
      else if (e.kind === 'dirty') {
        (d.modified || []).forEach((p) => { dirty.add(p); saved.delete(p); });
        (d.saved_or_reverted || []).forEach((p) => { saved.add(p); dirty.delete(p); });
      } else if (e.kind === 'op') ops.push(`${e.by}: ${d.summary || d.op}${d.ok === false ? ' (failed)' : ''}`);
    }
    if (level) lines.push(`level changed → ${level}`);
    for (const o of ops.slice(-6)) lines.push(o);
    if (ops.length > 6) lines.push(`…and ${ops.length - 6} more agent operations`);
    if (selection) {
      lines.push(selection.count
        ? `user selection → ${selection.actors.join(', ')}${selection.count > selection.actors.length ? ` (+${selection.count - selection.actors.length})` : ''}`
        : 'user cleared the selection');
    }
    if (dirty.size) lines.push(`edited in editor (unsaved): ${[...dirty].slice(0, 8).join(', ')}${dirty.size > 8 ? ` (+${dirty.size - 8})` : ''}`);
    if (saved.size) lines.push(`saved: ${[...saved].slice(0, 8).join(', ')}${saved.size > 8 ? ` (+${saved.size - 8})` : ''}`);
    if (pie) lines.push(`play-in-editor ${pie}`);
    const src = disk.filter((d) => d.area === 'source');
    const other = disk.filter((d) => d.area !== 'source');
    if (src.length) lines.push(`C++/build files changed on disk: ${[...new Set(src.map((d) => d.path))].slice(0, 6).join(', ')} — run ue_build to compile`);
    if (other.length) {
      const uniq = [...new Set(other.map((d) => d.path))];
      lines.push(`files changed on disk: ${uniq.slice(0, 6).join(', ')}${uniq.length > 6 ? ` (+${uniq.length - 6})` : ''}`);
    }
    if (!lines.length) return '';
    return `[engine sync · rev ${rev}] changes since your last call:\n- ${lines.join('\n- ')}`;
  }
}

/** Watches Content/Source/Config with one recursive OS watcher each (FSEvents/ReadDirectoryChangesW). */
export class DiskWatcher {
  constructor(journal) {
    this.journal = journal;
    this.watchers = [];
  }

  start(projectDir) {
    this.stop();
    // recursive fs.watch is efficient on macOS/Windows; on Linux it would add one inotify watch per folder
    if (process.platform !== 'darwin' && process.platform !== 'win32') return;
    for (const [sub, area] of [['Content', 'content'], ['Source', 'source'], ['Config', 'config']]) {
      const dir = path.join(projectDir, sub);
      if (!fs.existsSync(dir)) continue;
      try {
        const w = fs.watch(dir, { recursive: true, persistent: false }, (_type, file) => {
          if (!file) return;
          const f = file.toString();
          const ext = path.extname(f).toLowerCase();
          if (area === 'content' && !ASSET_EXT.has(ext)) return;
          if (area === 'source' && !SOURCE_EXT.has(ext)) return;
          if (area === 'config' && ext !== '.ini') return;
          this.journal.addDisk({ t: Date.now(), area, path: `${sub}/${f.split(path.sep).join('/')}` });
        });
        w.on('error', () => {});
        this.watchers.push(w);
      } catch { /* watching is best-effort */ }
    }
  }

  stop() {
    for (const w of this.watchers) { try { w.close(); } catch { /* ignore */ } }
    this.watchers = [];
  }
}
