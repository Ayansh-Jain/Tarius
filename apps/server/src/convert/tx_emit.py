"""
tx_emit -- shared emitter base + Python and JavaScript code generators.
(C++ and Java live in tx_emit_c.py.)
"""
import re
from tx_core import N, Ty, INT, FLOAT, STR, BOOL, CHAR, VOID, ANY, Unsupported, is_seq
from tx_parse import default_for, intr, num

TERN, OR, AND, NOT, EQ, REL, BOR, BXOR, BAND, SHIFT, ADD, MUL, UN, POW, ATOM = range(1, 16)

BIN_PREC = {
    "or": OR, "and": AND, "==": EQ, "!=": EQ, "<": REL, "<=": REL, ">": REL, ">=": REL,
    "|": BOR, "^": BXOR, "&": BAND, "<<": SHIFT, ">>": SHIFT, "+": ADD, "-": ADD,
    "*": MUL, "/": MUL, "%": MUL, "//": MUL, "tdiv": MUL, "**": POW, "in": REL, "notin": REL,
}


def esc(s, q, ctrl="py"):
    out = []
    for ch in s:
        if ch == "\\":
            out.append("\\\\")
        elif ch == q:
            out.append("\\" + q)
        elif ch == "\n":
            out.append("\\n")
        elif ch == "\t":
            out.append("\\t")
        elif ch == "\r":
            out.append("\\r")
        elif ch == "\0":
            out.append("\\0")
        elif ord(ch) < 32:
            out.append("\\u%04x" % ord(ch) if ctrl == "java" else "\\x%02x" % ord(ch))
        else:
            out.append(ch)
    return "".join(out)


def parse_spec(spec):
    m = re.match(r"^([<>^]?)(0?)(\d*)(?:\.(\d+))?([a-zA-Z]?)$", spec or "")
    if not m:
        return None
    al, zero, w, pr, ty = m.groups()
    return {"align": al, "zero": bool(zero), "width": int(w) if w else 0,
            "prec": int(pr) if pr else None, "type": ty}


def fold_add(e, k):
    """e + k, folding numeric literals."""
    if e.k == "Num" and not e.isf:
        r = N("Num", v=str(int(e.v) + k), isf=False)
        r.ty = INT
        return r
    if k == 0:
        return e
    r = N("Bin", op="+" if k > 0 else "-", l=e, r=num(abs(k)))
    r.ty = e.ty
    r.r.ty = INT
    return r


class Em:
    RES = set()
    STATIC = False

    def __init__(self, prog, src):
        self.prog, self.src = prog, src
        self.o = []
        self.ind = 0
        self.need = set()
        self.sq = False
        self.cur_class = None
        self.cur_fn = None
        self.classes = {c.name: c for c in prog.classes}

    # ── output ──────────────────────────────────────────────────────────
    def w(self, line=""):
        self.o.append(("    " * self.ind + line) if line else "")

    def sub(self, stmts):
        self.ind += 1
        n = len(self.o)
        self.stmts(stmts)
        if len(self.o) == n:
            self.empty_body()
        self.ind -= 1

    def empty_body(self):
        pass

    def stmts(self, lst):
        for s in lst:
            getattr(self, "st_" + s.k)(s)

    def id(self, name):
        return name + "_" if name in self.RES else name

    # ── expressions ─────────────────────────────────────────────────────
    def x(self, e, minp=0):
        fn = getattr(self, "ex_" + e.k, None)
        if fn is None:
            raise Unsupported("cannot emit expression " + e.k)
        r = fn(e)
        txt, p = r if isinstance(r, tuple) else (r, ATOM)
        return "(" + txt + ")" if p < minp else txt

    def raw(self, e):
        return self.x(e, 0)

    def fmt(self, template, args, e=None):
        """<n> = raw expr, {n} = atom."""
        def rep(m):
            kind, i = m.group(1), int(m.group(2))
            return self.x(args[i], 0 if kind == "<" else ATOM)
        return re.sub(r"([<{])(\d)[>}]", rep, template)

    def ex_Num(self, e):
        v = e.v
        if v.startswith("-"):
            return v, UN
        return v

    def ex_Name(self, e):
        return self.id(e.id)

    def ex_Intr(self, e):
        fn = getattr(self, "in_" + e.name, None)
        if fn is None:
            raise Unsupported("intrinsic " + e.name)
        r = fn(e, e.args)
        return r

    def is_str(self, e):
        return e.ty is not None and e.ty.k == "str"

    def ty_k(self, e):
        return e.ty.k if e.ty is not None else None

    def need_(self, *names):
        self.need.update(names)

    def finish(self):
        return "\n".join(self.o).rstrip() + "\n"


