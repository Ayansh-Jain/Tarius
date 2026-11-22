"""
tx_emit_c -- C++ and Java code generators.
"""
import re
from tx_core import N, Ty, INT, FLOAT, STR, BOOL, CHAR, VOID, ANY, Unsupported
from tx_parse import default_for, intr, num
from tx_sema import walk
from tx_emit import (Em, esc, parse_spec, fold_add, BIN_PREC, TERN, OR, AND, NOT, EQ, REL, BOR, BXOR,
                     BAND, SHIFT, ADD, MUL, UN, POW, ATOM)

MUT_INTR = {"sort_key", "append", "insert", "pop_last", "pop_at", "remove_value", "sort", "reverse_inplace", "clear",
            "extend", "ddel", "sadd", "sdel", "del"}


def root_name(e):
    while e is not None and e.k in ("Index", "Attr", "Slice"):
        e = e.obj
    return e.id if e is not None and e.k == "Name" else None


def rooted_at_this(e):
    while e is not None and e.k in ("Index", "Attr", "Slice"):
        if e.k == "Attr" and e.obj.k == "This":
            return True
        e = e.obj
    return False


def mutates_this(body, const_ok):
    found = []

    def f(n):
        k = n.k
        if k == "Assign" and rooted_at_this(n.target):
            found.append(1)
        elif k == "IncDec" and rooted_at_this(n.e):
            found.append(1)
        elif k == "Intr" and n.name in MUT_INTR and n.args and rooted_at_this(n.args[0]):
            found.append(1)
        elif k == "Swap" and (rooted_at_this(n.a) or rooted_at_this(n.b)):
            found.append(1)
        elif k == "Call" and n.fn.k == "Attr" and (n.fn.obj.k == "This" or rooted_at_this(n.fn.obj)):
            if not const_ok.get(n.fn.name, False):
                found.append(1)
    walk(body, f)
    return bool(found)


def mutated_names(body, const_names=frozenset()):
    out = set()

    def f(n):
        if n.k == "Assign":
            r = root_name(n.target)
            if r and n.target.k != "Name":
                out.add(r)
        elif n.k == "Intr" and n.name in MUT_INTR and n.args:
            r = root_name(n.args[0])
            if r:
                out.add(r)
        elif n.k == "Swap":
            for t in (n.a, n.b):
                r = root_name(t)
                if r and t.k != "Name":
                    out.add(r)
        elif n.k == "Call":
            if n.fn.k == "Attr" and n.fn.name not in const_names:
                r = root_name(n.fn.obj)
                if r:
                    out.add(r)
            for a in n.args:
                if a.k == "Name":
                    out.add(a.id)
        elif n.k == "ForEach" and n.it.k == "Name":
            pass
        elif n.k == "IncDec":
            r = root_name(n.e)
            if r:
                out.add(r)
    walk(body, f)
    return out


class CBase(Em):
    STATIC = True
    boxed = 0
    loopvars = set()
    alias = {}

    def render_key(self, lam, name):
        saved = dict(self.alias)
        self.alias = dict(saved)
        self.alias[lam.params[0]] = name
        try:
            return self.x(lam.body, REL + 1)
        finally:
            self.alias = saved

    def prep(self):
        p = self.prog
        big = []
        mul = []

        def chk(n):
            if n.k == "Num" and not n.isf:
                try:
                    if abs(int(n.v)) > 2147483647:
                        big.append(1)
                except ValueError:
                    pass
            elif n.k == "Bin" and n.op == "**":
                mul.append(1)
            elif n.k == "Bin" and n.op == "*" and (n.l.k in ("Call", "Intr") or n.r.k in ("Call", "Intr")) and \
                    (n.ty is not None and n.ty.k == "int"):
                mul.append(1)
            elif n.k == "Assign" and n.op == "*=":
                mul.append(1)
            elif n.k == "Intr" and n.name == "factorial":
                mul.append(1)
        walk(p.main, chk)
        for f in p.funcs:
            walk(f.body, chk)
        for g in p.globals:
            walk(g, chk)
        for c in p.classes:
            for m in c.methods + ([c.ctor] if c.ctor else []):
                walk(m.body, chk)
        self.wide = bool(big) or (self.src in ("python", "javascript") and bool(mul))

    # shared statements -----------------------------------------------------
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

    def st_Return(self, s):
        self.w("return%s;" % (" " + self.raw(s.e) if s.e is not None else ""))

    def st_ExprS(self, s):
        self.w(self.stmt_expr(s.e) + ";")

    def stmt_expr(self, e):
        return self.raw(e)

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

    def loop_ty(self, s):
        if s.vty is not None and s.vty.k == "float":
            raise Unsupported("float loop variable")
        for b in (s.lo, s.hi):
            if b.k == "Num" and b.v.lstrip("-").isdigit() and abs(int(b.v)) > 2147483647:
                return self.IT
        return self.IT if (self.is_java and self.wide) else "int"

    def st_ForRange(self, s):
        v = self.id(s.var)
        st = s.step
        neg = st.k == "Num" and st.v.startswith("-")
        cmp = (">=" if s.incl else ">") if neg else ("<=" if s.incl else "<")
        if st.k == "Num" and st.v in ("1", "-1"):
            upd = v + ("--" if neg else "++")
        else:
            upd = "%s += %s" % (v, self.raw(st))
        self.w("for (%s %s = %s; %s %s %s; %s) {" % (self.loop_ty(s), v, self.raw(s.lo), v, cmp,
                                                    self.x(s.hi, REL + 1), upd))
        self.sub(s.body)
        self.w("}")

    def inline(self, s):
        k = s.k
        if k == "VarDecl":
            return "%s %s = %s" % (self.tn(s.ty, True), self.id(s.name), self.raw(s.init))
        if k == "Assign":
            return self.assign_str(s)
        if k == "ExprS":
            return self.raw(s.e)
        raise Unsupported("for-loop clause")

    def st_CFor(self, s):
        init = ", ".join(self.inline(i) for i in s.init)
        if len(s.init) > 1 and all(i.k == "VarDecl" for i in s.init):
            init = "%s %s" % (self.tn(s.init[0].ty, True),
                              ", ".join("%s = %s" % (self.id(i.name), self.raw(i.init)) for i in s.init))
        cond = self.raw(s.cond) if s.cond is not None else ""
        upd = ", ".join(self.inline(u) for u in s.update)
        self.w("for (%s; %s; %s) {" % (init, cond, upd))
        self.sub(s.body)
        self.w("}")

    def st_Swap(self, s):
        self.w("swap(%s, %s);" % (self.raw(s.a), self.raw(s.b))) if self.STATIC and self.is_cpp else \
            self.swap_java(s)

    def st_Assign(self, s):
        self.w(self.assign_str(s) + ";")

    def st_Assert(self, s):
        self.w("assert(%s);" % self.raw(s.cond))

    def st_Switch(self, s):
        k = s.e.ty.k if s.e.ty is not None else None
        if k not in ("int", "char") and not (self.is_java and k == "str"):
            # if-chain for types a C switch cannot handle
            subj = self.x(s.e, EQ + 1)
            first = True
            for c in s.cases:
                conds = " || ".join(self.eq_expr(subj, v) for v in c.vals)
                self.w("%s (%s) {" % ("if" if first else "} else if", conds))
                self.sub(c.body)
                first = False
            if s.default:
                if first:
                    self.w("{")
                else:
                    self.w("} else {")
                self.sub(s.default)
            if not first or s.default:
                self.w("}")
            return
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

    def eq_expr(self, subj, v):
        if self.is_java and v.ty is not None and v.ty.k == "str":
            return "%s.equals(%s)" % (self.x(v, ATOM), subj)
        return "%s == %s" % (subj, self.x(v, EQ + 1))

    # shared expression bits ------------------------------------------------
    def ex_Bool(self, e):
        return "true" if e.v else "false"

    def ex_Null(self, e):
        if self.is_cpp:
            raise Unsupported("null object references (needs pointers)")
        return "null"

    def ex_Un(self, e):
        if e.op == "not":
            return "!" + self.x(e.e, UN), UN
        return e.op + self.x(e.e, UN), UN

    def ex_IncDec(self, e):
        t = self.raw(e.e)
        return (e.op + t if e.pre else t + e.op), UN

    def ex_Assign(self, e):
        return self.assign_str(e), TERN

    def ex_Tern(self, e):
        return "%s ? %s : %s" % (self.x(e.c, TERN + 1), self.x(e.a, TERN), self.x(e.b, TERN)), TERN

    def ex_Lambda(self, e):
        raise Unsupported("lambda")

    def ex_ListComp(self, e):
        raise Unsupported("list comprehension in this position")

    def ex_Num(self, e):
        v = e.v
        if not e.isf and v.lstrip("-").isdigit() and (abs(int(v)) > 2147483647 or (
                self.is_java and self.wide and getattr(self, "boxed", 0))):
            v += "LL" if self.is_cpp else "L"
        if v.startswith("-"):
            return v, UN
        return v

    def ex_Name(self, e):
        if e.id in self.alias:
            return self.alias[e.id]
        return self.id(e.id)

    def ex_This(self, e):
        return "this"

    def num_t(self, e):
        return e.ty is not None and e.ty.k in ("int", "float", "char")

    def isint(self, e):
        return e.ty is not None and e.ty.k in ("int", "char")

    def isflt(self, e):
        return e.ty is not None and e.ty.k == "float"

    # helpers shared by both -------------------------------------------------
    def default_val(self, ty):
        d = default_for(ty)
        return d

    def finalize_main_body(self):
        pass


