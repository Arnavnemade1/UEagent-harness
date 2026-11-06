"""Detects changes made in the editor (by the user or the engine) and journals them.

Polling is cheap and only runs while at least one agent is subscribed:
selection / level / PIE every 250 ms, dirty packages every second.
Changes caused by an agent's own call are absorbed via ``resync()`` so they are
attributed to that agent (as an 'op' event) instead of to the editor.
"""
import time

from . import compat

FAST_INTERVAL = 0.25
DIRTY_INTERVAL = 1.0


def _label(a):
    try:
        return a.get_actor_label()
    except Exception:
        return a.get_name()


class Watcher(object):
    def __init__(self, server):
        self.server = server
        self.sel = None
        self.level = None
        self.pie = None
        self.dirty = None
        self._t_fast = 0.0
        self._t_dirty = 0.0
        self._failures = 0

    def _selection(self):
        acts = compat.selected_actors()
        return tuple(sorted(a.get_path_name() for a in acts)), acts

    def resync(self):
        try:
            self.level = compat.level_path()
            self.pie = compat.is_pie()
            self.sel = self._selection()[0]
            self.dirty = set(compat.dirty_packages())
        except Exception:
            pass

    def tick(self):
        if not self.server.has_subscribers():
            self.sel = self.level = self.pie = self.dirty = None
            return
        if self._failures > 20:
            return  # editor API unavailable; stop trying instead of spamming
        now = time.monotonic()
        try:
            if now - self._t_fast >= FAST_INTERVAL:
                self._t_fast = now
                self._fast()
            if now - self._t_dirty >= DIRTY_INTERVAL:
                self._t_dirty = now
                self._dirty()
            self._failures = 0
        except Exception:
            self._failures += 1

    def _fast(self):
        emit = self.server.emit
        level = compat.level_path()
        if self.level is not None and level != self.level:
            emit("level", {"path": level})
        self.level = level
        pie = compat.is_pie()
        if self.pie is not None and pie != self.pie:
            emit("pie", {"state": "running" if pie else "stopped"})
        self.pie = pie
        key, acts = self._selection()
        if self.sel is not None and key != self.sel:
            emit("selection", {"count": len(acts), "actors": ["%s (%s)" % (_label(a), a.get_class().get_name()) for a in acts[:15]]})
        self.sel = key

    def _dirty(self):
        d = set(compat.dirty_packages())
        if self.dirty is not None and d != self.dirty:
            added = sorted(d - self.dirty)
            cleared = sorted(self.dirty - d)
            data = {"dirty_count": len(d)}
            if added:
                data["modified"] = added[:20]
            if cleared:
                data["saved_or_reverted"] = cleared[:20]
            self.server.emit("dirty", data)
        self.dirty = d
