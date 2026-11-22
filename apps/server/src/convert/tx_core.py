"""
tx_core -- shared pieces of the ICE offline code converter:
types, IR node, and the lexer for Python / JavaScript / C++ / Java.
"""
import re


class Unsupported(Exception):
    """Raised when the source uses something the offline engine cannot translate."""


# ─── Types ────────────────────────────────────────────────────────────────────
class Ty:
    """A (mutable) type. List/dict element slots start as None and get filled in
    by inference, so every holder of the same Ty object sees the refinement."""

    __slots__ = ("k", "a", "wide")

    def __init__(self, k, *a):
        self.k = k
        self.a = list(a)
        self.wide = False

    def __repr__(self):
        return self.k if not self.a else "%s<%s>" % (self.k, ",".join(map(repr, self.a)))


INT, FLOAT, STR, BOOL, CHAR, VOID, ANY = (
    Ty("int"), Ty("float"), Ty("str"), Ty("bool"), Ty("char"), Ty("void"), Ty("any"))


LONG = Ty("int")
LONG.wide = True


def list_of(t=None):
    return Ty("list", t)


def arr_of(t=None):
    return Ty("arr", t)


def dict_of(k=None, v=None):
    return Ty("dict", k, v)


def set_of(t=None):
    return Ty("set", t)


def cls_of(name):
    return Ty("class", name)


def kind(t):
    return t.k if t is not None else None


def is_seq(t):
    return t is not None and t.k in ("list", "arr")


def is_num(t):
    return t is not None and t.k in ("int", "float", "char")


def fill(t, u):
    """Fill unknown slots of t from u (same shape). Returns t."""
    if t is None or u is None or t.k != u.k:
        return t
    for i in range(min(len(t.a), len(u.a))):
        if t.a[i] is None:
            t.a[i] = u.a[i]
        elif isinstance(t.a[i], Ty) and isinstance(u.a[i], Ty):
            fill(t.a[i], u.a[i])
    return t


def join_ty(a, b):
    """Least upper bound of two types (None = unknown)."""
    if a is None or a.k == "any":
        return b
    if b is None or b.k == "any":
        return a
    if a.k == b.k:
        if a.a and b.a:
            fill(a, b)
        if a.k == "int" and b.wide:
            return b
        return a
    if {a.k, b.k} <= {"int", "float"}:
        return FLOAT
    if {a.k, b.k} <= {"int", "char"}:
        return INT
    return a


# ─── IR node ──────────────────────────────────────────────────────────────────
class N:
    def __init__(self, k, **kw):
        self.k = k
        self.ty = None
        self.__dict__.update(kw)

    def __repr__(self):
        d = {k: v for k, v in self.__dict__.items() if k not in ("k", "ty") and v is not None}
        return "N<%s %s>" % (self.k, d)


# ─── Lexer ────────────────────────────────────────────────────────────────────
class Tok:
    __slots__ = ("k", "v", "line", "x")

    def __init__(self, k, v, line, x=None):
        self.k, self.v, self.line, self.x = k, v, line, x

    def __repr__(self):
        return "%s:%r" % (self.k, self.v)


_OPS = [
    ">>>=", "...", "<<=", ">>=", "**=", "//=", "===", "!==", ">>>", "->", "=>", "::", "**", "//",
    "<<", ">>", "<=", ">=", "==", "!=", "&&", "||", "++", "--", "+=", "-=", "*=", "/=", "%=",
    "&=", "|=", "^=", "??", "?.", ":=",
]
_SINGLE = set("+-*/%=<>!&|^~?:;,.(){}[]@#")

_NUM_RE = re.compile(
    r"0[xX][0-9a-fA-F_]+|0[bB][01_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?")
_ID_RE = re.compile(r"[A-Za-z_$][A-Za-z_$0-9]*")


