"""
tx_parse -- parse Python / JavaScript / C++ / Java source into the neutral IR.
"""
import re
from tx_core import (N, Ty, INT, FLOAT, STR, BOOL, CHAR, VOID, ANY, LONG, list_of, arr_of, dict_of,
                     set_of, cls_of, lex, Unsupported, Tok)

AUTO = Ty("auto")
SCANNER = Ty("scanner")

_PRIMS = {
    "int": INT, "long": LONG, "short": INT, "byte": INT, "size_t": INT, "Integer": INT, "Long": LONG,
    "Short": INT, "uint": INT, "int64_t": LONG, "int32_t": INT, "uint64_t": LONG, "ll": LONG,
    "double": FLOAT, "float": FLOAT, "Double": FLOAT, "Float": FLOAT,
    "string": STR, "String": STR, "str": STR,
    "bool": BOOL, "boolean": BOOL, "Boolean": BOOL,
    "char": CHAR, "Character": CHAR, "void": VOID, "None": VOID, "NoneType": VOID,
    "number": FLOAT, "any": ANY, "Any": ANY, "object": ANY, "Object": ANY,
    "StringBuilder": STR, "StringBuffer": STR, "stringstream": STR,
}
_LISTS = {"vector", "list", "List", "ArrayList", "LinkedList", "deque", "Deque", "array", "Array",
          "Vector", "Sequence", "Iterable", "Queue", "Stack", "ArrayDeque", "Tuple", "tuple"}
_DICTS = {"map", "unordered_map", "Map", "HashMap", "TreeMap", "dict", "Dict", "LinkedHashMap",
          "Mapping"}
_SETS = {"set", "unordered_set", "Set", "HashSet", "TreeSet", "frozenset", "LinkedHashSet"}
_QUALS = {"const", "static", "final", "volatile", "register", "constexpr", "mutable", "inline",
          "extern", "virtual", "public", "private", "protected", "abstract", "synchronized",
          "transient", "explicit", "unsigned", "signed", "override"}
_ASSIGN_OPS = {"=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>=", "**=", "//=", ">>>="}

_C_BIN = {
    "??": 1, "||": 2, "&&": 3, "|": 4, "^": 5, "&": 6,
    "==": 7, "!=": 7, "===": 7, "!==": 7,
    "<": 8, "<=": 8, ">": 8, ">=": 8,
    "<<": 9, ">>": 9, ">>>": 9, "+": 10, "-": 10, "*": 11, "/": 11, "%": 11, "**": 12,
}
_CTYPE_WORDS = {"int", "double", "float", "long", "short", "char", "bool", "unsigned", "signed", "byte",
                "boolean"}


def ty_from_name(name, args):
    if name in _PRIMS:
        return _PRIMS[name]
    if name in _LISTS:
        return list_of(args[0] if args else None)
    if name in _DICTS:
        return dict_of(args[0] if args else None, args[1] if len(args) > 1 else None)
    if name in _SETS:
        return set_of(args[0] if args else None)
    if name in ("auto", "var", "let", "const"):
        return AUTO
    if name in ("Scanner", "BufferedReader", "InputStreamReader"):
        return SCANNER
    if name in ("pair", "Pair", "Optional", "function", "Function", "tuple"):
        raise Unsupported("type " + name)
    return cls_of(name)


def expr_to_ty(e):
    """Convert a Python annotation expression into a Ty."""
    if e is None:
        return None
    if e.k == "Null":
        return VOID
    if e.k == "Name":
        return ty_from_name(e.id, [])
    if e.k == "Str":
        return ty_from_name(e.v, [])
    if e.k == "Attr":
        return ty_from_name(e.name, [])
    if e.k == "Index":
        base = e.obj.id if e.obj.k == "Name" else (e.obj.name if e.obj.k == "Attr" else None)
        args = [expr_to_ty(x) for x in (e.idx.items if e.idx.k == "TupleE" else [e.idx])]
        if base in ("Optional",):
            return args[0]
        return ty_from_name(base, args)
    raise Unsupported("annotation")


def dotted(e):
    if e.k == "Name":
        return e.id
    if e.k == "Attr":
        d = dotted(e.obj)
        return d + "." + e.name if d else None
    if e.k == "This":
        return "this"
    return None


def num(v):
    return N("Num", v=str(v), isf=False)


def intr(name, *args):
    return N("Intr", name=name, args=list(args))


def fmt_to_fstr(fmt, args):
    """printf-style format -> FStr node."""
    if fmt.k != "Str":
        raise Unsupported("non-literal format string")
    s, parts, buf, ai = fmt.v, [], [], 0
    i = 0
    rx = re.compile(r"%([-+ 0#]*)(\d+)?(?:\.(\d+))?(?:ll|l|h|L)?([diufsScxXeEgGn%])")
    while i < len(s):
        if s[i] != "%":
            buf.append(s[i])
            i += 1
            continue
        m = rx.match(s, i)
        if not m:
            raise Unsupported("format spec")
        flags, width, prec, conv = m.groups()
        i = m.end()
        if conv == "%":
            buf.append("%")
            continue
        if conv == "n":
            buf.append("\n")
            continue
        if ai >= len(args):
            raise Unsupported("format args")
        a = args[ai]
        ai += 1
        if buf:
            parts.append("".join(buf))
            buf = []
        spec = ""
        if flags and "-" in flags:
            spec += "<"
        elif width and conv in "sS":
            spec += ">"
        if flags and "0" in flags and "-" not in flags:
            spec += "0"
        spec += width or ""
        if conv in "fF":
            spec += "." + (prec if prec is not None else "6") + "f"
        elif conv in "eE":
            spec += "." + (prec if prec is not None else "6") + "e"
        elif conv in "xX":
            spec += "x"
        elif conv in "di" and spec:
            spec += "d"
        elif conv in "sS" and prec:
            spec += "." + prec
        parts.append((a, spec))
    if buf:
        parts.append("".join(buf))
    return N("FStr", parts=parts)