# ═════════════════════════════════════════════════════════════════════════
#  C++
# ═════════════════════════════════════════════════════════════════════════
HELPERS = {
    "str": 'template<class T> string _str(const T& v) { ostringstream o; o << v; return o.str(); }\ninline string _str(bool b) { return b ? "true" : "false"; }',
    "line": 'inline string _line() { string s; getline(cin, s); if (!s.empty() && s[s.size()-1] == \'\\r\') s.erase(s.size()-1); return s; }',
    "tok": 'template<class T> T _tok() { T v; cin >> v; return v; }',
    "strip": 'inline string _strip(const string& s) { size_t a = s.find_first_not_of(" \\t\\r\\n"); if (a == string::npos) return ""; size_t b = s.find_last_not_of(" \\t\\r\\n"); return s.substr(a, b - a + 1); }',
    "split": 'inline vector<string> _split(const string& s) { vector<string> r; istringstream i(s); string t; while (i >> t) r.push_back(t); return r; }\ninline vector<string> _split(const string& s, const string& d) { vector<string> r; size_t p = 0, q; while ((q = s.find(d, p)) != string::npos) { r.push_back(s.substr(p, q - p)); p = q + d.size(); } r.push_back(s.substr(p)); return r; }',
    "join": 'inline string _join(const string& d, const vector<string>& v) { string r; for (size_t i = 0; i < v.size(); i++) { if (i) r += d; r += v[i]; } return r; }',
    "replace1": 'inline string _replace1(string s, const string& a, const string& b) { size_t p = s.find(a); if (p != string::npos) s.replace(p, a.size(), b); return s; }',
    "replace": 'inline string _replace(string s, const string& a, const string& b) { if (a.empty()) return s; size_t p = 0; while ((p = s.find(a, p)) != string::npos) { s.replace(p, a.size(), b); p += b.size(); } return s; }',
    "upper": 'inline string _upper(string s) { for (size_t i = 0; i < s.size(); i++) s[i] = toupper(s[i]); return s; }',
    "lower": 'inline string _lower(string s) { for (size_t i = 0; i < s.size(); i++) s[i] = tolower(s[i]); return s; }',
    "repeat": 'inline string _repeat(const string& s, int n) { string r; for (int i = 0; i < n; i++) r += s; return r; }',
    "sorted": 'template<class T> vector<T> _sorted(vector<T> v) { sort(v.begin(), v.end()); return v; }',
    "sorted_rev": 'template<class T> vector<T> _sorted_rev(vector<T> v) { sort(v.begin(), v.end(), greater<T>()); return v; }',
    "reversed": 'template<class T> vector<T> _reversed(vector<T> v) { reverse(v.begin(), v.end()); return v; }',
    "range": 'inline vector<IT> _range(IT a, IT b, IT s = 1) { vector<IT> r; if (s > 0) for (IT i = a; i < b; i += s) r.push_back(i); else for (IT i = a; i > b; i += s) r.push_back(i); return r; }',
    "pop": 'template<class T> T _pop(vector<T>& v) { T x = v.back(); v.pop_back(); return x; }',
    "pop_at": 'template<class T> T _pop_at(vector<T>& v, int i) { T x = v[i]; v.erase(v.begin() + i); return x; }',
    "fdiv": 'template<class T, class U> T _fdiv(T a, U b) { T q = a / b; if ((a % b != 0) && ((a < 0) != (b < 0))) q--; return q; }',
    "keys": 'template<class K, class V> vector<K> _keys(const map<K, V>& m) { vector<K> r; for (typename map<K, V>::const_iterator it = m.begin(); it != m.end(); ++it) r.push_back(it->first); return r; }',
    "values": 'template<class K, class V> vector<V> _values(const map<K, V>& m) { vector<V> r; for (typename map<K, V>::const_iterator it = m.begin(); it != m.end(); ++it) r.push_back(it->second); return r; }',
    "endswith": 'inline bool _endswith(const string& s, const string& x) { return s.size() >= x.size() && s.compare(s.size() - x.size(), x.size(), x) == 0; }',
    "count": 'inline int _scount(const string& s, const string& x) { int c = 0; size_t p = 0; while (!x.empty() && (p = s.find(x, p)) != string::npos) { c++; p += x.size(); } return c; }',
    "ipow": 'template<class T> T _ipow(T b, T e) { T r = 1; while (e > 0) { if (e & 1) r *= b; b *= b; e >>= 1; } return r; }',
    "gcd": 'template<class T> T _gcd(T a, T b) { return b == 0 ? (a < 0 ? -a : a) : _gcd(b, a % b); }',
    "fact": 'inline IT _fact(IT n) { IT r = 1; for (IT i = 2; i <= n; i++) r *= i; return r; }',
    "fmt": 'template<class T> string _fmt(T v, int w, int p, int al, bool zero, char t) { ostringstream o; if (t == \'f\') o << fixed << setprecision(p < 0 ? 6 : p); else if (t == \'e\') o << scientific << setprecision(p < 0 ? 6 : p); else if (t == \'x\') o << hex; if (w > 0) { if (zero) o << setfill(\'0\') << internal; else if (al == 1) o << left; else o << right; o << setw(w); } o << v; return o.str(); }',
    "repr": 'template<class T> string _r1(const T& v) { ostringstream o; o << v; return o.str(); }\ninline string _r1(const string& s) { return "\'" + s + "\'"; }\ninline string _r1(char c) { return string("\'") + c + "\'"; }\ntemplate<class T> string _repr(const vector<T>& v) { string r = "["; for (size_t i = 0; i < v.size(); i++) { if (i) r += ", "; r += _r1(v[i]); } return r + "]"; }',
    "strs": 'template<class T> vector<string> _strs(const vector<T>& v) { vector<string> r; for (size_t i = 0; i < v.size(); i++) { ostringstream o; o << v[i]; r.push_back(o.str()); } return r; }',
    "sort_str": 'inline string _sort_str(string s) { sort(s.begin(), s.end()); return s; }',
    "ints": 'inline vector<IT> _ints(const vector<string>& v) { vector<IT> r; for (size_t i = 0; i < v.size(); i++) r.push_back(stoll(v[i])); return r; }',
    "floats": 'inline vector<double> _floats(const vector<string>& v) { vector<double> r; for (size_t i = 0; i < v.size(); i++) r.push_back(stod(v[i])); return r; }',
    "concat": 'template<class T> vector<T> _concat(vector<T> a, const vector<T>& b) { a.insert(a.end(), b.begin(), b.end()); return a; }',
    "extend": 'template<class T> void _extend(vector<T>& a, const vector<T>& b) { vector<T> t(b); a.insert(a.end(), t.begin(), t.end()); }',
    "fin": 'struct _Fin { function<void()> f; _Fin(function<void()> g) : f(g) {} ~_Fin() { f(); } };',
    "chars": 'inline vector<char> _chars(const string& s) { return vector<char>(s.begin(), s.end()); }',
    "isalldigit": 'inline bool _alldigit(const string& s) { if (s.empty()) return false; for (size_t i = 0; i < s.size(); i++) if (!isdigit(s[i])) return false; return true; }',
    "isallalpha": 'inline bool _allalpha(const string& s) { if (s.empty()) return false; for (size_t i = 0; i < s.size(); i++) if (!isalpha(s[i])) return false; return true; }',
}


