"""Local TCP bridge (newline-delimited JSON) pumped from the editor's Slate tick.

Wire format, one JSON object per line:
  -> {"id": 1, "method": "hello", "params": {"token": "...", "client": "claude-code"}}
  -> {"id": 2, "method": "call",  "params": {"fn": "find_actors", "args": {...}}}
  <- {"id": 2, "ok": true, "result": {...}, "rev": 17, "ms": 0.8}
  <- {"event": "change", "rev": 18, "kind": "selection", "by": "editor", "data": {...}}

All sockets are non-blocking and serviced on the game thread, so every engine
call is thread-safe and there are no Python threads competing for the GIL.
"""
import collections
import hmac
import json
import os
import secrets
import selectors
import socket
import sys
import time
import traceback
import types

import unreal

from . import VERSION, compat
from .registry import OPS, BridgeError, CallContext
from .watch import Watcher

PROTOCOL = 1
DEFAULT_PORT = 47821
MAX_CLIENTS = 16
MAX_LINE = 64 * 1024 * 1024
TICK_BUDGET = 0.010  # seconds of request work per editor frame
ACTIVE_WINDOW = 45.0  # keep the editor unthrottled this long after the last request
JOURNAL_MAX = 1000
HOME_DIR = os.path.join(os.path.expanduser("~"), ".ue-agent-harness")


def _now():
    return time.monotonic()


def _log(msg):
    unreal.log("[UEAgentBridge] %s" % msg)


class _Client(object):
    def __init__(self, sock, addr, cid):
        self.sock = sock
        self.addr = addr
        self.cid = cid
        self.rbuf = bytearray()
        self.wbuf = bytearray()
        self.authed = False
        self.name = "unauthenticated"
        self.subscribed = False
        self.closed = False
        self.namespace = None
        self.connected_at = time.time()
        self.calls = 0
        self.want_write = False


class _Task(object):
    __slots__ = ("gen", "client", "rid", "wake", "deadline", "ctx", "t0")

    def __init__(self, gen, client, rid, ctx, t0, timeout):
        self.gen = gen
        self.client = client
        self.rid = rid
        self.ctx = ctx
        self.t0 = t0
        self.wake = 0.0
        self.deadline = t0 + timeout if timeout else None


class Throttle(object):
    """Turns off 'Use Less CPU when in Background' while agents are active.

    Without this the editor ticks only a few times per second while the user is
    in their terminal, which would add up to ~100 ms to every agent call. The
    original value is restored once agents go quiet, so idle CPU stays low.
    """

    PROP = "throttle_cpu_when_not_foreground"

    def __init__(self, state_path):
        self.state_path = state_path
        self.disabled_by_us = False
        self.last_activity = 0.0
        self._settings = None
        self._recover()

    def _obj(self):
        if self._settings is None:
            cls = getattr(unreal, "EditorPerformanceSettings", None)
            if cls is not None:
                try:
                    self._settings = unreal.get_default_object(cls)
                except Exception:
                    self._settings = None
        return self._settings

    def _recover(self):
        # if the editor crashed while we had throttling disabled, put it back
        try:
            with open(self.state_path) as f:
                st = json.load(f)
            os.remove(self.state_path)
            if st.get("original") is True and self._obj() is not None:
                compat.set_property_quiet(self._obj(), self.PROP, True)
        except Exception:
            pass

    def activity(self):
        self.last_activity = _now()
        if self.disabled_by_us:
            return
        obj = self._obj()
        if obj is None:
            return
        try:
            if obj.get_editor_property(self.PROP):
                compat.set_property_quiet(obj, self.PROP, False)
                self.disabled_by_us = True
                try:
                    with open(self.state_path, "w") as f:
                        json.dump({"original": True}, f)
                except Exception:
                    pass
        except Exception:
            self._settings = None

    def tick(self):
        if self.disabled_by_us and _now() - self.last_activity > ACTIVE_WINDOW:
            self.restore()

    def restore(self):
        if not self.disabled_by_us:
            return
        self.disabled_by_us = False
        try:
            compat.set_property_quiet(self._obj(), self.PROP, True)
        except Exception:
            pass
        try:
            os.remove(self.state_path)
        except Exception:
            pass


