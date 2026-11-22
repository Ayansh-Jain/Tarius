"""
transpiler -- offline source-to-source converter for the ICE editor.

    convert(code, src, tgt) -> str     (raises Unsupported when it cannot do it faithfully)

Languages: python, javascript, typescript, cpp, java.

Pipeline: lex -> parse to a neutral IR -> infer types / canonicalise -> emit.
TypeScript is JavaScript plus type annotations: it parses with the JavaScript
front end (annotations are read into the IR types) and prints with the
JavaScript generator extended by type annotations.
"""
from tx_core import Unsupported
from tx_parse import parse
from tx_sema import analyze

LANGUAGES = ("python", "javascript", "typescript", "cpp", "java")


def _emitter(tgt, prog, src):
    if tgt == "python":
        from tx_emit import PyE
        return PyE(prog, src)
    if tgt == "javascript":
        from tx_emit import JsE
        return JsE(prog, src)
    if tgt == "typescript":
        from tx_emit_ts import TsE
        return TsE(prog, src)
    if tgt == "cpp":
        from tx_emit_c import CppE
        return CppE(prog, src)
    if tgt == "java":
        from tx_emit_c import JavaE
        return JavaE(prog, src)
    raise Unsupported("target " + tgt)


def convert(code, src, tgt):
    if src not in LANGUAGES or tgt not in LANGUAGES:
        raise Unsupported("unsupported language pair %s -> %s" % (src, tgt))
    if src == tgt:
        return code
    ts_src = src == "typescript"
    parse_lang = "javascript" if ts_src else src
    # the analysis only distinguishes the JavaScript family, so TS and JS share a target
    sema_tgt = "javascript" if tgt == "typescript" else tgt
    prog = parse(code, parse_lang, ts=ts_src)
    prog = analyze(prog, parse_lang, sema_tgt)
    return _emitter(tgt, prog, parse_lang).run()