# ═════════════════════════════════════════════════════════════════════════
#  Python
# ═════════════════════════════════════════════════════════════════════════
class PyE(Em):
    RES = {"False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue",
           "def", "del", "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in",
           "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with",
           "yield", "print", "len", "str", "int", "float", "list", "dict", "set", "input", "range", "max",
           "min", "sum", "abs", "sorted", "round", "pow", "ord", "chr", "map", "filter", "type", "id",
           "object", "bool", "tuple", "any", "all", "zip", "enumerate", "reversed", "open", "format",
           "math"}

    def empty_body(self):
        self.w("pass")

    def run(self):
        p = self.prog
        for c in getattr(p, "lead_comments", []):
            self.w("# " + c.text)
        for c in p.classes:
            self.st_Class(c)
            self.w()
        for f in p.funcs:
            self.st_Func(f)
            self.w()
        self.stmts(p.globals)
        if p.globals:
            self.w()
        if p.main_is_fn:
            self.w("def main():")
            self.ind += 1
            gw = sorted(getattr(p, "main_gw", ()))
            if gw:
                self.w("global " + ", ".join(self.id(g) for g in gw))
            self.ind -= 1
            self.sub(p.main)
            self.w()
            self.w('if __name__ == "__main__":')
            self.ind += 1
            self.w("main()")
            self.ind -= 1
        elif p.main_guard:
            self.w('if __name__ == "__main__":')
            self.sub(p.main)
        else:
            self.stmts(p.main)
        out = self.finish()
        imp = []
        if "math" in self.need:
            imp.append("import math")
        if "sys" in self.need:
            imp.append("import sys")
        if "tok" in self.need:
            imp += ["_buf = []", "", "", "def _tok():", "    while not _buf:", "        _buf.extend(input().split())",
                    "    return _buf.pop(0)"]
        return ("\n".join(imp) + "\n\n\n" if imp else "") + out

    # ── statements ──────────────────────────────────────────────────────
    def st_Comment(self, s):
        self.w("# " + s.text if s.text else "#")

    def st_Pass(self, s):
        self.w("pass")

    def st_Break(self, s):
        self.w("break")

    def st_Continue(self, s):
        self.w("continue")

    def st_GlobalDecl(self, s):
        pass

    def st_ExprS(self, s):
        self.w(self.raw(s.e))

    def st_Print(self, s):
        self.w(self.ex_Print(s))

    def ex_Print(self, s):
        items = [self.raw(i) for i in s.items]
        extra = ""
        if s.sep != " " and len(items) > 1:
            extra += ", sep=" + self.pstr(s.sep)
        if s.end != "\n":
            extra += ", end=" + self.pstr(s.end)
        return "print(" + ", ".join(items) + extra + ")"

    def pstr(self, s):
        q = "'" if self.sq else '"'
        return q + esc(s, q) + q

    def st_VarDecl(self, s):
        if getattr(s, "hoisted", False):
            return
        init = s.init
        if init is None:
            d = default_for(s.ty) if s.ty is not None else N("Null")
            self.sema_default(d)
            init = d
        self.w("%s = %s" % (self.id(s.name), self.raw(init)))

    def sema_default(self, d):
        if d.ty is None:
            d.ty = None

    def st_Assign(self, s):
        t = self.raw(s.target)
        op = s.op
        if op == "tdiv=":
            self.w("%s = int(%s / %s)" % (t, t, self.x(s.value, MUL + 1)))
        elif op == ">>>=":
            self.w("%s >>= %s" % (t, self.raw(s.value)))
        else:
            self.w("%s %s %s" % (t, op, self.raw(s.value)))

    def st_Swap(self, s):
        self.w("%s, %s = %s, %s" % (self.raw(s.a), self.raw(s.b), self.raw(s.b), self.raw(s.a)))

    def st_If(self, s, kw="if"):
        self.w("%s %s:" % (kw, self.raw(s.cond)))
        self.sub(s.body)
        o = s.orelse
        if len(o) == 1 and o[0].k == "If":
            self.st_If(o[0], "elif")
        elif o:
            self.w("else:")
            self.sub(o)

    def st_While(self, s):
        self.w("while %s:" % self.raw(s.cond))
        self.sub(s.body)

    def st_DoWhile(self, s):
        self.w("while True:")
        self.ind += 1
        self.stmts(s.body)
        self.w("if not (%s):" % self.raw(s.cond))
        self.ind += 1
        self.w("break")
        self.ind -= 2

    def range_args(self, s):
        lo, hi, st = s.lo, s.hi, s.step
        neg = st.k == "Num" and st.v.startswith("-")
        if s.incl:
            hi = fold_add(hi, -1 if neg else 1)
        a = []
        if not (lo.k == "Num" and lo.v == "0") or not (st.k == "Num" and st.v == "1"):
            a.append(self.raw(lo))
        a.append(self.raw(hi))
        if not (st.k == "Num" and st.v == "1"):
            a.append(self.raw(st))
        return ", ".join(a)

    def st_ForRange(self, s):
        if s.vty is not None and s.vty.k == "float":
            raise Unsupported("float loop variable")
        self.w("for %s in range(%s):" % (self.id(s.var), self.range_args(s)))
        self.sub(s.body)

    def st_CFor(self, s):
        self.stmts(s.init)
        cond = self.raw(s.cond) if s.cond is not None else "True"
        self.w("while %s:" % cond)
        self.ind += 1
        n = len(self.o)
        self.emit_cfor_body(s.body, s.update)
        self.stmts(s.update)
        if len(self.o) == n:
            self.w("pass")
        self.ind -= 1

    def emit_cfor_body(self, body, update):
        for st in body:
            if st.k == "Continue":
                self.stmts(update)
                self.w("continue")
            elif st.k == "If":
                self.w("if %s:" % self.raw(st.cond))
                self.ind += 1
                n = len(self.o)
                self.emit_cfor_body(st.body, update)
                if len(self.o) == n:
                    self.w("pass")
                self.ind -= 1
                if st.orelse:
                    self.w("else:")
                    self.ind += 1
                    self.emit_cfor_body(st.orelse, update)
                    self.ind -= 1
            else:
                getattr(self, "st_" + st.k)(st)

    def st_ForEach(self, s):
        self.w("for %s in %s:" % (self.id(s.var), self.raw(s.it)))
        self.sub(s.body)

    def st_ForEnum(self, s):
        st = "" if (s.start.k == "Num" and s.start.v == "0") else ", " + self.raw(s.start)
        self.w("for %s, %s in enumerate(%s%s):" % (self.id(s.idx), self.id(s.var), self.raw(s.it), st))
        self.sub(s.body)

    def st_ForZip(self, s):
        self.w("for %s in zip(%s):" % (", ".join(self.id(v) for v in s.vars), ", ".join(self.raw(i) for i in s.its)))
        self.sub(s.body)

    def st_ForDict(self, s):
        if s.vvar:
            self.w("for %s, %s in %s.items():" % (self.id(s.kvar), self.id(s.vvar), self.x(s.it, ATOM)))
        else:
            self.w("for %s in %s:" % (self.id(s.kvar), self.raw(s.it)))
        self.sub(s.body)

    def st_Return(self, s):
        self.w("return" + (" " + self.raw(s.e) if s.e is not None else ""))

    def st_Throw(self, s):
        self.w("raise Exception(%s)" % (self.raw(s.e) if s.e is not None else ""))

    def st_Assert(self, s):
        self.w("assert " + self.raw(s.cond))

    def st_Try(self, s):
        self.w("try:")
        self.sub(s.body)
        if s.handler or not s.fin:
            self.w("except Exception%s:" % (" as " + self.id(s.var) if s.var else ""))
            self.sub(s.handler)
        if s.fin:
            self.w("finally:")
            self.sub(s.fin)

    def st_Switch(self, s):
        subj = self.x(s.e, EQ + 1)
        first = True
        for c in s.cases:
            conds = " or ".join("%s == %s" % (subj, self.x(v, EQ + 1)) for v in c.vals)
            self.w("%s %s:" % ("if" if first else "elif", conds))
            self.sub(c.body)
            first = False
        if s.default:
            if first:
                self.stmts(s.default)
            else:
                self.w("else:")
                self.sub(s.default)

    def st_ReadStmt(self, s):
        names = [self.raw(t) for t in s.targets]
        tys = [t.k if t is not None else "str" for t in s.tys]
        conv = {"int": "int", "float": "float", "str": "", "char": "", "bool": ""}
        if not getattr(s, "linesplit", False):
            self.need_("tok")
            for n, t in zip(names, tys):
                c = conv.get(t, "")
                self.w("%s = %s" % (n, "%s(_tok())" % c if c else "_tok()"))
            return
        if len(names) == 1:
            c = conv.get(tys[0], "")
            self.w("%s = %s" % (names[0], "%s(input())" % c if c else "input()"))
        elif len(set(tys)) == 1:
            c = conv.get(tys[0], "")
            self.w("%s = %s" % (", ".join(names), "map(%s, input().split())" % c if c else "input().split()"))
        else:
            self.w("_p = input().split()")
            for i, (n, t) in enumerate(zip(names, tys)):
                c = conv.get(t, "")
                self.w("%s = %s" % (n, "%s(_p[%d])" % (c, i) if c else "_p[%d]" % i))

    def st_SuperCall(self, s):
        self.w("super().__init__(%s)" % ", ".join(self.raw(a) for a in s.args))

    def st_Func(self, f):
        prev = self.cur_fn
        self.cur_fn = f
        if f.static and f.method:
            self.w("@staticmethod")
        ps = ["self"] if (f.method and not f.static) else []
        for p in f.params:
            ps.append(self.id(p.name) + ("=" + self.raw(p.default) if p.default is not None else ""))
        name = "__init__" if f.ctor else self.id(f.name)
        if f.method and f.name == "toString" and not f.params:
            name = "__str__"
        self.w("def %s(%s):" % (name, ", ".join(ps)))
        self.ind += 1
        gw = sorted(getattr(f, "global_writes", ()))
        if gw:
            self.w("global " + ", ".join(self.id(g) for g in gw))
        self.ind -= 1
        self.sub(f.body)
        self.cur_fn = prev

    def st_Class(self, c):
        self.cur_class = c
        base = "(%s)" % c.base if c.base else ""
        self.w("class %s%s:" % (c.name, base))
        self.ind += 1
        n0 = len(self.o)
        for f in c.fields:
            if f.static and f.init is not None:
                self.w("%s = %s" % (self.id(f.name), self.raw(f.init)))
        inst = [f for f in c.fields if not f.static]
        if c.ctor is not None:
            self.ctor(c, inst)
        elif inst:
            self.w("def __init__(self):")
            self.ind += 1
            for f in inst:
                self.w("self.%s = %s" % (self.id(f.name), self.raw(self.field_init(f))))
            self.ind -= 1
        for m in c.methods:
            self.st_Func(m)
        if len(self.o) == n0:
            self.w("pass")
        self.ind -= 1
        self.cur_class = None

    def field_init(self, f):
        if f.init is not None:
            return f.init
        return default_for(f.ty) if f.ty is not None else N("Null")

    def ctor(self, c, inst):
        f = c.ctor
        assigned = set()
        for st in f.body:
            if st.k == "Assign" and st.target.k == "Attr" and st.target.obj.k == "This":
                assigned.add(st.target.name)
        pre = []
        for fl in inst:
            if fl.name not in assigned:
                pre.append(N("Assign", target=N("Attr", obj=N("This"), name=fl.name), op="=",
                             value=self.field_init(fl)))
        # keep an explicit super() call first
        body = list(f.body)
        head = []
        while body and body[0].k in ("SuperCall", "Comment"):
            head.append(body.pop(0))
        g = N("Func", name=f.name, params=f.params, ret=None, body=head + pre + body, static=False,
              method=True, ctor=True)
        g.global_writes = set()
        self.st_Func(g)

    # ── expressions ─────────────────────────────────────────────────────
    def ex_Str(self, e):
        q = "'" if self.sq else '"'
        return q + esc(e.v, q) + q

    def ex_Bool(self, e):
        return "True" if e.v else "False"

    def ex_Null(self, e):
        return "None"

    def ex_This(self, e):
        return "self"

    def ex_Super(self, e):
        return "super()"

    def ex_Attr(self, e):
        return "%s.%s" % (self.x(e.obj, ATOM), self.id(e.name))

    def ex_Index(self, e):
        return "%s[%s]" % (self.x(e.obj, ATOM), self.raw(e.idx))

    def ex_Slice(self, e):
        lo = self.raw(e.lo) if e.lo is not None else ""
        hi = self.raw(e.hi) if e.hi is not None else ""
        return "%s[%s:%s]" % (self.x(e.obj, ATOM), lo, hi)

    def ex_ListLit(self, e):
        return "[" + ", ".join(self.raw(i) for i in e.items) + "]"

    def ex_SetLit(self, e):
        return "{" + ", ".join(self.raw(i) for i in e.items) + "}" if e.items else "set()"

    def ex_DictLit(self, e):
        return "{" + ", ".join("%s: %s" % (self.raw(k), self.raw(v)) for k, v in e.pairs) + "}"

    def ex_TupleE(self, e):
        if len(e.items) == 1:
            return "(%s,)" % self.raw(e.items[0])
        return "(" + ", ".join(self.raw(i) for i in e.items) + ")"

    def st_TupleAssign(self, s):
        self.w("%s = %s" % (", ".join(self.raw(t) for t in s.targets), self.raw(s.value)))

    def ex_Tern(self, e):
        return "%s if %s else %s" % (self.x(e.a, TERN + 1), self.x(e.c, TERN + 1), self.x(e.b, TERN)), TERN

    def ex_Lambda(self, e):
        return "lambda %s: %s" % (", ".join(e.params), self.raw(e.body)), TERN

    def ex_ListComp(self, e):
        s = "%s for %s in %s" % (self.raw(e.elt), self.id(e.var), self.x(e.it, OR))
        if e.cond is not None:
            s += " if " + self.x(e.cond, OR)
        return "[" + s + "]"

    def ex_Un(self, e):
        if e.op == "not":
            return "not " + self.x(e.e, NOT), NOT
        return e.op + self.x(e.e, UN), UN

    def ex_IncDec(self, e):
        raise Unsupported("++/-- inside an expression")

    def ex_Assign(self, e):
        raise Unsupported("assignment inside an expression")

    def ex_Swap(self, e):
        raise Unsupported("swap in expression")

    def ex_Bin(self, e):
        op = e.op
        p = BIN_PREC[op]
        if op == "tdiv":
            return "int(%s / %s)" % (self.x(e.l, MUL), self.x(e.r, MUL + 1))
        if op == "notin":
            return "%s not in %s" % (self.x(e.l, REL + 1), self.x(e.r, REL + 1)), REL
        if op == "in":
            return "%s in %s" % (self.x(e.l, REL + 1), self.x(e.r, REL + 1)), REL
        l = self.x(e.l, p if op != "**" else POW + 1)
        r = self.x(e.r, p + 1 if op != "**" else UN)
        return "%s %s %s" % (l, op, r), p

    def ex_Cast(self, e):
        a = self.raw(e.e)
        k = e.to.k
        if k == "int":
            return "int(%s)" % a
        if k == "float":
            return "float(%s)" % a
        if k == "bool":
            return "bool(%s)" % a
        return a

    def ex_New(self, e):
        cls = e.cls
        if cls in ("Error", "RuntimeException", "IllegalArgumentException", "IllegalStateException",
                   "runtime_error", "invalid_argument"):
            cls = "Exception"
        return "%s(%s)" % (cls, ", ".join(self.raw(a) for a in e.args))

    def ex_NewArr(self, e):
        d = default_for(e.elem)
        dv = self.raw(d) if e.elem is not None else "0"
        if len(e.dims) == 1:
            return "[%s] * %s" % (dv, self.x(e.dims[0], MUL + 1)), MUL
        if len(e.dims) == 2:
            return "[[%s] * %s for _ in range(%s)]" % (dv, self.x(e.dims[1], MUL + 1), self.raw(e.dims[0]))
        raise Unsupported("3-d array")

    def ex_Call(self, e):
        fn = e.fn
        if fn.k == "Attr" and fn.obj.k == "Name" and fn.obj.id in self.classes:
            return "%s.%s(%s)" % (fn.obj.id, self.id(fn.name), ", ".join(self.raw(a) for a in e.args))
        return "%s(%s)" % (self.x(fn, ATOM), ", ".join(self.raw(a) for a in e.args))

    def ex_Input(self, e):
        p = self.raw(e.prompt) if e.prompt is not None else ""
        base = "input(%s)" % p
        if e.mode == "tok":
            self.need_("tok")
            ty = getattr(e, "cast", None)
            if ty is not None and ty.k == "int":
                return "int(_tok())"
            if ty is not None and ty.k == "float":
                return "float(_tok())"
            return "_tok()"
        return base

    def ex_FStr(self, e):
        # try an f-string; fall back to concatenation if an embedded expression is awkward
        parts, ok = [], True
        old = self.sq
        self.sq = True
        try:
            for p in e.parts:
                if isinstance(p, str):
                    parts.append(esc(p, '"').replace("{", "{{").replace("}", "}}"))
                else:
                    t = self.raw(p[0])
                    if "\\" in t or "{" in t or "}" in t or '"' in t:
                        ok = False
                    parts.append("{%s%s}" % (t, ":" + p[1] if p[1] else ""))
        finally:
            self.sq = old
        if ok:
            return 'f"' + "".join(parts) + '"'
        out = []
        for p in e.parts:
            if isinstance(p, str):
                out.append(self.pstr(p))
            else:
                t = self.raw(p[0])
                out.append("format(%s, %s)" % (t, self.pstr(p[1])) if p[1] else "str(%s)" % t)
        return " + ".join(out), ADD

    # ── intrinsics ──────────────────────────────────────────────────────
    def call(self, name, args, prec=ATOM):
        return "%s(%s)" % (name, ", ".join(self.raw(a) for a in args))

    def meth(self, a, name, rest):
        return "%s.%s(%s)" % (self.x(a[0], ATOM), name, ", ".join(self.raw(r) for r in rest))

    def in_len(self, e, a): return self.call("len", a)
    def in_tostr(self, e, a): return self.call("str", a)
    def in_abs(self, e, a): return self.call("abs", a)
    def in_min(self, e, a): return self.call("min", a)
    def in_max(self, e, a): return self.call("max", a)
    def in_sum(self, e, a): return self.call("sum", a)
    def in_sorted(self, e, a): return self.call("sorted", a)
    def in_reversed(self, e, a): return "list(reversed(%s))" % self.raw(a[0])
    def in_reversed_copy(self, e, a): return "%s[::-1]" % self.x(a[0], ATOM)
    def in_sorted_rev(self, e, a): return "sorted(%s, reverse=True)" % self.raw(a[0])
    def in_round(self, e, a): return self.call("round", a)
    def in_round2(self, e, a): return self.call("round", a)
    def in_ord(self, e, a): return self.call("ord", a)
    def in_chr(self, e, a): return self.call("chr", a)

    def in_pow(self, e, a):
        if e.ty is not None and e.ty.k == "int":
            return self.call("pow", a)
        self.need_("math")
        return self.call("math.pow", a)

    def mathf(name):
        def f(self, e, a):
            self.need_("math")
            return self.call("math." + name, a)
        return f

    in_sqrt = mathf("sqrt")
    in_floor = mathf("floor")
    in_ceil = mathf("ceil")
    in_log = mathf("log")
    in_log10 = mathf("log10")
    in_exp = mathf("exp")
    in_sin = mathf("sin")
    in_cos = mathf("cos")
    in_tan = mathf("tan")
    in_factorial = mathf("factorial")
    in_gcd = mathf("gcd")

    def in_trunc(self, e, a): return self.call("int", a)

    def in_pi(self, e, a):
        self.need_("math")
        return "math.pi"

    def in_e(self, e, a):
        self.need_("math")
        return "math.e"

    def in_inf(self, e, a): return "float('inf')"

    def strpred(name):
        def f(self, e, a): return self.meth(a, name, [])
        return f

    in_isdigit = strpred("isdigit")
    in_isalpha = strpred("isalpha")
    in_isalnum = strpred("isalnum")
    in_isspace = strpred("isspace")
    in_isupper = strpred("isupper")
    in_islower = strpred("islower")
    in_upper = strpred("upper")
    in_lower = strpred("lower")
    in_strip = strpred("strip")

    def in_split(self, e, a): return self.meth(a, "split", a[1:])
    def in_join(self, e, a): return "%s.join(%s)" % (self.x(a[0], ATOM), self.raw(a[1]))
    def in_replace(self, e, a): return self.meth(a, "replace", a[1:])
    def in_replace_first(self, e, a): return "%s.replace(%s, 1)" % (self.x(a[0], ATOM), ", ".join(self.raw(x) for x in a[1:]))
    def in_startswith(self, e, a): return self.meth(a, "startswith", a[1:])
    def in_endswith(self, e, a): return self.meth(a, "endswith", a[1:])
    def in_find(self, e, a): return self.meth(a, "find", a[1:])
    def in_repeat(self, e, a): return "%s * %s" % (self.x(a[0], MUL), self.x(a[1], MUL + 1)), MUL
    def in_str_count(self, e, a): return self.meth(a, "count", a[1:])
    def in_append(self, e, a): return self.meth(a, "append", a[1:])
    def in_insert(self, e, a): return self.meth(a, "insert", a[1:])
    def in_pop_last(self, e, a): return self.meth(a, "pop", [])
    def in_pop_at(self, e, a): return self.meth(a, "pop", a[1:])
    def in_remove_value(self, e, a): return self.meth(a, "remove", a[1:])
    def in_sort(self, e, a): return self.meth(a, "sort", [])
    def in_reverse_inplace(self, e, a): return self.meth(a, "reverse", [])
    def in_clear(self, e, a): return self.meth(a, "clear", [])
    def in_extend(self, e, a): return self.meth(a, "extend", a[1:])
    def in_index(self, e, a): return self.meth(a, "index", a[1:])
    def in_list_count(self, e, a): return self.meth(a, "count", a[1:])
    def in_list_copy(self, e, a): return "list(%s)" % self.raw(a[0])
    def sort_kw(self, a):
        parts = []
        if a[1].k == "Lambda":
            parts.append("key=lambda %s: %s" % (self.id(a[1].params[0]), self.raw(a[1].body)))
        if a[2].v:
            parts.append("reverse=True")
        return ", ".join(parts)

    def in_sort_key(self, e, a): return "%s.sort(%s)" % (self.x(a[0], ATOM), self.sort_kw(a))

    def in_sorted_key(self, e, a):
        kw = self.sort_kw(a)
        return "sorted(%s%s)" % (self.raw(a[0]), ", " + kw if kw else "")

    def in_chars(self, e, a): return "list(%s)" % self.raw(a[0])
    def in_ints(self, e, a): return "list(map(int, %s))" % self.raw(a[0])
    def in_floats(self, e, a): return "list(map(float, %s))" % self.raw(a[0])
    def in_list_concat(self, e, a): return "%s + %s" % (self.x(a[0], ADD), self.x(a[1], ADD + 1)), ADD
    def in_digit_val(self, e, a): return "int(%s)" % self.raw(a[0])

    def in_exit(self, e, a):
        self.need_("sys")
        return "sys.exit(%s)" % ", ".join(self.raw(x) for x in a)
    def in_strs(self, e, a): return "[str(v) for v in %s]" % self.raw(a[0])
    def in_sort_str(self, e, a): return '"".join(sorted(%s))' % self.raw(a[0])
    def in_list(self, e, a): return self.call("list", a)
    def in_set(self, e, a): return self.call("set", a)
    def in_range(self, e, a): return "list(range(%s))" % ", ".join(self.raw(x) for x in a)
    def in_dget(self, e, a): return self.meth(a, "get", a[1:])
    def in_dkeys(self, e, a): return "list(%s.keys())" % self.x(a[0], ATOM)
    def in_dvalues(self, e, a): return "list(%s.values())" % self.x(a[0], ATOM)
    def in_ditems(self, e, a): return "%s.items()" % self.x(a[0], ATOM)
    def in_ddel(self, e, a): return self.meth(a, "pop", a[1:])
    def in_del(self, e, a): return "del %s[%s]" % (self.x(a[0], ATOM), self.raw(a[1]))
    def in_sadd(self, e, a): return self.meth(a, "add", a[1:])
    def in_sdel(self, e, a): return self.meth(a, "discard", a[1:])
    def in_keys_of(self, e, a): return self.raw(a[0])

    def in_list_new(self, e, a):
        n, v = a
        if v.k in ("ListLit", "DictLit", "SetLit") or (v.k == "Intr" and v.name == "list_new"):
            return "[%s for _ in range(%s)]" % (self.raw(v), self.raw(n))
        return "[%s] * %s" % (self.raw(v), self.x(n, MUL + 1)), MUL