class BridgeServer(object):
    def __init__(self, port=None, token=None, host="127.0.0.1"):
        self.host = host
        self.port_pref = DEFAULT_PORT if port is None else int(port)
        self.port = None
        self.token = token or secrets.token_hex(24)
        self.sel = selectors.DefaultSelector()
        self.lsock = None
        self.clients = {}
        self.queue = collections.deque()
        self.tasks = []
        self.rev = 0
        self.journal = collections.deque(maxlen=JOURNAL_MAX)
        self.last_txn = None
        self.tick_hooks = []
        self.started_at = time.time()
        self._next_cid = 1
        self._tick_handle = None
        self._last_err_log = 0.0
        self.paths = compat.project_paths()
        self.bridge_dir = os.path.join(self.paths.get("saved_dir") or HOME_DIR, "UEAgentBridge")
        self._discovery_files = []
        self.watch = Watcher(self)
        self.throttle = Throttle(os.path.join(self.bridge_dir, "throttle_state.json"))
        self.stats = {"calls": 0, "errors": 0, "busy_ms": 0.0}

    # ------------------------------------------------------------ lifecycle

    def start(self):
        try:
            os.makedirs(self.bridge_dir, exist_ok=True)
        except Exception:
            pass
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        if os.name != "nt":
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind((self.host, self.port_pref))
        except OSError:
            s.bind((self.host, 0))
        s.listen(16)
        s.setblocking(False)
        self.lsock = s
        self.port = s.getsockname()[1]
        self.sel.register(s, selectors.EVENT_READ, None)
        self._write_discovery()
        self._tick_handle = unreal.register_slate_post_tick_callback(self._on_tick)
        reg = getattr(unreal, "register_python_shutdown_callback", None)
        if reg is not None:
            try:
                reg(self.stop)
            except Exception:
                pass
        _log("listening on %s:%d (protocol %d, v%s)" % (self.host, self.port, PROTOCOL, VERSION))
        return self

    def stop(self):
        if self.lsock is None:
            return
        try:
            if self._tick_handle is not None:
                unreal.unregister_slate_post_tick_callback(self._tick_handle)
        except Exception:
            pass
        self._tick_handle = None
        for c in list(self.clients.values()):
            self._close(c, "bridge stopping")
        try:
            self.sel.unregister(self.lsock)
        except Exception:
            pass
        try:
            self.lsock.close()
        except Exception:
            pass
        self.lsock = None
        self.throttle.restore()
        self._remove_discovery()
        _log("stopped")

    def describe(self):
        return {
            "running": self.lsock is not None,
            "port": self.port,
            "rev": self.rev,
            "clients": [{"name": c.name, "id": c.cid, "calls": c.calls} for c in self.clients.values() if c.authed],
            "stats": dict(self.stats),
        }

    # ------------------------------------------------------------ discovery

    def _discovery_info(self):
        return {
            "protocol": PROTOCOL,
            "version": VERSION,
            "host": self.host,
            "port": self.port,
            "token": self.token,
            "pid": os.getpid(),
            "project": self.paths.get("project_file"),
            "project_dir": self.paths.get("project_dir"),
            "engine_dir": self.paths.get("engine_dir"),
            "engine_version": compat.engine_version(),
            "python": sys.version.split()[0],
            "started": int(self.started_at),
        }

    def _write_discovery(self):
        info = json.dumps(self._discovery_info(), indent=2)
        targets = [os.path.join(self.bridge_dir, "bridge.json"), os.path.join(HOME_DIR, "instances", "%d.json" % os.getpid())]
        self._cleanup_stale_instances()
        for path in targets:
            try:
                d = os.path.dirname(path)
                os.makedirs(d, exist_ok=True)
                try:
                    os.chmod(d, 0o700)
                except Exception:
                    pass
                tmp = path + ".tmp"
                fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                with os.fdopen(fd, "w") as f:
                    f.write(info)
                os.replace(tmp, path)
                self._discovery_files.append(path)
            except Exception as exc:
                unreal.log_warning("[UEAgentBridge] could not write %s: %s" % (path, exc))

    def _remove_discovery(self):
        for path in self._discovery_files:
            try:
                with open(path) as f:
                    if json.load(f).get("token") != self.token:
                        continue
                os.remove(path)
            except Exception:
                pass
        self._discovery_files = []

    def _cleanup_stale_instances(self):
        if os.name == "nt":  # os.kill(pid, 0) terminates processes on Windows
            return
        d = os.path.join(HOME_DIR, "instances")
        try:
            names = os.listdir(d)
        except Exception:
            return
        for n in names:
            if not n.endswith(".json"):
                continue
            try:
                pid = int(n[:-5])
                if pid == os.getpid():
                    continue
                os.kill(pid, 0)
            except ProcessLookupError:
                try:
                    os.remove(os.path.join(d, n))
                except Exception:
                    pass
            except Exception:
                pass

    # ------------------------------------------------------------ tick pump

    def _on_tick(self, _dt):
        try:
            self.pump()
        except Exception:
            t = _now()
            if t - self._last_err_log > 5.0:
                self._last_err_log = t
                unreal.log_error("[UEAgentBridge] tick error: %s" % traceback.format_exc(limit=4))

    def pump(self):
        if self.lsock is None:
            return
        t0 = _now()
        self._poll_io()
        if self.tasks:
            self._run_tasks()
        n = 0
        while self.queue:
            if n and _now() - t0 > TICK_BUDGET:
                break
            c, msg = self.queue.popleft()
            if c.closed:
                continue
            self._dispatch(c, msg)
            n += 1
        if n or self.tasks:
            self.throttle.activity()
        self.watch.tick()
        self.throttle.tick()
        for hook in list(self.tick_hooks):
            try:
                hook()
            except Exception:
                pass
        self._flush_all()
        if n:
            self.stats["busy_ms"] += (_now() - t0) * 1000.0

    def has_subscribers(self):
        for c in self.clients.values():
            if c.authed and c.subscribed and not c.closed:
                return True
        return False

    # ------------------------------------------------------------ socket I/O

    def _poll_io(self):
        try:
            events = self.sel.select(timeout=0)
        except Exception:
            return
        for key, mask in events:
            if key.data is None:
                self._accept()
                continue
            c = key.data
            if mask & selectors.EVENT_READ:
                self._read(c)
            if mask & selectors.EVENT_WRITE and not c.closed:
                self._flush(c)

    def _accept(self):
        for _ in range(8):
            try:
                conn, addr = self.lsock.accept()
            except (BlockingIOError, InterruptedError):
                return
            except OSError:
                return
            if len(self.clients) >= MAX_CLIENTS:
                conn.close()
                continue
            conn.setblocking(False)
            try:
                conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            except Exception:
                pass
            c = _Client(conn, addr, self._next_cid)
            self._next_cid += 1
            self.clients[c.cid] = c
            self.sel.register(conn, selectors.EVENT_READ, c)

    def _read(self, c):
        try:
            data = c.sock.recv(1 << 18)
        except (BlockingIOError, InterruptedError):
            return
        except OSError:
            self._close(c, "read error")
            return
        if not data:
            self._close(c, "disconnected")
            return
        c.rbuf += data
        while True:
            i = c.rbuf.find(b"\n")
            if i < 0:
                break
            line = bytes(c.rbuf[:i])
            del c.rbuf[: i + 1]
            if not line.strip():
                continue
            try:
                msg = json.loads(line.decode("utf-8"))
                if not isinstance(msg, dict):
                    raise ValueError("message must be an object")
            except Exception as exc:
                self._send(c, {"id": None, "ok": False, "error": {"code": "bad_json", "message": str(exc)}})
                continue
            self.queue.append((c, msg))
        if len(c.rbuf) > MAX_LINE:
            self._close(c, "message too large")

    def _send(self, c, obj):
        if c.closed:
            return
        try:
            data = json.dumps(obj, separators=(",", ":"), ensure_ascii=False, default=str)
        except Exception as exc:
            data = json.dumps({"id": obj.get("id"), "ok": False, "error": {"code": "encode_error", "message": str(exc)}})
        c.wbuf += data.encode("utf-8") + b"\n"
        self._flush(c)

    def _flush(self, c):
        while c.wbuf and not c.closed:
            try:
                n = c.sock.send(c.wbuf[: 1 << 20])
            except (BlockingIOError, InterruptedError):
                break
            except OSError:
                self._close(c, "write error")
                return
            if n <= 0:
                break
            del c.wbuf[:n]
        want = bool(c.wbuf)
        if want != c.want_write and not c.closed:
            c.want_write = want
            try:
                self.sel.modify(c.sock, selectors.EVENT_READ | (selectors.EVENT_WRITE if want else 0), c)
            except Exception:
                pass

    def _flush_all(self):
        for c in list(self.clients.values()):
            if c.wbuf:
                self._flush(c)

    def _close(self, c, why=""):
        if c.closed:
            return
        c.closed = True
        try:
            self.sel.unregister(c.sock)
        except Exception:
            pass
        try:
            c.sock.close()
        except Exception:
            pass
        self.clients.pop(c.cid, None)
        for t in [t for t in self.tasks if t.client is c]:
            self.tasks.remove(t)
            try:
                t.gen.close()
            except Exception:
                pass
        if c.authed:
            _log("%s disconnected (%s)" % (c.name, why))

    # ------------------------------------------------------------ dispatch

    def _reply(self, c, rid, ok, payload, t0=None, warnings=None):
        msg = {"id": rid, "ok": ok, "rev": self.rev}
        if ok:
            msg["result"] = payload
        else:
            msg["error"] = payload
        if t0 is not None:
            msg["ms"] = round((_now() - t0) * 1000.0, 2)
        if warnings:
            msg["warnings"] = warnings
        self._send(c, msg)

    def _error_payload(self, exc):
        if isinstance(exc, BridgeError):
            p = {"code": exc.code, "message": exc.message}
            p.update({k: v for k, v in exc.data.items() if v not in (None, [], {})})
            return p
        tb = traceback.format_exc(limit=6).strip().splitlines()
        return {"code": "exception", "message": "%s: %s" % (type(exc).__name__, exc), "traceback": "\n".join(tb[-12:])}

    def _dispatch(self, c, msg):
        rid = msg.get("id")
        method = msg.get("method")
        params = msg.get("params") or {}
        if not c.authed:
            if method != "hello":
                self._reply(c, rid, False, {"code": "unauthorized", "message": "send hello with the token first"})
                self._flush(c)
                self._close(c, "unauthorized")
                return
            tok = str(params.get("token") or "")
            if not hmac.compare_digest(tok.encode("utf-8"), self.token.encode("utf-8")):
                self._reply(c, rid, False, {"code": "unauthorized", "message": "bad token (re-read bridge.json)"})
                self._flush(c)
                self._close(c, "bad token")
                return
            c.authed = True
            c.name = str(params.get("client") or "agent")[:64]
            c.subscribed = bool(params.get("subscribe", True))
            _log("%s connected (#%d)" % (c.name, c.cid))
            self._reply(c, rid, True, self.hello_info(c))
            return
        if method == "ping":
            self._reply(c, rid, True, {"pong": True, "rev": self.rev})
            return
        if method == "call":
            self._call(c, rid, params)
            return
        if method == "bye":
            self._reply(c, rid, True, {})
            self._flush(c)
            self._close(c, "bye")
            return
        self._reply(c, rid, False, {"code": "unknown_method", "message": "unknown method %r" % method})

    def hello_info(self, c):
        info = self._discovery_info()
        info.pop("token", None)
        info.update(
            {
                "client_id": c.cid,
                "rev": self.rev,
                "ops": sorted(OPS),
                "clients": [x.name for x in self.clients.values() if x.authed],
            }
        )
        return info

    def _call(self, c, rid, params):
        t0 = _now()
        fn = params.get("fn")
        op = OPS.get(fn)
        self.stats["calls"] += 1
        c.calls += 1
        if op is None:
            self._reply(c, rid, False, {"code": "unknown_op", "message": "unknown op %r" % fn, "ops": sorted(OPS)}, t0)
            return
        ctx = CallContext(self, c, fn)
        try:
            a = ctx.args(params.get("args"), "args")
            if op.mutating:
                result = self._run_mutating(op, ctx, a)
            else:
                result = op.fn(ctx, a)
        except Exception as exc:
            self.stats["errors"] += 1
            ctx.collect_unused()
            self._reply(c, rid, False, self._error_payload(exc), t0, ctx.warnings)
            return
        if isinstance(result, types.GeneratorType):
            timeout = params.get("timeout") or op.timeout
            self.tasks.append(_Task(result, c, rid, ctx, t0, float(timeout) if timeout else None))
            return
        ctx.collect_unused()
        self._reply(c, rid, True, result, t0, ctx.warnings)

    def _state_key(self):
        try:
            return (compat.level_path(), tuple(sorted(compat.dirty_packages())), tuple(sorted(x.get_path_name() for x in compat.selected_actors())))
        except Exception:
            return None

    def _run_mutating(self, op, ctx, a):
        label = "%s: %s" % (ctx.agent, op.describe(a.raw()))
        err = None
        result = None
        before = self._state_key() if op.name in ("python", "console") else None
        if op.transact:
            # exceptions are caught *inside* the transaction so it always commits
            # normally; a rollback is then an ordinary undo of exactly this batch
            with compat.transaction(label):
                try:
                    result = op.fn(ctx, a)
                except Exception as exc:
                    err = exc
            if err is not None and getattr(err, "rollback", False):
                try:
                    compat.undo(1)
                    err.data["rolled_back"] = True
                except Exception:
                    pass
        else:
            try:
                result = op.fn(ctx, a)
            except Exception as exc:
                err = exc
        if err is not None and before is not None and before == self._state_key():
            # a failed script/command that visibly changed nothing: don't report it as an engine change
            self.watch.resync()
            raise err
        if op.transact and (err is None or not getattr(err, "data", {}).get("rolled_back")):
            self.last_txn = {"label": label, "by": ctx.agent, "time": time.time(), "failed": err is not None}
        self.watch.resync()
        summary = ctx.summary or op.describe(a.raw())
        self.emit("op", {"op": op.name, "summary": summary, "ok": err is None}, by=ctx.client)
        if err is not None:
            raise err
        return result

    def _run_tasks(self):
        now = _now()
        for t in list(self.tasks):
            if t.client.closed:
                self.tasks.remove(t)
                continue
            if t.wake > now:
                continue
            try:
                if t.deadline is not None and now > t.deadline:
                    t.gen.close()
                    raise BridgeError("timeout", "%s did not finish within %.0fs" % (t.ctx.op, t.deadline - t.t0))
                delay = next(t.gen)
                t.wake = now + float(delay or 0.0)
            except StopIteration as stop:
                self.tasks.remove(t)
                t.ctx.collect_unused()
                self._reply(t.client, t.rid, True, stop.value, t.t0, t.ctx.warnings)
            except Exception as exc:
                self.tasks.remove(t)
                self.stats["errors"] += 1
                self._reply(t.client, t.rid, False, self._error_payload(exc), t.t0, t.ctx.warnings)

    # ------------------------------------------------------------ change journal

    def emit(self, kind, data, by=None):
        self.rev += 1
        ev = {
            "rev": self.rev,
            "t": round(time.time(), 3),
            "kind": kind,
            "by": by.name if by is not None else "editor",
            "cid": by.cid if by is not None else None,
            "data": data,
        }
        self.journal.append(ev)
        msg = dict(ev)
        msg["event"] = "change"
        for c in list(self.clients.values()):
            if c.authed and c.subscribed and not c.closed:
                self._send(c, msg)
        return ev

    def changes_since(self, rev, limit=200):
        out = [e for e in self.journal if e["rev"] > rev]
        oldest = self.journal[0]["rev"] if self.journal else self.rev + 1
        return {
            "rev": self.rev,
            "changes": out[-limit:],
            "truncated": len(out) > limit or (rev + 1 < oldest and rev < self.rev),
        }