def _decode(s):
    out, i, n = [], 0, len(s)
    while i < n:
        c = s[i]
        if c != "\\" or i + 1 >= n:
            out.append(c)
            i += 1
            continue
        e = s[i + 1]
        i += 2
        m = {"n": "\n", "t": "\t", "r": "\r", "0": "\0", "\\": "\\", "'": "'", '"': '"',
             "`": "`", "$": "$", "a": "\a", "b": "\b", "f": "\f", "v": "\v"}
        if e == "x" and i + 2 <= n:
            out.append(chr(int(s[i:i + 2], 16)))
            i += 2
        elif e == "u" and i + 4 <= n:
            out.append(chr(int(s[i:i + 4], 16)))
            i += 4
        elif e == "\n":
            pass
        elif e in m:
            out.append(m[e])
        else:
            out.append("\\" + e)
    return "".join(out)


def _split_fstring(body, mode):
    """Split an f-string / template body into text and expression parts.
    Returns [str | (expr_src, spec)]."""
    parts, buf, i, n = [], [], 0, len(body)
    while i < n:
        c = body[i]
        if mode == "py":
            if c == "{" and body[i + 1:i + 2] == "{":
                buf.append("{")
                i += 2
                continue
            if c == "}" and body[i + 1:i + 2] == "}":
                buf.append("}")
                i += 2
                continue
            start = c == "{"
            skip = 1
        else:
            if c == "\\" and i + 1 < n:
                buf.append(body[i:i + 2])
                i += 2
                continue
            start = c == "$" and body[i + 1:i + 2] == "{"
            skip = 2
        if not start:
            buf.append(c)
            i += 1
            continue
        if buf:
            parts.append(_decode("".join(buf)) if mode != "pyraw" else "".join(buf))
            buf = []
        i += skip
        depth, j, q = 0, i, None
        spec_at = None
        while j < n:
            ch = body[j]
            if q:
                if ch == "\\":
                    j += 1
                elif ch == q:
                    q = None
            elif ch in "'\"`":
                q = ch
            elif ch in "([{":
                depth += 1
            elif ch in ")]":
                depth -= 1
            elif ch == "}":
                if depth == 0:
                    break
                depth -= 1
            elif ch == ":" and depth == 0 and spec_at is None and mode == "py":
                spec_at = j
            elif ch == "!" and depth == 0 and spec_at is None and mode == "py" \
                    and body[j + 1:j + 2] in ("r", "s", "a") and body[j + 2:j + 3] in (":", "}"):
                spec_at = -j  # conversion flag, dropped
            j += 1
        if spec_at is None:
            expr, spec = body[i:j], ""
        elif spec_at < 0:
            expr, spec = body[i:-spec_at], ""
        else:
            expr, spec = body[i:spec_at], body[spec_at + 1:j]
        parts.append((expr.strip(), spec.strip()))
        i = j + 1
    if buf:
        parts.append(_decode("".join(buf)))
    return parts