class P:
    def __init__(self, src, lang, ts=False):
        self.ts = ts
        self.lang = lang
        self.py = lang == "python"
        self.js = lang == "javascript"
        self.t = lex(src, lang)
        self.i = 0
        self.scanners = set()
        self.class_names = set()
        self.pending = {}  # C++ out-of-class method bodies
        self.boolalpha = False
        self.cout_fixed = False
        self.cout_prec = None
        self.extra_classes = []
        self.static_inits = []
        self.has_main = False

    # ── token helpers ─────────────────────────────────────────────────────
    def peek(self, k=0):
        return self.t[min(self.i + k, len(self.t) - 1)]

    def nxt(self):
        t = self.t[self.i]
        if self.i < len(self.t) - 1:
            self.i += 1
        return t

    def is_op(self, v, k=0):
        t = self.peek(k)
        return t.k == "op" and t.v == v

    def is_id(self, v, k=0):
        t = self.peek(k)
        return t.k == "id" and t.v == v

    def accept_op(self, v):
        if self.is_op(v):
            self.nxt()
            return True
        return False

    def accept_id(self, v):
        if self.is_id(v):
            self.nxt()
            return True
        return False

    def expect_op(self, v):
        if not self.accept_op(v):
            raise Unsupported("line %d: expected %r, found %r" % (self.peek().line, v, self.peek().v))

    def expect_id(self, v=None):
        t = self.peek()
        if t.k != "id" or (v and t.v != v):
            raise Unsupported("line %d: expected identifier %s" % (t.line, v or ""))
        return self.nxt().v

    def at_eof(self):
        return self.peek().k == "eof"

    # ── program ───────────────────────────────────────────────────────────
    def parse_program(self):
        items = []
        if self.py:
            while not self.at_eof():
                items.extend(self.py_stmt())
        else:
            while not self.at_eof():
                items.extend(self.c_top())
        for fn in list(self.pending.values()):
            raise Unsupported("method body without class: " + fn.name)
        items.extend(self.extra_classes)
        for owner, fname, init, fty in self.static_inits:
            for c in items:
                if c.k == "Class" and c.name == owner:
                    for f in c.fields:
                        if f.name == fname:
                            f.init = init
                            f.static = True
        return N("Prog", items=items, src=self.lang, has_main=self.has_main, boolalpha=self.boolalpha)

    # =====================================================================
    #  PYTHON
    # =====================================================================
    def py_skip_to_nl(self):
        while self.peek().k not in ("nl", "eof"):
            self.nxt()
        if self.peek().k == "nl":
            self.nxt()

    def py_block(self):
        self.expect_op(":")
        if self.peek().k == "nl":
            self.nxt()
            body = []
            while self.peek().k == "comment":
                body.append(N("Comment", text=self.nxt().v))
            if self.peek().k != "indent":
                raise Unsupported("line %d: expected an indented block" % self.peek().line)
            self.nxt()
            while self.peek().k not in ("dedent", "eof"):
                body.extend(self.py_stmt())
            if self.peek().k == "dedent":
                self.nxt()
            return body
        return self.py_simple_stmts()

    def py_stmt(self):
        t = self.peek()
        if t.k == "comment":
            self.nxt()
            return [N("Comment", text=t.v)]
        if t.k == "nl":
            self.nxt()
            return []
        if t.k == "op" and t.v == "@":
            self.nxt()
            deco = self.expect_id()
            self.py_skip_to_nl()
            node = self.py_stmt()
            if deco == "staticmethod" and node and node[0].k == "Func":
                node[0].static = True
            return node
        if t.k == "id":
            v = t.v
            if v == "def":
                return [self.py_def()]
            if v == "class":
                return [self.py_class()]
            if v == "if":
                return [self.py_if()]
            if v == "while":
                self.nxt()
                c = self.py_expr()
                return [N("While", cond=c, body=self.py_block())]
            if v == "for":
                return [self.py_for()]
            if v == "try":
                return [self.py_try()]
            if v == "with":
                raise Unsupported("with statement")
        return self.py_simple_stmts()

    def py_if(self):
        self.nxt()
        c = self.py_expr()
        body = self.py_block()
        orelse = []
        while self.peek().k == "comment":
            self.nxt()
        if self.is_id("elif"):
            self.t[self.i].v = "if"
            orelse = [self.py_if()]
        elif self.is_id("else"):
            self.nxt()
            orelse = self.py_block()
        return N("If", cond=c, body=body, orelse=orelse)

    def py_for(self):
        self.nxt()
        targets = []
        while True:
            targets.append(self.py_target_atom())
            if not self.accept_op(","):
                break
        self.expect_id("in")
        it = self.py_exprlist()
        body = self.py_block()
        if len(targets) == 1:
            v = targets[0]
            if it.k == "MaybeBuiltin" and it.name == "range":
                a = it.args
                if len(a) == 1:
                    lo, hi, st = num(0), a[0], num(1)
                elif len(a) == 2:
                    lo, hi, st = a[0], a[1], num(1)
                elif len(a) == 3:
                    lo, hi, st = a
                else:
                    raise Unsupported("range arity")
                return N("ForRange", var=v.id, vty=INT, lo=lo, hi=hi, step=st, incl=False, body=body)
            return N("ForEach", var=v.id, vty=None, it=it, body=body)
        if len(targets) >= 2 and it.k == "Call" and dotted(it.fn) == "zip" and len(it.args) == len(targets):
            return N("ForZip", vars=[t.id for t in targets], its=it.args, body=body)
        if len(targets) == 2:
            if it.k == "Call" and dotted(it.fn) == "enumerate" and len(it.args) >= 1:
                start = it.args[1] if len(it.args) > 1 else num(0)
                return N("ForEnum", idx=targets[0].id, var=targets[1].id, it=it.args[0], start=start,
                         body=body)
            if it.k == "Call" and isinstance(it.fn, N) and it.fn.k == "Attr" and it.fn.name == "items":
                return N("ForDict", kvar=targets[0].id, vvar=targets[1].id, it=it.fn.obj, body=body)
        raise Unsupported("for-loop form")

    def py_target_atom(self):
        if self.accept_op("("):
            t = self.py_target_atom()
            self.expect_op(")")
            return t
        name = self.expect_id()
        return N("Name", id=name)

    def py_try(self):
        self.nxt()
        body = self.py_block()
        while self.peek().k == "comment":
            self.nxt()
        var, handler, fin = None, [], []
        excs = 0
        while self.is_id("except"):
            excs += 1
            self.nxt()
            if not self.is_op(":"):
                self.py_expr()
                if self.accept_id("as"):
                    var = self.expect_id()
            h = self.py_block()
            if excs == 1:
                handler = h
            else:
                raise Unsupported("multiple except clauses")
            while self.peek().k == "comment":
                self.nxt()
        if self.is_id("finally"):
            self.nxt()
            fin = self.py_block()
        return N("Try", body=body, var=var, handler=handler, fin=fin)

    def py_def(self):
        self.nxt()
        name = self.expect_id()
        self.expect_op("(")
        params, is_method = [], False
        while not self.is_op(")"):
            if self.is_op("*") or self.is_op("**"):
                raise Unsupported("*args/**kwargs")
            pn = self.expect_id()
            pty, default = None, None
            if self.accept_op(":"):
                pty = expr_to_ty(self.py_expr())
            if self.accept_op("="):
                default = self.py_expr()
            if pn in ("self", "cls") and not params:
                is_method = True
            else:
                params.append(N("Param", name=pn, ty=pty, default=default))
            if not self.accept_op(","):
                break
        self.expect_op(")")
        ret = None
        if self.accept_op("->"):
            ret = expr_to_ty(self.py_expr())
        body = self.py_block()
        # drop docstring
        if body and body[0].k == "ExprS" and body[0].e.k == "Str":
            body = body[1:]
        if name == "__str__":
            name = "toString"
        f = N("Func", name=name, params=params, ret=ret, body=body, static=False, method=is_method,
              ctor=(name == "__init__"))
        return f

    def py_class(self):
        self.nxt()
        name = self.expect_id()
        base = None
        if self.accept_op("("):
            if not self.is_op(")"):
                b = self.py_expr()
                if dotted(b) not in ("object", None):
                    base = dotted(b)
            self.expect_op(")")
        self.class_names.add(name)
        body = self.py_block()
        fields, methods, ctor = [], [], None
        for s in body:
            if s.k == "Func":
                if s.ctor:
                    s.name = name
                    ctor = s
                else:
                    if not s.method:
                        s.static = True
                    methods.append(s)
            elif s.k == "Assign" and s.target.k == "Name":
                fields.append(N("Field", name=s.target.id, ty=None, init=s.value, static=True))
            elif s.k == "VarDecl":
                fields.append(N("Field", name=s.name, ty=s.ty, init=s.init, static=True))
        return N("Class", name=name, base=base, fields=fields, ctor=ctor, methods=methods)

    def py_simple_stmts(self):
        out = []
        while True:
            out.extend(self.py_simple())
            if self.accept_op(";"):
                if self.peek().k in ("nl", "eof"):
                    break
                continue
            break
        if self.peek().k == "nl":
            self.nxt()
        elif self.peek().k not in ("eof", "dedent"):
            raise Unsupported("line %d: unexpected %r" % (self.peek().line, self.peek().v))
        return out

    def py_simple(self):
        t = self.peek()
        if t.k == "id":
            v = t.v
            if v == "pass":
                self.nxt()
                return [N("Pass")]
            if v == "break":
                self.nxt()
                return [N("Break")]
            if v == "continue":
                self.nxt()
                return [N("Continue")]
            if v in ("import", "from"):
                self.py_skip_to_nl()
                self.i -= 1  # leave the nl for py_simple_stmts
                if self.peek().k != "nl":
                    self.i += 1
                return []
            if v in ("global", "nonlocal"):
                self.nxt()
                names = []
                while self.peek().k == "id":
                    names.append(self.nxt().v)
                    self.accept_op(",")
                return [N("GlobalDecl", names=names)]
            if v == "return":
                self.nxt()
                e = None
                if self.peek().k not in ("nl", "eof") and not self.is_op(";"):
                    e = self.py_exprlist()
                return [N("Return", e=e)]
            if v == "raise":
                self.nxt()
                e = None
                if self.peek().k not in ("nl", "eof"):
                    e = self.py_expr()
                return [self.make_throw(e)]
            if v == "del":
                self.nxt()
                tg = self.py_expr()
                if tg.k == "Index":
                    return [N("ExprS", e=intr("del", tg.obj, tg.idx))]
                raise Unsupported("del")
            if v == "assert":
                self.nxt()
                c = self.py_expr()
                if self.accept_op(","):
                    self.py_expr()
                return [N("Assert", cond=c)]
            if v in ("lambda",) and False:
                pass
        e = self.py_exprlist()
        # annotated declaration
        if self.is_op(":") and e.k in ("Name", "Attr"):
            self.nxt()
            ty = expr_to_ty(self.py_expr())
            init = self.py_expr() if self.accept_op("=") else None
            if e.k == "Name":
                return [N("VarDecl", name=e.id, ty=ty, init=init, const=False)]
            return [N("Assign", target=e, op="=", value=init)]
        if self.is_op("="):
            parts = [e]
            while self.accept_op("="):
                parts.append(self.py_exprlist())
            value = parts[-1]
            out = []
            for tg in reversed(parts[:-1]):
                out.extend(self.py_assign(tg, value))
            return out
        t = self.peek()
        if t.k == "op" and t.v in _ASSIGN_OPS and t.v != "=":
            self.nxt()
            v = self.py_exprlist()
            return [N("Assign", target=e, op=t.v, value=v)]
        if e.k in ("Print", "SuperCall", "Swap"):
            return [e]
        return [N("ExprS", e=e)]

    def py_assign(self, tg, value):
        if tg.k != "TupleE":
            return [N("Assign", target=tg, op="=", value=value)]
        names = tg.items
        if value.k == "TupleE":
            if len(value.items) != len(names):
                raise Unsupported("tuple unpack")
            if len(names) == 2 and value.items[0] is not None and \
                    dotted(value.items[0]) is not None and dotted(value.items[1]) is not None and \
                    dotted(value.items[0]) == dotted(names[1]) and dotted(value.items[1]) == dotted(names[0]):
                return [N("Swap", a=names[0], b=names[1])]
            tnames = {dotted(t) for t in names if dotted(t)}
            used = set()

            def nm(n):
                d = dotted(n) if n.k in ("Name", "Attr") else None
                if d:
                    used.add(d)
                    if n.k == "Attr":
                        used.add(dotted(n.obj) or "")
                if n.k == "Name":
                    used.add(n.id)
            from tx_sema import walk as _walk
            for v in value.items:
                _walk(v, nm)
            if not (tnames & used) and all(t.k in ("Name", "Attr") for t in names):
                return [N("Assign", target=t, op="=", value=v) for t, v in zip(names, value.items)]
            # general: evaluate all values first via temps
            out, tmps = [], []
            self.tmpn = getattr(self, "tmpn", 0) + 1
            for k, v in enumerate(value.items):
                tn = "_t%d_%d" % (self.tmpn, k)
                out.append(N("VarDecl", name=tn, ty=None, init=v, const=False))
                tmps.append(tn)
            for nm, tn in zip(names, tmps):
                out.append(N("Assign", target=nm, op="=", value=N("Name", id=tn)))
            return out
        # a, b = map(int, input().split())  /  a, b = input().split()
        r = self.read_pattern(names, value)
        if r:
            return [r]
        return [N("TupleAssign", targets=names, value=value)]

    def read_pattern(self, names, value):
        if value.k == "Call" and dotted(value.fn) == "map" and len(value.args) == 2 \
                and dotted(value.args[0]) in ("int", "float", "str"):
            inner = value.args[1]
            cast = {"int": INT, "float": FLOAT, "str": STR}[dotted(value.args[0])]
        else:
            inner, cast = value, STR
        if inner.k == "Call" and inner.fn.k == "Attr" and inner.fn.name == "split" and not inner.args:
            src = inner.fn.obj
            if src.k == "Input" and src.mode == "line":
                return N("ReadStmt", targets=names, mode="tok", tys=[cast] * len(names), decl=[False] * len(names),
                         linesplit=True)
        return None

    def py_exprlist(self):
        e = self.py_expr()
        if self.is_op(","):
            items = [e]
            while self.accept_op(","):
                if self.peek().k in ("nl", "eof") or self.is_op("=") or self.is_op(")"):
                    break
                items.append(self.py_expr())
            return N("TupleE", items=items)
        return e

    # ── python expressions ────────────────────────────────────────────────
    def py_expr(self):
        if self.is_id("lambda"):
            self.nxt()
            ps = []
            while not self.is_op(":"):
                ps.append(self.expect_id())
                if not self.accept_op(","):
                    break
            self.expect_op(":")
            return N("Lambda", params=ps, body=self.py_expr())
        e = self.py_or()
        if self.is_id("if"):
            self.nxt()
            c = self.py_or()
            self.expect_id("else")
            b = self.py_expr()
            return N("Tern", c=c, a=e, b=b)
        return e

    def py_or(self):
        e = self.py_and()
        while self.accept_id("or"):
            e = N("Bin", op="or", l=e, r=self.py_and())
        return e

    def py_and(self):
        e = self.py_not()
        while self.accept_id("and"):
            e = N("Bin", op="and", l=e, r=self.py_not())
        return e

    def py_not(self):
        if self.accept_id("not"):
            return N("Un", op="not", e=self.py_not())
        return self.py_cmp()

    def py_cmp(self):
        left = self.py_bin(0)
        out, prev = None, left
        while True:
            op = None
            t = self.peek()
            if t.k == "op" and t.v in ("<", ">", "<=", ">=", "==", "!="):
                op = t.v
                self.nxt()
            elif t.k == "id" and t.v == "in":
                op = "in"
                self.nxt()
            elif t.k == "id" and t.v == "not" and self.is_id("in", 1):
                self.nxt()
                self.nxt()
                op = "notin"
            elif t.k == "id" and t.v == "is":
                self.nxt()
                op = "!=" if self.accept_id("not") else "=="
            else:
                break
            right = self.py_bin(0)
            node = N("Bin", op=op, l=prev, r=right)
            out = node if out is None else N("Bin", op="and", l=out, r=node)
            prev = right
        return out if out is not None else left

    _PY_BIN = {"|": 1, "^": 2, "&": 3, "<<": 4, ">>": 4, "+": 5, "-": 5, "*": 6, "/": 6, "//": 6, "%": 6}

    def py_bin(self, minp):
        left = self.py_unary()
        while True:
            t = self.peek()
            if t.k == "op" and t.v in self._PY_BIN and self._PY_BIN[t.v] > minp:
                p = self._PY_BIN[t.v]
                self.nxt()
                right = self.py_bin(p)
                if t.v == "%" and left.k == "Str":
                    left = fmt_to_fstr(left, right.items if right.k == "TupleE" else [right])
                else:
                    left = N("Bin", op=t.v, l=left, r=right)
            else:
                return left

    def py_unary(self):
        t = self.peek()
        if t.k == "op" and t.v in ("-", "+", "~"):
            self.nxt()
            e = self.py_unary()
            if t.v == "-" and e.k == "Num":
                return N("Num", v="-" + e.v, isf=e.isf)
            return N("Un", op=t.v, e=e)
        return self.py_power()

    def py_power(self):
        base = self.py_postfix()
        if self.accept_op("**"):
            return N("Bin", op="**", l=base, r=self.py_unary())
        return base

    def py_args(self):
        args, kw = [], []
        while not self.is_op(")"):
            if self.is_op("*") or self.is_op("**"):
                raise Unsupported("star-args")
            if self.peek().k == "id" and self.is_op("=", 1) and not self.is_op("==", 1):
                name = self.nxt().v
                self.nxt()
                kw.append((name, self.py_expr()))
            else:
                e = self.py_expr()
                if self.is_id("for"):
                    e = self.py_comp_tail(e)
                args.append(e)
            if not self.accept_op(","):
                break
        self.expect_op(")")
        return args, kw

    def py_comp_tail(self, elt):
        self.nxt()  # for
        v = self.py_target_atom()
        self.expect_id("in")
        it = self.py_or()
        cond = None
        if self.accept_id("if"):
            cond = self.py_or()
        if self.is_id("for"):
            raise Unsupported("nested comprehension")
        return N("ListComp", elt=elt, var=v.id, it=it, cond=cond)

    def py_postfix(self):
        e = self.py_atom()
        while True:
            if self.is_op("("):
                self.nxt()
                args, kw = self.py_args()
                e = self.make_call(e, args, kw)
            elif self.is_op("."):
                self.nxt()
                e = self.make_attr(e, self.expect_id())
            elif self.is_op("["):
                self.nxt()
                e = self.py_subscript(e)
            else:
                return e

    def py_subscript(self, obj):
        lo = hi = step = None
        sl = False
        if not self.is_op(":"):
            lo = self.py_expr()
        if self.accept_op(":"):
            sl = True
            if not self.is_op("]") and not self.is_op(":"):
                hi = self.py_expr()
            if self.accept_op(":"):
                if not self.is_op("]"):
                    step = self.py_expr()
        self.expect_op("]")
        if sl:
            if step is not None:
                if step.k == "Num" and step.v == "-1" and lo is None and hi is None:
                    return intr("reversed_copy", obj)
                raise Unsupported("slice step")
            return N("Slice", obj=obj, lo=lo, hi=hi)
        return N("Index", obj=obj, idx=lo)

    def py_atom(self):
        t = self.peek()
        if t.k == "num":
            self.nxt()
            return N("Num", v=t.v, isf=(t.x == "float"))
        if t.k == "str":
            self.nxt()
            s = t.v
            while self.peek().k == "str":
                s += self.nxt().v
            return N("Str", v=s, char=False)
        if t.k == "fstr":
            self.nxt()
            return self.build_fstr(t.v)
        if t.k == "id":
            self.nxt()
            v = t.v
            if v == "True":
                return N("Bool", v=True)
            if v == "False":
                return N("Bool", v=False)
            if v == "None":
                return N("Null")
            if v == "self":
                return N("This")
            if v == "input":
                pass
            return N("Name", id=v)
        if t.k == "op":
            if t.v == "(":
                self.nxt()
                if self.accept_op(")"):
                    return N("TupleE", items=[])
                e = self.py_expr()
                if self.is_id("for"):
                    e = self.py_comp_tail(e)
                if self.is_op(","):
                    items = [e]
                    while self.accept_op(","):
                        if self.is_op(")"):
                            break
                        items.append(self.py_expr())
                    self.expect_op(")")
                    return N("TupleE", items=items)
                self.expect_op(")")
                return e
            if t.v == "[":
                self.nxt()
                if self.accept_op("]"):
                    return N("ListLit", items=[])
                e = self.py_expr()
                if self.is_id("for"):
                    e = self.py_comp_tail(e)
                    self.expect_op("]")
                    return e
                items = [e]
                while self.accept_op(","):
                    if self.is_op("]"):
                        break
                    items.append(self.py_expr())
                self.expect_op("]")
                return N("ListLit", items=items)
            if t.v == "{":
                self.nxt()
                if self.accept_op("}"):
                    return N("DictLit", pairs=[])
                k = self.py_expr()
                if self.accept_op(":"):
                    pairs = [(k, self.py_expr())]
                    while self.accept_op(","):
                        if self.is_op("}"):
                            break
                        kk = self.py_expr()
                        self.expect_op(":")
                        pairs.append((kk, self.py_expr()))
                    self.expect_op("}")
                    return N("DictLit", pairs=pairs)
                items = [k]
                while self.accept_op(","):
                    if self.is_op("}"):
                        break
                    items.append(self.py_expr())
                self.expect_op("}")
                return N("SetLit", items=items)
            if t.v == "...":
                self.nxt()
                return N("Null")
        raise Unsupported("line %d: unexpected %r" % (t.line, t.v))

    def build_fstr(self, parts):
        out = []
        for p in parts:
            if isinstance(p, str):
                out.append(p)
            else:
                src, spec = p
                sub = P(src, "python" if self.py else self.lang)
                if self.py:
                    sub.t = [x for x in sub.t if x.k not in ("nl", "indent", "dedent", "comment")]
                e = sub.py_exprlist() if self.py else sub.c_expr()
                out.append((e, spec))
        return N("FStr", parts=out)

    # =====================================================================
    #  CALLS & NAMES (shared canonicalisation, language independent)
    # =====================================================================
    def make_attr(self, obj, name):
        d = dotted(obj)
        full = (d + "." + name) if d else None
        const = {
            "Integer.MAX_VALUE": "2147483647", "Integer.MIN_VALUE": "-2147483648",
            "Long.MAX_VALUE": "9223372036854775807", "Long.MIN_VALUE": "-9223372036854775808",
        }
        if full in const:
            return num(const[full])
        if full in ("Math.PI", "math.pi", "M_PI"):
            return intr("pi")
        if full in ("Math.E", "math.e"):
            return intr("e")
        if full in ("math.inf", "Double.POSITIVE_INFINITY"):
            return intr("inf")
        if full == "Number.MAX_SAFE_INTEGER":
            return num("9007199254740991")
        if obj.k == "Name" and obj.id in ("std", "System", "Math") and False:
            return N("Name", id=name)
        if obj.k == "Name" and obj.id == "std":
            return N("Name", id=name)
        if full in ("string::npos",):
            return num("-1")
        return N("Attr", obj=obj, name=name)

    def make_throw(self, e):
        if e is None:
            return N("Throw", e=None)
        if e.k == "Call" or e.k == "New":
            args = e.args
            return N("Throw", e=args[0] if args else N("Str", v="error", char=False))
        return N("Throw", e=e)

    def make_call(self, fn, args, kw=None):
        r = self.make_call_inner(fn, args, kw)
        # a bare builtin name may be shadowed by a user function: let sema decide
        if fn.k == "Name" and r.k in ("Intr", "Cast", "Swap") and r is not None \
                and fn.id not in ("print", "input", "super"):
            return N("MaybeBuiltin", name=fn.id, fn=fn, args=args, kw=kw or [], canon=r)
        return r

    def make_call_inner(self, fn, args, kw=None):
        kw = kw or []
        d = dotted(fn)
        L = self.lang
        # --- super calls
        if d == "super" and not args and L == "python":
            return N("Super")
        if d == "super" or (fn.k == "Attr" and fn.obj.k == "Super" and fn.name == "__init__"):
            return N("SuperCall", args=args)
        if fn.k == "Attr" and fn.name == "__init__" and fn.obj.k == "Name" and \
                fn.obj.id in self.class_names:
            return N("SuperCall", args=args[1:])
        # --- sorting with a key function / comparator
        r = self.sort_call(fn, d, args, kw)
        if r is not None:
            return r
        # --- "...".format(...)
        if fn.k == "Attr" and fn.name == "format" and fn.obj.k == "Str":
            return self.format_to_fstr(fn.obj, args, kw)
        # --- printing
        if d == "print" and L == "python":
            sep, end = " ", "\n"
            for k, v in kw:
                if k == "sep" and v.k == "Str":
                    sep = v.v
                elif k == "end" and v.k == "Str":
                    end = v.v
                elif k == "flush":
                    pass
                else:
                    raise Unsupported("print option " + k)
            return N("Print", items=args, sep=sep, end=end)
        if d in ("console.log", "console.info", "console.error", "console.warn", "console.debug"):
            return N("Print", items=args, sep=" ", end="\n")
        if d == "process.stdout.write":
            return N("Print", items=args, sep="", end="")
        if d in ("System.out.println", "System.out.print", "System.err.println", "System.err.print"):
            if len(args) > 1:
                raise Unsupported("println arity")
            return N("Print", items=args, sep="", end="\n" if d.endswith("ln") else "")
        if d in ("System.out.printf", "System.out.format", "printf"):
            return self.fixup_print(N("Print", items=[fmt_to_fstr(args[0], args[1:])], sep="", end=""))
        if d in ("String.format",):
            return fmt_to_fstr(args[0], args[1:])
        if d == "puts":
            return N("Print", items=args, sep="", end="\n")
        # --- input
        if d == "input" and L == "python":
            return N("Input", prompt=args[0] if args else None, mode="line")
        if d == "prompt" and L == "javascript":
            return N("Input", prompt=args[0] if args else None, mode="line")
        if d == "getline" and L == "cpp" and len(args) == 2:
            return N("Assign", target=args[1], op="=", value=N("Input", prompt=None, mode="line"))
        if fn.k == "Attr" and fn.obj.k == "Name" and fn.obj.id in self.scanners:
            m = fn.name
            if m in ("nextLine", "readLine"):
                return N("Input", prompt=None, mode="line")
            tk = {"nextInt": INT, "nextLong": INT, "nextDouble": FLOAT, "nextFloat": FLOAT,
                  "next": STR, "nextBoolean": BOOL}
            if m in tk:
                return N("Input", prompt=None, mode="tok", cast=tk[m])
            if m == "close":
                return N("Null")
        # --- casts / conversions
        simple = {
            "len": "len", "str": "tostr", "String": "tostr", "to_string": "tostr",
            "String.valueOf": "tostr", "Integer.toString": "tostr", "Double.toString": "tostr",
            "abs": "abs", "fabs": "abs", "Math.abs": "abs", "min": "min", "max": "max",
            "Math.min": "min", "Math.max": "max", "std.min": "min", "std.max": "max",
            "sum": "sum", "sorted": "sorted", "reversed": "reversed", "pow": "pow", "Math.pow": "pow",
            "math.pow": "pow", "sqrt": "sqrt", "Math.sqrt": "sqrt", "math.sqrt": "sqrt",
            "floor": "floor", "Math.floor": "floor", "math.floor": "floor",
            "ceil": "ceil", "Math.ceil": "ceil", "math.ceil": "ceil",
            "round": "round", "Math.round": "round", "Math.trunc": "trunc",
            "math.trunc": "trunc", "trunc": "trunc",
            "math.log": "log", "Math.log": "log", "log": "log", "math.log10": "log10",
            "Math.log10": "log10", "log10": "log10", "math.exp": "exp", "Math.exp": "exp", "exp": "exp",
            "math.sin": "sin", "Math.sin": "sin", "sin": "sin", "math.cos": "cos", "Math.cos": "cos",
            "cos": "cos", "math.tan": "tan", "Math.tan": "tan", "tan": "tan",
            "ord": "ord", "chr": "chr", "isdigit": "isdigit", "isalpha": "isalpha",
            "isalnum": "isalnum", "isspace": "isspace", "isupper": "isupper", "islower": "islower",
            "toupper": "upper", "tolower": "lower",
            "Character.isDigit": "isdigit", "Character.isLetter": "isalpha",
            "Character.isLetterOrDigit": "isalnum", "Character.isWhitespace": "isspace",
            "Character.isUpperCase": "isupper", "Character.isLowerCase": "islower",
            "Character.toUpperCase": "upper", "Character.toLowerCase": "lower",
            "String.join": "join", "Collections.sort": "sort", "Arrays.sort": "sort",
            "Collections.reverse": "reverse_inplace", "accumulate": "sum",
            "math.factorial": "factorial", "math.gcd": "gcd", "gcd": "gcd", "__gcd": "gcd",
            "Object.keys": "dkeys", "Object.values": "dvalues",
            "exit": "exit", "sys.exit": "exit", "System.exit": "exit", "process.exit": "exit", "quit": "exit",
            "Character.getNumericValue": "digit_val", "Arrays.toString": "repr",
        }
        if d in simple:
            name = simple[d]
            if d == "round" and len(args) == 2:
                return intr("round2", *args)
            if d in ("accumulate",):
                args = args[:1] if args and args[0].k != "Call" else [args[0].fn.obj]
            if d in ("sort", "Collections.sort", "Arrays.sort") and len(args) > 1:
                raise Unsupported("sort comparator")
            if d == "sorted" and kw:
                for k, v in kw:
                    if k == "reverse":
                        return intr("sorted_rev", args[0])
                raise Unsupported("sorted key")
            return intr(name, *args)
        if d in ("int", "parseInt", "Integer.parseInt", "Integer.valueOf", "stoi", "stol", "stoll",
                 "Long.parseLong", "std.stoi", "Math.floorInt"):
            return N("Cast", to=INT, e=args[0])
        if d in ("float", "parseFloat", "Number", "Double.parseDouble", "stod", "stof", "double",
                 "Float.parseFloat", "Double.valueOf", "std.stod"):
            if d == "float" and args and args[0].k == "Str" and args[0].v in ("inf", "+inf"):
                return intr("inf")
            return N("Cast", to=FLOAT, e=args[0])
        if d == "swap" and len(args) == 2 or d == "std.swap":
            return N("Swap", a=args[0], b=args[1])
        if d in ("sort", "std.sort", "reverse", "std.reverse") and len(args) >= 2 and \
                args[0].k == "Call" and args[0].fn.k == "Attr" and args[0].fn.name == "begin":
            if len(args) > 2:
                raise Unsupported("sort comparator")
            return intr("sort" if d.endswith("sort") else "reverse_inplace", args[0].fn.obj)
        if d == "string" and L == "cpp" and len(args) == 2:
            return intr("repeat", N("Cast", to=STR, e=args[1]), args[0])
        if d == "string" and L == "cpp" and len(args) == 1:
            return args[0]
        if d == "map" and len(args) == 2 and dotted(args[0]) in ("int", "float", "str"):
            return intr({"int": "ints", "float": "floats", "str": "strs"}[dotted(args[0])], args[1])
        if d == "list" and L == "python" and args:
            a0 = args[0].canon if args[0].k == "MaybeBuiltin" else args[0]
            if a0.k == "Intr" and a0.name in ("ints", "floats", "strs"):
                return a0
        if d == "list" and L == "python":
            return intr("list", *args) if args else N("ListLit", items=[])
        if d in ("set", "frozenset") and L == "python":
            return N("SetLit", items=[]) if not args else intr("set", *args)
        if d == "dict" and L == "python" and not args:
            return N("DictLit", pairs=[])
        if d == "range" and L == "python":
            return intr("range", *args)
        if d in ("Arrays.asList", "List.of", "Arrays.stream") and d != "Arrays.stream":
            return N("ListLit", items=args)
        if d == "Collections.max":
            return intr("max", *args)
        if d == "Collections.min":
            return intr("min", *args)
        if d in ("Math.random",):
            raise Unsupported("random")
        return N("Call", fn=fn, args=args, kw=kw)

    def key_lambda(self, f):
        """key=len / key=str.lower / key=lambda ...  ->  Lambda"""
        if f.k in ("Lambda",):
            return f
        k = N("Name", id="_k")
        if f.k == "Name":
            return N("Lambda", params=["_k"], body=self.make_call(f, [k]))
        if f.k == "Attr" and f.obj.k == "Name" and f.obj.id == "str":
            return N("Lambda", params=["_k"], body=self.make_call(N("Attr", obj=k, name=f.name), []))
        raise Unsupported("sort key")

    def cmp_to_key(self, lam):
        """(a, b) => a.x - b.x   ->  (key lambda, reverse)  or None"""
        import copy
        if len(lam.params) != 2:
            return None
        pa, pb = lam.params
        if lam.k == "Lambda":
            body = lam.body
        elif len(lam.body) == 1 and lam.body[0].k == "Return":
            body = lam.body[0].e
        else:
            return None
        # normalise helper-call comparators to a subtraction
        if body.k == "Call" and body.fn.k == "Attr" and body.fn.name in ("compareTo", "localeCompare", "compare") \
                and len(body.args) == 1:
            body = N("Bin", op="-", l=body.fn.obj, r=body.args[0])
        elif body.k == "Call" and body.fn.k == "Attr" and body.fn.name == "compare" and len(body.args) == 2:
            body = N("Bin", op="-", l=body.args[0], r=body.args[1])
        elif body.k == "Call" and dotted(body.fn) in ("Integer.compare", "Double.compare", "Long.compare",
                                                      "Character.compare") and len(body.args) == 2:
            body = N("Bin", op="-", l=body.args[0], r=body.args[1])
        if body.k != "Bin" or body.op not in ("-", "<", ">", "<=", ">="):
            return None
        from tx_sema import walk as _walk

        def uses(n, name):
            f = []
            _walk(n, lambda x: f.append(1) if x.k == "Name" and x.id == name else None)
            return bool(f)

        def sig(n):
            if isinstance(n, N):
                return (n.k,) + tuple((k, sig(v)) for k, v in sorted(n.__dict__.items()) if k not in ("k", "ty"))
            if isinstance(n, (list, tuple)):
                return tuple(sig(x) for x in n)
            return n

        def subst(n, old, new):
            c = copy.deepcopy(n)

            def f(x):
                if x.k == "Name" and x.id == old:
                    x.id = new
            _walk(c, f)
            return c
        L, R = body.l, body.r
        if uses(L, pa) and not uses(L, pb) and sig(subst(L, pa, pb)) == sig(R):
            return N("Lambda", params=[pa], body=L), body.op in (">", ">=")
        if uses(L, pb) and not uses(L, pa) and sig(subst(L, pb, pa)) == sig(R):
            return N("Lambda", params=[pa], body=R), body.op in ("-", "<", "<=")
        return None

    def sort_call(self, fn, d, args, kw):
        L = self.lang
        key, rev = None, False
        is_lam = lambda n: n.k in ("Lambda", "LambdaBlock")
        # python: sorted(x, key=..., reverse=...) / x.sort(key=..., reverse=...)
        if L == "python" and (d == "sorted" or (fn.k == "Attr" and fn.name == "sort")) and kw:
            for k, v in kw:
                if k == "key":
                    key = self.key_lambda(v)
                elif k == "reverse":
                    if v.k != "Bool":
                        raise Unsupported("reverse must be a literal")
                    rev = v.v
                else:
                    raise Unsupported("sort option " + k)
            if d == "sorted":
                return intr("sorted_key", args[0], key or N("Null"), N("Bool", v=rev))
            return intr("sort_key", fn.obj, key or N("Null"), N("Bool", v=rev))
        # js / java:  arr.sort(cmp)  list.sort(cmp)  Collections.sort(list, cmp)
        target = cmpf = None
        if fn.k == "Attr" and fn.name == "sort" and len(args) == 1 and is_lam(args[0]) and L in ("javascript", "java"):
            target, cmpf = fn.obj, args[0]
        elif d in ("Collections.sort", "Arrays.sort") and len(args) == 2 and is_lam(args[1]):
            target, cmpf = args[0], args[1]
        elif d in ("sort", "std.sort") and len(args) == 3 and is_lam(args[2]) and args[0].k == "Call" \
                and args[0].fn.k == "Attr" and args[0].fn.name == "begin":
            target, cmpf = args[0].fn.obj, args[2]
        if cmpf is not None:
            r = self.cmp_to_key(cmpf)
            if r is None:
                raise Unsupported("sort comparator")
            return intr("sort_key", target, r[0], N("Bool", v=r[1]))
        return None

    def format_to_fstr(self, tmpl, args, kw):
        s, parts, buf, i, auto = tmpl.v, [], [], 0, 0
        kws = dict(kw)
        while i < len(s):
            c = s[i]
            if c == "{":
                if s[i + 1:i + 2] == "{":
                    buf.append("{")
                    i += 2
                    continue
                j = s.index("}", i)
                field = s[i + 1:j]
                i = j + 1
                name, _, spec = field.partition(":")
                name = name.split("!")[0]
                if name == "":
                    arg = args[auto]
                    auto += 1
                elif name.isdigit():
                    arg = args[int(name)]
                else:
                    arg = kws[name]
                if buf:
                    parts.append("".join(buf))
                    buf = []
                parts.append((arg, spec))
            elif c == "}" and s[i + 1:i + 2] == "}":
                buf.append("}")
                i += 2
            else:
                buf.append(c)
                i += 1
        if buf:
            parts.append("".join(buf))
        return N("FStr", parts=parts)

    def fixup_print(self, p):
        """Move a trailing newline in a format string into `end`."""
        if p.items and p.items[-1].k == "Str" and p.items[-1].v.endswith("\n"):
            s = p.items[-1].v[:-1]
            p.items[-1] = N("Str", v=s, char=False)
            p.end = "\n"
            if not s:
                p.items.pop()
        elif p.items and p.items[-1].k == "FStr" and p.items[-1].parts and \
                isinstance(p.items[-1].parts[-1], str) and p.items[-1].parts[-1].endswith("\n"):
            last = p.items[-1].parts[-1][:-1]
            if last:
                p.items[-1].parts[-1] = last
            else:
                p.items[-1].parts.pop()
            p.end = "\n"
        return p

    # =====================================================================
    #  C-LIKE (JavaScript, C++, Java)
    # =====================================================================
    def c_skip_comments(self, into=None):
        while self.peek().k == "comment":
            c = self.nxt()
            if into is not None:
                into.append(N("Comment", text=c.v))

    def c_top(self):
        out = []
        self.c_skip_comments(out)
        if self.at_eof():
            return out
        t = self.peek()
        if self.accept_op(";"):
            return out
        if t.k == "id":
            v = t.v
            if v in ("import", "package", "using", "typedef") and not (self.js and v == "import" and False):
                while not self.is_op(";") and not self.at_eof():
                    self.nxt()
                self.accept_op(";")
                return out
            if v == "namespace":
                self.nxt()
                self.nxt()
                self.expect_op("{")
                while not self.is_op("}"):
                    out.extend(self.c_top())
                self.expect_op("}")
                return out
            if v == "template":
                raise Unsupported("templates")
            if v in ("enum", "interface", "type", "declare") and (v != "type" or self.peek(1).k == "id"):
                raise Unsupported(v)
        out.extend(self.c_stmt(top=True))
        return out

    def c_block(self):
        body = []
        if self.accept_op("{"):
            while not self.is_op("}"):
                if self.at_eof():
                    raise Unsupported("unexpected end of file")
                body.extend(self.c_stmt())
            self.expect_op("}")
        else:
            body.extend(self.c_stmt())
        return body

    # type parsing -------------------------------------------------------
    def parse_type_c(self):
        quals = set()
        while self.peek().k == "id" and self.peek().v in _QUALS and not (
                self.peek().v in ("unsigned", "signed") and self.peek(1).k != "id" and False):
            q = self.nxt().v
            quals.add(q)
        if self.peek().k != "id":
            raise Unsupported("type expected")
        name = self.nxt().v
        if name in ("struct", "class", "typename"):
            name = self.expect_id()
        if name in ("unsigned", "signed") and self.peek().k != "id":
            name = "int"
        while self.is_op("::") or (not self.js and self.is_op(".") and self.peek(1).k == "id"
                                   and name[:1].isupper() and self.peek(1).v[:1].isupper()
                                   and self.lang == "java"):
            self.nxt()
            name = self.expect_id()
        if name in ("long", "short", "unsigned", "signed"):
            while self.peek().k == "id" and self.peek().v in ("long", "int", "double", "short", "char"):
                nx = self.nxt().v
                if nx == "double":
                    name = "double"
        args = []
        if self.is_op("<"):
            self.nxt()
            while True:
                if self.accept_op("?"):
                    args.append(ANY)
                else:
                    args.append(self.parse_type_c())
                if self.accept_op(","):
                    continue
                break
            self.close_angle()
        ty = ty_from_name(name, args)
        while self.is_op("&") or self.is_op("&&"):
            self.nxt()
        while self.is_op("[") and self.is_op("]", 1):
            self.nxt()
            self.nxt()
            ty = arr_of(ty)
        if self.is_op("...", 0):
            raise Unsupported("varargs")
        ty = Ty(ty.k, *ty.a) if ty.k in ("list", "dict", "set", "arr") else ty
        self._last_quals = quals
        return ty

    def close_angle(self):
        t = self.peek()
        if t.k == "op" and t.v in (">>", ">>>"):
            rest = t.v[1:]
            self.t[self.i:self.i + 1] = [Tok("op", ">", t.line), Tok("op", rest, t.line)]
        self.expect_op(">")

    def try_type(self):
        save = self.i
        try:
            return self.parse_type_c()
        except Unsupported:
            self.i = save
            return None

    def looks_like_decl(self):
        """After a successful type parse, a declaration continues with `ident` then one of = ; , [ ( { :"""
        save = self.i
        ty = self.try_type()
        if ty is None:
            self.i = save
            return None
        quals = set(self._last_quals)
        t = self.peek()
        if t.k == "id" and t.v not in ("instanceof", "in", "of"):
            n = self.peek(1)
            if n.k == "op" and n.v in ("=", ";", ",", "[", "(", "{", ":", ")"):
                if n.v == "(" and self.peek().v and self.lang != "cpp":
                    self.i = save
                    return None
                return ty, quals
        self.i = save
        return None

    # statements ----------------------------------------------------------
    def c_stmt(self, top=False):
        out = []
        self.c_skip_comments(out)
        t = self.peek()
        if t.k == "eof":
            return out
        if t.k == "op":
            if t.v == "{":
                out.extend(self.c_block())
                return out
            if t.v == ";":
                self.nxt()
                return out
        if t.k == "id":
            v = t.v
            if v == "if":
                out.append(self.c_if())
                return out
            if v == "while":
                self.nxt()
                self.expect_op("(")
                c = self.c_expr()
                self.expect_op(")")
                out.append(N("While", cond=c, body=self.c_block()))
                return out
            if v == "do":
                self.nxt()
                body = self.c_block()
                self.expect_id("while")
                self.expect_op("(")
                c = self.c_expr()
                self.expect_op(")")
                self.accept_op(";")
                out.append(N("DoWhile", body=body, cond=c))
                return out
            if v == "for":
                out.append(self.c_for())
                return out
            if v == "return":
                self.nxt()
                e = None
                if not self.is_op(";"):
                    e = self.c_expr()
                self.accept_op(";")
                out.append(N("Return", e=e))
                return out
            if v == "break":
                self.nxt()
                self.accept_op(";")
                out.append(N("Break"))
                return out
            if v == "continue":
                self.nxt()
                self.accept_op(";")
                out.append(N("Continue"))
                return out
            if v == "switch":
                out.append(self.c_switch())
                return out
            if v == "try":
                out.append(self.c_try())
                return out
            if v == "throw":
                self.nxt()
                e = self.c_expr()
                self.accept_op(";")
                out.append(self.make_throw(e))
                return out
            if v == "assert" and self.lang != "cpp":
                self.nxt()
                c = self.c_expr()
                if self.accept_op(":"):
                    self.c_expr()
                self.accept_op(";")
                out.append(N("Assert", cond=c))
                return out
            if v == "class" or (v == "struct" and self.lang == "cpp"):
                out.append(self.c_class())
                return out
            if v in ("public", "private", "protected", "static", "final", "abstract") and \
                    self.lang == "java" and self.peek_class_ahead():
                out.append(self.c_class())
                return out
            if v == "function" and self.js:
                out.append(self.js_function())
                return out
            if v == "async":
                raise Unsupported("async")
            if v in ("let", "const", "var") and self.js:
                return out + self.js_decl()
            if self.js and v == "export":
                self.nxt()
                return out + self.c_stmt(top)
            if v in ("import",):
                raise Unsupported("import")
        # typed declaration (C++ / Java) or function definition
        if not self.js:
            save = self.i
            ty = self.try_type()
            if ty is not None:
                quals = set(self._last_quals)
                nm = self.peek()
                if nm.k == "id" and self.is_op("(", 1) and (top or self.lang != "cpp" or True):
                    # function definition (top level) -- only valid at top level / class level
                    if top:
                        return out + self.c_func(ty, quals)
                if nm.k == "id" and self.is_op("::", 1):
                    if self.peek(2).k == "id" and (self.is_op("=", 3) or self.is_op(";", 3)):
                        owner = self.nxt().v
                        self.nxt()
                        fname = self.nxt().v
                        init = self.c_assign() if self.accept_op("=") else None
                        self.accept_op(";")
                        self.static_inits.append((owner, fname, init, ty))
                        return out
                    return out + self.c_func(ty, quals)
                self.i = save
            d = self.looks_like_decl()
            if d is not None:
                ty, quals = d
                return out + self.c_decl(ty, quals, top)
            self.i = save
        # expression statement
        e = self.c_expr()
        self.accept_op(";")
        out.extend(self.c_expr_stmt(e))
        return out

    def peek_class_ahead(self):
        k = 0
        while self.peek(k).k == "id" and self.peek(k).v in ("public", "private", "protected", "static",
                                                          "final", "abstract"):
            k += 1
        return self.is_id("class", k)

    def unroll_chain(self, e):
        """sb.append(a).append(b)  ->  [sb.append(a), sb.append(b)]"""
        calls = []
        cur = e
        while cur.k == "Call" and cur.fn.k == "Attr" and cur.fn.name in ("append", "insert", "reverse") and \
                cur.fn.obj.k == "Call" and cur.fn.obj.fn.k == "Attr" and cur.fn.obj.fn.name in ("append", "insert", "reverse"):
            calls.append(cur)
            cur = cur.fn.obj
        if not calls:
            return None
        base = cur.fn.obj
        out = [N("ExprS", e=N("Call", fn=N("Attr", obj=base, name=cur.fn.name), args=cur.args, kw=[]))]
        for c in reversed(calls):
            out.append(N("ExprS", e=N("Call", fn=N("Attr", obj=base, name=c.fn.name), args=c.args, kw=[])))
        return out

    def c_expr_stmt(self, e):
        ch = self.unroll_chain(e)
        if ch:
            return ch
        if e.k == "Call" and e.fn.k == "Attr" and e.fn.name == "forEach" and len(e.args) == 1 and \
                e.args[0].k in ("Lambda", "LambdaBlock") and len(e.args[0].params) >= 1:
            lam = e.args[0]
            body = lam.body if lam.k == "LambdaBlock" else [N("ExprS", e=lam.body)]
            if len(lam.params) == 1:
                return [N("ForEach", var=lam.params[0], vty=None, it=e.fn.obj, body=body)]
            if len(lam.params) == 2:
                return [N("ForEnum", idx=lam.params[1], var=lam.params[0], it=e.fn.obj, start=num(0), body=body)]
        if e.k == "MaybeBuiltin" and e.canon.k == "Swap":
            e = e.canon
        if e.k == "Print":
            return [e]
        if e.k == "Assign" and e.op == "=" and e.target.k == "ListLit" and e.value.k == "ListLit" and \
                len(e.target.items) == len(e.value.items):
            return self.py_assign(N("TupleE", items=e.target.items), N("TupleE", items=e.value.items))
        if e.k == "Assign":
            return [e]
        # cout / cin chains
        if e.k == "Bin" and e.op in ("<<", ">>"):
            chain, cur = [], e
            while cur.k == "Bin" and cur.op == e.op:
                chain.append(cur.r)
                cur = cur.l
            d = dotted(cur)
            if e.op == "<<" and d in ("cout", "std.cout", "cerr", "std.cerr"):
                chain.reverse()
                items, end = [], ""
                width = None
                for it in chain:
                    if it.k == "Name" and it.id in ("boolalpha", "fixed", "noboolalpha"):
                        if it.id == "boolalpha":
                            self.boolalpha = True
                        elif it.id == "fixed":
                            self.cout_fixed = True
                        continue
                    if it.k == "MaybeBuiltin" and it.name in ("setprecision", "setw") or \
                            (it.k == "Call" and it.fn.k == "Name" and it.fn.id in ("setprecision", "setw")):
                        nm = it.name if it.k == "MaybeBuiltin" else it.fn.id
                        arg = it.args[0] if it.args else None
                        if arg is not None and arg.k == "Num":
                            if nm == "setprecision":
                                self.cout_prec = int(arg.v)
                            else:
                                width = int(arg.v)
                        continue
                    if it.k == "Name" and it.id == "endl":
                        items.append(N("Str", v="\n", char=False))
                        continue
                    if it.k in ("Num", "Name", "Bin", "Call", "Attr", "Index", "Cast", "Intr", "Un", "Tern", "MaybeBuiltin") \
                            and (self.cout_fixed and self.cout_prec is not None or width):
                        spec = ""
                        if width:
                            spec += ">%d" % width
                        if self.cout_fixed and self.cout_prec is not None:
                            spec += "@.%df" % self.cout_prec
                        items.append(N("FStr", parts=[(it, spec)]))
                        width = None
                        continue
                    if it.k == "Str" and width:
                        items.append(N("FStr", parts=[(it, "<%d" % width)]))
                        width = None
                        continue
                    if it.k == "Name" and it.id == "endl":
                        items.append(N("Str", v="\n", char=False))
                    elif dotted(it) == "std.endl":
                        items.append(N("Str", v="\n", char=False))
                    else:
                        items.append(it)
                p = N("Print", items=items, sep="", end="")
                if p.items and p.items[-1].k == "Str" and p.items[-1].v == "\n":
                    p.items.pop()
                    p.end = "\n"
                else:
                    self.fixup_print(p)
                if not p.items and not p.end:
                    return []
                return [p]
            if e.op == ">>" and d in ("cin", "std.cin"):
                chain.reverse()
                return [N("ReadStmt", targets=chain, mode="tok", tys=[None] * len(chain),
                          decl=[False] * len(chain))]
        if e.k == "IncDec":
            return [N("Assign", target=e.e, op="+=" if e.op == "++" else "-=", value=num(1))]
        if e.k == "Swap" or e.k == "SuperCall" or e.k == "Intr":
            return [e] if e.k != "Intr" else [N("ExprS", e=e)]
        if e.k == "Null":
            return []
        return [N("ExprS", e=e)]

    def c_if(self):
        self.nxt()
        self.expect_op("(")
        c = self.c_expr()
        self.expect_op(")")
        body = self.c_block()
        orelse = []
        pend = []
        self.c_skip_comments(pend)
        if self.is_id("else"):
            self.nxt()
            if self.is_id("if"):
                orelse = [self.c_if()]
            else:
                orelse = self.c_block()
        return N("If", cond=c, body=body, orelse=orelse)

    def c_switch(self):
        self.nxt()
        self.expect_op("(")
        e = self.c_expr()
        self.expect_op(")")
        self.expect_op("{")
        cases, vals = [], []
        default = None
        while not self.is_op("}"):
            self.c_skip_comments()
            if self.is_id("case"):
                self.nxt()
                vals.append(self.c_ternary())
                self.expect_op(":")
                continue
            if self.is_id("default"):
                self.nxt()
                self.expect_op(":")
                vals.append(None)
                continue
            body = []
            while not (self.is_id("case") or self.is_id("default") or self.is_op("}")):
                body.extend(self.c_stmt())
            if body and body[-1].k == "Break":
                body.pop()
            elif body and body[-1].k not in ("Return", "Throw", "Continue") and not self.is_op("}"):
                raise Unsupported("switch fallthrough")
            if None in vals:
                if len(vals) > 1:
                    raise Unsupported("mixed default case")
                default = body
            else:
                cases.append(N("Case", vals=vals, body=body))
            vals = []
        self.expect_op("}")
        if vals:  # trailing empty case labels
            if None in vals:
                default = []
            else:
                cases.append(N("Case", vals=vals, body=[]))
        return N("Switch", e=e, cases=cases, default=default)

    def c_try(self):
        self.nxt()
        body = self.c_block()
        var, handler, fin = None, [], []
        n = 0
        while self.is_id("catch"):
            n += 1
            self.nxt()
            self.expect_op("(")
            if self.is_op("..."):
                self.nxt()
            else:
                if not self.js:
                    self.try_type()
                var = self.expect_id() if self.peek().k == "id" else None
                if self.ts and self.accept_op(":"):
                    self.ts_type()
            self.expect_op(")")
            h = self.c_block()
            if n > 1:
                raise Unsupported("multiple catch")
            handler = h
        if self.is_id("finally"):
            self.nxt()
            fin = self.c_block()
        return N("Try", body=body, var=var, handler=handler, fin=fin)

    # for loops
    def c_for(self):
        self.nxt()
        self.expect_op("(")
        save = self.i
        # foreach forms
        if self.js:
            if self.peek().k == "id" and self.peek().v in ("let", "const", "var"):
                self.nxt()
            if self.is_op("[") and self.peek(1).k == "id" and self.is_op(",", 2) and self.peek(3).k == "id" \
                    and self.is_op("]", 4) and self.is_id("of", 5):
                kv, vv = self.peek(1).v, self.peek(3).v
                for _ in range(6):
                    self.nxt()
                it = self.c_expr()
                if it.k == "Call" and dotted(it.fn) == "Object.entries" and it.args:
                    it = it.args[0]
                self.expect_op(")")
                return N("ForDict", kvar=kv, vvar=vv, it=it, body=self.c_block())
            if self.peek().k == "id" and self.peek(1).k == "id" and self.peek(1).v in ("of", "in"):
                v = self.nxt().v
                kind_ = self.nxt().v
                it = self.c_expr()
                self.expect_op(")")
                body = self.c_block()
                if kind_ == "in":
                    return N("ForEach", var=v, vty=None, it=intr("keys_of", it), body=body)
                return N("ForEach", var=v, vty=None, it=it, body=body)
            self.i = save
        else:
            ty = self.try_type()
            if ty is not None and self.peek().k == "id" and self.is_op(":", 1):
                v = self.nxt().v
                self.nxt()
                it = self.c_expr()
                self.expect_op(")")
                body = self.c_block()
                return N("ForEach", var=v, vty=None if ty is AUTO else ty, it=it, body=body)
            self.i = save
        # classic for
        init = []
        if not self.is_op(";"):
            if self.js and self.peek().k == "id" and self.peek().v in ("let", "var", "const"):
                init = self.js_decl(semi=False)
            else:
                d = None if self.js else self.looks_like_decl()
                if d is not None:
                    init = self.c_decl(d[0], d[1], False, semi=False)
                else:
                    e = self.c_expr()
                    init = self.c_expr_stmt(e)
        self.expect_op(";")
        cond = None if self.is_op(";") else self.c_expr()
        self.expect_op(";")
        upd = []
        while not self.is_op(")"):
            upd.extend(self.c_expr_stmt(self.c_expr()))
            if not self.accept_op(","):
                break
        self.expect_op(")")
        body = self.c_block()
        r = self.try_for_range(init, cond, upd, body)
        if r:
            return r
        return N("CFor", init=init, cond=cond, update=upd, body=body)

    def try_for_range(self, init, cond, upd, body):
        if len(init) != 1 or len(upd) != 1 or cond is None:
            return None
        d = init[0]
        if d.k != "VarDecl" or d.init is None or (d.ty is not None and d.ty.k not in ("int", "float")):
            return None
        v = d.name
        if cond.k != "Bin" or cond.op not in ("<", "<=", ">", ">=") or cond.l.k != "Name" or cond.l.id != v:
            return None
        u = upd[0]
        if u.k != "Assign" or u.target.k != "Name" or u.target.id != v:
            return None
        if u.op in ("+=", "-="):
            step = u.value
            if u.op == "-=":
                step = N("Un", op="-", e=step) if step.k != "Num" else num("-" + step.v)
        elif u.op == "=" and u.value.k == "Bin" and u.value.op in ("+", "-") and \
                u.value.l.k == "Name" and u.value.l.id == v:
            step = u.value.r if u.value.op == "+" else (
                num("-" + u.value.r.v) if u.value.r.k == "Num" else N("Un", op="-", e=u.value.r))
        else:
            return None
        if step.k != "Num":
            return None
        neg = step.v.startswith("-")
        if (cond.op in ("<", "<=")) == neg:
            return None
        if self.assigns_name(body, v) or self.uses_mutated(cond.r, body):
            return None
        return N("ForRange", var=v, vty=d.ty, lo=d.init, hi=cond.r, step=step,
                 incl=cond.op in ("<=", ">="), body=body)

    def assigns_name(self, nodes, name):
        def walk(x):
            if isinstance(x, list):
                return any(walk(i) for i in x)
            if isinstance(x, tuple):
                return any(walk(i) for i in x)
            if not isinstance(x, N):
                return False
            if x.k == "Assign" and x.target.k == "Name" and x.target.id == name:
                return True
            if x.k == "IncDec" and x.e.k == "Name" and x.e.id == name:
                return True
            if x.k == "VarDecl" and x.name == name:
                return True
            return any(walk(v) for kk, v in x.__dict__.items() if kk not in ("k", "ty"))
        return walk(nodes)

    def uses_mutated(self, expr, body):
        names = set()

        def collect(x):
            if isinstance(x, (list, tuple)):
                for i in x:
                    collect(i)
            elif isinstance(x, N):
                if x.k == "Name":
                    names.add(x.id)
                for kk, v in x.__dict__.items():
                    if kk not in ("k", "ty"):
                        collect(v)
        collect(expr)
        if not names:
            return False
        for nm in names:
            if self.assigns_name(body, nm):
                return True
        # method calls on the bound object (e.g. v.size() while v.push_back inside)
        def calls_mut(x):
            if isinstance(x, (list, tuple)):
                return any(calls_mut(i) for i in x)
            if not isinstance(x, N):
                return False
            if x.k == "Call" and x.fn.k == "Attr" and x.fn.obj.k == "Name" and x.fn.obj.id in names and \
                    x.fn.name in ("push_back", "push", "pop_back", "erase", "insert", "remove", "add",
                                  "append", "pop", "clear", "removeLast", "shift", "unshift", "splice"):
                return True
            return any(calls_mut(v) for kk, v in x.__dict__.items() if kk not in ("k", "ty"))
        return calls_mut(body)

    # declarations ---------------------------------------------------------
    def c_decl(self, ty, quals, top, semi=True):
        out = []
        base = ty
        if base.k == "scanner":
            # Scanner sc = new Scanner(System.in);
            nm = self.expect_id()
            self.scanners.add(nm)
            while not self.is_op(";") and not self.at_eof():
                self.nxt()
            self.accept_op(";")
            return out
        while True:
            name = self.expect_id()
            dims = []
            while self.accept_op("["):
                dims.append(None if self.is_op("]") else self.c_expr())
                self.expect_op("]")
            vty = base
            for _ in dims:
                vty = arr_of(vty)
            init = None
            if self.accept_op("="):
                init = self.c_init(vty)
            elif self.is_op("(") and self.lang == "cpp":
                self.nxt()
                args = self.c_call_args()
                init = self.ctor_init(vty, args)
            elif self.is_op("{") and self.lang == "cpp":
                init = self.c_init(vty)
            elif dims and all(d is not None for d in dims):
                init = N("NewArr", elem=base, dims=dims, init=None)
            const = "const" in quals or "final" in quals or "constexpr" in quals
            if dims and init is not None and init.k == "ListLit":
                pass
            out.append(N("VarDecl", name=name, ty=None if vty is AUTO else vty, init=init, const=const,
                         static="static" in quals))
            if self.accept_op(","):
                continue
            break
        if semi:
            self.accept_op(";")
        return out

    def ctor_init(self, ty, args):
        if ty.k in ("list", "arr"):
            if not args:
                return N("ListLit", items=[])
            if len(args) == 1:
                return intr("list_new", args[0], default_for(ty.a[0]))
            return intr("list_new", args[0], args[1])
        if ty.k in ("dict", "set"):
            return N("DictLit", pairs=[]) if ty.k == "dict" else N("SetLit", items=[])
        if ty.k == "class":
            return N("New", cls=ty.a[0], args=args)
        if len(args) == 1:
            return args[0]
        return N("Null")

    def c_init(self, ty):
        if self.is_op("{"):
            self.nxt()
            items = []
            while not self.is_op("}"):
                if self.is_op("{"):
                    items.append(self.c_init(ty.a[0] if ty is not None and ty.a else None))
                else:
                    items.append(self.c_assign())
                if not self.accept_op(","):
                    break
            self.expect_op("}")
            if ty is not None and ty.k in ("dict",):
                raise Unsupported("brace map init")
            if ty is not None and ty.k == "set":
                return N("SetLit", items=items)
            if ty is not None and ty.k == "class":
                return N("New", cls=ty.a[0], args=items)
            r = N("ListLit", items=items)
            if ty is not None and ty.k == "arr":
                r.arr = True
            return r
        return self.c_assign()

    def default_init(self, ty):
        return default_for(ty)

    def ts_type(self):
        t = self.ts_type_atom()
        while self.is_op("|") or self.is_op("&"):
            self.nxt()
            u = self.ts_type_atom()
            if t is None or t.k in ("null",):
                t = u
        return None if (t is not None and t.k == "null") else t

    def ts_type_atom(self):
        tok = self.peek()
        if tok.k in ("str", "num"):
            self.nxt()
            return STR if tok.k == "str" else None
        if self.accept_op("("):
            if self.is_op(")") or (self.peek().k == "id" and (self.is_op(":", 1) or self.is_op(",", 1))):
                raise Unsupported("function type")
            t = self.ts_type()
            self.expect_op(")")
            return self.ts_array_suffix(t)
        if self.is_op("["):
            raise Unsupported("tuple type")
        if self.is_op("{"):
            raise Unsupported("object type")
        name = self.expect_id()
        args = []
        if self.is_op("<"):
            self.nxt()
            while True:
                args.append(self.ts_type())
                if self.accept_op(","):
                    continue
                break
            self.close_angle()
        if name in ("number", "any", "unknown", "never", "object", "bigint"):
            t = None
        elif name == "string":
            t = STR
        elif name == "boolean":
            t = BOOL
        elif name == "void":
            t = VOID
        elif name in ("null", "undefined"):
            t = Ty("null")
        elif name in ("Array", "ReadonlyArray"):
            t = list_of(args[0] if args else None)
        elif name in ("Map", "Record"):
            t = dict_of(args[0] if args else None, args[1] if len(args) > 1 else None)
        elif name == "Set":
            t = set_of(args[0] if args else None)
        elif name in ("Promise", "Function", "Date", "RegExp"):
            raise Unsupported("type " + name)
        else:
            t = cls_of(name)
        return self.ts_array_suffix(t)

    def ts_array_suffix(self, t):
        while self.is_op("[") and self.is_op("]", 1):
            self.nxt()
            self.nxt()
            t = list_of(t)
        return t

    def ts_annot(self):
        if self.ts and self.is_op("?") and self.is_op(":", 1):
            self.nxt()
        if self.ts and self.accept_op(":"):
            return self.ts_type()
        return None

    def js_decl(self, semi=True):
        kw = self.nxt().v
        out = []
        while True:
            name = self.expect_id()
            init = None
            vty = self.ts_annot()
            if self.accept_op("="):
                if self.js_is_arrow_fn():
                    f = self.js_arrow_fn(name)
                    out.append(f)
                    if self.accept_op(","):
                        continue
                    break
                init = self.c_assign()
            if init is not None and init.k == "Call" and dotted(init.fn) == "require":
                pass
            else:
                out.append(N("VarDecl", name=name, ty=vty, init=init, const=(kw == "const")))
            if self.accept_op(","):
                continue
            break
        if semi:
            self.accept_op(";")
        return out

    def ts_arrow_after(self, k):
        """tokens after `)`: `: ReturnType =>` (TypeScript)"""
        if not (self.ts and self.is_op(":", k)):
            return False
        depth = 0
        while True:
            t = self.peek(k)
            if t.k == "eof":
                return False
            if t.k == "op":
                if t.v in ("(", "[", "{"):
                    depth += 1
                elif t.v in (")", "]", "}"):
                    depth -= 1
                    if depth < 0:
                        return False
                elif t.v == "=>" and depth == 0:
                    return True
                elif t.v in (";", "=") and depth == 0:
                    return False
            k += 1

    def lambda_ahead(self):
        arrow = "->" if self.lang == "java" else "=>"
        if self.peek().k == "id" and self.is_op(arrow, 1):
            return True
        if self.is_op("("):
            depth, k = 0, 0
            while True:
                t = self.peek(k)
                if t.k == "eof":
                    return False
                if t.k == "op" and t.v == "(":
                    depth += 1
                elif t.k == "op" and t.v == ")":
                    depth -= 1
                    if depth == 0:
                        return self.is_op(arrow, k + 1)
                k += 1
        return False

    def js_is_arrow_fn(self):
        if self.is_id("function"):
            return True
        if self.peek().k == "id" and self.is_op("=>", 1):
            return True
        if self.is_op("("):
            depth, k = 0, 0
            while True:
                t = self.peek(k)
                if t.k == "eof":
                    return False
                if t.k == "op" and t.v == "(":
                    depth += 1
                elif t.k == "op" and t.v == ")":
                    depth -= 1
                    if depth == 0:
                        return self.is_op("=>", k + 1) or self.ts_arrow_after(k + 1)
                k += 1
        return False

    def js_params(self):
        params = []
        self.expect_op("(")
        while not self.is_op(")"):
            if self.is_op("..."):
                raise Unsupported("rest params")
            if self.lang == "java" and self.peek().k == "id" and (self.peek(1).k == "id" or self.is_op("<", 1)):
                self.parse_type_c()
            if self.ts and self.peek().k == "id" and self.peek().v in ("public", "private", "protected", "readonly") \
                    and self.peek(1).k == "id":
                raise Unsupported("constructor parameter properties")
            pn = self.expect_id()
            pty = self.ts_annot()
            default = self.c_assign() if self.accept_op("=") else None
            params.append(N("Param", name=pn, ty=pty, default=default))
            if not self.accept_op(","):
                break
        self.expect_op(")")
        return params

    def ts_ret(self):
        if self.ts and self.accept_op(":"):
            return self.ts_type()
        return None

    def js_arrow_fn(self, name):
        if self.accept_id("function"):
            if self.peek().k == "id":
                self.nxt()
            if self.ts and self.is_op("<"):
                raise Unsupported("generic function")
            params = self.js_params()
            ret = self.ts_ret()
            body = self.c_block()
            self.accept_op(";")
            return N("Func", name=name, params=params, ret=ret, body=body, static=False, method=False,
                     ctor=False)
        if self.peek().k == "id":
            params = [N("Param", name=self.nxt().v, ty=None, default=None)]
        else:
            params = self.js_params()
        ret = self.ts_ret()
        self.expect_op("->" if self.lang == "java" else "=>")
        if self.is_op("{"):
            body = self.c_block()
        else:
            body = [N("Return", e=self.c_assign())]
        self.accept_op(";")
        return N("Func", name=name, params=params, ret=ret, body=body, static=False, method=False,
                 ctor=False)

    def js_lambda(self):
        f = self.js_arrow_fn("_lambda")
        if f.body and len(f.body) == 1 and f.body[0].k == "Return" and f.body[0].e is not None:
            return N("Lambda", params=[p.name for p in f.params], body=f.body[0].e)
        return N("LambdaBlock", params=[p.name for p in f.params], body=f.body)

    def js_function(self):
        self.nxt()
        name = self.expect_id()
        if self.ts and self.is_op("<"):
            raise Unsupported("generic function")
        params = self.js_params()
        ret = self.ts_ret()
        body = self.c_block()
        return N("Func", name=name, params=params, ret=ret, body=body, static=False, method=False,
                 ctor=False)

    # functions (C++/Java) ---------------------------------------------------
    def c_params(self):
        params = []
        self.expect_op("(")
        if self.is_id("void") and self.is_op(")", 1):
            self.nxt()
        while not self.is_op(")"):
            pty = self.parse_type_c()
            pn = self.expect_id() if self.peek().k == "id" else "_p%d" % len(params)
            while self.accept_op("["):
                self.expect_op("]")
                pty = arr_of(pty)
            default = self.c_assign() if self.accept_op("=") else None
            params.append(N("Param", name=pn, ty=None if pty is AUTO else pty, default=default))
            if not self.accept_op(","):
                break
        self.expect_op(")")
        return params

    def c_func(self, ret, quals):
        name = self.expect_id()
        owner = None
        while self.accept_op("::"):
            owner, name = name, self.expect_id()
        params = self.c_params()
        while self.peek().k == "id" and self.peek().v in ("const", "noexcept", "override", "final"):
            self.nxt()
        if self.accept_op(";"):
            return [N("Func", name=name, params=params, ret=ret, body=None, static="static" in quals,
                      method=False, ctor=False, virtual="virtual" in quals)]
        if self.lang == "java" and self.is_id("throws"):
            self.nxt()
            self.parse_type_c()
        body = self.c_block()
        f = N("Func", name=name, params=params, ret=ret, body=body, static="static" in quals,
              method=False, ctor=False, virtual="virtual" in quals)
        if name == "main":
            f.is_main = True
            self.has_main = True
        if owner:
            f.owner = owner
            self.pending[owner + "::" + name] = f
            return []
        return [f]

    # classes ----------------------------------------------------------------
    def c_class(self):
        while self.peek().k == "id" and self.peek().v in ("public", "private", "protected", "static",
                                                          "final", "abstract"):
            self.nxt()
        kw = self.nxt().v  # class / struct
        name = self.expect_id()
        self.class_names.add(name)
        base = None
        if self.accept_id("extends"):
            base = self.expect_id()
        elif self.lang == "cpp" and self.accept_op(":"):
            while self.peek().k == "id" and self.peek().v in ("public", "private", "protected", "virtual"):
                self.nxt()
            base = self.expect_id()
        if self.accept_id("implements"):
            while self.peek().k == "id":
                self.nxt()
                if not self.accept_op(","):
                    break
        self.expect_op("{")
        fields, methods, ctor = [], [], None
        while not self.is_op("}"):
            self.c_skip_comments()
            if self.is_op("}"):
                break
            if self.lang == "cpp" and self.peek().k == "id" and self.peek().v in (
                    "public", "private", "protected") and self.is_op(":", 1):
                self.nxt()
                self.nxt()
                continue
            if self.accept_op(";"):
                continue
            if self.lang == "java" and self.peek_class_ahead():
                self.extra_classes.append(self.c_class())
                continue
            if self.js:
                self.js_member(name, fields, methods)
                continue
            # destructor
            if self.is_op("~"):
                raise Unsupported("destructor")
            quals = set()
            save = self.i
            # constructor?
            while self.peek().k == "id" and self.peek().v in _QUALS:
                quals.add(self.nxt().v)
            if self.peek().k == "id" and self.peek().v == name and self.is_op("(", 1):
                self.nxt()
                params = self.c_params()
                inits = []
                if self.accept_op(":"):
                    while True:
                        fn_ = self.expect_id()
                        self.expect_op("(")
                        args = self.c_call_args()
                        inits.append((fn_, args))
                        if not self.accept_op(","):
                            break
                if self.accept_op(";"):
                    ctor = N("Func", name=name, params=params, ret=None, body=None, static=False,
                             method=True, ctor=True, inits=inits)
                    continue
                body = self.c_block()
                pre = []
                for fn_, args in inits:
                    if fn_ == base:
                        pre.append(N("SuperCall", args=args))
                    else:
                        pre.append(N("Assign", target=N("Attr", obj=N("This"), name=fn_), op="=",
                                     value=args[0] if args else N("Null")))
                body = pre + body
                ctor = N("Func", name=name, params=params, ret=None, body=body, static=False, method=True,
                         ctor=True)
                continue
            self.i = save
            ty = self.parse_type_c()
            quals = set(self._last_quals)
            mname = self.expect_id()
            if self.is_op("("):
                self.i -= 1
                f = self.c_func(ty, quals)[0] if True else None
                f.method = True
                if f.body is None and self.lang == "cpp":
                    self.pending_decl(name, f, methods)
                    continue
                methods.append(f)
                continue
            # field(s)
            self.i -= 1
            for d in self.c_decl(ty, quals, False):
                fields.append(N("Field", name=d.name, ty=d.ty, init=d.init, static="static" in quals))
        self.expect_op("}")
        self.accept_op(";")
        c = N("Class", name=name, base=base, fields=fields, ctor=ctor, methods=methods)
        # attach out-of-class definitions
        for key in list(self.pending):
            if key.startswith(name + "::"):
                f = self.pending.pop(key)
                f.method = True
                if f.name == name:
                    c.ctor = f
                else:
                    c.methods = [m for m in c.methods if m.name != f.name] + [f]
        return c

    def pending_decl(self, cname, f, methods):
        methods.append(f)

    def js_member(self, cname, fields, methods):
        static = False
        while self.ts and self.peek().k == "id" and self.peek().v in (
                "public", "private", "protected", "readonly", "abstract", "override", "declare") and \
                (self.peek(1).k == "id"):
            self.nxt()
        if self.is_id("static"):
            self.nxt()
            static = True
        while self.ts and self.peek().k == "id" and self.peek().v in ("readonly", "public", "private", "protected") \
                and self.peek(1).k == "id":
            self.nxt()
        if self.is_id("get") or self.is_id("set") or self.is_id("async"):
            if self.peek(1).k == "id":
                raise Unsupported("accessor/async member")
        name = self.expect_id()
        if self.ts and self.is_op("<"):
            raise Unsupported("generic member")
        if self.is_op("("):
            params = self.js_params()
            ret = self.ts_ret()
            body = self.c_block()
            f = N("Func", name=name, params=params, ret=ret, body=body, static=static, method=True,
                  ctor=(name == "constructor"))
            if name == "constructor":
                self._js_ctor = f
            methods.append(f)
            return
        init = None
        fty = self.ts_annot()
        if self.accept_op("="):
            init = self.c_assign()
        self.accept_op(";")
        fields.append(N("Field", name=name, ty=fty, init=init, static=static))

    # expressions ---------------------------------------------------------------
    def c_call_args(self):
        args = []
        while not self.is_op(")"):
            args.append(self.c_assign())
            if not self.accept_op(","):
                break
        self.expect_op(")")
        return args

    def c_expr(self):
        e = self.c_assign()
        return e

    def c_assign(self):
        lhs = self.c_ternary()
        t = self.peek()
        if t.k == "op" and t.v in _ASSIGN_OPS:
            self.nxt()
            rhs = self.c_assign()
            if lhs.k == "Name" and False:
                pass
            return N("Assign", target=lhs, op=t.v, value=rhs)
        return lhs

    def c_ternary(self):
        c = self.c_bin(0)
        if self.accept_op("?"):
            a = self.c_assign()
            self.expect_op(":")
            b = self.c_assign()
            return N("Tern", c=c, a=a, b=b)
        return c

    def c_bin(self, minp):
        left = self.c_unary()
        while True:
            t = self.peek()
            if t.k == "op" and t.v in _C_BIN and _C_BIN[t.v] > minp:
                p = _C_BIN[t.v]
                self.nxt()
                right = self.c_bin(p - 1 if t.v == "**" else p)
                op = {"===": "==", "!==": "!=", "&&": "and", "||": "or", ">>>": ">>"}.get(t.v, t.v)
                if op == "??":
                    op = "or"
                left = N("Bin", op=op, l=left, r=right)
            elif t.k == "id" and t.v == "instanceof":
                raise Unsupported("instanceof")
            elif self.ts and t.k == "id" and t.v == "as" and _C_BIN.get("+", 0) > minp - 1:
                self.nxt()
                self.ts_type()
            else:
                return left

    def c_unary(self):
        t = self.peek()
        if t.k == "op":
            if t.v == "!":
                self.nxt()
                return N("Un", op="not", e=self.c_unary())
            if t.v in ("-", "+", "~"):
                self.nxt()
                e = self.c_unary()
                if t.v == "-" and e.k == "Num":
                    return N("Num", v="-" + e.v, isf=e.isf)
                return N("Un", op=t.v, e=e)
            if t.v in ("++", "--"):
                self.nxt()
                return N("IncDec", op=t.v, pre=True, e=self.c_unary())
            if t.v in ("*", "&"):
                raise Unsupported("pointer operator")
            if t.v == "(":
                # C cast: (int) x
                k = 1
                if self.peek(k).k == "id" and self.peek(k).v in _CTYPE_WORDS | {"string", "String"}:
                    save = self.i
                    self.nxt()
                    try:
                        ty = self.parse_type_c()
                    except Unsupported:
                        self.i = save
                        ty = None
                    if ty is not None and self.is_op(")"):
                        self.nxt()
                        nt = self.peek()
                        if nt.k in ("id", "num", "str", "fstr") or (nt.k == "op" and nt.v in (
                                "(", "!", "-", "~", "+")):
                            return N("Cast", to=ty, e=self.c_unary())
                    self.i = save
        if t.k == "id":
            if t.v == "typeof":
                raise Unsupported("typeof")
            if t.v == "new":
                return self.c_new()
            if t.v in ("static_cast", "dynamic_cast", "reinterpret_cast", "const_cast") and self.is_op("<", 1):
                self.nxt()
                self.nxt()
                ty = self.parse_type_c()
                self.expect_op(">")
                self.expect_op("(")
                e = self.c_assign()
                self.expect_op(")")
                return N("Cast", to=ty, e=e)
            if t.v == "await":
                raise Unsupported("await")
            if t.v == "sizeof":
                raise Unsupported("sizeof")
        return self.c_postfix()

    def c_new(self):
        self.nxt()
        # new int[n] / new int[]{..} / new Foo(args) / new ArrayList<>()
        name = self.expect_id()
        while self.is_op(".") or self.is_op("::"):
            self.nxt()
            name = self.expect_id()
        args_t = []
        if self.is_op("<"):
            self.nxt()
            while not self.is_op(">") and not self.is_op(">>") and not self.is_op(">>>"):
                if self.is_op(","):
                    self.nxt()
                    continue
                args_t.append(self.parse_type_c())
            self.close_angle()
        if self.is_op("["):
            dims = []
            while self.is_op("["):
                self.nxt()
                if self.is_op("]"):
                    dims.append(None)
                else:
                    dims.append(self.c_assign())
                self.expect_op("]")
            init = None
            if self.is_op("{"):
                base = ty_from_name(name, [])
                ty = base
                for _ in dims:
                    ty = arr_of(ty)
                init = self.c_init(ty)
                return init
            return N("NewArr", elem=ty_from_name(name, []), dims=dims, init=None)
        if self.is_op("("):
            self.nxt()
            args = self.c_call_args()
        else:
            args = []
        if name in _LISTS | _DICTS | _SETS:
            t = ty_from_name(name, args_t)
            if t.k == "dict":
                return N("DictLit", pairs=[])
            if t.k == "set":
                return N("SetLit", items=[])
            if args and args[0].k != "Num":
                return intr("list_copy", args[0])
            if args:
                return intr("list_new", args[0], default_for(t.a[0] if t.a else None))
            return N("ListLit", items=[])
        if name in ("Error", "Exception", "RuntimeException", "IllegalArgumentException",
                    "IllegalStateException", "runtime_error", "invalid_argument"):
            return N("New", cls=name, args=args)
        if name == "Scanner" or name == "BufferedReader":
            return N("Null")
        if name == "Array" and self.js:
            return intr("list_new", args[0], N("Num", v="0", isf=False)) if args else N("ListLit", items=[])
        if name in ("String", "StringBuilder", "StringBuffer"):
            return N("Cast", to=STR, e=args[0]) if args else N("Str", v="", char=False)
        return N("New", cls=name, args=args)

    def c_postfix(self):
        e = self.c_primary()
        while True:
            t = self.peek()
            if t.k != "op":
                return e
            v = t.v
            if v == "(":
                self.nxt()
                args = self.c_call_args()
                e = self.make_call(e, args)
            elif v in (".", "->", "?."):
                self.nxt()
                e = self.make_attr(e, self.expect_id())
            elif v == "::":
                self.nxt()
                nm = self.expect_id()
                e = self.make_attr(e, nm)
            elif v == "[":
                self.nxt()
                idx = self.c_assign()
                self.expect_op("]")
                e = N("Index", obj=e, idx=idx)
            elif v in ("++", "--"):
                self.nxt()
                e = N("IncDec", op=v, pre=False, e=e)
            elif v == "<" and e.k == "Name" and self.generic_call_ahead():
                if e.id in _LISTS or e.id in _DICTS or e.id in _SETS:
                    # vector<int>(n, v): a container constructor expression
                    self.i -= 1
                    ty = self.parse_type_c()
                    self.expect_op("(")
                    args = self.c_call_args()
                    e = self.ctor_init(ty, args)
                    continue
                # templated call like max<int>(a, b): skip the type args
                self.nxt()
                while not self.is_op(">"):
                    self.nxt()
                self.nxt()
            else:
                return e

    def generic_call_ahead(self):
        k, depth = 1, 1
        while k < 16:
            t = self.peek(k)
            if t.k == "op" and t.v == "<":
                depth += 1
            elif t.k == "op" and t.v in (">", ">>"):
                depth -= 1 if t.v == ">" else 2
                if depth <= 0:
                    return self.is_op("(", k + 1)
            elif not (t.k == "id" or (t.k == "op" and t.v in (",", "::"))):
                return False
            k += 1
        return False

    def c_primary(self):
        t = self.peek()
        if t.k == "num":
            self.nxt()
            return N("Num", v=t.v, isf=(t.x == "float"))
        if t.k == "str":
            self.nxt()
            return N("Str", v=t.v, char=(t.x == "char"))
        if t.k == "fstr":
            self.nxt()
            return self.build_fstr(t.v)
        if t.k == "id":
            v = t.v
            if (self.js and self.js_is_arrow_fn()) or (self.lang == "java" and self.lambda_ahead()):
                return self.js_lambda()
            self.nxt()
            if v in ("true", "True"):
                return N("Bool", v=True)
            if v in ("false", "False"):
                return N("Bool", v=False)
            if v in ("null", "nullptr", "NULL", "undefined", "None"):
                return N("Null")
            if v == "this":
                return N("This")
            if v == "super":
                return N("Name", id="super")
            if v in ("INT_MAX",):
                return num("2147483647")
            if v in ("INT_MIN",):
                return num("-2147483648")
            if v in ("LLONG_MAX",):
                return num("9223372036854775807")
            if v == "Infinity":
                return intr("inf")
            return N("Name", id=v)
        if t.k == "op":
            if t.v == "(":
                if (self.js and self.js_is_arrow_fn()) or (self.lang == "java" and self.lambda_ahead()):
                    return self.js_lambda()
                self.nxt()
                e = self.c_assign()
                self.expect_op(")")
                return e
            if t.v == "[" and self.lang == "cpp":
                self.nxt()
                while not self.is_op("]"):
                    self.nxt()
                self.nxt()
                params = self.c_params() if self.is_op("(") else []
                if self.accept_op("->"):
                    self.parse_type_c()
                body = self.c_block()
                return N("LambdaBlock", params=[p.name for p in params], body=body)
            if t.v == "[" and self.js:
                self.nxt()
                items = []
                while not self.is_op("]"):
                    if self.is_op("..."):
                        raise Unsupported("spread")
                    items.append(self.c_assign())
                    if not self.accept_op(","):
                        break
                self.expect_op("]")
                return N("ListLit", items=items)
            if t.v == "{" and self.js:
                self.nxt()
                pairs = []
                while not self.is_op("}"):
                    kt = self.nxt()
                    if kt.k not in ("id", "str", "num"):
                        raise Unsupported("object key")
                    key = N("Str", v=str(kt.v), char=False)
                    if self.accept_op(":"):
                        val = self.c_assign()
                    else:
                        val = N("Name", id=kt.v)
                    pairs.append((key, val))
                    if not self.accept_op(","):
                        break
                self.expect_op("}")
                return N("DictLit", pairs=pairs)
            if t.v == "{":
                return self.c_init(None)
        raise Unsupported("line %d: unexpected %r" % (t.line, t.v))


def default_for(ty):
    if ty is None:
        return N("Num", v="0", isf=False)
    if ty.k == "int" or ty.k == "char":
        return N("Num", v="0", isf=False)
    if ty.k == "float":
        return N("Num", v="0.0", isf=True)
    if ty.k == "bool":
        return N("Bool", v=False)
    if ty.k == "str":
        return N("Str", v="", char=False)
    if ty.k in ("list", "arr"):
        return N("ListLit", items=[])
    if ty.k == "dict":
        return N("DictLit", pairs=[])
    if ty.k == "set":
        return N("SetLit", items=[])
    return N("Null")


def parse(src, lang, ts=False):
    p = P(src, lang, ts)
    return p.parse_program()
