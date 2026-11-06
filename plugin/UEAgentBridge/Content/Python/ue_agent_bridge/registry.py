"""Operation registry, argument wrapper and error type shared by every op."""
import difflib

OPS = {}


class BridgeError(Exception):
    """An error with a stable code that is reported to the agent verbatim.

    Set ``rollback=True`` when part of a transacted batch was applied and the
    server should undo the transaction so the batch stays all-or-nothing.
    """

    def __init__(self, code, message, rollback=False, **data):
        Exception.__init__(self, message)
        self.code = code
        self.message = message
        self.rollback = rollback
        self.data = data


class Op(object):
    __slots__ = ("name", "fn", "mutating", "transact", "label", "timeout")

    def __init__(self, name, fn, mutating, transact, label, timeout):
        self.name = name
        self.fn = fn
        self.mutating = mutating
        self.transact = transact
        self.label = label
        self.timeout = timeout

    def describe(self, raw_args):
        if callable(self.label):
            try:
                return self.label(raw_args or {})
            except Exception:
                pass
        return self.label or self.name


def op(name, mutating=False, transact=None, label=None, timeout=60.0):
    """Register ``fn(ctx, args)`` as bridge op ``name``.

    mutating: changes engine state (bumps the revision, notifies other agents)
    transact: wrap in one undoable editor transaction (defaults to ``mutating``)
    """

    def deco(fn):
        OPS[name] = Op(name, fn, mutating, mutating if transact is None else transact, label, timeout)
        return fn

    return deco


class Args(object):
    """Dict wrapper that remembers which keys were read, so typos get reported."""

    __slots__ = ("_d", "_used", "where")

    def __init__(self, data, where="args"):
        if data is None:
            data = {}
        if not isinstance(data, dict):
            raise BridgeError("bad_args", "%s must be a JSON object" % where)
        self._d = data
        self._used = set()
        self.where = where

    def get(self, key, default=None):
        self._used.add(key)
        v = self._d.get(key)
        return default if v is None else v

    def has(self, key):
        self._used.add(key)
        return self._d.get(key) is not None

    def require(self, key):
        self._used.add(key)
        v = self._d.get(key)
        if v is None or v == "":
            raise BridgeError("bad_args", "missing required argument '%s' in %s" % (key, self.where))
        return v

    def raw(self):
        return self._d

    def unused(self):
        return [k for k in self._d if k not in self._used]


class CallContext(object):
    """Per-call state handed to every op."""

    def __init__(self, server, client, op_name):
        self.server = server
        self.client = client
        self.op = op_name
        self.warnings = []
        self.summary = None
        self._args = []

    @property
    def agent(self):
        return self.client.name if self.client else "editor"

    def args(self, data, where="args"):
        a = Args(data, where)
        self._args.append(a)
        return a

    def warn(self, msg):
        if msg not in self.warnings and len(self.warnings) < 20:
            self.warnings.append(msg)

    def collect_unused(self):
        for a in self._args:
            for k in a.unused():
                self.warn("unknown argument '%s' in %s was ignored" % (k, a.where))


def suggest(word, candidates, n=5):
    if not word:
        return []
    cands = list(candidates)
    lower = {c.lower(): c for c in cands}
    hits = difflib.get_close_matches(word.lower(), list(lower), n=n, cutoff=0.5)
    out = [lower[h] for h in hits]
    if len(out) < n:
        w = word.lower()
        for c in cands:
            if w in c.lower() and c not in out:
                out.append(c)
                if len(out) >= n:
                    break
    return out
