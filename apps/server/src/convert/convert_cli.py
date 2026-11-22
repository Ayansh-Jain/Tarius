"""
Offline (rule-based) code conversion runner.

Reads one JSON object from stdin: {"code": str, "src": str, "tgt": str}
Writes one JSON object to stdout:  {"ok": true, "code": str} or {"ok": false, "error": str}

The converter (transpiler.py: lexer -> parser -> typed IR -> code generator) can
raise Unsupported for constructs it cannot translate faithfully. Its output is
additionally syntax-checked with the real toolchain when one is installed, and
rejected (ok=false) when it does not pass, letting the caller fall back.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.setrecursionlimit(5000)

from transpiler import convert  # noqa: E402

LANGS = {"python", "javascript", "typescript", "cpp", "java"}


def _balanced(code: str) -> bool:
    """Bracket balance outside strings/comments -- the check of last resort."""
    pairs = {")": "(", "]": "[", "}": "{"}
    stack = []
    i, n = 0, len(code)
    while i < n:
        ch = code[i]
        nxt = code[i + 1] if i + 1 < n else ""
        if ch == "/" and nxt == "/":
            while i < n and code[i] != "\n":
                i += 1
            continue
        if ch == "/" and nxt == "*":
            end = code.find("*/", i + 2)
            i = n if end == -1 else end + 2
            continue
        if ch in ("'", '"', "`"):
            q = ch
            i += 1
            while i < n and code[i] != q:
                if code[i] == "\\":
                    i += 1
                i += 1
            i += 1
            continue
        if ch in "([{":
            stack.append(ch)
        elif ch in pairs:
            if not stack or stack.pop() != pairs[ch]:
                return False
        i += 1
    return not stack


def _run(cmd, cwd=None, timeout=25):
    try:
        r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)
        return r.returncode == 0
    except Exception:
        return None  # tool unusable -> unknown


def validate(code: str, tgt: str) -> bool:
    if not code.strip():
        return False
    if tgt != "python" and not _balanced(code):
        return False

    if tgt == "python":
        try:
            compile(code, "<converted>", "exec")
            return True
        except Exception:
            return False

    with tempfile.TemporaryDirectory() as d:
        if tgt == "javascript":
            node = os.environ.get("ICE_NODE_BIN") or shutil.which("node")
            if node:
                p = os.path.join(d, "x.js")
                with open(p, "w", encoding="utf-8") as f:
                    f.write(code)
                res = _run([node, "--check", p])
                if res is not None:
                    return res
        elif tgt == "typescript":
            node = os.environ.get("ICE_NODE_BIN") or shutil.which("node")
            if node:
                p = os.path.join(d, "x.ts")
                with open(p, "w", encoding="utf-8") as f:
                    f.write(code)
                res = _run([node, "--experimental-strip-types", "--check", p])
                if res is not None:
                    return res
        elif tgt == "cpp":
            gpp = shutil.which("g++") or shutil.which("clang++")
            if gpp:
                p = os.path.join(d, "x.cpp")
                with open(p, "w", encoding="utf-8") as f:
                    f.write(code)
                # old compilers (e.g. g++ 6) reject newer -std values outright
                for std in ("c++17", "c++14", "c++11"):
                    res = _run([gpp, "-std=" + std, "-fsyntax-only", p])
                    if res:
                        return True
                return False
        elif tgt == "java":
            javac = shutil.which("javac")
            if javac:
                p = os.path.join(d, "Main.java")
                with open(p, "w", encoding="utf-8") as f:
                    f.write(code)
                res = _run([javac, "-encoding", "UTF-8", "-d", d, p], timeout=45)
                if res is not None:
                    return res
    # No toolchain for this target: structural heuristics only.
    return True


def main() -> None:
    try:
        req = json.loads(sys.stdin.read())
        code, src, tgt = req["code"], req["src"], req["tgt"]
        if src not in LANGS or tgt not in LANGS:
            raise ValueError("unsupported language")
        out = convert(code, src, tgt)
        if not isinstance(out, str) or not validate(out, tgt):
            raise ValueError("output failed validation")
        print(json.dumps({"ok": True, "code": out}))
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": "%s: %s" % (type(e).__name__, e)}))


if __name__ == "__main__":
    main()