# ═════════════════════════════════════════════════════════════════════════
#  JavaScript  (and TypeScript: the same generator plus type annotations)
# ═════════════════════════════════════════════════════════════════════════
class JsE(Em):
    RES = {"abstract", "arguments", "await", "boolean", "break", "byte", "case", "catch", "char", "class",
           "const", "continue", "debugger", "default", "delete", "do", "double", "else", "enum", "eval",
           "export", "extends", "false", "final", "finally", "float", "for", "function", "goto", "if",
           "implements", "import", "in", "instanceof", "int", "interface", "let", "long", "native", "new",
           "null", "package", "private", "protected", "public", "return", "short", "static", "super",
           "switch", "synchronized", "this", "throw", "throws", "transient", "true", "try", "typeof", "var",
           "void", "volatile", "while", "with", "yield", "Map", "Set", "Array", "Object", "String",
           "Number", "Math", "console", "process", "require"}

    def run(self):
        p = self.prog
        for c in getattr(p, "lead_comments", []):
            self.w("// " + c.text)
        for c in p.classes:
            self.st_Class(c)
            self.w()
        for f in p.funcs:
            self.st_Func(f)
            self.w()
        self.stmts(p.globals)
        if p.globals:
            self.w()
        if p.main_is_fn:
            self.w("function main() {")
            self.sub(p.main)
            self.w("}")
            self.w()
            self.w("main();")
        else:
            self.stmts(p.main)
        out = self.finish()
        pre = []
        if self.need & {"line", "tok"}:
            pre.append("const _data = require('fs').readFileSync(0, 'utf8');")
            pre.append("let _pos = 0;")
            pre.append("function _line() {")
            pre.append("    let e = _data.indexOf('\\n', _pos);")
            pre.append("    if (e < 0) e = _data.length;")
            pre.append("    const s = _data.slice(_pos, e).replace(/\\r$/, '');")
            pre.append("    _pos = Math.min(e + 1, _data.length);")
            pre.append("    return s;")
            pre.append("}")
            pre.append("function _tok() {")
            pre.append("    while (_pos < _data.length && /\\s/.test(_data[_pos])) _pos++;")
            pre.append("    const s = _pos;")
            pre.append("    while (_pos < _data.length && !/\\s/.test(_data[_pos])) _pos++;")
            pre.append("    return _data.slice(s, _pos);")
            pre.append("}")
        if "by" in self.need:
            pre.append("function _by(k, rev) {")
            pre.append("    return (a, b) => {")
            pre.append("        const x = k(a), y = k(b);")
            pre.append("        const r = x < y ? -1 : x > y ? 1 : 0;")
            pre.append("        return rev ? -r : r;")
            pre.append("    };")
            pre.append("}")
        if "gcd" in self.need:
            pre.append("function _gcd(a, b) { return b === 0 ? Math.abs(a) : _gcd(b, a % b); }")
        if "fact" in self.need:
            pre.append("function _fact(n) { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; }")
        return ("\n".join(pre) + "\n\n" if pre else "") + out

    def empty_body(self):
        pass

    # ── statements ──────────────────────────────────────────────────────
    def st_Comment(self, s):
        self.w("// " + s.text)

    def st_Pass(self, s):
        pass

    def st_Break(self, s):
        self.w("break;")

    def st_Continue(self, s):
        self.w("continue;")

    def st_GlobalDecl(self, s):
        pass

    def st_ExprS(self, s):
        self.w(self.raw(s.e) + ";")

    def st_Print(self, s):
        self.w(self.ex_Print(s) + ";")

    def ex_Print(self, s):
        items = s.items
        if s.sep == " " and s.end == "\n":
            return "console.log(%s)" % ", ".join(self.raw(i) for i in items)
        if not items:
            return "process.stdout.write(%s)" % self.jstr(s.end)
        body = self.join_items(items, s.sep)
        if s.end == "\n" and len(items) == 1:
            return "console.log(%s)" % self.raw(items[0])
        if s.end == "\n":
            return "console.log(%s)" % body
        return "process.stdout.write(%s)" % (body + (" + " + self.jstr(s.end) if s.end else ""))

    def join_items(self, items, sep):
        # template literal so numbers are formatted uniformly
        out = []
        for i, it in enumerate(items):
            if i and sep:
                out.append(sep.replace("\\", "\\\\").replace("`", "\\`").replace("${", "\\${").replace("\n", "\\n"))
            if it.k == "Str":
                out.append(it.v.replace("\\", "\\\\").replace("`", "\\`").replace("${", "\\${").replace("\n", "\\n"))
            else:
                out.append("${%s}" % self.raw(it))
        return "`" + "".join(out) + "`"

    def jstr(self, s):
        q = "'" if self.sq else '"'
        return q + esc(s, q) + q

    def decl_kw(self, s):
        return "const" if getattr(s, "const", False) and self.src == "javascript" else "let"

    def st_VarDecl(self, s):
        if getattr(s, "hoisted", False) and s.init is None:
            d = default_for(s.ty) if s.ty is not None else None
            self.w("let %s%s;" % (self.id(s.name), " = " + self.raw(d) if d is not None and d.k != "Null" else ""))
            return
        init = s.init
        if init is None:
            d = default_for(s.ty) if s.ty is not None else None
            if d is not None and d.k != "Null":
                init = d
        self.w("%s %s%s;" % (self.decl_kw(s), self.id(s.name), " = " + self.raw(init) if init is not None else ""))

    def assign_str(self, s):
        t = s.target
        op = s.op
        if t.k == "Index" and t.obj.ty is not None and t.obj.ty.k == "dict":
            obj = self.x(t.obj, ATOM)
            k = self.raw(t.idx)
            if op == "=":
                return "%s.set(%s, %s)" % (obj, k, self.raw(s.value))
            bop = {"tdiv=": "/"}.get(op, op[:-1])
            cur = "%s.get(%s)" % (obj, k)
            if self.src in ("cpp",):
                cur = "(%s.get(%s) || 0)" % (obj, k)
            v = N("Bin", op=bop if bop != "/" or op != "tdiv=" else "tdiv", l=N("Name", id="@"), r=s.value)
            return "%s.set(%s, %s)" % (obj, k, self.bin_with_left(v, cur))
        tt = self.raw(t)
        if op == "tdiv=":
            return "%s = Math.trunc(%s / %s)" % (tt, tt, self.x(s.value, MUL + 1))
        if op == "//=":
            return "%s = Math.floor(%s / %s)" % (tt, tt, self.x(s.value, MUL + 1))
        if op == ">>>=":
            op = ">>="
        return "%s %s %s" % (tt, op, self.raw(s.value))

    def bin_with_left(self, v, left):
        r = self.x(v.r, MUL + 1)
        if v.op == "tdiv":
            return "Math.trunc(%s / %s)" % (left, r)
        return "%s %s %s" % (left, v.op, self.raw(v.r))

    def st_Assign(self, s):
        self.w(self.assign_str(s) + ";")

    def st_Swap(self, s):
        self.w("[%s, %s] = [%s, %s];" % (self.raw(s.a), self.raw(s.b), self.raw(s.b), self.raw(s.a)))

    def st_If(self, s, chain=False):
        self.w("%s(%s) {" % ("} else if " if chain else "if ", self.raw(s.cond)))
        self.sub(s.body)
        o = s.orelse
        if len(o) == 1 and o[0].k == "If":
            self.st_If(o[0], True)
            return
        if o:
            self.w("} else {")
            self.sub(o)
        self.w("}")

    def st_While(self, s):
        self.w("while (%s) {" % self.raw(s.cond))
        self.sub(s.body)
        self.w("}")

    def st_DoWhile(self, s):
        self.w("do {")
        self.sub(s.body)
        self.w("} while (%s);" % self.raw(s.cond))

    def st_ForRange(self, s):
        v = self.id(s.var)
        st = s.step
        neg = st.k == "Num" and st.v.startswith("-")
        cmp = (">=" if s.incl else ">") if neg else ("<=" if s.incl else "<")
        if st.k == "Num" and st.v in ("1", "-1"):
            upd = v + ("--" if neg else "++")
        else:
            upd = "%s += %s" % (v, self.raw(st))
        self.w("for (let %s = %s; %s %s %s; %s) {" % (v, self.raw(s.lo), v, cmp, self.x(s.hi, REL + 1), upd))
        self.sub(s.body)
        self.w("}")

    def inline(self, s):
        k = s.k
        if k == "VarDecl":
            return "let %s = %s" % (self.id(s.name), self.raw(s.init)) if s.init is not None else "let " + self.id(s.name)
        if k == "Assign":
            return self.assign_str(s)
        if k == "ExprS":
            return self.raw(s.e)
        raise Unsupported("for-loop clause")

    def st_CFor(self, s):
        init = ", ".join(self.inline(i) for i in s.init)
        if len(s.init) > 1:
            if all(i.k == "VarDecl" for i in s.init):
                init = "let " + ", ".join("%s = %s" % (self.id(i.name), self.raw(i.init)) for i in s.init)
        cond = self.raw(s.cond) if s.cond is not None else ""
        upd = ", ".join(self.inline(u) for u in s.update)
        self.w("for (%s; %s; %s) {" % (init, cond, upd))
        self.sub(s.body)
        self.w("}")

    def st_ForEach(self, s):
        self.w("for (const %s of %s) {" % (self.id(s.var), self.raw(s.it)))
        self.sub(s.body)
        self.w("}")

    def st_ForEnum(self, s):
        if s.start.k == "Num" and s.start.v == "0":
            self.w("for (const [%s, %s] of %s.entries()) {" % (self.id(s.idx), self.id(s.var), self.x(s.it, ATOM)))
        else:
            self.w("for (const [_i, %s] of %s.entries()) {" % (self.id(s.var), self.x(s.it, ATOM)))
            self.ind += 1
            self.w("const %s = _i + %s;" % (self.id(s.idx), self.x(s.start, ADD + 1)))
            self.ind -= 1
        self.sub(s.body)
        self.w("}")

    def st_ForDict(self, s):
        if s.vvar:
            self.w("for (const [%s, %s] of %s) {" % (self.id(s.kvar), self.id(s.vvar), self.raw(s.it)))
        else:
            self.w("for (const %s of %s.keys()) {" % (self.id(s.kvar), self.x(s.it, ATOM)))
        self.sub(s.body)
        self.w("}")

    def st_Return(self, s):
        self.w("return%s;" % (" " + self.raw(s.e) if s.e is not None else ""))

    def st_Throw(self, s):
        self.w("throw new Error(%s);" % (self.raw(s.e) if s.e is not None else ""))

    def st_Assert(self, s):
        self.w("console.assert(%s);" % self.raw(s.cond))

    def st_Try(self, s):
        self.w("try {")
        self.sub(s.body)
        if s.handler or not s.fin:
            self.w("} catch (%s) {" % (self.id(s.var) if s.var else "_e"))
            self.sub(s.handler)
        if s.fin:
            self.w("} finally {")
            self.sub(s.fin)
        self.w("}")

    def st_Switch(self, s):
        self.w("switch (%s) {" % self.raw(s.e))
        self.ind += 1
        for c in s.cases:
            for i, v in enumerate(c.vals):
                self.w("case %s:" % self.raw(v) + (" {" if i == len(c.vals) - 1 else ""))
            self.ind += 1
            self.stmts(c.body)
            if not c.body or c.body[-1].k not in ("Return", "Throw", "Continue"):
                self.w("break;")
            self.ind -= 1
            self.w("}")
        if s.default is not None:
            self.w("default: {")
            self.ind += 1
            self.stmts(s.default)
            self.ind -= 1
            self.w("}")
        self.ind -= 1
        self.w("}")

    def st_ReadStmt(self, s):
        self.need_("tok", "line")
        for t, ty, d in zip(s.targets, s.tys, s.decl):
            k = ty.k if ty is not None else "str"
            rd = {"int": "parseInt(_tok(), 10)", "float": "parseFloat(_tok())"}.get(k, "_tok()")
            if d:
                self.w("let %s = %s;" % (self.raw(t), rd))
            else:
                self.w("%s = %s;" % (self.raw(t), rd))

    def st_SuperCall(self, s):
        self.w("super(%s);" % ", ".join(self.raw(a) for a in s.args))

    def st_Func(self, f, in_class=False):
        ps = ", ".join(self.id(p.name) + (" = " + self.raw(p.default) if p.default is not None else "")
                       for p in f.params)
        if in_class:
            name = "constructor" if f.ctor else self.id(f.name)
            self.w("%s%s(%s) {" % ("static " if f.static else "", name, ps))
        else:
            self.w("function %s(%s) {" % (self.id(f.name), ps))
        self.sub(f.body)
        self.w("}")

    def st_Class(self, c):
        self.cur_class = c
        self.w("class %s%s {" % (c.name, " extends " + c.base if c.base else ""))
        self.ind += 1
        for f in c.fields:
            if f.static and f.init is not None:
                self.w("static %s = %s;" % (self.id(f.name), self.raw(f.init)))
        inst = [f for f in c.fields if not f.static]
        if c.ctor is not None:
            f = c.ctor
            assigned = {st.target.name for st in f.body if st.k == "Assign" and st.target.k == "Attr"
                        and st.target.obj.k == "This"}
            pre = []
            for fl in inst:
                if fl.name not in assigned:
                    d = fl.init if fl.init is not None else (default_for(fl.ty) if fl.ty is not None else N("Null"))
                    pre.append(N("Assign", target=N("Attr", obj=N("This"), name=fl.name), op="=", value=d))
            body = list(f.body)
            head = []
            while body and body[0].k in ("SuperCall", "Comment"):
                head.append(body.pop(0))
            g = N("Func", name=f.name, params=f.params, ret=None, body=head + pre + body, static=False,
                  method=True, ctor=True)
            self.st_Func(g, True)
        elif inst:
            self.w("constructor() {")
            self.ind += 1
            for fl in inst:
                d = fl.init if fl.init is not None else (default_for(fl.ty) if fl.ty is not None else N("Null"))
                self.w("this.%s = %s;" % (self.id(fl.name), self.raw(d)))
            self.ind -= 1
            self.w("}")
        for m in c.methods:
            self.st_Func(m, True)
        self.ind -= 1
        self.w("}")
        self.cur_class = None

    # ── expressions ─────────────────────────────────────────────────────
    def ex_Str(self, e):
        q = "'" if self.sq else '"'
        return q + esc(e.v, q) + q

    def ex_Bool(self, e):
        return "true" if e.v else "false"

    def ex_Null(self, e):
        return "null"

    def ex_This(self, e):
        return "this"

    def ex_Super(self, e):
        return "super"

    def ex_Attr(self, e):
        return "%s.%s" % (self.x(e.obj, ATOM), self.id(e.name))

    def ex_Index(self, e):
        t = e.obj.ty
        if t is not None and t.k == "dict":
            return "%s.get(%s)" % (self.x(e.obj, ATOM), self.raw(e.idx))
        if e.idx.k == "Num" and e.idx.v.startswith("-"):
            return "%s.at(%s)" % (self.x(e.obj, ATOM), e.idx.v)
        return "%s[%s]" % (self.x(e.obj, ATOM), self.raw(e.idx))

    def ex_Slice(self, e):
        a = [self.raw(e.lo) if e.lo is not None else "0"]
        if e.hi is not None:
            a.append(self.raw(e.hi))
        return "%s.slice(%s)" % (self.x(e.obj, ATOM), ", ".join(a))

    def ex_ListLit(self, e):
        return "[" + ", ".join(self.raw(i) for i in e.items) + "]"

    def ex_SetLit(self, e):
        return "new Set([%s])" % ", ".join(self.raw(i) for i in e.items)

    def ex_DictLit(self, e):
        if not e.pairs:
            return "new Map()"
        return "new Map([%s])" % ", ".join("[%s, %s]" % (self.raw(k), self.raw(v)) for k, v in e.pairs)

    def ex_Tern(self, e):
        return "%s ? %s : %s" % (self.x(e.c, TERN + 1), self.x(e.a, TERN), self.x(e.b, TERN)), TERN

    def ex_Lambda(self, e):
        return "(%s) => %s" % (", ".join(e.params), self.x(e.body, TERN)), TERN

    def ex_ListComp(self, e):
        it = self.x(e.it, ATOM)
        s = it
        if e.cond is not None:
            s += ".filter(%s => %s)" % (self.id(e.var), self.raw(e.cond))
        return "%s.map(%s => %s)" % (s, self.id(e.var), self.raw(e.elt))

    def ex_Un(self, e):
        if e.op == "not":
            return "!" + self.x(e.e, UN), UN
        return e.op + self.x(e.e, UN), UN

    def ex_IncDec(self, e):
        t = self.raw(e.e)
        return (e.op + t if e.pre else t + e.op), UN

    def ex_Assign(self, e):
        return self.assign_str(e), TERN

    def ex_Bin(self, e):
        op = e.op
        if op == "tdiv":
            return "Math.trunc(%s / %s)" % (self.x(e.l, MUL), self.x(e.r, MUL + 1))
        if op == "//":
            return "Math.floor(%s / %s)" % (self.x(e.l, MUL), self.x(e.r, MUL + 1))
        if op in ("in", "notin"):
            t = e.r.ty
            k = t.k if t is not None else None
            c, o = self.x(e.l, 0), self.x(e.r, ATOM)
            if k == "dict" or k == "set":
                s = "%s.has(%s)" % (o, c)
            elif k in ("list", "arr", "str"):
                s = "%s.includes(%s)" % (o, c)
            else:
                s = "%s in %s" % (self.x(e.l, REL + 1), self.x(e.r, REL + 1))
                return ("!(%s)" % s if op == "notin" else s), (ATOM if op == "notin" else REL)
            return ("!" + s, UN) if op == "notin" else s
        p = BIN_PREC[op]
        if op in ("==", "!=") and (self.ty_k(e.l) in ("list", "arr") or self.ty_k(e.r) in ("list", "arr")):
            s = "JSON.stringify(%s) %s JSON.stringify(%s)" % (self.raw(e.l), "===" if op == "==" else "!==", self.raw(e.r))
            return s, EQ
        jop = {"and": "&&", "or": "||", "==": "===", "!=": "!=="}.get(op, op)
        if op in ("==", "!=") and (e.l.k == "Null" or e.r.k == "Null"):
            jop = "==" if op == "==" else "!="
        l = self.x(e.l, p if op != "**" else POW + 1)
        r = self.x(e.r, p + 1 if op != "**" else UN)
        return "%s %s %s" % (l, jop, r), p

    def ex_Cast(self, e):
        a = self.raw(e.e)
        k = e.to.k
        src_str = e.e.ty is not None and e.e.ty.k == "str"
        if k == "int":
            return ("parseInt(%s, 10)" % a) if src_str else "Math.trunc(%s)" % a
        if k == "float":
            return ("parseFloat(%s)" % a) if src_str else a
        if k == "bool":
            return "Boolean(%s)" % a
        return self.x(e.e, ATOM), ATOM

    def ex_New(self, e):
        cls = e.cls
        if cls in ("RuntimeException", "IllegalArgumentException", "IllegalStateException",
                   "runtime_error", "invalid_argument", "Exception"):
            cls = "Error"
        return "new %s(%s)" % (cls, ", ".join(self.raw(a) for a in e.args))

    def ex_NewArr(self, e):
        dv = self.raw(default_for(e.elem))
        if len(e.dims) == 1:
            return "new Array(%s).fill(%s)" % (self.raw(e.dims[0]), dv)
        if len(e.dims) == 2:
            return "Array.from({length: %s}, () => new Array(%s).fill(%s))" % (
                self.raw(e.dims[0]), self.raw(e.dims[1]), dv)
        raise Unsupported("3-d array")

    def ex_Call(self, e):
        fn = e.fn
        return "%s(%s)" % (self.x(fn, ATOM), ", ".join(self.raw(a) for a in e.args))

    def ex_Input(self, e):
        self.need_("line", "tok")
        ty = getattr(e, "cast", None)
        if e.mode == "tok":
            base = "_tok()"
            if ty is not None and ty.k == "int":
                base = "parseInt(_tok(), 10)"
            elif ty is not None and ty.k == "float":
                base = "parseFloat(_tok())"
        else:
            base = "_line()"
        if e.prompt is not None:
            return "(process.stdout.write(%s), %s)" % (self.raw(e.prompt), base)
        return base

    def ex_FStr(self, e):
        out = []
        for p in e.parts:
            if isinstance(p, str):
                out.append(p.replace("\\", "\\\\").replace("`", "\\`").replace("${", "\\${").replace("\n", "\\n"))
            else:
                out.append("${%s}" % self.fmt_val(p[0], p[1]))
        return "`" + "".join(out) + "`"

    def fmt_val(self, e, spec):
        t = self.raw(e)
        sp = parse_spec(spec) if spec else None
        if not sp:
            return t
        v = t
        if sp["prec"] is not None and sp["type"] in ("f", "F"):
            v = "(%s).toFixed(%d)" % (t, sp["prec"])
        elif sp["type"] == "x":
            v = "(%s).toString(16)" % t
        elif sp["type"] == "e":
            v = "(%s).toExponential(%d)" % (t, sp["prec"] or 6)
        elif sp["width"]:
            v = "String(%s)" % t
        if sp["width"]:
            if sp["align"] == "<":
                v = "%s.padEnd(%d)" % (v, sp["width"])
            else:
                v = "%s.padStart(%d%s)" % (v, sp["width"], ", '0'" if sp["zero"] else "")
        return v

    # ── intrinsics ──────────────────────────────────────────────────────
    def call(self, name, args):
        return "%s(%s)" % (name, ", ".join(self.raw(a) for a in args))

    def meth(self, a, name, rest):
        return "%s.%s(%s)" % (self.x(a[0], ATOM), name, ", ".join(self.raw(r) for r in rest))

    def in_len(self, e, a):
        k = self.ty_k(a[0])
        if k == "dict" or k == "set":
            return "%s.size" % self.x(a[0], ATOM)
        return "%s.length" % self.x(a[0], ATOM)

    def in_tostr(self, e, a): return self.call("String", a)
    def in_abs(self, e, a): return self.call("Math.abs", a)

    def minmax(name):
        def f(self, e, a):
            if len(a) == 1:
                return "Math.%s(...%s)" % (name, self.x(a[0], ATOM))
            return self.call("Math." + name, a)
        return f

    in_min = minmax("min")
    in_max = minmax("max")

    def cmp_fn(self, t):
        et = t.a[0] if t is not None and t.a else None
        if et is not None and et.k in ("int", "float"):
            return "(a, b) => a - b"
        return ""

    def in_sum(self, e, a): return "%s.reduce((s, x) => s + x, 0)" % self.x(a[0], ATOM)

    def in_sorted(self, e, a):
        return "[...%s].sort(%s)" % (self.x(a[0], ATOM), self.cmp_fn(a[0].ty))

    def in_sorted_rev(self, e, a):
        return "[...%s].sort(%s).reverse()" % (self.x(a[0], ATOM), self.cmp_fn(a[0].ty))

    def in_reversed(self, e, a): return "[...%s].reverse()" % self.x(a[0], ATOM)

    def in_reversed_copy(self, e, a):
        if self.ty_k(a[0]) == "str":
            return '[...%s].reverse().join("")' % self.x(a[0], ATOM)
        return "[...%s].reverse()" % self.x(a[0], ATOM)

    def in_pow(self, e, a): return self.call("Math.pow", a)
    def in_sqrt(self, e, a): return self.call("Math.sqrt", a)
    def in_floor(self, e, a): return self.call("Math.floor", a)
    def in_ceil(self, e, a): return self.call("Math.ceil", a)
    def in_round(self, e, a): return self.call("Math.round", a)
    def in_round2(self, e, a): return "Number((%s).toFixed(%s))" % (self.raw(a[0]), self.raw(a[1]))
    def in_trunc(self, e, a): return self.call("Math.trunc", a)
    def in_log(self, e, a): return self.call("Math.log", a)
    def in_log10(self, e, a): return self.call("Math.log10", a)
    def in_exp(self, e, a): return self.call("Math.exp", a)
    def in_sin(self, e, a): return self.call("Math.sin", a)
    def in_cos(self, e, a): return self.call("Math.cos", a)
    def in_tan(self, e, a): return self.call("Math.tan", a)
    def in_pi(self, e, a): return "Math.PI"
    def in_e(self, e, a): return "Math.E"
    def in_inf(self, e, a): return "Infinity"

    def in_factorial(self, e, a):
        self.need_("fact")
        return self.call("_fact", a)

    def in_gcd(self, e, a):
        self.need_("gcd")
        return self.call("_gcd", a)

    def in_ord(self, e, a): return "%s.charCodeAt(0)" % self.x(a[0], ATOM)
    def in_chr(self, e, a): return "String.fromCharCode(%s)" % self.raw(a[0])

    def pred(rx_char, rx_str):
        def f(self, e, a):
            k = self.ty_k(a[0])
            rx = rx_char if k == "char" else rx_str
            return "/%s/.test(%s)" % (rx, self.raw(a[0]))
        return f

    in_isdigit = pred("^[0-9]$", "^[0-9]+$")
    in_isalpha = pred("^[A-Za-z]$", "^[A-Za-z]+$")
    in_isalnum = pred("^[A-Za-z0-9]$", "^[A-Za-z0-9]+$")
    in_isspace = pred("^\\\\s$", "^\\\\s+$")
    in_isupper = pred("^[A-Z]$", "^[^a-z]*[A-Z][^a-z]*$")
    in_islower = pred("^[a-z]$", "^[^A-Z]*[a-z][^A-Z]*$")

    def in_upper(self, e, a): return self.meth(a, "toUpperCase", [])
    def in_lower(self, e, a): return self.meth(a, "toLowerCase", [])
    def in_strip(self, e, a): return self.meth(a, "trim", [])

    def in_split(self, e, a):
        if len(a) == 1:
            return "%s.trim().split(/\\s+/)" % self.x(a[0], ATOM)
        return self.meth(a, "split", a[1:])

    def in_join(self, e, a): return "%s.join(%s)" % (self.x(a[1], ATOM), self.raw(a[0]))
    def in_replace(self, e, a): return self.meth(a, "replaceAll", a[1:])
    def in_replace_first(self, e, a): return self.meth(a, "replace", a[1:])
    def in_startswith(self, e, a): return self.meth(a, "startsWith", a[1:])
    def in_endswith(self, e, a): return self.meth(a, "endsWith", a[1:])
    def in_find(self, e, a): return self.meth(a, "indexOf", a[1:])
    def in_repeat(self, e, a): return self.meth(a, "repeat", a[1:])
    def in_str_count(self, e, a): return "(%s.split(%s).length - 1)" % (self.x(a[0], ATOM), self.raw(a[1]))
    def in_append(self, e, a): return self.meth(a, "push", a[1:])
    def in_insert(self, e, a): return "%s.splice(%s, 0, %s)" % (self.x(a[0], ATOM), self.raw(a[1]), self.raw(a[2]))
    def in_pop_last(self, e, a): return self.meth(a, "pop", [])
    def in_pop_at(self, e, a): return "%s.splice(%s, 1)[0]" % (self.x(a[0], ATOM), self.raw(a[1]))

    def in_remove_value(self, e, a):
        o = self.x(a[0], ATOM)
        return "%s.splice(%s.indexOf(%s), 1)" % (o, o, self.raw(a[1]))

    def in_sort(self, e, a): return "%s.sort(%s)" % (self.x(a[0], ATOM), self.cmp_fn(a[0].ty))
    def in_reverse_inplace(self, e, a): return self.meth(a, "reverse", [])

    def in_clear(self, e, a):
        k = self.ty_k(a[0])
        if k in ("dict", "set"):
            return self.meth(a, "clear", [])
        return "%s.length = 0" % self.x(a[0], ATOM)

    def in_extend(self, e, a): return "%s.push(...%s)" % (self.x(a[0], ATOM), self.x(a[1], ATOM))
    def in_index(self, e, a): return self.meth(a, "indexOf", a[1:])

    def in_list_count(self, e, a):
        return "%s.filter(_x => _x === %s).length" % (self.x(a[0], ATOM), self.x(a[1], REL + 1))

    def in_list_copy(self, e, a): return "[...%s]" % self.x(a[0], ATOM)
    def by_fn(self, a):
        self.need_("by")
        key = "(%s) => %s" % (self.id(a[1].params[0]), self.x(a[1].body, TERN)) if a[1].k == "Lambda" else "(v) => v"
        return "_by(%s, %s)" % (key, "true" if a[2].v else "false")

    def in_sort_key(self, e, a): return "%s.sort(%s)" % (self.x(a[0], ATOM), self.by_fn(a))
    def in_sorted_key(self, e, a): return "[...%s].sort(%s)" % (self.x(a[0], ATOM), self.by_fn(a))

    def in_chars(self, e, a): return "[...%s]" % self.x(a[0], ATOM)
    def in_ints(self, e, a): return "%s.map(v => parseInt(v, 10))" % self.x(a[0], ATOM)
    def in_floats(self, e, a): return "%s.map(v => parseFloat(v))" % self.x(a[0], ATOM)
    def in_list_concat(self, e, a): return "[...%s, ...%s]" % (self.x(a[0], ATOM), self.x(a[1], ATOM))
    def in_digit_val(self, e, a): return "parseInt(%s, 10)" % self.raw(a[0])
    def in_exit(self, e, a): return "process.exit(%s)" % ", ".join(self.raw(x) for x in a)

    def ex_TupleE(self, e):
        return "[" + ", ".join(self.raw(i) for i in e.items) + "]"

    def st_TupleAssign(self, s):
        names = ", ".join(self.raw(t) for t in s.targets)
        if all(s.decl):
            self.w("let [%s] = %s;" % (names, self.raw(s.value)))
        else:
            for t, d in zip(s.targets, s.decl):
                if d:
                    self.w("let %s;" % self.raw(t))
            self.w("[%s] = %s;" % (names, self.raw(s.value)))
    def in_strs(self, e, a): return self.raw(a[0])
    def in_sort_str(self, e, a): return '[...%s].sort().join("")' % self.x(a[0], ATOM)

    def in_repr(self, e, a):
        return "`[${%s.map(v => typeof v === 'string' ? \"'\" + v + \"'\" : v).join(', ')}]`" % self.x(a[0], ATOM)
    def in_list(self, e, a):
        if self.ty_k(a[0]) == "str":
            return "[...%s]" % self.x(a[0], ATOM)
        return "[...%s]" % self.x(a[0], ATOM)

    def in_set(self, e, a): return "new Set(%s)" % self.raw(a[0])

    def in_range(self, e, a):
        if len(a) == 1:
            return "Array.from({length: %s}, (_, i) => i)" % self.raw(a[0])
        lo, hi = self.raw(a[0]), self.x(a[1], ADD)
        return "Array.from({length: %s - %s}, (_, i) => i + %s)" % (hi, self.x(a[0], ADD + 1), lo)

    def in_dget(self, e, a):
        d, k = self.x(a[0], ATOM), self.raw(a[1])
        if len(a) == 3:
            return "(%s.has(%s) ? %s.get(%s) : %s)" % (d, k, d, k, self.x(a[2], TERN + 1)), ATOM
        return "%s.get(%s)" % (d, k)

    def in_dkeys(self, e, a): return "[...%s.keys()]" % self.x(a[0], ATOM)
    def in_dvalues(self, e, a): return "[...%s.values()]" % self.x(a[0], ATOM)
    def in_ditems(self, e, a): return "%s" % self.raw(a[0])
    def in_ddel(self, e, a): return self.meth(a, "delete", a[1:])
    def in_del(self, e, a):
        if self.ty_k(a[0]) == "dict":
            return self.meth(a, "delete", a[1:])
        return "%s.splice(%s, 1)" % (self.x(a[0], ATOM), self.raw(a[1]))

    def in_sadd(self, e, a): return self.meth(a, "add", a[1:])
    def in_sdel(self, e, a): return self.meth(a, "delete", a[1:])
    def in_keys_of(self, e, a): return "%s.keys()" % self.x(a[0], ATOM)

    def in_list_new(self, e, a):
        n, v = a
        if v.k in ("ListLit", "DictLit", "SetLit") or (v.k == "Intr" and v.name == "list_new"):
            return "Array.from({length: %s}, () => %s)" % (self.raw(n), self.raw(v))
        return "new Array(%s).fill(%s)" % (self.raw(n), self.raw(v))
