"""
tx_sema -- scope resolution, type inference and canonicalisation of the IR.

After this pass every expression has (best-effort) `.ty`, library calls are
language-neutral `Intr` nodes, and statements are normalised so the emitters
only need to know how to *print* things.
"""
from tx_core import (N, Ty, INT, FLOAT, STR, BOOL, CHAR, VOID, ANY, LONG, list_of, arr_of, dict_of, set_of,
                     cls_of, join_ty, fill, is_seq, is_num, Unsupported)
from tx_parse import intr, num, default_for, dotted


class V:
    __slots__ = ("name", "ty", "decl", "block", "is_global")

    def __init__(self, name, ty, decl, block, is_global=False):
        self.name, self.ty, self.decl, self.block, self.is_global = name, ty, decl, block, is_global


def walk(x, fn):
    """Call fn on every N reachable from x (pre-order)."""
    if isinstance(x, (list, tuple)):
        for i in x:
            walk(i, fn)
    elif isinstance(x, N):
        fn(x)
        for k, v in x.__dict__.items():
            if k not in ("k", "ty", "owner"):
                walk(v, fn)


def become(node, k, **kw):
    old = {kk: vv for kk, vv in node.__dict__.items()}
    node.__dict__.clear()
    node.k = k
    node.ty = None
    node.__dict__.update(kw)
    return node


def copy_ty(t):
    if t is None or not t.a:
        return t
    return Ty(t.k, *[copy_ty(x) if isinstance(x, Ty) else x for x in t.a])


_STATIC = ("cpp", "java")
_ARITH = {"+", "-", "*", "/", "%", "//", "tdiv", "**"}
_CMP = {"==", "!=", "<", "<=", ">", ">="}