class CppE(CBase):
    is_cpp = True
    protos = False
    is_java = False
    RES = {"alignas", "and", "asm", "auto", "bitand", "bitor", "bool", "break", "case", "catch", "char",
           "class", "compl", "const", "continue", "default", "delete", "do", "double", "else", "enum",
           "explicit", "export", "extern", "false", "float", "for", "friend", "goto", "if", "inline", "int",
           "long", "mutable", "namespace", "new", "not", "operator", "or", "private", "protected", "public",
           "register", "return", "short", "signed", "sizeof", "static", "struct", "switch", "template",
           "this", "throw", "true", "try", "typedef", "typename", "union", "unsigned", "using", "virtual",
           "void", "volatile", "while", "xor", "string", "vector", "map", "set", "list", "pair", "array",
           "queue", "stack", "deque", "bitset", "tuple", "function", "NULL", "main", "cin", "cout", "endl",
           "max", "min", "swap", "sort", "count", "find", "reverse", "replace", "distance", "remove", "pow",
           "abs", "sqrt", "floor", "ceil", "round", "log", "exp", "sin", "cos", "tan", "rand", "exit",
           "time", "index", "accumulate", "copy", "fill", "move", "next", "prev", "left", "right",
           "internal", "fixed", "hex", "y0", "y1", "j0", "j1", "gamma", "signal", "link", "div", "free",
           "data", "size", "equal", "all", "any", "none", "greater", "less", "plus", "minus", "hash"}

    def collect_temps(self):
        """(callee, argument index) pairs that are sometimes called with a temporary (rvalue)."""
        self.temps = set()
        p = self.prog

        def chk(n):
            args, key = None, None
            if n.k == "Call":
                args = n.args
                key = n.fn.id if n.fn.k == "Name" else (n.fn.name if n.fn.k == "Attr" else None)
            elif n.k == "New":
                args, key = n.args, n.cls
            if key is not None:
                for i, a in enumerate(args):
                    if a.k not in ("Name", "Attr", "Index", "This"):
                        self.temps.add((key, i))
        walk(p.main, chk)
        for f in p.funcs:
            walk(f.body, chk)
        for g in p.globals:
            walk(g, chk)
        for c in p.classes:
            for m in c.methods + ([c.ctor] if c.ctor else []):
                walk(m.body, chk)

    def compute_const(self):
        ms = [(c, m) for c in self.prog.classes for m in c.methods if not m.static]
        cand = {}
        for c, m in ms:
            cand.setdefault(m.name, True)
        changed = True
        while changed:
            changed = False
            for c, m in ms:
                if cand[m.name] and mutates_this(m.body, cand):
                    cand[m.name] = False
                    changed = True
        self.const_methods = {n for n, v in cand.items() if v}

    def run(self):
        self.prep()
        self.collect_temps()
        self.compute_const()
        p = self.prog
        self.IT = "long long" if self.wide else "int"
        self.virtuals = set()
        for c in p.classes:
            if c.base:
                for m in c.methods:
                    self.virtuals.add(m.name)
        body = []
        # classes, base first
        done, order = set(), []

        def add(c):
            if c.name in done:
                return
            done.add(c.name)
            if c.base in self.classes:
                add(self.classes[c.base])
            order.append(c)
        for c in p.classes:
            add(c)
        for c in getattr(p, "lead_comments", []):
            self.w("// " + c.text)
        for c in order:
            self.st_Class(c)
            self.w()
        # prototypes
        self.protos = len(p.funcs) > 1
        if len(p.funcs) > 1:
            for f in p.funcs:
                self.w(self.func_sig(f) + ";")
            self.w()
        self.stmts(p.globals)
        if p.globals:
            self.w()
        for f in p.funcs:
            self.st_Func(f)
            self.w()
        self.w("int main() {")
        if self.prints_bool():
            self.ind += 1
            self.w("cout << boolalpha;")
            self.ind -= 1
        self.sub(p.main)
        self.ind += 1
        self.w("return 0;")
        self.ind -= 1
        self.w("}")
        out = self.finish()
        hdr = ["#include <bits/stdc++.h>", "using namespace std;", ""]
        helpers = []
        order_h = ["str", "line", "tok", "strip", "split", "join", "replace", "replace1", "upper", "lower", "repeat",
                   "sorted", "sorted_rev", "reversed", "range", "pop", "pop_at", "fdiv", "keys", "values",
                   "endswith", "count", "ipow", "gcd", "fact", "fmt", "fin", "chars", "repr", "strs", "sort_str", "ints", "floats", "concat", "extend", "isalldigit", "isallalpha"]
        for h in order_h:
            if h in self.need:
                helpers.append(HELPERS[h].replace("IT", self.IT))
        if self.need & {"line", "tok", "str"}:
            pass
        return "\n".join(hdr + helpers) + ("\n\n" if helpers else "\n") + out

    def prints_bool(self):
        found = []

        def chk(n):
            if n.k == "Print" and any(i.ty is not None and i.ty.k == "bool" for i in n.items):
                found.append(1)
        walk(self.prog.main, chk)
        for f in self.prog.funcs:
            walk(f.body, chk)
        for c in self.prog.classes:
            for m in c.methods + ([c.ctor] if c.ctor else []):
                walk(m.body, chk)
        return bool(found)

    # types -------------------------------------------------------------
    def tn(self, ty, auto_ok=False):
        if ty is None:
            return "auto" if auto_ok else "int"
        k = ty.k
        if k == "int":
            return "long long" if ty.wide else self.IT
        if k == "float":
            return "double"
        if k == "str":
            return "string"
        if k == "bool":
            return "bool"
        if k == "char":
            return "char"
        if k == "void":
            return "void"
        if k in ("list", "arr"):
            return "vector<%s>" % self.tn(ty.a[0])
        if k == "dict":
            return "map<%s, %s>" % (self.tn(ty.a[0]), self.tn(ty.a[1]))
        if k == "set":
            return "set<%s>" % self.tn(ty.a[0])
        if k == "class":
            return ty.a[0]
        return "auto" if auto_ok else "int"

    def id(self, name):
        return name + "_" if name in self.RES else name

    def fid(self, name):
        return name + "_fn" if name in self.RES else name

    def cstr(self, s):
        return '"' + esc(s, '"') + '"'

    # statements -----------------------------------------------------------
    def st_VarDecl(self, s):
        name = self.id(s.name)
        ty = s.ty
        t = self.tn(ty, True)
        init = s.init
        if getattr(s, "static", False) and False:
            pass
        const = "const " if getattr(s, "const", False) and self.src in ("cpp",) and ty is not None and \
            ty.k in ("int", "float", "str", "bool", "char") else ""
        if init is None:
            if getattr(s, "hoisted", False) or self.ind == 0 or True:
                d = default_for(ty) if ty is not None and ty.k in ("int", "float", "bool", "char", "str") else None
                if d is not None and getattr(s, "hoisted", False):
                    self.w("%s %s = %s;" % (t, name, self.raw(d)))
                    return
            self.w("%s %s;" % (t, name))
            return
        if init.k == "New" and init.cls in self.classes:
            if init.args:
                self.w("%s %s(%s);" % (t, name, ", ".join(self.raw(a) for a in init.args)))
            else:
                self.w("%s %s;" % (t, name))
            return
        if init.k == "ListLit" and ty is not None and ty.k in ("list", "arr"):
            self.w("%s %s = {%s};" % (t, name, ", ".join(self.raw(i) for i in init.items)))
            return
        if init.k == "DictLit" and not init.pairs:
            self.w("%s %s;" % (t, name))
            return
        if init.k == "DictLit":
            self.w("%s %s = {%s};" % (t, name, ", ".join("{%s, %s}" % (self.raw(k), self.raw(v)) for k, v in init.pairs)))
            return
        if init.k == "SetLit":
            self.w("%s %s = {%s};" % (t, name, ", ".join(self.raw(i) for i in init.items)))
            return
        if init.k == "NewArr" and ty is not None:
            self.w("%s %s = %s;" % (t, name, self.raw(init)))
            return
        self.w("%s%s %s = %s;" % (const, t, name, self.raw(init)))

    def assign_str(self, s):
        t = self.raw(s.target)
        op = s.op
        v = s.value
        if op == "tdiv=":
            op = "/="
        if op == "//=":
            self.need_("fdiv")
            return "%s = _fdiv(%s, %s)" % (t, t, self.raw(v))
        if op == "**=":
            return "%s = %s" % (t, self.pow_expr(s.target, v, s.target.ty))
        if op == ">>>=":
            op = ">>="
        if op == "+=" and s.target.ty is not None and s.target.ty.k == "str" and v.k == "Str":
            pass
        # dict[k] += 1 in python-source semantics is fine because map::operator[] defaults to 0
        if op == "/=" and s.target.ty is not None and s.target.ty.k == "float":
            pass
        return "%s %s %s" % (t, op, self.raw(v))

    def pow_expr(self, l, r, ty):
        if ty is not None and ty.k == "int" and self.isint(l) and self.isint(r):
            self.need_("ipow")
            return "_ipow<%s>(%s, %s)" % (self.IT, self.raw(l), self.raw(r))
        c = "pow(%s, %s)" % (self.raw(l), self.raw(r))
        if ty is not None and ty.k == "int":
            return "(%s)%s" % (self.IT, c)
        return c

    def impure(self, e):
        found = []
        walk(e, lambda n: found.append(1) if n.k in ("Call", "New", "Input") or (
            n.k == "Intr" and n.name in ("pop_last", "pop_at", "ddel")) else None)
        return bool(found)

    def st_Print(self, s):
        # C++ leaves the evaluation order of `<<` operands unspecified: sequence side effects explicitly
        if sum(1 for it in s.items if self.impure(it)) >= 2:
            for i, it in enumerate(s.items):
                if i and s.sep:
                    self.w("cout << %s;" % self.cstr(s.sep))
                self.w("cout << %s;" % self.print_item(it))
            if s.end == "\n":
                self.w("cout << endl;")
            elif s.end:
                self.w("cout << %s;" % self.cstr(s.end))
            return
        parts = []
        for i, it in enumerate(s.items):
            if i and s.sep:
                parts.append(self.cstr(s.sep))
            parts.append(self.print_item(it))
        if s.end == "\n":
            parts.append("endl")
        elif s.end:
            parts.append(self.cstr(s.end))
        if not parts:
            return
        self.w("cout << " + " << ".join(parts) + ";")

    def print_item(self, it):
        t = it.ty
        if t is not None and t.k in ("list", "arr", "dict", "set"):
            raise Unsupported("printing a whole collection")
        if it.k == "Str":
            return self.cstr(it.v) if not it.char else "'%s'" % esc(it.v, "'")
        if it.k in ("Bin", "Tern") and it.op in ("and", "or") if it.k == "Bin" else False:
            return self.x(it, ATOM)
        return self.x(it, SHIFT + 1)

    def st_ReadStmt(self, s):
        for t, ty, d in zip(s.targets, s.tys, s.decl):
            if d:
                self.w("%s %s;" % (self.tn(ty), self.raw(t)))
        self.w("cin >> %s;" % " >> ".join(self.raw(t) for t in s.targets))

    def st_Swap(self, s):
        self.w("swap(%s, %s);" % (self.raw(s.a), self.raw(s.b)))

    def st_ForEach(self, s):
        t = self.tn(s.vty, True) if s.vty is not None else "auto"
        if s.vty is not None and s.vty.k in ("list", "arr", "dict", "set", "class", "str"):
            t = ("%s&" % t) if s.var in mutated_names(s.body, self.const_methods) else "const %s&" % t
        self.w("for (%s %s : %s) {" % (t, self.id(s.var), self.recv(s.it)))
        self.sub(s.body)
        self.w("}")

    def st_ForEnum(self, s):
        it = self.x(s.it, ATOM)
        idx = self.id(s.idx)
        et = self.tn(s.ety, True)
        if s.start.k == "Num" and s.start.v == "0":
            self.w("for (int %s = 0; %s < (int)%s.size(); %s++) {" % (idx, idx, it, idx))
            self.ind += 1
            self.w("%s %s = %s[%s];" % (et, self.id(s.var), it, idx))
            self.ind -= 1
        else:
            self.w("for (int _i = 0; _i < (int)%s.size(); _i++) {" % it)
            self.ind += 1
            self.w("int %s = _i + %s;" % (idx, self.x(s.start, ADD + 1)))
            self.w("%s %s = %s[_i];" % (et, self.id(s.var), it))
            self.ind -= 1
        self.sub(s.body)
        self.w("}")

    def st_ForDict(self, s):
        self.w("for (auto& _kv : %s) {" % self.raw(s.it))
        self.ind += 1
        self.w("auto %s = _kv.first;" % self.id(s.kvar))
        if s.vvar:
            self.w("auto %s = _kv.second;" % self.id(s.vvar))
        self.ind -= 1
        self.sub(s.body)
        self.w("}")

    def st_Throw(self, s):
        self.w("throw runtime_error(%s);" % (self.raw(s.e) if s.e is not None else '""'))

    def st_Try(self, s):
        if s.fin:
            self.need_("fin")
            self.w("{")
            self.ind += 1
            self.w("_Fin _fin([&]() {")
            self.sub(s.fin)
            self.w("});")
        self.w("try {")
        self.sub(s.body)
        if s.handler or not s.fin:
            self.w("} catch (exception& %s) {" % (self.id(s.var) if s.var else "_e"))
            self.sub(s.handler)
        self.w("}")
        if s.fin:
            self.ind -= 1
            self.w("}")

    def st_SuperCall(self, s):
        pass  # emitted as constructor initialiser

    def func_sig(self, f, defaults=True):
        mut = mutated_names(f.body, self.const_methods) if f.body else set()
        ps = []
        for pi, p in enumerate(f.params):
            t = self.tn(p.ty)
            if p.ty is not None and p.ty.k in ("list", "arr", "dict", "set", "class"):
                if p.name in mut:
                    key = (f.name, pi)
                    t = t if key in self.temps else "%s&" % t
                else:
                    t = "const %s&" % t
            ps.append("%s %s%s" % (t, self.id(p.name),
                                   " = " + self.raw(p.default) if (p.default is not None and defaults) else ""))
        if f.ctor:
            return "%s(%s)" % (f.name, ", ".join(ps))
        pre = ""
        if f.static and f.method:
            pre = "static "
        elif f.method and f.name in self.virtuals:
            pre = "virtual "
        const = " const" if (f.method and not f.static and f.name in self.const_methods) else ""
        return "%s%s %s(%s)%s" % (pre, self.tn(f.ret if f.ret is not None else VOID), self.fid(f.name) if not f.method else self.id(f.name), ", ".join(ps), const)

    def st_Func(self, f):
        self.cur_fn = f
        if f.ctor:
            body = list(f.body)
            init = ""
            if body and body[0].k == "SuperCall":
                sc = body.pop(0)
                init = " : %s(%s)" % (self.cur_class.base, ", ".join(self.raw(a) for a in sc.args))
            self.w("%s%s {" % (self.func_sig(f), init))
            self.sub(body)
        else:
            self.w(self.func_sig(f, defaults=not (self.protos and not f.method)) + " {")
            self.sub(f.body)
        self.w("}")
        self.cur_fn = None

    def st_Class(self, c):
        self.cur_class = c
        self.w("class %s%s {" % (c.name, " : public " + c.base if c.base else ""))
        self.w("public:")
        self.ind += 1
        post = []
        for f in c.fields:
            t = self.tn(f.ty)
            if f.static:
                self.w("static %s %s;" % (t, self.id(f.name)))
                init = f.init if f.init is not None else default_for(f.ty)
                post.append("%s %s::%s = %s;" % (t, c.name, self.id(f.name), self.raw(init)))
            else:
                if f.init is not None and f.init.k not in ("New",):
                    self.w("%s %s = %s;" % (t, self.id(f.name), self.raw(f.init)))
                else:
                    self.w("%s %s;" % (t, self.id(f.name)))
        if c.ctor is not None:
            if not c.ctor.params:
                pass
            self.st_Func(c.ctor)
        elif any(not f.static for f in c.fields):
            self.w("%s() {}" % c.name)
        for m in c.methods:
            self.st_Func(m)
        self.ind -= 1
        self.w("};")
        for l in post:
            self.w(l)
        self.cur_class = None

    # expressions ---------------------------------------------------------
    def ex_Str(self, e):
        if e.char:
            return "'%s'" % esc(e.v, "'")
        return '"%s"' % esc(e.v, '"')

    def ex_Attr(self, e):
        o = e.obj
        if o.k == "This":
            return "this->%s" % self.id(e.name)
        if o.k == "Name" and o.id in self.classes:
            return "%s::%s" % (o.id, self.id(e.name))
        if o.k == "Super":
            return "%s::%s" % (self.cur_class.base, self.id(e.name))
        return "%s.%s" % (self.x(o, ATOM), self.id(e.name))

    def recv(self, e):
        s = self.x(e, ATOM)
        return "string(%s)" % s if e.k == "Str" and not e.char else s

    def sz(self, e, off=0):
        return "(int)%s.size()" % self.x(e, ATOM)

    def ex_Index(self, e):
        idx = e.idx
        if idx.k == "Num" and idx.v.startswith("-") and e.obj.ty is not None and e.obj.ty.k != "dict":
            return "%s[%s - %s]" % (self.x(e.obj, ATOM), self.sz(e.obj), idx.v[1:])
        return "%s[%s]" % (self.x(e.obj, ATOM), self.raw(idx))

    def ex_Slice(self, e):
        o = self.x(e.obj, ATOM)
        isstr = self.ty_k(e.obj) == "str"

        def bound(b):
            if b.k == "Num" and b.v.startswith("-"):
                return "(%s - %s)" % (self.sz(e.obj), b.v[1:])
            return self.x(b, ADD + 1)
        lo = bound(e.lo) if e.lo is not None else "0"
        if isstr:
            if e.hi is None:
                return "%s.substr(%s)" % (o, lo)
            return "%s.substr(%s, %s - %s)" % (o, lo, bound(e.hi), lo if e.lo is not None else "0")
        hi = bound(e.hi) if e.hi is not None else "%s.size()" % o
        return "%s(%s.begin() + %s, %s.begin() + %s)" % (self.tn(e.obj.ty), o, lo, o, hi)

    def ex_ListLit(self, e):
        if not e.items:
            return "{}"
        t = self.tn(e.ty) if e.ty is not None else "vector<int>"
        return "%s{%s}" % (t, ", ".join(self.raw(i) for i in e.items))

    def ex_SetLit(self, e):
        if not e.items:
            return "{}"
        return "%s{%s}" % (self.tn(e.ty), ", ".join(self.raw(i) for i in e.items))

    def ex_DictLit(self, e):
        if not e.pairs:
            return "{}"
        return "%s{%s}" % (self.tn(e.ty), ", ".join("{%s, %s}" % (self.raw(k), self.raw(v)) for k, v in e.pairs))

    def ex_Bin(self, e):
        op = e.op
        l, r = e.l, e.r
        if op == "tdiv":
            return "%s / %s" % (self.x(l, MUL), self.x(r, MUL + 1)), MUL
        if op == "/":
            if self.isint(l) and self.isint(r):
                return "(double)%s / %s" % (self.x(l, UN), self.x(r, MUL + 1)), MUL
            return "%s / %s" % (self.x(l, MUL), self.x(r, MUL + 1)), MUL
        if op == "//":
            if self.isflt(l) or self.isflt(r):
                return "floor(%s / %s)" % (self.x(l, MUL), self.x(r, MUL + 1))
            self.need_("fdiv")
            return "_fdiv(%s, %s)" % (self.raw(l), self.raw(r))
        if op == "%":
            if self.isflt(l) or self.isflt(r):
                return "fmod(%s, %s)" % (self.raw(l), self.raw(r))
        if op == "**":
            return self.pow_expr(l, r, e.ty)
        if op in ("in", "notin"):
            t = r.ty
            k = t.k if t is not None else None
            o = self.recv(r)
            if k == "str":
                s = "%s.find(%s) != string::npos" % (o, self.raw(l))
            elif k in ("dict", "set"):
                s = "%s.count(%s) > 0" % (o, self.raw(l))
            else:
                s = "find(%s.begin(), %s.end(), %s) != %s.end()" % (o, o, self.raw(l), o)
            if op == "notin":
                s = s.replace(" != ", " == ", 1).replace(" > 0", " == 0") if k not in ("dict", "set") else \
                    "%s.count(%s) == 0" % (o, self.raw(l))
            return "(%s)" % s
        p = BIN_PREC[op]
        cop = {"and": "&&", "or": "||"}.get(op, op)
        ls = self.x(l, p)
        if op == "+" and l.k == "Str" and not l.char:
            ls = "string(%s)" % ls
        if op == "+" and self.is_str(r) and l.k == "Str" and False:
            pass
        rs = self.x(r, p + 1)
        return "%s %s %s" % (ls, cop, rs), p

    def ex_Cast(self, e):
        a = self.raw(e.e)
        k = e.to.k
        src_str = e.e.ty is not None and e.e.ty.k == "str"
        if k == "int":
            if src_str:
                return "%s(%s)" % ("stoll" if self.wide else "stoi", a)
            return "(%s)%s" % (self.IT, self.x(e.e, UN)), UN
        if k == "float":
            if src_str:
                return "stod(%s)" % a
            return "(double)%s" % self.x(e.e, UN), UN
        if k == "char":
            return "(char)%s" % self.x(e.e, UN), UN
        if k == "bool":
            return "(bool)%s" % self.x(e.e, UN), UN
        return self.x(e.e, ATOM)

    def ex_New(self, e):
        cls = e.cls
        if cls in ("Error", "Exception", "RuntimeException", "IllegalArgumentException",
                   "IllegalStateException", "invalid_argument"):
            cls = "runtime_error"
        return "%s(%s)" % (cls, ", ".join(self.raw(a) for a in e.args))

    def ex_NewArr(self, e):
        t = self.tn(e.elem)
        d = self.raw(default_for(e.elem))
        dims = e.dims
        if len(dims) == 1:
            return "vector<%s>(%s)" % (t, self.raw(dims[0]))
        if len(dims) == 2:
            return "vector<vector<%s> >(%s, vector<%s>(%s))" % (t, self.raw(dims[0]), t, self.raw(dims[1]))
        raise Unsupported("3-d array")

    def ex_Call(self, e):
        fn = e.fn
        args = ", ".join(self.raw(a) for a in e.args)
        if fn.k == "Name":
            nm = fn.id
            if nm in self.prog_funcs():
                return "%s(%s)" % (self.fid(nm), args)
            return "%s(%s)" % (self.id(nm), args)
        if fn.k == "Attr" and fn.obj.k == "Super":
            return "%s::%s(%s)" % (self.cur_class.base, self.id(fn.name), args)
        return "%s(%s)" % (self.x(fn, ATOM), args)

    def prog_funcs(self):
        if not hasattr(self, "_pf"):
            self._pf = {f.name for f in self.prog.funcs}
        return self._pf

    def ex_Input(self, e):
        ty = getattr(e, "cast", None)
        if e.mode == "tok":
            self.need_("tok")
            base = "_tok<%s>()" % self.tn(ty or STR)
        else:
            self.need_("line")
            base = "_line()"
        if e.prompt is not None:
            return "(cout << %s, %s)" % (self.x(e.prompt, SHIFT + 1), base)
        return base

    def ex_FStr(self, e):
        parts = []
        for p in e.parts:
            if isinstance(p, str):
                parts.append('string("%s")' % esc(p, '"') if not parts else '"%s"' % esc(p, '"'))
            else:
                parts.append(self.fstr_val(p[0], p[1]))
        if not parts:
            return '""'
        if len(parts) == 1:
            return parts[0] if parts[0].startswith(("string(", "_")) else "string(%s)" % parts[0]
        # make sure the first operand is a std::string
        if not (parts[0].startswith("string(") or parts[0].startswith("_str(") or parts[0].startswith("_fmt(")):
            parts[0] = "string(%s)" % parts[0]
        return "(" + " + ".join(parts) + ")"

    def fstr_val(self, e, spec):
        sp = parse_spec(spec) if spec else None
        t = e.ty
        if sp and (sp["width"] or sp["prec"] is not None or sp["type"] in ("f", "x", "e")):
            self.need_("fmt", "str")
            al = 1 if sp["align"] == "<" else (2 if sp["align"] == ">" else
                                               (1 if t is not None and t.k in ("str", "char") else 2))
            ch = sp["type"] if sp["type"] in ("f", "x", "e") else "d"
            return "_fmt(%s, %d, %d, %d, %s, '%s')" % (self.raw(e), sp["width"], -1 if sp["prec"] is None else sp["prec"],
                                                       al, "true" if sp["zero"] else "false", ch)
        if t is not None and t.k == "str":
            return self.x(e, ATOM) if e.k != "Str" else '"%s"' % esc(e.v, '"')
        if t is not None and t.k == "char":
            return "string(1, %s)" % self.raw(e)
        if t is not None and t.k == "class":
            return "%s.toString()" % self.x(e, ATOM)
        self.need_("str")
        return "_str(%s)" % self.raw(e)

    # intrinsics ------------------------------------------------------------
    def call(self, name, args):
        return "%s(%s)" % (name, ", ".join(self.raw(a) for a in args))

    def meth(self, a, name, rest):
        return "%s.%s(%s)" % (self.recv(a[0]), name, ", ".join(self.raw(r) for r in rest))

    def in_len(self, e, a): return "(%s)%s.size()" % (self.IT, self.recv(a[0])), UN

    def in_tostr(self, e, a):
        k = self.ty_k(a[0])
        if k == "str":
            return self.raw(a[0])
        if k == "char":
            return "string(1, %s)" % self.raw(a[0])
        if k == "class":
            return "%s.toString()" % self.x(a[0], ATOM)
        self.need_("str")
        return self.call("_str", a)

    def in_abs(self, e, a): return self.call("abs", a)

    def minmax(name):
        def f(self, e, a):
            if len(a) == 1:
                return "*%s_element(%s.begin(), %s.end())" % (name, self.x(a[0], ATOM), self.x(a[0], ATOM)), UN
            t = "double" if any(self.isflt(x) for x in a) else (self.tn(e.ty) if e.ty is not None and e.ty.k in ("int", "str", "char") else self.IT)
            if e.ty is not None and e.ty.k == "str":
                t = "string"
            r = "%s<%s>(%s)" % (name, t, ", ".join(self.raw(x) for x in a))
            if len(a) > 2:
                r = "%s<%s>(%s, %s)" % (name, t, self.raw(a[0]), "%s<%s>(%s)" % (name, t, ", ".join(self.raw(x) for x in a[1:])))
            return r
        return f

    in_min = minmax("min")
    in_max = minmax("max")

    def in_sum(self, e, a):
        et = a[0].ty.a[0] if a[0].ty is not None and a[0].ty.a else None
        zero = "0.0" if et is not None and et.k == "float" else ("(%s)0" % self.IT)
        o = self.x(a[0], ATOM)
        return "accumulate(%s.begin(), %s.end(), %s)" % (o, o, zero)

    def in_sorted(self, e, a):
        self.need_("sorted")
        return self.call("_sorted", a)

    def in_sorted_rev(self, e, a):
        self.need_("sorted_rev")
        return self.call("_sorted_rev", a)

    def in_reversed(self, e, a):
        self.need_("reversed")
        return self.call("_reversed", a)

    def in_reversed_copy(self, e, a):
        o = self.x(a[0], ATOM)
        t = self.tn(a[0].ty)
        return "%s(%s.rbegin(), %s.rend())" % (t, o, o)

    def in_pow(self, e, a):
        c = self.call("pow", a)
        return ("(%s)%s" % (self.IT, c), UN) if e.ty is not None and e.ty.k == "int" else c

    def in_sqrt(self, e, a): return self.call("sqrt", a)
    def in_floor(self, e, a): return "(%s)floor(%s)" % (self.IT, self.raw(a[0])), UN
    def in_ceil(self, e, a): return "(%s)ceil(%s)" % (self.IT, self.raw(a[0])), UN
    def in_round(self, e, a): return "(%s)floor(%s + 0.5)" % (self.IT, self.x(a[0], ADD)), UN
    def in_round2(self, e, a):
        return "floor(%s * pow(10, %s) + 0.5) / pow(10, %s)" % (self.x(a[0], MUL), self.raw(a[1]), self.raw(a[1])), MUL
    def in_trunc(self, e, a): return "(%s)%s" % (self.IT, self.x(a[0], UN)), UN
    def in_log(self, e, a): return self.call("log", a)
    def in_log10(self, e, a): return self.call("log10", a)
    def in_exp(self, e, a): return self.call("exp", a)
    def in_sin(self, e, a): return self.call("sin", a)
    def in_cos(self, e, a): return self.call("cos", a)
    def in_tan(self, e, a): return self.call("tan", a)
    def in_pi(self, e, a): return "3.14159265358979323846"
    def in_e(self, e, a): return "2.71828182845904523536"
    def in_inf(self, e, a): return "numeric_limits<double>::infinity()"

    def in_factorial(self, e, a):
        self.need_("fact")
        return self.call("_fact", a)

    def in_gcd(self, e, a):
        self.need_("gcd")
        return self.call("_gcd", a)

    def in_ord(self, e, a):
        x = a[0]
        if x.k == "Str" and len(x.v) == 1:
            return "(int)'%s'" % esc(x.v, "'"), UN
        return "(int)%s" % self.x(x, UN), UN

    def in_chr(self, e, a): return "(char)%s" % self.x(a[0], UN), UN

    def pred(fn, alld=None):
        def f(self, e, a):
            k = self.ty_k(a[0])
            if k == "str" and alld:
                self.need_(alld[0])
                return "%s(%s)" % (alld[1], self.raw(a[0]))
            if k == "str":
                raise Unsupported("string-level %s" % fn)
            return "(bool)%s(%s)" % (fn, self.raw(a[0])), UN
        return f

    in_isdigit = pred("isdigit", ("isalldigit", "_alldigit"))
    in_isalpha = pred("isalpha", ("isallalpha", "_allalpha"))
    in_isalnum = pred("isalnum")
    in_isspace = pred("isspace")
    in_isupper = pred("isupper")
    in_islower = pred("islower")

    def in_upper(self, e, a):
        if self.ty_k(a[0]) == "char":
            return "(char)toupper(%s)" % self.raw(a[0]), UN
        self.need_("upper")
        return self.call("_upper", a)

    def in_lower(self, e, a):
        if self.ty_k(a[0]) == "char":
            return "(char)tolower(%s)" % self.raw(a[0]), UN
        self.need_("lower")
        return self.call("_lower", a)

    def in_strip(self, e, a):
        self.need_("strip")
        return self.call("_strip", a)

    def in_split(self, e, a):
        self.need_("split")
        return self.call("_split", [x if x.k != "Str" or not x.char else x for x in a])

    def in_join(self, e, a):
        self.need_("join")
        return self.call("_join", a)

    def in_replace(self, e, a):
        self.need_("replace")
        return self.call("_replace", a)

    def in_replace_first(self, e, a):
        self.need_("replace1")
        return self.call("_replace1", a)

    def in_startswith(self, e, a): return "(%s.rfind(%s, 0) == 0)" % (self.recv(a[0]), self.raw(a[1]))

    def in_endswith(self, e, a):
        self.need_("endswith")
        return self.call("_endswith", a)

    def in_find(self, e, a): return "(int)%s.find(%s)" % (self.recv(a[0]), self.raw(a[1])), UN

    def in_repeat(self, e, a):
        self.need_("repeat")
        return self.call("_repeat", a)

    def in_str_count(self, e, a):
        self.need_("count")
        return self.call("_scount", a)

    def in_append(self, e, a): return self.meth(a, "push_back", a[1:])

    def in_insert(self, e, a):
        return "%s.insert(%s.begin() + %s, %s)" % (self.x(a[0], ATOM), self.x(a[0], ATOM), self.x(a[1], ADD + 1), self.raw(a[2]))

    def in_pop_last(self, e, a):
        if getattr(self, "_stmt", False):
            return self.meth(a, "pop_back", [])
        self.need_("pop")
        return self.call("_pop", a)

    def in_pop_at(self, e, a):
        if getattr(self, "_stmt", False):
            return "%s.erase(%s.begin() + %s)" % (self.x(a[0], ATOM), self.x(a[0], ATOM), self.x(a[1], ADD + 1))
        self.need_("pop_at")
        return self.call("_pop_at", a)

    def in_remove_value(self, e, a):
        o = self.x(a[0], ATOM)
        return "%s.erase(find(%s.begin(), %s.end(), %s))" % (o, o, o, self.raw(a[1]))

    def in_sort(self, e, a):
        o = self.x(a[0], ATOM)
        return "sort(%s.begin(), %s.end())" % (o, o)

    def in_reverse_inplace(self, e, a):
        o = self.x(a[0], ATOM)
        return "reverse(%s.begin(), %s.end())" % (o, o)

    def in_clear(self, e, a): return self.meth(a, "clear", [])

    def in_extend(self, e, a):
        self.need_("extend")
        return self.call("_extend", a)

    def in_index(self, e, a):
        o = self.x(a[0], ATOM)
        return "(int)(find(%s.begin(), %s.end(), %s) - %s.begin())" % (o, o, self.raw(a[1]), o), UN

    def in_list_count(self, e, a):
        o = self.x(a[0], ATOM)
        return "(int)count(%s.begin(), %s.end(), %s)" % (o, o, self.raw(a[1])), UN

    def in_list_copy(self, e, a): return self.raw(a[0])

    def cmp_lambda(self, a):
        lam, rev = a[1], a[2].v
        t = a[0].ty
        et = self.tn(t.a[0] if t is not None and t.a else None)
        if lam.k == "Lambda":
            ka, kb = self.render_key(lam, "_a"), self.render_key(lam, "_b")
        else:
            ka, kb = "_a", "_b"
        return "[&](const %s& _a, const %s& _b) { return %s %s %s; }" % (et, et, ka, ">" if rev else "<", kb)

    def in_sort_key(self, e, a):
        o = self.x(a[0], ATOM)
        return "sort(%s.begin(), %s.end(), %s)" % (o, o, self.cmp_lambda(a))

    def in_sorted_key(self, e, a):
        o = self.x(a[0], ATOM)
        return "[&]() { %s _t = %s; sort(_t.begin(), _t.end(), %s); return _t; }()" % (
            self.tn(a[0].ty), self.raw(a[0]), self.cmp_lambda(a))

    def in_repr(self, e, a):
        self.need_("repr")
        return self.call("_repr", a)

    def in_ints(self, e, a):
        self.need_("ints")
        return self.call("_ints", a)

    def in_floats(self, e, a):
        self.need_("floats")
        return self.call("_floats", a)

    def in_list_concat(self, e, a):
        self.need_("concat")
        return self.call("_concat", a)

    def in_digit_val(self, e, a): return "(%s - '0')" % self.x(a[0], ADD), ADD
    def in_exit(self, e, a): return "exit(%s)" % ", ".join(self.raw(x) for x in a)

    def in_strs(self, e, a):
        self.need_("strs")
        return self.call("_strs", a)

    def in_sort_str(self, e, a):
        self.need_("sort_str")
        return self.call("_sort_str", a)

    def in_chars(self, e, a):
        o = self.recv(a[0])
        return "vector<char>(%s.begin(), %s.end())" % (o, o)

    def in_list(self, e, a):
        if self.ty_k(a[0]) == "str":
            return self.in_chars(e, a)
        return self.raw(a[0])

    def in_set(self, e, a):
        o = self.x(a[0], ATOM)
        return "%s(%s.begin(), %s.end())" % (self.tn(e.ty), o, o)

    def in_range(self, e, a):
        self.need_("range")
        if len(a) == 1:
            return "_range(0, %s)" % self.raw(a[0])
        return self.call("_range", a)

    def in_dget(self, e, a):
        d, k = self.x(a[0], ATOM), self.raw(a[1])
        if len(a) == 3:
            return "(%s.count(%s) ? %s.at(%s) : %s)" % (d, k, d, k, self.x(a[2], TERN + 1)), ATOM
        return "%s.at(%s)" % (d, k)

    def in_dkeys(self, e, a):
        self.need_("keys")
        return self.call("_keys", a)

    def in_dvalues(self, e, a):
        self.need_("values")
        return self.call("_values", a)

    def in_ditems(self, e, a): raise Unsupported("items() outside a for loop")
    def in_ddel(self, e, a): return self.meth(a, "erase", a[1:])
    def in_del(self, e, a):
        if self.ty_k(a[0]) == "dict":
            return self.meth(a, "erase", a[1:])
        return "%s.erase(%s.begin() + %s)" % (self.x(a[0], ATOM), self.x(a[0], ATOM), self.x(a[1], ADD + 1))

    def in_sadd(self, e, a): return self.meth(a, "insert", a[1:])
    def in_sdel(self, e, a): return self.meth(a, "erase", a[1:])
    def in_keys_of(self, e, a): raise Unsupported("for-in over object keys")

    def in_list_new(self, e, a):
        return "%s(%s, %s)" % (self.tn(e.ty), self.raw(a[0]), self.raw(a[1]))

    def stmt_expr(self, e):
        self._stmt = True
        try:
            return self.raw(e)
        finally:
            self._stmt = False


