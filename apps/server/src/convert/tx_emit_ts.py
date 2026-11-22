"""
tx_emit_ts -- TypeScript = the JavaScript generator + type annotations.
"""
import re
from tx_core import N, VOID
from tx_parse import default_for
from tx_emit import JsE, ATOM, TERN


class TsE(JsE):
    def ts(self, ty, default="any"):
        if ty is None:
            return default
        k = ty.k
        if k in ("int", "float"):
            return "number"
        if k in ("str", "char"):
            return "string"
        if k == "bool":
            return "boolean"
        if k == "void":
            return "void"
        if k in ("list", "arr"):
            inner = self.ts(ty.a[0]) if ty.a else "any"
            return ("(%s)[]" % inner) if ("|" in inner or "=>" in inner) else inner + "[]"
        if k == "dict":
            return "Map<%s, %s>" % (self.ts(ty.a[0]), self.ts(ty.a[1]))
        if k == "set":
            return "Set<%s>" % self.ts(ty.a[0])
        if k == "class":
            return ty.a[0]
        return default

    def run(self):
        out = JsE.run(self)
        # type the small runtime helpers that the generator may have added
        out = out.replace("const _data = require('fs')", "declare const require: any;\ndeclare const process: any;\nconst _data: string = require('fs')")
        out = out.replace("let _pos = 0;", "let _pos: number = 0;")
        out = out.replace("function _line() {", "function _line(): string {")
        out = out.replace("function _tok() {", "function _tok(): string {")
        out = out.replace("function _gcd(a, b)", "function _gcd(a: number, b: number): number")
        out = out.replace("function _fact(n)", "function _fact(n: number): number")
        out = out.replace("function _by(k, rev)", "function _by(k: (v: any) => any, rev: boolean)")
        out = out.replace("return (a, b) => {", "return (a: any, b: any) => {")
        out = out.replace("const _data = ", "const _data = ") if False else out
        if "process.stdout" in out and "declare const process" not in out:
            out = "declare const process: any;\n" + out
        return out

    def st_VarDecl(self, s):
        if getattr(s, "hoisted", False) and s.init is None:
            d = default_for(s.ty) if s.ty is not None else None
            self.w("let %s%s%s;" % (self.id(s.name), ": " + self.ts(s.ty) if s.ty is not None else "",
                                  " = " + self.raw(d) if d is not None and d.k != "Null" else ""))
            return
        init = s.init
        if init is None:
            d = default_for(s.ty) if s.ty is not None else None
            if d is not None and d.k != "Null":
                init = d
        ann = ": " + self.ts(s.ty) if (s.ty is not None and self.ts(s.ty) != "any") else (
            ": any" if init is None else "")
        if init is not None and init.k in ("ListLit", "DictLit", "SetLit") and s.ty is not None:
            ann = ": " + self.ts(s.ty)
        self.w("%s %s%s%s;" % (self.decl_kw(s), self.id(s.name), ann, " = " + self.raw(init) if init is not None else ""))

    def params(self, f):
        out = []
        for p in f.params:
            out.append("%s: %s%s" % (self.id(p.name), self.ts(p.ty), " = " + self.raw(p.default) if p.default is not None else ""))
        return ", ".join(out)

    def st_Func(self, f, in_class=False):
        ps = self.params(f)
        ret = "" if f.ctor else ": " + self.ts(f.ret if f.ret is not None else VOID, "void")
        if in_class:
            name = "constructor" if f.ctor else self.id(f.name)
            self.w("%s%s(%s)%s {" % ("static " if f.static else "", name, ps, ret))
        else:
            self.w("function %s(%s)%s {" % (self.id(f.name), ps, ret))
        self.sub(f.body)
        self.w("}")

    def st_Class(self, c):
        self.cur_class = c
        self.w("class %s%s {" % (c.name, " extends " + c.base if c.base else ""))
        self.ind += 1
        for f in c.fields:
            if f.static:
                self.w("static %s: %s%s;" % (self.id(f.name), self.ts(f.ty), " = " + self.raw(f.init) if f.init is not None else ""))
            else:
                self.w("%s: %s;" % (self.id(f.name), self.ts(f.ty)))
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