class Sema:
    def __init__(self, prog, src, tgt):
        self.prog, self.src, self.tgt = prog, src, tgt
        self.static = tgt in _STATIC
        self.csrc = src in ("cpp", "java", "javascript")
        self.funcs, self.classes = {}, {}
        self.scopes = []
        self.blocks = []
        self.cur_fn = None
        self.fn_base = None
        self.cur_class = None
        self.tmp_n = 0
        self.block_n = 0

    # ───────────────────────── program shape ─────────────────────────────
    def flatten(self):
        prog, src = self.prog, self.src
        funcs, classes, globs, main = [], [], [], []
        prog.main_is_fn = False
        prog.main_guard = False
        for it in prog.items:
            if it.k == "Class":
                is_main_cls = src == "java" and any(m.name == "main" and m.static for m in it.methods)
                if is_main_cls:
                    for m in it.methods:
                        if m.name == "main":
                            main = list(m.body)
                            prog.main_is_fn = True
                        else:
                            m.method = False
                            m.static = False
                            funcs.append(m)
                    for f in it.fields:
                        globs.append(N("VarDecl", name=f.name, ty=f.ty, init=f.init, const=False, static=True))
                else:
                    classes.append(it)
            elif it.k == "Func":
                if it.name == "main" and src in ("cpp", "java"):
                    main = list(it.body)
                    prog.main_is_fn = True
                else:
                    funcs.append(it)
            elif it.k == "If" and src == "python" and it.cond.k == "Bin" and it.cond.op == "==" and \
                    it.cond.l.k == "Name" and it.cond.l.id == "__name__":
                main.extend(it.body)
                prog.main_guard = True
            elif it.k == "VarDecl" and src in ("cpp", "java"):
                globs.append(it)
            elif it.k == "Comment" and not (funcs or classes or main):
                prog.lead_comments = getattr(prog, "lead_comments", []) + [it]
            elif it.k in ("Comment",):
                main.append(it)
            else:
                main.append(it)
        # strip `return 0;` at the end of C++ main
        if main and main[-1].k == "Return" and (main[-1].e is None or main[-1].e.k == "Num"):
            main = main[:-1]
        # globals referenced from functions/classes (script languages)
        if src in ("python", "javascript"):
            used = set()
            for f in funcs:
                used |= self.free_names(f.body, [p.name for p in f.params])
            for c in classes:
                for m in c.methods + ([c.ctor] if c.ctor else []):
                    used |= self.free_names(m.body, [p.name for p in m.params])
            moved, rest = [], []
            seen = set()
            for s in main:
                nm = None
                if s.k == "VarDecl":
                    nm = s.name
                elif s.k == "Assign" and s.op == "=" and s.target.k == "Name":
                    nm = s.target.id
                if nm and nm in used and nm not in seen and not self.has_call_or_input(s):
                    seen.add(nm)
                    if s.k == "Assign":
                        s = N("VarDecl", name=nm, ty=None, init=s.value, const=False)
                    moved.append(s)
                else:
                    rest.append(s)
            globs.extend(moved)
            main = rest
        prog.funcs, prog.classes, prog.globals, prog.main = funcs, classes, globs, main
        for f in funcs:
            self.funcs[f.name] = f
        for c in classes:
            self.classes[c.name] = c
            c.fmap = {}
            for f in c.fields:
                c.fmap[f.name] = f
            c.mmap = {m.name: m for m in c.methods}
        # Java/C++/JS: the constructor of JS classes lives in methods
        for c in classes:
            if c.ctor is None:
                for m in c.methods:
                    if m.name == "constructor":
                        m.ctor = True
                        m.name = c.name
                        c.ctor = m
                        c.methods = [x for x in c.methods if x is not m]
                        c.mmap = {mm.name: mm for mm in c.methods}
            if c.ctor is not None:
                c.ctor.method = True
        prog.main_decl_names = set()
        self.synth_ctors()

    def synth_ctors(self):
        """`Foo(a, b)` on a class without a constructor (C++ struct init) needs one."""
        want = set()

        def chk(n):
            if n.k == "New" and n.args:
                want.add(n.cls)
            elif n.k == "Call" and n.fn.k == "Name" and n.fn.id in self.classes and n.args:
                want.add(n.fn.id)
        walk(self.prog.main, chk)
        for f in self.prog.funcs:
            walk(f.body, chk)
        for g in self.prog.globals:
            walk(g, chk)
        for c in self.prog.classes:
            for m in c.methods + ([c.ctor] if c.ctor else []):
                walk(m.body, chk)
        for c in self.prog.classes:
            if c.ctor is None and c.name in want:
                inst = [f for f in c.fields if not f.static]
                params = [N("Param", name=f.name, ty=f.ty, default=None) for f in inst]
                body = [N("Assign", target=N("Attr", obj=N("This"), name=f.name), op="=",
                          value=N("Name", id=f.name)) for f in inst]
                c.ctor = N("Func", name=c.name, params=params, ret=None, body=body, static=False,
                           method=True, ctor=True)

    def free_names(self, body, params):
        """Names a function reads from an enclosing (module) scope."""
        assigned, refs, glob = set(params), set(), set()

        def f(n):
            k = n.k
            if k == "Assign" and n.target.k == "Name":
                assigned.add(n.target.id)
            elif k == "VarDecl":
                assigned.add(n.name)
            elif k in ("ForRange", "ForEach"):
                assigned.add(n.var)
            elif k == "ForEnum":
                assigned.update((n.idx, n.var))
            elif k == "ForDict":
                assigned.add(n.kvar)
                if n.vvar:
                    assigned.add(n.vvar)
            elif k == "Try" and n.var:
                assigned.add(n.var)
            elif k == "ListComp":
                assigned.add(n.var)
            elif k == "Lambda":
                assigned.update(n.params)
            elif k == "GlobalDecl":
                glob.update(n.names)
            elif k == "ReadStmt":
                for t in n.targets:
                    if t.k == "Name":
                        assigned.add(t.id)
            elif k == "Name":
                refs.add(n.id)
        walk(body, f)
        return (refs - (assigned - glob)) | glob

    def has_call_or_input(self, s):
        found = []

        def chk(n):
            if n.k in ("Input", "Print") or (n.k == "Call" and n.fn.k == "Name" and n.fn.id in self.funcs):
                found.append(1)
        walk(s, chk)
        return bool(found)

    # ───────────────────────── scopes ────────────────────────────────────
    def push(self, new_block=True):
        self.scopes.append({})
        self.block_n += 1
        self.blocks.append(self.block_n)

    def pushb(self):
        """Nested block. Python scopes by function, everything else by block."""
        if self.src == "python" and self.scopes:
            self.scopes.append(self.scopes[-1])
        else:
            self.scopes.append({})
        self.block_n += 1
        self.blocks.append(self.block_n)

    def pop(self):
        sc = self.scopes.pop()
        self.blocks.pop()
        for v in sc.values():
            if v.decl is not None and v.decl.k == "VarDecl" and v.ty is not None:
                v.decl.ty = v.ty

    popb = pop

    def lookup(self, name):
        for sc in reversed(self.scopes):
            if name in sc:
                return sc[name]
        return None

    def declare(self, name, ty, decl, glob=False, loopvar=False):
        v = V(name, ty, decl, self.blocks[-1], glob)
        if self.src == "python" and not loopvar and not glob and self.fn_base is not None:
            self.scopes[self.fn_base][name] = v
        else:
            self.scopes[-1][name] = v
        return v

    def pushloop(self):
        self.scopes.append({})
        self.block_n += 1
        self.blocks.append(self.block_n)

    # ───────────────────────── driver ────────────────────────────────────
    def run(self):
        self.flatten()
        for _ in range(4):
            self.one_pass()
        self.finish()
        return self.prog

    def one_pass(self):
        prog = self.prog
        self.scopes, self.blocks = [], []
        self.push()
        self.cur_fn = None
        for g in prog.globals:
            self.stmt(g, glob=True)
        for c in prog.classes:
            self.klass(c)
        for f in prog.funcs:
            self.func(f)
        mf = N("Func", name="__main__", params=[], ret=VOID, body=prog.main, static=True,
               method=False, ctor=False)
        self.func(mf, main=True)
        prog.main_gw = mf.global_writes
        self.pop()

    def klass(self, c):
        self.cur_class = c
        if c.ctor:
            self.func(c.ctor)
        for m in c.methods:
            self.func(m)
        for f in c.fields:
            if f.init is not None:
                self.push()
                f.init = self.ex(f.init)
                self.pop()
                if f.ty is None:
                    f.ty = f.init.ty
                else:
                    fill(f.ty, f.init.ty)
        self.cur_class = None

    def func(self, f, main=False):
        self.cur_fn = f
        f.global_writes = set()
        f.hoists = []
        self.push()
        self.fn_base = len(self.scopes) - 1
        if not main and not hasattr(f, "ret_inf"):
            f.ret_inf = None
        for p in f.params:
            if p.default is not None:
                p.default = self.ex(p.default)
                if p.ty is None:
                    p.ty = p.default.ty
            self.declare(p.name, p.ty, p)
        self.block(f.body, new=False)
        # finalise inferred types
        for sc in self.scopes[-1:]:
            for v in sc.values():
                if v.decl is not None and v.decl.k == "VarDecl":
                    if v.ty is not None:
                        v.decl.ty = v.ty
        if not main and f.ret is None and not f.ctor:
            r = getattr(f, "ret_inf", None)
            f.ret_inferred = r if r is not None else None
            f.ret_final = r
        self.pop()
        self.cur_fn = None
        self.fn_base = None
        # hoisted declarations (python-style scoping -> C-like)
        if f.hoists:
            seen = set()
            decls = []
            for d in f.hoists:
                if d.name in seen:
                    continue
                seen.add(d.name)
                decls.append(N("VarDecl", name=d.name, ty=d.ty, init=None, const=False, hoisted=True))
            f.body[:0] = decls
            for d in f.hoists:
                if d.k == "VarDecl" and not getattr(d, "hoisted", False):
                    become(d, "Assign", target=N("Name", id=d.name), op="=", value=d.init)
                    d.target.ty = None
            f.hoists = []

    def block(self, stmts, new=True):
        if new:
            self.pushb()
        i = 0
        while i < len(stmts):
            s = stmts[i]
            pre = self.stmt(s)
            if pre:
                stmts[i:i] = pre
                i += len(pre)
            i += 1
        if new:
            self.popb()

    # ───────────────────────── statements ────────────────────────────────
    def tmp(self, base="_t"):
        self.tmp_n += 1
        return "%s%d" % (base, self.tmp_n)

    def hoist_comps(self, e, out):
        """Lower list comprehensions into explicit loops (for non-python targets)."""
        if e is None or self.tgt in ("python", "javascript") and False:
            return e
        if isinstance(e, list):
            return [self.hoist_comps(x, out) for x in e]
        if not isinstance(e, N):
            return e
        for k, v in list(e.__dict__.items()):
            if k in ("k", "ty"):
                continue
            if isinstance(v, N):
                e.__dict__[k] = self.hoist_comps(v, out)
            elif isinstance(v, list):
                e.__dict__[k] = [self.hoist_comps(x, out) if isinstance(x, N) else
                                 (tuple(self.hoist_comps(y, out) for y in x) if isinstance(x, tuple) else x)
                                 for x in v]
        if e.k == "ListComp":
            name = self.tmp("_lc")
            body = [N("ExprS", e=intr("append", N("Name", id=name), e.elt))]
            if e.cond is not None:
                body = [N("If", cond=e.cond, body=body, orelse=[])]
            out.append(N("VarDecl", name=name, ty=None, init=N("ListLit", items=[]), const=False))
            it = e.it
            if it.k == "MaybeBuiltin" and it.name == "range":
                a = it.args
                lo, hi, st = (num(0), a[0], num(1)) if len(a) == 1 else (
                    (a[0], a[1], num(1)) if len(a) == 2 else (a[0], a[1], a[2]))
                out.append(N("ForRange", var=e.var, vty=INT, lo=lo, hi=hi, step=st, incl=False, body=body))
            else:
                out.append(N("ForEach", var=e.var, vty=None, it=e.it, body=body))
            return N("Name", id=name)
        return e

    def stmt(self, s, glob=False):
        k = s.k
        pre = []
        if self.tgt != "python" and k in ("VarDecl", "Assign", "ExprS", "Return", "If", "While", "Print"):
            for fld in ("init", "value", "e", "cond", "items"):
                if hasattr(s, fld) and getattr(s, fld) is not None:
                    setattr(s, fld, self.hoist_comps(getattr(s, fld), pre))
            for p_ in pre:
                self.stmt(p_)
        if k == "VarDecl":
            if s.init is not None:
                s.init = self.ex(s.init)
            if s.ty is None and s.init is not None:
                s.ty = copy_ty(s.init.ty) if s.init.ty is not None and s.init.ty.k not in (
                    "int", "float", "str", "bool", "char") else s.init.ty
            elif s.ty is not None and s.init is not None:
                fill(s.ty, s.init.ty)
                s.init = self.coerce(s.init, s.ty)
            if s.init is None and s.ty is not None and s.ty.k in ("list", "dict", "set") and \
                    not getattr(s, "hoisted", False) and self.src in ("cpp", "java"):
                s.init = default_for(s.ty)
                s.init = self.ex(s.init)
                s.init.ty = s.ty
            if s.init is None and s.ty is not None and s.ty.k == "class" and s.ty.a[0] in self.classes \
                    and not getattr(s, "hoisted", False):
                s.init = N("New", cls=s.ty.a[0], args=[])
                s.init.ty = s.ty
            v = self.declare(s.name, s.ty, s, glob)
            s.var = v
            if s.ty is None:
                v.ty = None
            return pre
        if k == "Assign":
            self.assign(s)
            return pre
        if k == "ExprS":
            s.e = self.ex(s.e)
            if s.e.k == "Assign":
                become(s, "Assign", target=s.e.target, op=s.e.op, value=s.e.value)
            elif s.e.k == "Intr" and s.e.name == "reversed_copy" and s.e.args[0].k in ("Name", "Attr", "Index"):
                become(s, "Assign", target=s.e.args[0], op="=", value=s.e)
            elif s.e.k == "Intr" and s.e.name in ("reverse_inplace", "sort") and s.e.args[0].ty is not None \
                    and s.e.args[0].ty.k == "str":
                tgt = s.e.args[0]
                nm = "reversed_copy" if s.e.name == "reverse_inplace" else "sort_str"
                val = intr(nm, tgt)
                val.ty = STR
                become(s, "Assign", target=tgt, op="=", value=val)
            return pre
        if k == "If":
            s.cond = self.cond(s.cond)
            self.block(s.body)
            self.block(s.orelse)
            return pre
        if k == "While":
            s.cond = self.cond(s.cond)
            self.block(s.body)
            return pre
        if k == "DoWhile":
            self.block(s.body)
            s.cond = self.cond(s.cond)
            return pre
        if k == "ForRange":
            s.lo, s.hi, s.step = self.ex(s.lo), self.ex(s.hi), self.ex(s.step)
            vt = s.vty if s.vty is not None else INT
            if s.lo.ty is not None and s.lo.ty.k == "float" or (s.hi.ty is not None and s.hi.ty.k == "float" and False):
                vt = FLOAT
            s.vty = vt
            self.pushloop()
            self.declare(s.var, vt, s, loopvar=True)
            self.block(s.body, new=False)
            self.popb()
            return pre
        if k == "CFor":
            self.pushb()
            for i in s.init:
                self.stmt(i)
            if s.cond is not None:
                s.cond = self.cond(s.cond)
            for u in s.update:
                self.stmt(u)
            self.block(s.body)
            self.popb()
            return pre
        if k == "ForEach":
            s.it = self.ex(s.it)
            et = None
            t = s.it.ty
            if t is not None:
                if t.k in ("list", "arr", "set"):
                    et = t.a[0]
                elif t.k == "str":
                    et = CHAR
                elif t.k == "dict":
                    et = t.a[0]
            if s.it.k == "Intr" and s.it.name == "range":
                et = INT
            if s.it.k == "Intr" and s.it.name == "ditems" and s.it.args[0].ty is not None \
                    and s.it.args[0].ty.k == "dict":
                s.it = s.it.args[0]
                t = s.it.ty
            vt = s.vty if s.vty is not None else et
            if t is not None and t.k == "dict":
                kv, vv = self.entry_vars(s.var, s.body)
                become(s, "ForDict", kvar=kv, vvar=vv, it=s.it, body=s.body)
                s.kty, s.vty = t.a[0], t.a[1]
                self.pushloop()
                if vv:
                    self.declare(vv, t.a[1], s, loopvar=True)
                self.declare(s.kvar, t.a[0], s, loopvar=True)
                self.block(s.body, new=False)
                self.popb()
                return pre
            self.pushloop()
            s.vty = vt
            self.declare(s.var, vt, s, loopvar=True)
            self.block(s.body, new=False)
            if s.vty is None:
                s.vty = self.lookup(s.var).ty
            self.popb()
            return pre
        if k == "ForZip":
            s.its = [self.ex(i) for i in s.its]
            if self.tgt != "python":
                idx = self.tmp("_z")
                lens = []
                for i in s.its:
                    c = intr("len", i)
                    c.ty = INT
                    lens.append(c)
                hi = lens[0]
                if len(lens) > 1:
                    hi = intr("min", *lens)
                    hi.ty = INT
                pre_ = []
                for v, i in zip(s.vars, s.its):
                    ix = N("Index", obj=i, idx=N("Name", id=idx))
                    pre_.append(N("VarDecl", name=v, ty=None, init=ix, const=False))
                body = pre_ + s.body
                become(s, "ForRange", var=idx, vty=INT, lo=num(0), hi=hi, step=num(1), incl=False, body=body)
                s.lo.ty = s.step.ty = INT
                return self.stmt(s)
            self.pushloop()
            for v, i in zip(s.vars, s.its):
                t = i.ty
                et = t.a[0] if t is not None and t.k in ("list", "arr", "set") else (CHAR if t is not None and t.k == "str" else None)
                self.declare(v, et, s, loopvar=True)
            self.block(s.body, new=False)
            self.popb()
            return pre
        if k == "ForEnum":
            s.it = self.ex(s.it)
            s.start = self.ex(s.start)
            t = s.it.ty
            et = t.a[0] if t is not None and t.k in ("list", "arr", "set") else (CHAR if t is not None and t.k == "str" else None)
            s.ety = et
            self.pushloop()
            self.declare(s.idx, INT, s, loopvar=True)
            self.declare(s.var, et, s, loopvar=True)
            self.block(s.body, new=False)
            self.popb()
            return pre
        if k == "ForDict":
            s.it = self.ex(s.it)
            t = s.it.ty
            kt = t.a[0] if t is not None and t.k == "dict" else None
            vt = t.a[1] if t is not None and t.k == "dict" else None
            s.kty, s.vty = kt, vt
            self.pushloop()
            self.declare(s.kvar, kt, s, loopvar=True)
            if s.vvar:
                self.declare(s.vvar, vt, s, loopvar=True)
            self.block(s.body, new=False)
            self.popb()
            return pre
        if k == "Return":
            if s.e is not None:
                s.e = self.ex(s.e)
                f = self.cur_fn
                if f is not None and not getattr(f, "ctor", False) and f.name != "__main__":
                    if f.ret is not None:
                        s.e = self.coerce(s.e, f.ret)
                    else:
                        f.ret_inf = join_ty(getattr(f, "ret_inf", None), s.e.ty) if s.e.ty is not None else getattr(f, "ret_inf", None)
            return pre
        if k == "Switch":
            s.e = self.ex(s.e)
            for c in s.cases:
                c.vals = [self.coerce_to_other(self.ex(v), s.e) for v in c.vals]
                self.block(c.body)
            if s.default is not None:
                self.block(s.default)
            return pre
        if k == "Try":
            self.block(s.body)
            self.pushb()
            if s.var:
                self.declare(s.var, ANY, None, loopvar=True)
            self.block(s.handler, new=False)
            self.popb()
            self.block(s.fin)
            return pre
        if k == "Print":
            s.items = [self.ex(i) for i in s.items]
            for i, it in enumerate(s.items):
                if it.k == "FStr" and len(it.parts) == 1 and not isinstance(it.parts[0], str) and \
                        not it.parts[0][1]:
                    s.items[i] = it.parts[0][0]
            if self.tgt in ("javascript", "cpp"):
                for i, it in enumerate(s.items):
                    if it.ty is not None and it.ty.k == "class" and it.ty.a[0] in self.classes and \
                            self.method_of(self.classes[it.ty.a[0]], "toString") is not None:
                        s.items[i] = self.tostr(it)
            if self.tgt != "python":
                for i, it in enumerate(s.items):
                    if it.ty is not None and it.ty.k in ("list", "arr") and it.ty.a and it.ty.a[0] is not None \
                            and it.ty.a[0].k in ("int", "float", "str", "char", "bool"):
                        r = intr("repr", it)
                        r.ty = STR
                        s.items[i] = r
            if self.src == "cpp" and not getattr(self.prog, "boolalpha", False):
                for i, it in enumerate(s.items):
                    if it.ty is not None and it.ty.k == "bool":
                        t = N("Tern", c=it, a=num(1), b=num(0))
                        t.a.ty = t.b.ty = INT
                        t.ty = INT
                        s.items[i] = t
            return pre
        if k == "ReadStmt":
            s.targets = [self.ex(t) for t in s.targets]
            for i, t in enumerate(s.targets):
                if t.k == "Name" and self.lookup(t.id) is None:
                    ty = s.tys[i] or STR
                    d = N("VarDecl", name=t.id, ty=ty, init=None, const=False)
                    self.declare(t.id, ty, d)
                    s.decl[i] = True
                elif s.tys[i] is None or True:
                    if t.ty is not None:
                        s.tys[i] = t.ty
                    elif s.tys[i] is None:
                        s.tys[i] = STR
            return pre
        if k == "Swap":
            s.a, s.b = self.ex(s.a), self.ex(s.b)
            return pre
        if k == "SuperCall":
            s.args = [self.ex(a) for a in s.args]
            if self.cur_class is not None and self.cur_class.base in self.classes:
                self.fix_args(self.classes[self.cur_class.base].ctor, s.args)
            return pre
        if k == "Throw":
            if s.e is not None:
                s.e = self.ex(s.e)
            return pre
        if k == "Assert":
            s.cond = self.cond(s.cond)
            return pre
        if k == "TupleAssign":
            if self.tgt not in ("python", "javascript"):
                raise Unsupported("tuple assignment from call")
            s.value = self.ex(s.value)
            s.targets = [self.ex(t) if t.k != "Name" else t for t in s.targets]
            s.decl = []
            for t in s.targets:
                if t.k == "Name" and self.lookup(t.id) is None:
                    d = N("VarDecl", name=t.id, ty=None, init=None, const=False)
                    self.declare(t.id, None, d)
                    s.decl.append(True)
                else:
                    s.decl.append(False)
            return pre
        if k == "GlobalDecl":
            for nm in s.names:
                self.cur_fn.global_writes.add(nm)
                self.scopes[-1][nm] = self.lookup(nm) or V(nm, None, None, 0, True)
            return pre
        return pre

    def assign(self, s):
        t = s.target
        s.value = self.ex(s.value)
        # first assignment to an undeclared name -> declaration (python / js)
        if t.k == "Name" and s.op == "=" and self.src in ("python", "javascript"):
            v = self.lookup(t.id)
            if v is None:
                ty = copy_ty(s.value.ty) if s.value.ty is not None and s.value.ty.k not in (
                    "int", "float", "str", "bool", "char") else s.value.ty
                become(s, "VarDecl", name=t.id, ty=ty, init=s.value, const=False)
                nv = self.declare(t.id, ty, s)
                s.var = nv
                return
        s.target = self.ex(t, lvalue=True)
        t = s.target
        # a variable first created in a nested block but used outside it needs hoisting
        if t.k == "Name":
            v = self.lookup(t.id)
            if v is not None:
                self.check_hoist(v)
                if v.is_global and self.cur_fn is not None and self.cur_fn.name != "__main__" or \
                        (v.is_global and self.cur_fn is not None and self.cur_fn.name == "__main__" and False):
                    self.cur_fn.global_writes.add(t.id)
                if t.ty is None:
                    t.ty = v.ty
                if s.op == "=":
                    nt = s.value.ty
                    if v.ty is None:
                        if not (v.decl is not None and v.decl.k == "Param"):
                            v.ty = nt
                    elif nt is not None:
                        nj = join_ty(v.ty, nt)
                        if nj is not v.ty and v.ty.k in ("int", "char") and nj.k == "float":
                            v.ty = nj
                            if v.decl is not None and v.decl.k == "VarDecl":
                                v.decl.ty = nj
                        else:
                            fill(v.ty, nt)
                    s.value = self.coerce(s.value, v.ty)
        elif t.k == "Attr" and t.obj.k == "This" and self.cur_class is not None:
            f = self.field_of(self.cur_class, t.name)
            if f is None:
                f = N("Field", name=t.name, ty=None, init=None, static=False)
                self.cur_class.fields.append(f)
                self.cur_class.fmap[t.name] = f
            if s.op == "=" and s.value.ty is not None:
                f.ty = join_ty(f.ty, s.value.ty) if f.ty is not None else s.value.ty
            t.ty = f.ty
            if f.ty is not None:
                s.value = self.coerce(s.value, f.ty)
        elif t.k == "Index":
            if s.op == "=" and t.obj.ty is not None:
                ot = t.obj.ty
                if ot.k in ("list", "arr") and ot.a[0] is None and s.value.ty is not None:
                    ot.a[0] = s.value.ty
                if ot.k == "dict":
                    if ot.a[0] is None:
                        ot.a[0] = self.wd(t.idx.ty)
                    if ot.a[1] is None:
                        ot.a[1] = self.wd(s.value.ty)
            if t.ty is not None:
                s.value = self.coerce(s.value, t.ty)
        # compound ops on chars etc.
        if s.op in ("/=",) and self.csrc and t.ty is not None and t.ty.k == "int" and \
                s.value.ty is not None and s.value.ty.k in ("int", "char"):
            s.op = "tdiv="
        if s.op == "+=" and is_seq(t.ty) and is_seq(s.value.ty):
            become(s, "ExprS", e=self.type_intr(intr("extend", t, s.value)))
            return
        if s.op == "+=" and t.ty is not None and t.ty.k == "str" and s.value.ty is not None and \
                s.value.ty.k in ("int", "float"):
            s.value = intr("tostr", s.value)
            s.value.ty = STR

    def entry_vars(self, var, body):
        """`for (auto& kv : m)` / `for (Map.Entry e : m.entrySet())`: split the entry into key/value variables."""
        uses = []

        def f(n):
            if n.k == "Attr" and n.obj.k == "Name" and n.obj.id == var and n.name in ("first", "second"):
                uses.append(n)
            elif n.k == "Call" and n.fn.k == "Attr" and n.fn.obj.k == "Name" and n.fn.obj.id == var and \
                    n.fn.name in ("getKey", "getValue") and not n.args:
                uses.append(n)
        walk(body, f)
        if not uses:
            return var, None
        kv, vv = var + "_key", var + "_val"
        for n in uses:
            nm = n.name if n.k == "Attr" else n.fn.name
            become(n, "Name", id=kv if nm in ("first", "getKey") else vv)
        return kv, vv

    def field_of(self, c, name):
        while c is not None:
            if name in c.fmap:
                return c.fmap[name]
            c = self.classes.get(c.base)
        return None

    def method_of(self, c, name):
        while c is not None:
            if name in c.mmap:
                return c.mmap[name]
            c = self.classes.get(c.base)
        return None

    # ───────────────────────── coercions ─────────────────────────────────
    def cond(self, e):
        e = self.ex(e)
        if self.src == "javascript" and e.k == "Index" and e.obj.ty is not None and e.obj.ty.k == "dict" \
                and not getattr(e, "ckd", False):
            e.ckd = True
            has = N("Bin", op="in", l=e.idx, r=e.obj)
            has.ty = BOOL
            e = N("Bin", op="and", l=has, r=e)
            e.ty = BOOL
            return e
        t = e.ty
        if self.tgt == "javascript" and self.src != "javascript" and t is not None and \
                t.k in ("list", "arr", "dict", "set"):
            r = N("Bin", op=">", l=intr("len", e), r=num(0))
            r.l.ty = INT
            r.ty = BOOL
            return r
        if self.static and t is not None and t.k != "bool":
            if t.k in ("int", "float", "char"):
                r = N("Bin", op="!=", l=e, r=num(0))
            elif t.k in ("str", "list", "arr", "dict", "set"):
                r = N("Bin", op=">", l=intr("len", e), r=num(0))
                r.l.ty = INT
            else:
                r = N("Bin", op="!=", l=e, r=N("Null"))
            r.ty = BOOL
            return r
        return e

    def cond_val(self, e):
        t = e.ty
        if t is not None and t.k in ("int", "float", "char"):
            r = N("Bin", op="!=", l=e, r=num(0))
            r.ty = BOOL
            return r
        return e

    def wd(self, t):
        """element types in Python/JS programs: a one-character string is just a string"""
        if t is not None and t.k == "char" and self.src in ("python", "javascript"):
            return STR
        return t

    def coerce(self, e, to):
        if to is None or e is None:
            return e
        if to.k == "str" and e.ty is not None and e.ty.k == "char" and self.static and e.k != "Str":
            return self.tostr(e)
        if to.k == "char":
            if e.k == "Str" and len(e.v) == 1 and not e.char:
                e.char = True
                e.ty = CHAR
            elif e.ty is not None and e.ty.k == "int" and self.tgt in ("python", "javascript") and \
                    self.csrc and e.k != "Num":
                r = intr("chr", e)
                r.ty = CHAR
                return r
        elif to.k == "float" and e.k == "Num" and not e.isf and False:
            pass
        return e

    def coerce_to_other(self, e, other):
        if other.ty is not None and other.ty.k == "char" and e.k == "Str" and len(e.v) == 1:
            e.char = True
            e.ty = CHAR
        return e

    def fix_args(self, fn, args):
        if fn is None:
            return
        for i, a in enumerate(args):
            if i < len(fn.params):
                p = fn.params[i]
                if p.ty is None and a.ty is not None:
                    p.ty = copy_ty(a.ty)
                elif p.ty is not None:
                    fill(p.ty, a.ty)
                    if p.ty.k == "float" and a.ty is not None and a.ty.k == "int" and False:
                        pass
                args[i] = self.coerce(a, p.ty)

    # ───────────────────────── expressions ───────────────────────────────
    def ex(self, e, lvalue=False):
        m = getattr(self, "e_" + e.k, None)
        if m is None:
            return e
        r = m(e) if not lvalue or e.k not in ("Name", "Index", "Attr") else m(e)
        return r

    def e_Num(self, e):
        e.ty = FLOAT if e.isf else INT
        return e

    def e_Str(self, e):
        e.ty = CHAR if e.char else STR
        return e

    def e_Bool(self, e):
        e.ty = BOOL
        return e

    def e_Null(self, e):
        e.ty = None
        return e

    def e_This(self, e):
        e.ty = cls_of(self.cur_class.name) if self.cur_class is not None else None
        return e

    def e_Super(self, e):
        return e

    def e_Name(self, e):
        v = self.lookup(e.id)
        if v is not None:
            e.ty = v.ty
            self.check_hoist(v)
            return e
        c = self.cur_class
        if c is not None:
            f = self.field_of(c, e.id)
            if f is not None:
                if f.static:
                    owner = c
                    while owner is not None and e.id not in owner.fmap:
                        owner = self.classes.get(owner.base)
                    r = N("Attr", obj=N("Name", id=(owner or c).name), name=e.id)
                else:
                    r = N("Attr", obj=N("This"), name=e.id)
                    r.obj.ty = cls_of(c.name)
                r.ty = f.ty
                return r
        return e

    def check_hoist(self, v):
        if self.src == "python" and v.decl is not None and v.decl.k == "VarDecl" and not v.is_global \
                and v.block not in self.blocks and self.cur_fn is not None \
                and not getattr(v.decl, "hoisted", False):
            if v.decl not in self.cur_fn.hoists:
                self.cur_fn.hoists.append(v.decl)

    def e_Attr(self, e):
        # static access through a class name
        if e.obj.k == "Name" and e.obj.id in self.classes and self.lookup(e.obj.id) is None:
            cl = self.classes[e.obj.id]
            f = self.field_of(cl, e.name)
            e.obj.ty = None
            e.ty = f.ty if f is not None else None
            return e
        e.obj = self.ex(e.obj)
        t = e.obj.ty
        if e.name == "size" and t is not None and t.k in ("dict", "set"):
            r = intr("len", e.obj)
            r.ty = INT
            return r
        if e.name == "length" and (t is None or t.k in ("str", "list", "arr")) and \
                not (t is None and e.obj.k == "Name" and e.obj.id in self.classes):
            r = intr("len", e.obj)
            r.ty = INT
            return r
        if t is not None and t.k == "class" and t.a[0] in self.classes:
            f = self.field_of(self.classes[t.a[0]], e.name)
            e.ty = f.ty if f is not None else None
        elif t is not None and t.k == "dict":
            r = N("Index", obj=e.obj, idx=N("Str", v=e.name, char=False))
            r.idx.ty = STR
            r.ty = t.a[1]
            return r
        return e

    def e_Index(self, e):
        e.obj = self.ex(e.obj)
        e.idx = self.ex(e.idx)
        t = e.obj.ty
        if t is not None:
            if t.k in ("list", "arr"):
                e.ty = t.a[0]
            elif t.k == "dict":
                e.ty = t.a[1]
                e.idx = self.coerce(e.idx, t.a[0])
            elif t.k == "str":
                e.ty = CHAR
        return e

    def e_Slice(self, e):
        e.obj = self.ex(e.obj)
        e.lo = self.ex(e.lo) if e.lo is not None else None
        e.hi = self.ex(e.hi) if e.hi is not None else None
        e.ty = e.obj.ty
        return e

    def e_ListLit(self, e):
        e.items = [self.ex(i) for i in e.items]
        et = None
        for i in e.items:
            et = join_ty(et, i.ty)
        e.ty = arr_of(et) if getattr(e, "arr", False) else list_of(et)
        return e

    def e_SetLit(self, e):
        e.items = [self.ex(i) for i in e.items]
        et = None
        for i in e.items:
            et = join_ty(et, i.ty)
        e.ty = set_of(et)
        return e

    def record_class(self, e):
        """{name: "ann", age: 31}  (mixed value types)  ->  a synthesized record class + constructor call"""
        keys = [k.v for k, _ in e.pairs]
        if len(set(keys)) != len(keys):
            return None
        cname = "Rec_" + "_".join(sorted(keys))
        vals = dict((k.v, v) for k, v in e.pairs)
        cls = self.classes.get(cname)
        if cls is None:
            fields, params, body = [], [], []
            for k in keys:
                ty = vals[k].ty
                fields.append(N("Field", name=k, ty=ty, init=None, static=False))
                params.append(N("Param", name=k, ty=ty, default=None))
                body.append(N("Assign", target=N("Attr", obj=N("This"), name=k), op="=", value=N("Name", id=k)))
            ctor = N("Func", name=cname, params=params, ret=None, body=body, static=False, method=True, ctor=True)
            cls = N("Class", name=cname, base=None, fields=fields, ctor=ctor, methods=[])
            cls.fmap = {f.name: f for f in fields}
            cls.mmap = {}
            cls.order = keys
            self.classes[cname] = cls
            self.prog.classes.append(cls)
        args = [vals[k] for k in cls.order]
        r = N("New", cls=cname, args=args)
        r.ty = cls_of(cname)
        return r

    def e_DictLit(self, e):
        e.pairs = [(self.ex(k), self.ex(v)) for k, v in e.pairs]
        if self.src == "javascript" and len(e.pairs) >= 2 and all(k.k == "Str" for k, _ in e.pairs):
            kinds = {v.ty.k if v.ty is not None else None for _, v in e.pairs}
            if len(kinds) > 1 and None not in kinds and not (kinds <= {"int", "float"}):
                r = self.record_class(e)
                if r is not None:
                    return r
        kt = vt = None
        for k, v in e.pairs:
            kt, vt = join_ty(kt, k.ty), join_ty(vt, v.ty)
        e.ty = dict_of(kt, vt)
        return e

    def e_TupleE(self, e):
        if self.tgt not in ("python", "javascript"):
            raise Unsupported("tuples")
        e.items = [self.ex(i) for i in e.items]
        e.ty = ANY
        return e

    def e_Tern(self, e):
        e.c = self.cond(e.c)
        e.a, e.b = self.ex(e.a), self.ex(e.b)
        e.ty = join_ty(e.a.ty, e.b.ty)
        return e

    def e_FStr(self, e):
        parts = []
        for p in e.parts:
            if isinstance(p, str):
                parts.append(p)
                continue
            ex, sp = self.ex(p[0]), p[1]
            if "@" in sp:  # "apply this precision only if the value is a float" (cout << fixed << setprecision)
                base, fixed = sp.split("@", 1)
                sp = base + fixed if ex.ty is not None and ex.ty.k == "float" else base
            parts.append((ex, sp))
        e.parts = parts
        e.ty = STR
        return e

    def e_LambdaBlock(self, e):
        raise Unsupported("function expression")

    def e_Bool_(self, e):
        return e

    def e_Lambda(self, e):
        self.push()
        for p in e.params:
            self.declare(p, None, None, loopvar=True)
        e.body = self.ex(e.body)
        self.pop()
        return e

    def e_ListComp(self, e):
        if e.cond is None and e.it.k == "MaybeBuiltin" and e.it.name == "range" and len(e.it.args) == 1:
            used = []
            walk(e.elt, lambda n: used.append(1) if n.k == "Name" and n.id == e.var else None)
            if not used:
                return self.type_intr(intr("list_new", self.ex(e.it.args[0]), self.ex(e.elt)))
        e.it = self.ex(e.it)
        t = e.it.ty
        et = None
        if t is not None and t.k in ("list", "arr", "set"):
            et = t.a[0]
        elif t is not None and t.k == "str":
            et = CHAR
        if e.it.k == "Intr" and e.it.name == "range":
            et = INT
        self.push()
        self.declare(e.var, et, None, loopvar=True)
        if e.cond is not None:
            e.cond = self.ex(e.cond)
        e.elt = self.ex(e.elt)
        self.pop()
        e.ty = list_of(e.elt.ty)
        return e

    def e_Input(self, e):
        if e.prompt is not None:
            e.prompt = self.ex(e.prompt)
        e.ty = getattr(e, "cast", None) or STR
        return e

    def e_Un(self, e):
        if e.op == "not":
            e.e = self.cond(e.e) if (self.static or self.tgt == "javascript") else self.ex(e.e)
            e.ty = BOOL
        else:
            e.e = self.ex(e.e)
            e.ty = e.e.ty
        return e

    def e_IncDec(self, e):
        e.e = self.ex(e.e)
        e.ty = e.e.ty
        return e

    def e_Assign(self, e):
        # assignment used as an expression (e.g. inside a condition)
        e.value = self.ex(e.value)
        e.target = self.ex(e.target)
        e.ty = e.value.ty
        return e

    def e_Cast(self, e):
        e.e = self.ex(e.e)
        e.ty = e.to
        if e.to.k == "str":
            r = intr("tostr", e.e)
            r.ty = STR
            return r
        if e.to.k == "char" and e.e.ty is not None and e.e.ty.k == "int" and self.tgt in ("python", "javascript"):
            r = intr("chr", e.e)
            r.ty = CHAR
            return r
        return e

    def e_Swap(self, e):
        e.a, e.b = self.ex(e.a), self.ex(e.b)
        return e

    def e_Bin(self, e):
        op = e.op
        if op in ("and", "or") and (self.static or (self.tgt == "javascript" and self.src != "javascript")):
            e.l, e.r = self.cond(e.l), self.cond(e.r)
        else:
            e.l, e.r = self.ex(e.l), self.ex(e.r)
        lt, rt = e.l.ty, e.r.ty
        if op in _CMP:
            e.r = self.coerce_to_other(e.r, e.l)
            e.l = self.coerce_to_other(e.l, e.r)
            e.ty = BOOL
            if self.static and lt is not None and rt is not None:
                if lt.k == "char" and rt.k == "str" and e.r.k != "Str":
                    e.l = self.tostr(e.l)
                elif rt.k == "char" and lt.k == "str" and e.l.k != "Str":
                    e.r = self.tostr(e.r)
            if self.csrc and self.tgt in ("python", "javascript") and lt is not None and rt is not None:
                # char vs int comparisons need numeric values in the dynamic targets
                if lt.k == "char" and rt.k == "int":
                    e.l = self.ordw(e.l)
                elif rt.k == "char" and lt.k == "int":
                    e.r = self.ordw(e.r)
            return e
        if op in ("in", "notin"):
            e.ty = BOOL
            # fill element type of the container
            if e.r.ty is not None and e.r.ty.k in ("list", "set") and e.r.ty.a[0] is None:
                e.r.ty.a[0] = e.l.ty
            if e.r.ty is not None and e.r.ty.k in ("list", "set", "arr") and e.r.ty.a and e.r.ty.a[0] is not None:
                e.l = self.coerce(e.l, e.r.ty.a[0])
            elif e.r.ty is not None and e.r.ty.k == "dict" and e.r.ty.a[0] is not None:
                e.l = self.coerce(e.l, e.r.ty.a[0])
            e.l = self.coerce_to_other(e.l, N("Name", id="_", ty=(e.r.ty.a[0] if e.r.ty is not None and e.r.ty.k in ("list", "arr", "set") and e.r.ty.a else (CHAR if e.r.ty is not None and e.r.ty.k == "str" and False else None))))
            return e
        if op in ("and", "or"):
            e.ty = BOOL if (lt is not None and lt.k == "bool") or self.static else join_ty(lt, rt)
            return e
        if op in ("&", "|", "^", "<<", ">>"):
            e.ty = INT
            return e
        # arithmetic
        if op == "*" and ((e.l.k == "ListLit" and len(e.l.items) == 1 and rt is not None and rt.k == "int") or
                          (e.r.k == "ListLit" and len(e.r.items) == 1 and lt is not None and lt.k == "int")):
            lst, n_ = (e.l, e.r) if e.l.k == "ListLit" else (e.r, e.l)
            return self.type_intr(intr("list_new", n_, lst.items[0]))
        if op == "*" and ((lt is not None and lt.k == "str" and rt is not None and rt.k == "int") or
                          (rt is not None and rt.k == "str" and lt is not None and lt.k == "int")):
            s_, n_ = (e.l, e.r) if lt.k == "str" else (e.r, e.l)
            return self.type_intr(intr("repeat", s_, n_))
        if op == "+":
            if (lt is not None and lt.k == "str") or (rt is not None and rt.k == "str"):
                e.ty = STR
                # mixing a string with a non-string (js / java): make the conversion explicit
                if lt is not None and rt is not None:
                    if lt.k != "str" and not (lt.k == "char" and self.tgt != "cpp"):
                        e.l = self.tostr(e.l)
                    if rt.k != "str" and not (rt.k == "char" and self.tgt != "cpp"):
                        e.r = self.tostr(e.r)
                return e
            if lt is not None and lt.k == "char" and rt is not None and rt.k == "char" and \
                    e.l.k == "Str" and False:
                pass
            if is_seq(lt) and is_seq(rt):
                return self.type_intr(intr("list_concat", e.l, e.r))
        if lt is not None and rt is not None and self.csrc and self.tgt in ("python", "javascript"):
            if lt.k == "char":
                e.l = self.ordw(e.l)
                lt = INT
            if rt.k == "char":
                e.r = self.ordw(e.r)
                rt = INT
        lk = "int" if lt is not None and lt.k == "char" else (lt.k if lt is not None else None)
        rk = "int" if rt is not None and rt.k == "char" else (rt.k if rt is not None else None)
        if op == "/":
            if self.src in ("cpp", "java") and lk == "int" and rk == "int":
                e.op = "tdiv"
                e.ty = INT
            elif self.src in ("cpp", "java") and (lk == "float" or rk == "float"):
                e.ty = FLOAT
            elif self.src in ("python", "javascript"):
                e.ty = FLOAT
            else:
                e.ty = FLOAT if "float" in (lk, rk) else (INT if lk == rk == "int" else None)
            return e
        if op == "//":
            e.ty = FLOAT if "float" in (lk, rk) else INT
            return e
        if op == "**":
            if lk == "int" and rk == "int" and not (e.r.k == "Num" and e.r.v.startswith("-")):
                e.ty = INT
            else:
                e.ty = FLOAT
            return e
        if lk == "float" or rk == "float":
            e.ty = FLOAT
        elif lk == "int" and rk == "int":
            e.ty = LONG if ((lt is not None and lt.wide) or (rt is not None and rt.wide)) else INT
        elif lk in ("int", "float") and rk is None:
            e.ty = lt
        elif rk in ("int", "float") and lk is None:
            e.ty = rt
        else:
            e.ty = join_ty(lt, rt)
        return e

    def ordw(self, x):
        if x.ty is not None and x.ty.k == "char":
            r = intr("ord", x)
            r.ty = INT
            return r
        return x

    def tostr(self, x):
        if x.k == "Intr" and x.name == "tostr":
            return x
        r = intr("tostr", x)
        r.ty = STR
        return r

    # ── calls ────────────────────────────────────────────────────────────
    def e_MaybeBuiltin(self, e):
        name = e.name
        user = name in self.funcs or (self.cur_class is not None and self.method_of(self.cur_class, name) is not None) \
            or self.lookup(name) is not None or name in self.classes
        if user:
            return self.ex(N("Call", fn=e.fn, args=e.args, kw=e.kw))
        return self.ex(e.canon)

    def e_Print(self, e):
        e.items = [self.ex(i) for i in e.items]
        return e

    def e_Intr(self, e):
        if e.name in ("sort_key", "sorted_key"):
            lst = self.ex(e.args[0])
            e.args[0] = lst
            lam = e.args[1]
            if lam.k == "Lambda":
                t = lst.ty
                et = t.a[0] if t is not None and t.k in ("list", "arr") and t.a else None
                self.push()
                self.declare(lam.params[0], et, None, loopvar=True)
                lam.body = self.ex(lam.body)
                self.pop()
                lam.ty = lam.body.ty
                lam.ety = et
            e.ty = lst.ty if e.name == "sorted_key" else VOID
            return e
        e.args = [self.ex(a) for a in e.args]
        return self.type_intr(e)

    def type_intr(self, e):
        n, a = e.name, e.args
        if n in ("sorted", "sorted_rev", "list", "reversed", "set") and len(a) == 1 and \
                a[0].ty is not None and a[0].ty.k == "str":
            c = intr("chars", a[0])
            c.ty = list_of(CHAR)
            a[0] = c
            e.args = a
            if n == "list":
                return c
        if n in ("sorted", "sorted_rev", "list", "reversed", "set", "min", "max", "sum", "len_keys") and                 a and a[0].ty is not None and a[0].ty.k == "dict" and len(a) == 1:
            k = intr("dkeys", a[0])
            k.ty = list_of(a[0].ty.a[0])
            a[0] = k
            e.args = a
        t0 = a[0].ty if a else None
        if n in ("len", "ord", "find", "index", "list_count", "str_count"):
            e.ty = INT
        elif n in ("tostr", "upper", "lower", "strip", "replace", "replace_first", "join", "repeat", "sort_str") and \
                not (n in ("upper", "lower") and t0 is not None and t0.k == "char"):
            e.ty = STR
        elif n in ("upper", "lower"):
            e.ty = CHAR
        elif n in ("floor", "ceil", "round", "trunc", "factorial", "gcd"):
            e.ty = INT
        elif n in ("sqrt", "log", "log10", "exp", "sin", "cos", "tan", "pi", "e", "inf", "round2"):
            e.ty = FLOAT
        elif n == "pow":
            if self.src == "python" and len(a) == 2 and a[0].ty is not None and a[1].ty is not None and \
                    a[0].ty.k == "int" and a[1].ty.k == "int":
                e.ty = INT
            else:
                e.ty = FLOAT
        elif n == "abs":
            e.ty = t0
        elif n in ("min", "max"):
            if len(a) == 1 and t0 is not None and t0.k in ("list", "arr", "set"):
                e.ty = t0.a[0]
            else:
                t = None
                for x in a:
                    t = join_ty(t, x.ty)
                e.ty = t
        elif n == "sum":
            e.ty = t0.a[0] if t0 is not None and t0.k in ("list", "arr", "set") else INT
        elif n in ("sorted", "sorted_rev", "reversed", "reversed_copy", "list_copy", "list"):
            e.ty = t0 if t0 is not None and t0.k in ("list", "arr", "str") else (
                list_of(CHAR) if t0 is not None and t0.k == "str" else None)
            if t0 is not None and t0.k == "str" and n in ("list", "sorted"):
                e.ty = list_of(CHAR)
            elif t0 is not None and t0.k == "set":
                e.ty = list_of(t0.a[0])
            elif t0 is not None and t0.k == "dict":
                e.ty = list_of(t0.a[0])
            elif t0 is not None and t0.k == "arr" and n == "list_copy":
                e.ty = t0
        elif n == "range":
            e.ty = list_of(INT)
        elif n == "chars":
            e.ty = list_of(CHAR)
        elif n == "list_concat":
            e.ty = t0
        elif n == "ints":
            e.ty = list_of(INT)
        elif n == "floats":
            e.ty = list_of(FLOAT)
        elif n == "digit_val":
            e.ty = INT
        elif n == "exit":
            e.ty = VOID
        elif n == "repr" or n == "sort_str":
            e.ty = STR
        elif n == "strs":
            e.ty = list_of(STR)
        elif n == "set":
            e.ty = set_of(t0.a[0] if t0 is not None and t0.a else None)
        elif n == "list_new":
            e.ty = list_of(a[1].ty if len(a) > 1 else None)
        elif n == "split":
            e.ty = list_of(STR)
        elif n in ("isdigit", "isalpha", "isalnum", "isspace", "isupper", "islower", "startswith",
                   "endswith"):
            e.ty = BOOL
        elif n in ("pop_last", "pop_at"):
            e.ty = t0.a[0] if t0 is not None and t0.k in ("list", "arr") else None
        elif n == "dget":
            e.ty = t0.a[1] if t0 is not None and t0.k == "dict" else None
        elif n == "dkeys":
            e.ty = list_of(t0.a[0]) if t0 is not None and t0.k == "dict" else None
        elif n == "dvalues":
            e.ty = list_of(t0.a[1]) if t0 is not None and t0.k == "dict" else None
        elif n == "chr":
            e.ty = CHAR
        elif n == "append" and t0 is not None and t0.k in ("list", "set") and len(a) > 1:
            if t0.a[0] is None:
                t0.a[0] = self.wd(a[1].ty)
            else:
                fill(t0.a[0], a[1].ty)
            e.ty = VOID
        elif n == "sadd" and t0 is not None and t0.k == "set" and len(a) > 1 and t0.a[0] is None:
            t0.a[0] = self.wd(a[1].ty)
            e.ty = VOID
        else:
            e.ty = None
        if n in ("dget", "ddel") and len(a) > 1 and t0 is not None and t0.k == "dict" and t0.a[0] is not None:
            a[1] = self.coerce(a[1], t0.a[0])
        # char literal coercion for list/set element operations
        if n in ("append", "insert", "sadd", "remove_value", "index") and a and a[0].ty is not None and \
                a[0].ty.k in ("list", "set", "arr") and a[0].ty.a[0] is not None:
            for i in range(1, len(a)):
                a[i] = self.coerce(a[i], a[0].ty.a[0])
        if n == "find" and len(a) > 1 and a[0].ty is not None and a[0].ty.k == "str":
            pass
        return e

    def e_New(self, e):
        e.args = [self.ex(a) for a in e.args]
        if e.cls in self.classes:
            e.ty = cls_of(e.cls)
            self.fix_args(self.classes[e.cls].ctor, e.args)
        else:
            e.ty = ANY
        return e

    def e_NewArr(self, e):
        e.dims = [self.ex(d) if d is not None else None for d in e.dims]
        t = e.elem
        for _ in e.dims:
            t = arr_of(t)
        e.ty = t
        return e

    def e_Call(self, e):
        fn = e.fn
        # ── plain function / class call
        if fn.k == "Name":
            if self.lookup(fn.id) is None:
                if fn.id in self.classes:
                    r = N("New", cls=fn.id, args=e.args)
                    return self.e_New(r)
                if fn.id in self.funcs:
                    f = self.funcs[fn.id]
                    e.args = [self.ex(a) for a in e.args]
                    self.fix_args(f, e.args)
                    e.ty = f.ret if f.ret is not None else getattr(f, "ret_inf", None)
                    return e
                # method of the current class called without `this`
                if self.cur_class is not None:
                    m = self.method_of(self.cur_class, fn.id)
                    if m is not None:
                        e.fn = N("Attr", obj=N("This") if not m.static else N("Name", id=self.cur_class.name),
                                 name=fn.id)
                        e.fn.obj.ty = cls_of(self.cur_class.name)
                        return self.e_Call(e)
            e.args = [self.ex(a) for a in e.args]
            return e
        if fn.k == "Attr":
            obj = fn.obj
            name = fn.name
            # static method through class name
            if obj.k == "Name" and obj.id in self.classes and self.lookup(obj.id) is None:
                cl = self.classes[obj.id]
                e.args = [self.ex(a) for a in e.args]
                m = self.method_of(cl, name)
                if m is not None:
                    self.fix_args(m, e.args)
                    e.ty = m.ret if m.ret is not None else getattr(m, "ret_inf", None)
                return e
            if obj.k == "Super":
                e.args = [self.ex(a) for a in e.args]
                return e
            obj = self.ex(obj)
            fn.obj = obj
            e.args = [self.ex(a) for a in e.args]
            t = obj.ty
            if t is not None and t.k == "class" and t.a[0] in self.classes:
                m = self.method_of(self.classes[t.a[0]], name)
                if m is not None:
                    self.fix_args(m, e.args)
                    e.ty = m.ret if m.ret is not None else getattr(m, "ret_inf", None)
                return e
            r = self.canon_method(e, obj, name, e.args)
            if r is not None:
                return r
            return e
        e.args = [self.ex(a) for a in e.args]
        return e

    def canon_method(self, e, obj, name, a):
        t = obj.ty
        k = t.k if t is not None else None
        I = lambda nm, *args: self.type_intr(intr(nm, *args))
        n = len(a)
        src = self.src
        # ---- universal / ambiguous names, resolved by receiver kind
        if name in ("length", "size", "len") and n == 0:
            return I("len", obj)
        if name == "empty" and n == 0:
            r = N("Bin", op="==", l=I("len", obj), r=num(0))
            r.ty = BOOL
            return r
        if name == "toString" and n == 0:
            return self.tostr(obj)
        if name == "equals" and n == 1:
            r = N("Bin", op="==", l=obj, r=a[0])
            r.ty = BOOL
            return r
        if k in ("str", "char") or (k is None and name in (
                "toUpperCase", "toLowerCase", "upper", "lower", "strip", "trim", "startsWith", "endsWith",
                "startswith", "endswith", "substring", "substr", "charAt", "split", "replaceAll",
                "isdigit", "isalpha")):
            return self.canon_str(e, obj, name, a, I)
        if k in ("list", "arr") or (k is None and name in (
                "push_back", "append", "push", "pop_back", "addLast", "unshift", "shift", "reverse",
                "extend", "addAll", "insert")):
            return self.canon_list(e, obj, name, a, I)
        if k == "dict" or (k is None and name in ("containsKey", "getOrDefault", "put", "keySet")):
            return self.canon_dict(e, obj, name, a, I)
        if k == "set" or (k is None and name in ("add", "discard")):
            return self.canon_set(e, obj, name, a, I)
        return None

    def canon_str(self, e, obj, name, a, I):
        n = len(a)
        m = {"toUpperCase": "upper", "upper": "upper", "toLowerCase": "lower", "lower": "lower",
             "strip": "strip", "trim": "strip", "isdigit": "isdigit", "isalpha": "isalpha",
             "isalnum": "isalnum", "isspace": "isspace", "isupper": "isupper", "islower": "islower"}
        if name in m and n == 0:
            return I(m[name], obj)
        if name == "split":
            return I("split", obj, *a)
        if name == "replace" and n == 2 and self.src == "javascript":
            return I("replace_first", obj, a[0], a[1])
        if name in ("replace", "replaceAll") and n == 2:
            return I("replace", obj, a[0], a[1])
        if name in ("startswith", "startsWith") and n == 1:
            return I("startswith", obj, a[0])
        if name in ("endswith", "endsWith") and n == 1:
            return I("endswith", obj, a[0])
        if name in ("find", "indexOf") and n == 1:
            return I("find", obj, a[0])
        if name in ("charAt", "at") and n == 1:
            r = N("Index", obj=obj, idx=a[0])
            r.ty = CHAR
            return r
        if name in ("substring", "slice") and n in (1, 2):
            r = N("Slice", obj=obj, lo=a[0], hi=a[1] if n == 2 else None)
            r.ty = STR
            return r
        if name == "substr" and n in (1, 2):
            hi = None
            if n == 2:
                if a[0].k == "Num" and a[1].k == "Num" and not a[0].isf and not a[1].isf:
                    hi = num(int(a[0].v) + int(a[1].v))
                    hi.ty = INT
                elif a[0].k == "Num" and a[0].v == "0":
                    hi = a[1]
                else:
                    hi = N("Bin", op="+", l=a[0], r=a[1])
                    hi.ty = INT
            r = N("Slice", obj=obj, lo=a[0], hi=hi)
            r.ty = STR
            return r
        if name in ("contains", "includes") and n == 1:
            r = N("Bin", op="in", l=a[0], r=obj)
            r.ty = BOOL
            return r
        if name == "join" and n == 1:
            return I("join", obj, a[0])
        if name in ("repeat",) and n == 1:
            return I("repeat", obj, a[0])
        if name == "count" and n == 1:
            return I("str_count", obj, a[0])
        if name in ("push_back", "append") and n == 1:
            v = a[0]
            if v.ty is not None and v.ty.k != "str" and not (v.ty.k == "char"):
                v = self.tostr(v)
            r = N("Assign", target=obj, op="+=", value=v)
            r.ty = None
            return r
        if name == "reverse" and n == 0:
            return I("reversed_copy", obj)
        if name == "insert" and n == 2 and a[0].k == "Num" and a[0].v == "0":
            v = a[1] if (a[1].ty is not None and a[1].ty.k == "str") else self.tostr(a[1])
            b = N("Bin", op="+", l=v, r=obj)
            b.ty = STR
            return N("Assign", target=obj, op="=", value=b)
        if name == "setLength" and n == 1:
            return N("Assign", target=obj, op="=", value=N("Str", v="", char=False))
        return None

    def canon_list(self, e, obj, name, a, I):
        n = len(a)
        if name in ("map", "filter") and n == 1 and a[0].k == "Lambda" and len(a[0].params) == 1:
            lam = a[0]
            v = lam.params[0]
            if name == "map":
                lc = N("ListComp", elt=lam.body, var=v, it=obj, cond=None)
            else:
                lc = N("ListComp", elt=N("Name", id=v), var=v, it=obj, cond=lam.body)
            return self.e_ListComp(lc)
        if name in ("append", "push", "push_back", "addLast", "offer", "add") and n == 1 or \
                (name == "push" and n == 1):
            if obj.ty is not None and obj.ty.k in ("list", "arr") and obj.ty.a[0] is None:
                obj.ty.a[0] = self.wd(a[0].ty)
            return I("append", obj, a[0])
        if name == "add" and n == 2:
            return I("insert", obj, a[0], a[1])
        if name == "insert" and n == 2 and not str(a[0].k) == "Call":
            return I("insert", obj, a[0], a[1])
        if name == "unshift" and n == 1:
            return I("insert", obj, num(0), a[0])
        if name in ("pop", "pop_back", "removeLast") and n == 0:
            return I("pop_last", obj)
        if name == "shift" and n == 0:
            return I("pop_at", obj, num(0))
        if name == "pop" and n == 1:
            return I("pop_at", obj, a[0])
        if name == "erase" and n == 1:
            x = a[0]
            if x.k == "Bin" and x.op == "+" and x.l.k == "Call" and x.l.fn.k == "Attr" and x.l.fn.name == "begin":
                return I("pop_at", obj, x.r)
            if x.k == "Call" and x.fn.k == "Attr" and x.fn.name == "begin":
                return I("pop_at", obj, num(0))
            raise Unsupported("erase form")
        if name == "remove" and n == 1:
            if self.src == "java" and a[0].ty is not None and a[0].ty.k == "int" and \
                    obj.ty is not None and obj.ty.a and obj.ty.a[0] is not None and obj.ty.a[0].k != "str":
                return I("pop_at", obj, a[0])
            return I("remove_value", obj, a[0])
        if name == "sort" and n == 0:
            return I("sort", obj)
        if name == "reverse" and n == 0:
            return I("reverse_inplace", obj)
        if name == "clear" and n == 0:
            return I("clear", obj)
        if name in ("extend", "addAll") and n == 1:
            return I("extend", obj, a[0])
        if name in ("index", "indexOf") and n == 1:
            return I("index", obj, a[0])
        if name == "count" and n == 1:
            return I("list_count", obj, a[0])
        if name in ("contains", "includes") and n == 1:
            r = N("Bin", op="in", l=a[0], r=obj)
            r.ty = BOOL
            return r
        if name in ("get", "at") and n == 1:
            r = N("Index", obj=obj, idx=a[0])
            r.ty = obj.ty.a[0] if obj.ty is not None and obj.ty.a else None
            return r
        if name == "set" and n == 2:
            r = N("Assign", target=N("Index", obj=obj, idx=a[0]), op="=", value=a[1])
            r.target.ty = obj.ty.a[0] if obj.ty is not None and obj.ty.a else None
            return r
        if name == "front" and n == 0:
            r = N("Index", obj=obj, idx=num(0))
            r.ty = obj.ty.a[0] if obj.ty is not None and obj.ty.a else None
            return r
        if name == "back" and n == 0:
            r = N("Index", obj=obj, idx=num(-1))
            r.ty = obj.ty.a[0] if obj.ty is not None and obj.ty.a else None
            return r
        if name == "copy" and n == 0:
            return I("list_copy", obj)
        if name == "join" and n == 1:
            et = obj.ty.a[0] if obj.ty is not None and obj.ty.a else None
            if et is not None and et.k != "str":
                obj = I("strs", obj)
            return I("join", a[0], obj)
        if name == "slice" and n in (1, 2):
            r = N("Slice", obj=obj, lo=a[0], hi=a[1] if n == 2 else None)
            r.ty = obj.ty
            return r
        return None

    def canon_dict(self, e, obj, name, a, I):
        n = len(a)
        if name in ("get", "getOrDefault") and n in (1, 2):
            return I("dget", obj, *a)
        if name in ("put", "set") and n == 2:
            r = N("Assign", target=N("Index", obj=obj, idx=a[0]), op="=", value=a[1])
            if obj.ty is not None and obj.ty.k == "dict":
                if obj.ty.a[0] is None:
                    obj.ty.a[0] = a[0].ty
                if obj.ty.a[1] is None:
                    obj.ty.a[1] = a[1].ty
            return r
        if name in ("containsKey", "has", "count", "contains") and n == 1:
            r = N("Bin", op="in", l=a[0], r=obj)
            r.ty = BOOL
            return r
        if name in ("keys", "keySet") and n == 0:
            return I("dkeys", obj)
        if name in ("values",) and n == 0:
            return I("dvalues", obj)
        if name in ("items", "entrySet") and n == 0:
            return I("ditems", obj)
        if name in ("pop", "remove", "erase", "delete") and n == 1:
            return I("ddel", obj, a[0])
        if name == "entries" and n == 0:
            return I("ditems", obj)
        if name == "clear" and n == 0:
            return I("clear", obj)
        if name == "at" and n == 1:
            r = N("Index", obj=obj, idx=a[0])
            r.ty = obj.ty.a[1] if obj.ty is not None and len(obj.ty.a) > 1 else None
            return r
        return None

    def canon_set(self, e, obj, name, a, I):
        n = len(a)
        if name in ("add", "insert") and n == 1:
            return I("sadd", obj, a[0])
        if name in ("remove", "discard", "erase", "delete") and n == 1:
            return I("sdel", obj, a[0])
        if name in ("contains", "has", "count") and n == 1:
            r = N("Bin", op="in", l=a[0], r=obj)
            r.ty = BOOL
            return r
        if name == "clear" and n == 0:
            return I("clear", obj)
        return None

    # ───────────────────────── wrap-up ───────────────────────────────────
    def finish(self):
        prog = self.prog
        for f in prog.funcs:
            self.finish_fn(f)
        for c in prog.classes:
            for m in c.methods + ([c.ctor] if c.ctor else []):
                self.finish_fn(m)
            for f in c.fields:
                if f.ty is None and f.init is not None:
                    f.ty = f.init.ty
        for g in prog.globals:
            pass

    def finish_fn(self, f):
        if f.ret is None and not f.ctor:
            r = getattr(f, "ret_inf", None)
            f.ret = r if r is not None else VOID
            # a function whose only returns are `return;` stays void
        for p in f.params:
            pass


def analyze(prog, src, tgt):
    return Sema(prog, src, tgt).run()