# ═════════════════════════════════════════════════════════════════════════
#  Java
# ═════════════════════════════════════════════════════════════════════════
class JavaE(CBase):
    is_cpp = False
    is_java = True
    RES = {"abstract", "assert", "boolean", "break", "byte", "case", "catch", "char", "class", "const",
           "continue", "default", "do", "double", "else", "enum", "extends", "final", "finally", "float",
           "for", "goto", "if", "implements", "import", "instanceof", "int", "interface", "long", "native",
           "new", "package", "private", "protected", "public", "return", "short", "static", "strictfp",
           "super", "switch", "synchronized", "this", "throw", "throws", "transient", "try", "void",
           "volatile", "while", "true", "false", "null", "var", "String", "Integer", "Double", "Math",
           "System", "List", "Map", "Set", "Object", "Scanner", "Main", "Character", "Boolean", "Long"}

    def run(self):
        self.prep()
        self.IT = "long" if self.wide else "int"
        p = self.prog
        for c in getattr(p, "lead_comments", []):
            self.w("// " + c.text)
        self.w("public class Main {")
        self.ind += 1
        for g in p.globals:
            self.st_VarDecl(g, static=True)
        for c in p.classes:
            self.st_Class(c)
            self.w()
        for f in p.funcs:
            f2 = f
            self.st_Func(f2, static=True)
            self.w()
        self.w("public static void main(String[] args) {")
        self.sub(p.main)
        self.w("}")
        self.ind -= 1
        self.w("}")
        out = self.finish()
        hdr = ["import java.util.*;", ""]
        helpers = []
        if self.need & {"sc"}:
            helpers.append("    static Scanner sc = new Scanner(System.in);")
        if "in" in self.need:
            helpers.append("    static String _in(String p) { System.out.print(p); return sc.nextLine(); }")
        if "sorted" in self.need:
            helpers.append("    static <T extends Comparable<T>> ArrayList<T> _sorted(List<T> l) { ArrayList<T> r = new ArrayList<>(l); Collections.sort(r); return r; }")
        if "sorted_rev" in self.need:
            helpers.append("    static <T extends Comparable<T>> ArrayList<T> _sorted_rev(List<T> l) { ArrayList<T> r = new ArrayList<>(l); Collections.sort(r, Collections.reverseOrder()); return r; }")
        if "reversed" in self.need:
            helpers.append("    static <T> ArrayList<T> _reversed(List<T> l) { ArrayList<T> r = new ArrayList<>(l); Collections.reverse(r); return r; }")
        if "range" in self.need:
            helpers.append("    static ArrayList<Integer> _range(int a, int b, int s) { ArrayList<Integer> r = new ArrayList<>(); if (s > 0) for (int i = a; i < b; i += s) r.add(i); else for (int i = a; i > b; i += s) r.add(i); return r; }")
        if "split" in self.need:
            helpers.append('    static ArrayList<String> _split(String s) { String t = s.trim(); return t.isEmpty() ? new ArrayList<String>() : new ArrayList<>(Arrays.asList(t.split("\\\\s+"))); }')
            helpers.append("    static ArrayList<String> _split(String s, String d) { return new ArrayList<>(Arrays.asList(s.split(java.util.regex.Pattern.quote(d), -1))); }")
        if "fact" in self.need:
            helpers.append("    static %s _fact(%s n) { %s r = 1; for (%s i = 2; i <= n; i++) r *= i; return r; }" % ((self.IT,) * 4))
        if "gcd" in self.need:
            helpers.append("    static %s _gcd(%s a, %s b) { return b == 0 ? Math.abs(a) : _gcd(b, a %% b); }" % ((self.IT,) * 3))
        if "scount" in self.need:
            helpers.append("    static int _scount(String s, String x) { int c = 0, p = 0; while (!x.isEmpty() && (p = s.indexOf(x, p)) >= 0) { c++; p += x.length(); } return c; }")
        if "repr" in self.need:
            helpers.append("    static String _repr(List<?> l) { StringBuilder sb = new StringBuilder(\"[\"); for (int i = 0; i < l.size(); i++) { if (i > 0) sb.append(\", \"); Object o = l.get(i); sb.append((o instanceof String || o instanceof Character) ? \"'\" + o + \"'\" : String.valueOf(o)); } return sb.append(\"]\").toString(); }")
        if "sortedby" in self.need:
            helpers.append("    static <T> ArrayList<T> _sortedBy(List<T> l, Comparator<T> c) { ArrayList<T> r = new ArrayList<>(l); r.sort(c); return r; }")
        if "ints" in self.need:
            helpers.append("    static ArrayList<%s> _ints(List<String> l) { ArrayList<%s> r = new ArrayList<>(); for (String s : l) r.add(%s.parse%s(s.trim())); return r; }" % (
                ("Long", "Long", "Long", "Long") if self.wide else ("Integer", "Integer", "Integer", "Int")))
        if "floats" in self.need:
            helpers.append("    static ArrayList<Double> _floats(List<String> l) { ArrayList<Double> r = new ArrayList<>(); for (String s : l) r.add(Double.parseDouble(s.trim())); return r; }")
        if "concat" in self.need:
            helpers.append("    static <T> ArrayList<T> _concat(List<T> a, List<T> b) { ArrayList<T> r = new ArrayList<>(a); r.addAll(b); return r; }")
        if "strs" in self.need:
            helpers.append("    static ArrayList<String> _strs(List<?> l) { ArrayList<String> r = new ArrayList<>(); for (Object o : l) r.add(String.valueOf(o)); return r; }")
        if "sort_str" in self.need:
            helpers.append("    static String _sort_str(String s) { char[] c = s.toCharArray(); Arrays.sort(c); return new String(c); }")
        if "chars" in self.need:
            helpers.append("    static ArrayList<Character> _chars(String s) { ArrayList<Character> r = new ArrayList<>(); for (char c : s.toCharArray()) r.add(c); return r; }")
        if "fill" in self.need:
            helpers.append("    static <T> ArrayList<T> _fill(int n, java.util.function.Supplier<T> s) { ArrayList<T> r = new ArrayList<>(); for (int i = 0; i < n; i++) r.add(s.get()); return r; }")
        if "allpred" in self.need:
            helpers.append("    static boolean _all(String s, java.util.function.IntPredicate f) { return !s.isEmpty() && s.chars().allMatch(f); }")
        if "strip" in self.need:
            pass
        if helpers:
            # place helpers right after the class opening line
            idx = out.index("{\n") + 2
            out = out[:idx] + "\n".join(helpers) + "\n\n" + out[idx:]
        return "\n".join(hdr) + out

    def tn(self, ty, auto_ok=False):
        if ty is None:
            return "var" if auto_ok else "int"
        k = ty.k
        if k == "int":
            return "long" if ty.wide else self.IT
        if k == "float":
            return "double"
        if k == "str":
            return "String"
        if k == "bool":
            return "boolean"
        if k == "char":
            return "char"
        if k == "void":
            return "void"
        if k == "list":
            return "ArrayList<%s>" % self.bx(ty.a[0])
        if k == "arr":
            return "%s[]" % self.tn(ty.a[0])
        if k == "dict":
            return "HashMap<%s, %s>" % (self.bx(ty.a[0]), self.bx(ty.a[1]))
        if k == "set":
            return "HashSet<%s>" % self.bx(ty.a[0])
        if k == "class":
            return ty.a[0]
        return "Object"

    def bx(self, ty):
        if ty is None:
            return "Integer"
        return {"int": "Long" if (self.wide or ty.wide) else "Integer", "float": "Double", "bool": "Boolean",
                "char": "Character"}.get(ty.k) or self.tn(ty)

    def id(self, name):
        if name and name.strip("_") == "":
            return "_u" + name
        return name + "_" if name in self.RES else name

    fid = id
    boxed = 0
    loopvars = set()

    def jstr(self, s):
        return '"' + esc(s, '"', "java") + '"'

    # statements ---------------------------------------------------------
    def st_VarDecl(self, s, static=False):
        name = self.id(s.name)
        ty = s.ty
        t = self.tn(ty, True)
        init = s.init
        pre = "static " if static else ""
        if init is None:
            d = default_for(ty) if ty is not None else None
            if d is not None and d.k != "Null" and (getattr(s, "hoisted", False) or static):
                self.w("%s%s %s = %s;" % (pre, t, name, self.raw(d)))
            else:
                self.w("%s%s %s;" % (pre, t, name))
            return
        if init.k == "ListLit" and ty is not None and ty.k == "arr":
            self.w("%s%s %s = %s;" % (pre, t, name, self.arr_braces(init)))
            return
        if t == "var" and init.k in ("ListLit", "DictLit", "SetLit"):
            t = self.tn(init.ty)
        self.w("%s%s %s = %s;" % (pre, t, name, self.raw(init)))

    def swap_java(self, s):
        a, b = s.a, s.b
        t = self.tn(a.ty, True)
        if t == "var":
            t = "int"
        self.w("{ %s _t = %s; %s; %s; }" % (t, self.raw(a), self.assign_str(N("Assign", target=a, op="=", value=b)),
                                            self.assign_str(N("Assign", target=b, op="=", value=N("Name", id="_t", ty=a.ty)))))

    def st_Swap(self, s):
        self.swap_java(s)

    def assign_str(self, s):
        t, op, v = s.target, s.op, s.value
        if t.k == "Index" and t.obj.ty is not None and t.obj.ty.k in ("list", "dict"):
            o = self.x(t.obj, ATOM)
            idx = self.raw(t.idx)
            if t.obj.ty.k == "list":
                idx = self.ix(t.idx)
                if op == "=":
                    return "%s.set(%s, %s)" % (o, idx, self.bxd(v))
                cur = "%s.get(%s)" % (o, idx)
                return "%s.set(%s, %s)" % (o, idx, self.compound(cur, op, v, t.ty))
            idx = self.bxd(t.idx)
            if op == "=":
                return "%s.put(%s, %s)" % (o, idx, self.bxd(v))
            vt = t.obj.ty.a[1]
            dflt = self.bxd(default_for(vt))
            cur = "%s.getOrDefault(%s, %s)" % (o, idx, dflt)
            return "%s.put(%s, %s)" % (o, idx, self.compound(cur, op, v, t.ty))
        tt = self.raw(t)
        if op == "tdiv=":
            op = "/="
        if op == "//=":
            return "%s = Math.floorDiv(%s, %s)" % (tt, tt, self.raw(v))
        if op == "**=":
            return "%s = %s" % (tt, self.pow_expr(t, v, t.ty))
        if op == ">>>=":
            op = ">>="
        return "%s %s %s" % (tt, op, self.raw(v))

    def compound(self, cur, op, v, ty):
        if op == "tdiv=":
            op = "/="
        if op == "//=":
            return "Math.floorDiv(%s, %s)" % (cur, self.raw(v))
        if op == "**=":
            return "(%s)Math.pow(%s, %s)" % (self.IT, cur, self.raw(v))
        return "%s %s %s" % (cur, op[:-1], self.x(v, MUL + 1) if op[:-1] in "*/%" else self.raw(v))

    def pow_expr(self, l, r, ty):
        c = "Math.pow(%s, %s)" % (self.raw(l), self.raw(r))
        if ty is not None and ty.k == "int":
            return "(%s)%s" % (self.IT, c)
        return c

    def st_Print(self, s):
        items = s.items
        if not items:
            self.w("System.out.%s(%s);" % ("println" if s.end == "\n" else "print", self.jstr(s.end) if s.end not in ("\n", "") else ""))
            return
        if len(items) == 1 and s.end in ("\n", ""):
            it = items[0]
            self.check_printable(it)
            self.w("System.out.%s(%s);" % ("println" if s.end == "\n" else "print", self.raw(it)))
            return
        parts = []
        for i, it in enumerate(items):
            self.check_printable(it)
            if i and s.sep:
                parts.append(self.jstr(s.sep))
            parts.append(self.x(it, ADD + 1) if it.k != "Str" else self.raw(it))
        if s.end not in ("\n", ""):
            parts.append(self.jstr(s.end))
        first = items[0]
        if not (first.k == "Str" and not first.char) and not (first.ty is not None and first.ty.k == "str" and False):
            if not (parts and parts[0].startswith('"')):
                parts.insert(0, '""')
        self.w("System.out.%s(%s);" % ("println" if s.end == "\n" else "print", " + ".join(parts)))

    def check_printable(self, it):
        if it.ty is not None and it.ty.k in ("dict", "set"):
            raise Unsupported("printing a whole collection")
        if it.ty is not None and it.ty.k in ("list", "arr"):
            raise Unsupported("printing a whole collection")

    def st_ReadStmt(self, s):
        self.need_("sc")
        for t, ty, d in zip(s.targets, s.tys, s.decl):
            k = ty.k if ty is not None else "str"
            rd = {"int": "sc.nextInt()" if not self.wide else "sc.nextLong()", "float": "sc.nextDouble()",
                  "char": "sc.next().charAt(0)", "bool": "sc.nextBoolean()"}.get(k, "sc.next()")
            if d:
                self.w("%s %s = %s;" % (self.tn(ty), self.raw(t), rd))
            else:
                self.w("%s = %s;" % (self.raw(t), rd))

    def st_ForEach(self, s):
        it = s.it
        t = self.tn(s.vty, True) if s.vty is not None else "var"
        if self.ty_k(it) == "str":
            self.w("for (%s %s : %s.toCharArray()) {" % ("char", self.id(s.var), self.x(it, ATOM)))
        elif self.ty_k(it) == "set" or self.ty_k(it) in ("list", "arr"):
            self.w("for (%s %s : %s) {" % (t, self.id(s.var), self.raw(it)))
        else:
            self.w("for (%s %s : %s) {" % (t, self.id(s.var), self.raw(it)))
        self.sub(s.body)
        self.w("}")

    def st_ForEnum(self, s):
        it = self.x(s.it, ATOM)
        idx = self.id(s.idx)
        islist = self.ty_k(s.it) != "arr"
        get = (lambda i: "%s.get(%s)" % (it, i)) if islist else (lambda i: "%s[%s]" % (it, i))
        size = "%s.size()" % it if islist else "%s.length" % it
        et = self.tn(s.ety, True)
        if s.start.k == "Num" and s.start.v == "0":
            self.w("for (int %s = 0; %s < %s; %s++) {" % (idx, idx, size, idx))
            self.ind += 1
            self.w("%s %s = %s;" % (et, self.id(s.var), get(idx)))
            self.ind -= 1
        else:
            self.w("for (int _i = 0; _i < %s; _i++) {" % size)
            self.ind += 1
            self.w("int %s = _i + %s;" % (idx, self.x(s.start, ADD + 1)))
            self.w("%s %s = %s;" % (et, self.id(s.var), get("_i")))
            self.ind -= 1
        self.sub(s.body)
        self.w("}")

    def st_ForDict(self, s):
        d = self.raw(s.it)
        t = s.it.ty
        kt, vt = self.bx(t.a[0]), self.bx(t.a[1])
        if s.vvar:
            self.w("for (Map.Entry<%s, %s> _e : %s.entrySet()) {" % (kt, vt, d))
            self.ind += 1
            self.w("%s %s = _e.getKey();" % (self.tn(t.a[0], True), self.id(s.kvar)))
            self.w("%s %s = _e.getValue();" % (self.tn(t.a[1], True), self.id(s.vvar)))
            self.ind -= 1
        else:
            self.w("for (%s %s : %s.keySet()) {" % (kt, self.id(s.kvar), d))
        self.sub(s.body)
        self.w("}")

    def st_Throw(self, s):
        e = self.raw(s.e) if s.e is not None else '""'
        if s.e is not None and not self.is_str(s.e):
            e = "String.valueOf(%s)" % e
        self.w("throw new RuntimeException(%s);" % e)

    def st_Try(self, s):
        self.w("try {")
        self.sub(s.body)
        if s.handler or not s.fin:
            self.w("} catch (Exception %s) {" % (self.id(s.var) if s.var else "_e"))
            self.sub(s.handler)
        if s.fin:
            self.w("} finally {")
            self.sub(s.fin)
        self.w("}")

    def st_SuperCall(self, s):
        self.w("super(%s);" % ", ".join(self.raw(a) for a in s.args))

    def st_Assert(self, s):
        self.w("assert %s;" % self.raw(s.cond))

    def params(self, f):
        return ", ".join("%s %s" % (self.tn(p.ty), self.id(p.name)) for p in f.params)

    def overloads(self, f, static):
        ps = f.params
        first = next((i for i, p in enumerate(ps) if p.default is not None), None)
        if first is None:
            return
        for k in range(first, len(ps)):
            sub = ps[:k]
            call_args = [self.id(p.name) for p in sub] + [self.raw(p.default) for p in ps[k:]]
            sig = ", ".join("%s %s" % (self.tn(p.ty), self.id(p.name)) for p in sub)
            if f.ctor:
                self.w("%s(%s) {" % (f.name, sig))
                self.ind += 1
                self.w("this(%s);" % ", ".join(call_args))
            else:
                mods = "public static " if (static or f.static) else "public "
                ret = self.tn(f.ret if f.ret is not None else VOID)
                self.w("%s%s %s(%s) {" % (mods, ret, self.id(f.name), sig))
                self.ind += 1
                self.w("%s%s(%s);" % ("" if ret == "void" else "return ", self.id(f.name), ", ".join(call_args)))
            self.ind -= 1
            self.w("}")

    def st_Func(self, f, static=False):
        self.cur_fn = f
        self.overloads(f, static)
        if f.ctor:
            self.w("%s(%s) {" % (f.name, self.params(f)))
        else:
            mods = "public static " if (static or f.static) else "public "
            self.w("%s%s %s(%s) {" % (mods, self.tn(f.ret if f.ret is not None else VOID), self.id(f.name),
                                      self.params(f)))
        self.sub(f.body)
        self.w("}")
        self.cur_fn = None

    def st_Class(self, c):
        self.cur_class = c
        self.w("static class %s%s {" % (c.name, " extends " + c.base if c.base else ""))
        self.ind += 1
        for f in c.fields:
            pre = "static " if f.static else ""
            if f.static and f.init is not None:
                self.w("%s%s %s = %s;" % (pre, self.tn(f.ty), self.id(f.name), self.raw(f.init)))
            elif f.init is not None and f.init.k != "New":
                self.w("%s%s %s = %s;" % (pre, self.tn(f.ty), self.id(f.name), self.raw(f.init)))
            else:
                self.w("%s%s %s;" % (pre, self.tn(f.ty), self.id(f.name)))
        if c.ctor is not None:
            self.st_Func(c.ctor)
        elif any(not f.static for f in c.fields):
            self.w("%s() {}" % c.name)
        for m in c.methods:
            self.st_Func(m)
        self.ind -= 1
        self.w("}")
        self.cur_class = None

    # expressions -----------------------------------------------------------
    def ex_Str(self, e):
        if e.char:
            return "'%s'" % esc(e.v, "'", "java")
        return self.jstr(e.v)

    def ex_Attr(self, e):
        o = e.obj
        if o.k == "This":
            return "this.%s" % self.id(e.name)
        return "%s.%s" % (self.x(o, ATOM), self.id(e.name))

    def unbox(self, e, s):
        t = e.ty
        if t is not None and t.k in ("int", "float", "char", "bool"):
            return "(%s) %s" % (self.tn(t), s), UN
        return s

    def ix(self, e):
        """index expression: int-typed even when ints are emitted as long"""
        s = self.raw(e)
        if self.wide and e.k not in ("Num",) and not (e.k == "Name" and e.id in self.loopvars) and \
                e.ty is not None and e.ty.k == "int":
            return "(int) " + self.x(e, UN)
        return s

    def bxd(self, e):
        self.boxed += 1
        try:
            return self.raw(e)
        finally:
            self.boxed -= 1

    def ex_Index(self, e):
        t = e.obj.ty
        k = t.k if t is not None else None
        o = self.x(e.obj, ATOM)
        idx = e.idx
        if k == "str":
            if idx.k == "Num" and idx.v.startswith("-"):
                return "%s.charAt(%s.length() - %s)" % (o, o, idx.v[1:])
            return "%s.charAt(%s)" % (o, self.ix(idx))
        if k == "list":
            if idx.k == "Num" and idx.v.startswith("-"):
                return "%s.get(%s.size() - %s)" % (o, o, idx.v[1:])
            return "%s.get(%s)" % (o, self.ix(idx))
        if k == "dict":
            return "%s.get(%s)" % (o, self.bxd(idx))
        if idx.k == "Num" and idx.v.startswith("-"):
            return "%s[%s.length - %s]" % (o, o, idx.v[1:])
        return "%s[%s]" % (o, self.ix(idx))

    def ex_Slice(self, e):
        o = self.x(e.obj, ATOM)
        k = self.ty_k(e.obj)

        def bound(b, size):
            if b.k == "Num" and b.v.startswith("-"):
                return "%s - %s" % (size, b.v[1:])
            return self.raw(b)
        if k == "str":
            size = "%s.length()" % o
            lo = bound(e.lo, size) if e.lo is not None else "0"
            if e.hi is None:
                return "%s.substring(%s)" % (o, lo)
            return "%s.substring(%s, %s)" % (o, lo, bound(e.hi, size))
        size = "%s.size()" % o
        lo = bound(e.lo, size) if e.lo is not None else "0"
        hi = bound(e.hi, size) if e.hi is not None else size
        return "new ArrayList<>(%s.subList(%s, %s))" % (o, lo, hi)

    def arr_braces(self, e):
        if e.k == "ListLit":
            return "{%s}" % ", ".join(self.arr_braces(i) for i in e.items)
        return self.raw(e)

    def ex_ListLit(self, e):
        if e.ty is not None and e.ty.k == "arr":
            return "new %s%s" % (self.tn(e.ty), self.arr_braces(e))
        if not e.items:
            return "new ArrayList<>()"
        return "new ArrayList<>(Arrays.asList(%s))" % ", ".join(self.bxd(i) for i in e.items)

    def ex_SetLit(self, e):
        if not e.items:
            return "new HashSet<>()"
        return "new HashSet<>(Arrays.asList(%s))" % ", ".join(self.bxd(i) for i in e.items)

    def ex_DictLit(self, e):
        if not e.pairs:
            return "new HashMap<>()"
        if len(e.pairs) > 10:
            raise Unsupported("large map literal")
        return "new HashMap<>(Map.of(%s))" % ", ".join("%s, %s" % (self.bxd(k), self.bxd(v)) for k, v in e.pairs)

    def ex_Bin(self, e):
        op = e.op
        l, r = e.l, e.r
        if op == "tdiv":
            return "%s / %s" % (self.x(l, MUL), self.x(r, MUL + 1)), MUL
        if op == "/":
            if self.isint(l) and self.isint(r):
                return "(double) %s / %s" % (self.x(l, UN), self.x(r, MUL + 1)), MUL
            return "%s / %s" % (self.x(l, MUL), self.x(r, MUL + 1)), MUL
        if op == "//":
            if self.isflt(l) or self.isflt(r):
                return "Math.floor(%s / %s)" % (self.x(l, MUL), self.x(r, MUL + 1))
            return "Math.floorDiv(%s, %s)" % (self.raw(l), self.raw(r))
        if op == "**":
            return self.pow_expr(l, r, e.ty)
        if op in ("in", "notin"):
            k = self.ty_k(r)
            o = self.x(r, ATOM)
            if k == "str":
                s = "%s.indexOf(%s) >= 0" % (o, self.raw(l))
                if op == "notin":
                    s = "%s.indexOf(%s) < 0" % (o, self.raw(l))
                return "(%s)" % s
            m = "containsKey" if k == "dict" else "contains"
            s = "%s.%s(%s)" % (o, m, self.raw(l))
            return ("!" + s, UN) if op == "notin" else s
        p = BIN_PREC[op]
        jop = {"and": "&&", "or": "||"}.get(op, op)
        if op in ("<", "<=", ">", ">=") and self.is_str(l) and self.is_str(r):
            return "%s.compareTo(%s) %s 0" % (self.x(l, ATOM), self.raw(r), op), REL
        if op in ("==", "!=") and (self.ty_k(l) in ("list", "arr", "dict", "set")):
            s = "%s.equals(%s)" % (self.x(l, ATOM), self.raw(r)) if self.ty_k(l) != "arr" else \
                "Arrays.equals(%s, %s)" % (self.raw(l), self.raw(r))
            return ("!" + s, UN) if op == "!=" else s
        if op in ("==", "!="):
            ls, rs = self.eq_side(l), self.eq_side(r)
            if self.is_str(l) and self.is_str(r) and not (l.k == "Null" or r.k == "Null"):
                s = "%s.equals(%s)" % (self.x(l, ATOM), self.raw(r))
                return ("!" + s, UN) if op == "!=" else s
            return "%s %s %s" % (self.x_or(l, ls, p), jop, self.x_or(r, rs, p + 1)), p
        ls = self.x(l, p)
        rs = self.x(r, p + 1)
        return "%s %s %s" % (ls, jop, rs), p

    def eq_side(self, e):
        if e.k in ("Index", "Intr") and e.ty is not None and e.ty.k in ("int", "float", "char", "bool"):
            return True
        return False

    def x_or(self, e, unbox, minp):
        if unbox and e.k == "Index" and self.ty_k_container(e) in ("list", "dict"):
            s = self.raw(e)
            return "(%s) %s" % (self.tn(e.ty), s) if minp <= UN else "((%s) %s)" % (self.tn(e.ty), s)
        return self.x(e, minp)

    def ty_k_container(self, e):
        return e.obj.ty.k if e.obj.ty is not None else None

    def ex_Cast(self, e):
        a = self.raw(e.e)
        k = e.to.k
        src_str = e.e.ty is not None and e.e.ty.k == "str"
        if k == "int":
            if src_str:
                return "%s.parse%s(%s.trim())" % ("Long" if self.wide else "Integer", "Long" if self.wide else "Int", a)
            return "(%s) %s" % (self.IT, self.x(e.e, UN)), UN
        if k == "float":
            if src_str:
                return "Double.parseDouble(%s.trim())" % a
            return "(double) %s" % self.x(e.e, UN), UN
        if k == "char":
            return "(char) %s" % self.x(e.e, UN), UN
        if k == "bool":
            return "Boolean.parseBoolean(%s)" % a
        return self.x(e.e, ATOM)

    def ex_New(self, e):
        cls = e.cls
        if cls in ("Error", "Exception", "runtime_error", "invalid_argument"):
            cls = "RuntimeException"
        return "new %s(%s)" % (cls, ", ".join(self.raw(a) for a in e.args))

    def ex_NewArr(self, e):
        t = self.tn(e.elem)
        dims = "".join("[%s]" % self.ix(d) for d in e.dims)
        return "new %s%s" % (t, dims)

    def ex_Call(self, e):
        return "%s(%s)" % (self.x(e.fn, ATOM), ", ".join(self.raw(a) for a in e.args))

    def ex_Input(self, e):
        self.need_("sc")
        ty = getattr(e, "cast", None)
        if e.mode == "tok":
            m = {"int": "nextInt()" if not self.wide else "nextLong()", "float": "nextDouble()",
                 "bool": "nextBoolean()"}.get(ty.k if ty is not None else "str", "next()")
            return "sc.%s" % m
        if e.prompt is not None:
            self.need_("in")
            return "_in(%s)" % self.raw(e.prompt)
        return "sc.nextLine()"

    def ex_FStr(self, e):
        specs = any((not isinstance(p, str)) and p[1] for p in e.parts)
        if specs:
            fmt, args = [], []
            for p in e.parts:
                if isinstance(p, str):
                    fmt.append(p.replace("%", "%%").replace("\n", "%n"))
                else:
                    ex, sp = p
                    s = parse_spec(sp) if sp else None
                    t = ex.ty
                    if not s:
                        fmt.append("%s")
                    else:
                        flags = ("-" if s["align"] == "<" else "") + ("0" if s["zero"] else "")
                        w = str(s["width"]) if s["width"] else ""
                        pr = ".%d" % s["prec"] if s["prec"] is not None else ""
                        conv = s["type"] if s["type"] in ("f", "x", "e") else (
                            "d" if t is not None and t.k == "int" else "s")
                        if conv == "s" and t is not None and t.k == "float":
                            conv = "f"
                        fmt.append("%" + flags + w + pr + conv)
                    args.append(self.raw(ex))
            return 'String.format("%s", %s)' % (esc("".join(fmt), '"', "java").replace("%%n", "%n"), ", ".join(args))
        parts = []
        for p in e.parts:
            if isinstance(p, str):
                parts.append(self.jstr(p))
            else:
                parts.append(self.x(p[0], ADD + 1))
        if not parts:
            return '""'
        if not parts[0].startswith('"'):
            parts.insert(0, '""')
        return " + ".join(parts), ADD

    # intrinsics -----------------------------------------------------------
    def call(self, name, args):
        return "%s(%s)" % (name, ", ".join(self.raw(a) for a in args))

    def meth(self, a, name, rest):
        return "%s.%s(%s)" % (self.x(a[0], ATOM), name, ", ".join(self.raw(r) for r in rest))

    def in_len(self, e, a):
        k = self.ty_k(a[0])
        if k == "str":
            return "%s.length()" % self.x(a[0], ATOM)
        if k == "arr":
            return "%s.length" % self.x(a[0], ATOM)
        return "%s.size()" % self.x(a[0], ATOM)

    def in_tostr(self, e, a):
        if self.is_str(a[0]):
            return self.raw(a[0])
        return self.call("String.valueOf", a)

    def in_abs(self, e, a): return self.call("Math.abs", a)

    def minmax(name):
        def f(self, e, a):
            if len(a) == 1:
                return "Collections.%s(%s)" % (name, self.raw(a[0]))
            r = self.call("Math." + name, a[:2])
            for x in a[2:]:
                r = "Math.%s(%s, %s)" % (name, r, self.raw(x))
            return r
        return f

    in_min = minmax("min")
    in_max = minmax("max")

    def in_sum(self, e, a):
        et = a[0].ty.a[0] if a[0].ty is not None and a[0].ty.a else None
        k = self.ty_k(a[0])
        mapper = "mapToDouble(Double::doubleValue)" if et is not None and et.k == "float" else (
            "mapToLong(Long::longValue)" if self.wide else "mapToInt(Integer::intValue)")
        if k == "arr":
            return "Arrays.stream(%s).sum()" % self.raw(a[0])
        return "%s.stream().%s.sum()" % (self.x(a[0], ATOM), mapper)

    def in_sorted(self, e, a):
        self.need_("sorted")
        return self.call("_sorted", a)

    def in_sorted_rev(self, e, a):
        self.need_("sorted_rev")
        return self.call("_sorted_rev", a)

    def in_reversed(self, e, a):
        self.need_("reversed")
        return self.call("_reversed", a)

    def in_reversed_copy(self, e, a):
        if self.ty_k(a[0]) == "str":
            return "new StringBuilder(%s).reverse().toString()" % self.raw(a[0])
        self.need_("reversed")
        return self.call("_reversed", a)

    def in_pow(self, e, a):
        c = self.call("Math.pow", a)
        return ("(%s) %s" % (self.IT, c), UN) if e.ty is not None and e.ty.k == "int" else c

    def in_sqrt(self, e, a): return self.call("Math.sqrt", a)
    def in_floor(self, e, a): return "(%s) Math.floor(%s)" % (self.IT, self.raw(a[0])), UN
    def in_ceil(self, e, a): return "(%s) Math.ceil(%s)" % (self.IT, self.raw(a[0])), UN
    def in_round(self, e, a): return "(%s) Math.round(%s)" % (self.IT, self.raw(a[0])), UN
    def in_round2(self, e, a):
        return "Math.round(%s * Math.pow(10, %s)) / Math.pow(10, %s)" % (self.x(a[0], MUL), self.raw(a[1]), self.raw(a[1])), MUL
    def in_trunc(self, e, a): return "(%s) %s" % (self.IT, self.x(a[0], UN)), UN
    def in_log(self, e, a): return self.call("Math.log", a)
    def in_log10(self, e, a): return self.call("Math.log10", a)
    def in_exp(self, e, a): return self.call("Math.exp", a)
    def in_sin(self, e, a): return self.call("Math.sin", a)
    def in_cos(self, e, a): return self.call("Math.cos", a)
    def in_tan(self, e, a): return self.call("Math.tan", a)
    def in_pi(self, e, a): return "Math.PI"
    def in_e(self, e, a): return "Math.E"
    def in_inf(self, e, a): return "Double.POSITIVE_INFINITY"

    def in_factorial(self, e, a):
        self.need_("fact")
        return self.call("_fact", a)

    def in_gcd(self, e, a):
        self.need_("gcd")
        return self.call("_gcd", a)

    def in_ord(self, e, a):
        x = a[0]
        if x.k == "Str" and len(x.v) == 1:
            return "(int) '%s'" % esc(x.v, "'", "java"), UN
        return "(int) %s" % self.x(x, UN), UN

    def in_chr(self, e, a): return "(char) %s" % self.x(a[0], UN), UN

    def pred(cname):
        def f(self, e, a):
            if self.ty_k(a[0]) == "str":
                self.need_("allpred")
                return "_all(%s, Character::%s)" % (self.raw(a[0]), cname)
            return "Character.%s(%s)" % (cname, self.raw(a[0]))
        return f

    in_isdigit = pred("isDigit")
    in_isalpha = pred("isLetter")
    in_isalnum = pred("isLetterOrDigit")
    in_isspace = pred("isWhitespace")
    in_isupper = pred("isUpperCase")
    in_islower = pred("isLowerCase")

    def in_upper(self, e, a):
        if self.ty_k(a[0]) == "char":
            return "Character.toUpperCase(%s)" % self.raw(a[0])
        return self.meth(a, "toUpperCase", [])

    def in_lower(self, e, a):
        if self.ty_k(a[0]) == "char":
            return "Character.toLowerCase(%s)" % self.raw(a[0])
        return self.meth(a, "toLowerCase", [])

    def in_strip(self, e, a): return self.meth(a, "trim", [])

    def in_split(self, e, a):
        self.need_("split")
        return self.call("_split", a)

    def in_join(self, e, a): return self.call("String.join", a)
    def in_replace(self, e, a): return self.meth(a, "replace", a[1:])

    def in_replace_first(self, e, a):
        return "%s.replaceFirst(java.util.regex.Pattern.quote(%s), java.util.regex.Matcher.quoteReplacement(%s))" % (
            self.x(a[0], ATOM), self.raw(a[1]), self.raw(a[2]))

    def in_startswith(self, e, a): return self.meth(a, "startsWith", a[1:])
    def in_endswith(self, e, a): return self.meth(a, "endsWith", a[1:])
    def in_find(self, e, a): return self.meth(a, "indexOf", a[1:])
    def in_repeat(self, e, a): return "%s.repeat(%s)" % (self.x(a[0], ATOM), self.ix(a[1]))

    def in_str_count(self, e, a):
        self.need_("scount")
        return self.call("_scount", a)

    def in_append(self, e, a): return "%s.add(%s)" % (self.x(a[0], ATOM), self.bxd(a[1]))
    def in_insert(self, e, a): return "%s.add(%s, %s)" % (self.x(a[0], ATOM), self.ix(a[1]), self.bxd(a[2]))

    def in_pop_last(self, e, a):
        o = self.x(a[0], ATOM)
        return "%s.remove(%s.size() - 1)" % (o, o)

    def in_pop_at(self, e, a): return "%s.remove((int) %s)" % (self.x(a[0], ATOM), self.x(a[1], UN))

    def in_remove_value(self, e, a):
        et = a[0].ty.a[0] if a[0].ty is not None and a[0].ty.a else None
        if et is not None and et.k == "int":
            return "%s.remove(Integer.valueOf(%s))" % (self.x(a[0], ATOM), self.raw(a[1]))
        return self.meth(a, "remove", a[1:])

    def in_sort(self, e, a):
        if self.ty_k(a[0]) == "arr":
            return "Arrays.sort(%s)" % self.raw(a[0])
        return "Collections.sort(%s)" % self.raw(a[0])

    def in_reverse_inplace(self, e, a): return "Collections.reverse(%s)" % self.raw(a[0])
    def in_clear(self, e, a): return self.meth(a, "clear", [])
    def in_extend(self, e, a): return self.meth(a, "addAll", a[1:])
    def in_index(self, e, a): return self.meth(a, "indexOf", a[1:])
    def in_list_count(self, e, a): return "Collections.frequency(%s, %s)" % (self.raw(a[0]), self.raw(a[1]))
    def in_list_copy(self, e, a):
        if self.ty_k(a[0]) == "arr":
            return "%s.clone()" % self.x(a[0], ATOM)
        return "new ArrayList<>(%s)" % self.raw(a[0])

    def in_chars(self, e, a):
        self.need_("chars")
        return "_chars(%s)" % self.raw(a[0])

    def in_strs(self, e, a):
        self.need_("strs")
        return "_strs(%s)" % self.raw(a[0])

    def in_sort_str(self, e, a):
        self.need_("sort_str")
        return "_sort_str(%s)" % self.raw(a[0])

    def cmp_java(self, a):
        lam, rev = a[1], a[2].v
        t = a[0].ty
        if t is not None and t.k == "arr":
            raise Unsupported("sorting an array with a key")
        if lam.k == "Lambda":
            ka, kb = self.render_key(lam, "_a"), self.render_key(lam, "_b")
            kt = lam.ty.k if lam.ty is not None else "int"
        else:
            ka, kb = "_a", "_b"
            et = t.a[0] if t is not None and t.a else None
            kt = et.k if et is not None else "int"
        if rev:
            ka, kb = kb, ka
        if kt == "str":
            body = "%s.compareTo(%s)" % (ka if ka.replace("_", "").isalnum() else "(%s)" % ka, kb)
        elif kt == "float":
            body = "Double.compare(%s, %s)" % (ka, kb)
        elif kt == "char":
            body = "Character.compare(%s, %s)" % (ka, kb)
        else:
            body = "%s.compare(%s, %s)" % ("Long" if self.wide else "Integer", ka, kb)
        return "(_a, _b) -> %s" % body

    def in_sort_key(self, e, a):
        return "%s.sort(%s)" % (self.x(a[0], ATOM), self.cmp_java(a))

    def in_sorted_key(self, e, a):
        self.need_("sortedby")
        return "_sortedBy(%s, %s)" % (self.raw(a[0]), self.cmp_java(a))

    def in_ints(self, e, a):
        self.need_("ints")
        return "_ints(%s)" % self.raw(a[0])

    def in_floats(self, e, a):
        self.need_("floats")
        return "_floats(%s)" % self.raw(a[0])

    def in_list_concat(self, e, a):
        self.need_("concat")
        return "_concat(%s, %s)" % (self.raw(a[0]), self.raw(a[1]))

    def in_digit_val(self, e, a): return "Character.getNumericValue(%s)" % self.raw(a[0])
    def in_exit(self, e, a): return "System.exit(%s)" % ", ".join(self.raw(x) for x in a)

    def in_repr(self, e, a):
        if self.ty_k(a[0]) == "arr":
            return "Arrays.toString(%s)" % self.raw(a[0])
        self.need_("repr")
        return "_repr(%s)" % self.raw(a[0])

    def in_list(self, e, a):
        if self.ty_k(a[0]) == "str":
            raise Unsupported("list(str)")
        return "new ArrayList<>(%s)" % self.raw(a[0])

    def in_set(self, e, a): return "new HashSet<>(%s)" % self.raw(a[0])

    def in_range(self, e, a):
        self.need_("range")
        lo, hi, st = ("0", self.raw(a[0]), "1") if len(a) == 1 else (
            self.raw(a[0]), self.raw(a[1]), self.raw(a[2]) if len(a) > 2 else "1")
        return "_range(%s, %s, %s)" % (lo, hi, st)

    def in_dget(self, e, a):
        if len(a) == 3:
            return "%s.getOrDefault(%s, %s)" % (self.x(a[0], ATOM), self.bxd(a[1]), self.bxd(a[2]))
        return "%s.get(%s)" % (self.x(a[0], ATOM), self.bxd(a[1]))

    def in_dkeys(self, e, a): return "new ArrayList<>(%s.keySet())" % self.x(a[0], ATOM)
    def in_dvalues(self, e, a): return "new ArrayList<>(%s.values())" % self.x(a[0], ATOM)
    def in_ditems(self, e, a): raise Unsupported("items() outside a for loop")
    def in_ddel(self, e, a): return self.meth(a, "remove", a[1:])
    def in_del(self, e, a):
        if self.ty_k(a[0]) == "dict":
            return self.meth(a, "remove", a[1:])
        return "%s.remove((int) %s)" % (self.x(a[0], ATOM), self.x(a[1], UN))

    def in_sadd(self, e, a): return self.meth(a, "add", a[1:])
    def in_sdel(self, e, a): return self.meth(a, "remove", a[1:])
    def in_keys_of(self, e, a): raise Unsupported("for-in over object keys")

    def in_list_new(self, e, a):
        v = a[1]
        if v.k in ("ListLit", "DictLit", "SetLit") or (v.k == "Intr" and v.name == "list_new"):
            self.need_("fill")
            return "_fill(%s, () -> %s)" % (self.ix(a[0]), self.bxd(v))
        return "new ArrayList<>(Collections.nCopies(%s, %s))" % (self.ix(a[0]), self.bxd(v))