def lex(src, lang):
    py = lang == "python"
    toks, i, n, line = [], 0, len(src), 1
    depth, indents = 0, [0]
    line_start, code_on_line = True, False

    def add(k, v, x=None):
        toks.append(Tok(k, v, line, x))

    while i < n:
        c = src[i]
        if line_start and py and depth == 0:
            j, col = i, 0
            while j < n and src[j] in " \t":
                col += 8 - col % 8 if src[j] == "\t" else 1
                j += 1
            if j >= n:
                i = j
                break
            if src[j] in "\r\n":
                if src[j] == "\r" and src[j + 1:j + 2] == "\n":
                    j += 1
                i = j + 1
                line += 1
            elif src[j] == "#":
                e = src.find("\n", j)
                e = n if e < 0 else e
                add("comment", src[j + 1:e].strip())
                i = e
            else:
                if col > indents[-1]:
                    indents.append(col)
                    add("indent", None)
                else:
                    while col < indents[-1]:
                        indents.pop()
                        add("dedent", None)
                line_start = False
                i = j
            continue
        if c == "\n":
            if py and depth == 0 and code_on_line:
                add("nl", None)
            line += 1
            line_start, code_on_line = True, False
            i += 1
            continue
        if c in " \t\r":
            i += 1
            continue
        if c == "\\" and src[i + 1:i + 2] in ("\n", "\r"):
            i += 2 if src[i + 1] == "\n" else 3
            line += 1
            continue
        # comments
        if py and c == "#":
            e = src.find("\n", i)
            e = n if e < 0 else e
            i = e  # trailing comment: dropped
            continue
        if not py and c == "/" and src[i + 1:i + 2] == "/":
            e = src.find("\n", i)
            e = n if e < 0 else e
            if not code_on_line:
                add("comment", src[i + 2:e].strip())
            i = e
            continue
        if not py and c == "/" and src[i + 1:i + 2] == "*":
            e = src.find("*/", i + 2)
            e = n if e < 0 else e + 2
            if not code_on_line:
                txt = src[i + 2:e - 2].strip()
                for ln in txt.split("\n"):
                    add("comment", ln.strip().lstrip("*").strip())
            line += src.count("\n", i, e)
            i = e
            continue
        if lang == "cpp" and c == "#" and not code_on_line:
            e = src.find("\n", i)
            i = n if e < 0 else e
            continue
        line_start = False
        # strings
        sm = None
        if py and c.isalpha():
            sm = re.match(r"([rRbBfFuU]{1,2})(\"\"\"|'''|\"|')", src[i:i + 6])
        if sm or c in "\"'" or (lang == "javascript" and c == "`"):
            prefix = sm.group(1).lower() if sm else ""
            qstart = i + (len(prefix) if sm else 0)
            q = src[qstart]
            triple = py and src[qstart:qstart + 3] in ('"""', "'''")
            qlen = 3 if triple else 1
            j = qstart + qlen
            while j < n:
                if src[j] == "\\" and "r" not in prefix:
                    j += 2
                    continue
                if src[j] == "\\":
                    j += 2
                    continue
                if triple and src[j:j + 3] == q * 3:
                    break
                if not triple and src[j] == q:
                    break
                if not triple and src[j] == "\n" and q != "`":
                    raise Unsupported("unterminated string")
                j += 1
            body = src[qstart + qlen:j]
            i = j + qlen
            line += body.count("\n")
            code_on_line = True
            if "f" in prefix:
                add("fstr", _split_fstring(body, "pyraw" if "r" in prefix else "py"))
            elif q == "`":
                parts = _split_fstring(body, "js")
                if all(isinstance(p, str) for p in parts):
                    add("str", "".join(parts))
                else:
                    add("fstr", parts)
            else:
                add("str", body if "r" in prefix else _decode(body),
                    "char" if (lang in ("cpp", "java") and q == "'") else None)
            continue
        # numbers
        if c.isdigit() or (c == "." and src[i + 1:i + 2].isdigit()):
            m = _NUM_RE.match(src, i)
            txt = m.group(0)
            i = m.end()
            suffix = ""
            while i < n and src[i] in "fFlLuUdD" and not py and not txt.lower().startswith("0x"):
                suffix += src[i]
                i += 1
            isf = (("." in txt or "e" in txt.lower()) and not txt.lower().startswith("0x")) \
                or suffix.lower() in ("f", "d")
            txt = txt.replace("_", "")
            if txt.startswith("0b") or txt.startswith("0B"):
                txt = str(int(txt, 2))
            elif txt.startswith("0o") or txt.startswith("0O"):
                txt = str(int(txt[2:], 8))
            elif txt.lower().startswith("0x"):
                txt = str(int(txt, 16))
            add("num", txt, "float" if isf else "int")
            code_on_line = True
            continue
        if c.isalpha() or c in "_$":
            m = _ID_RE.match(src, i)
            add("id", m.group(0))
            i = m.end()
            code_on_line = True
            continue
        # operators
        op = None
        for cand in _OPS:
            if src.startswith(cand, i):
                op = cand
                break
        if op is None:
            if c in _SINGLE:
                op = c
            else:
                raise Unsupported("unexpected character %r" % c)
        if op in ("(", "[", "{"):
            depth += 1
        elif op in (")", "]", "}"):
            depth = max(0, depth - 1)
        if py and op == "::":
            add("op", ":")
            add("op", ":")
        else:
            add("op", op)
        i += len(op)
        code_on_line = True
    if py:
        if code_on_line:
            add("nl", None)
        while len(indents) > 1:
            indents.pop()
            add("dedent", None)
    add("eof", None)
    return toks
