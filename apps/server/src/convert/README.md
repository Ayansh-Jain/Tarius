# Offline code converter

Converts between **Python, JavaScript, C++ and Java** without calling any API.
`convert.ts` runs it first and only asks Gemini when this engine raises
`Unsupported` (or its output fails a real compiler/syntax check).

```
source ──lex──▶ tokens ──parse──▶ neutral IR ──sema──▶ typed, canonical IR ──emit──▶ target
 tx_core.py       tx_parse.py                 tx_sema.py                      tx_emit.py / tx_emit_c.py
```

| file | job |
|---|---|
| `tx_core.py` | `Ty` types, IR `N` node, lexer for all four languages (indent handling, f-strings, templates, comments) |
| `tx_parse.py` | one recursive-descent parser per family (Python / C-like) that builds the same IR; maps library calls to canonical `Intr` nodes |
| `tx_sema.py` | scoping, **type inference** (call-site + return propagation), hoisting of Python-scoped variables, int-vs-float division, char arithmetic, method canonicalisation by receiver type, lowering (comprehensions, `zip`, string builders…) |
| `tx_emit.py` | Python + JavaScript generators |
| `tx_emit_c.py` | C++ + Java generators (types, includes/imports, helpers emitted only when used) |
| `transpiler.py` | `convert(code, src, tgt)` |
| `convert_cli.py` | stdin/stdout JSON wrapper used by the server; syntax-checks the result with `python`, `node`, `g++`, `javac` when installed |
| `test_transpiler.py` | round-trip tests: run the source, convert, run the result, compare output |

## What it handles

Variables and arithmetic (with correct integer/float division), `if/elif/else`, `while`,
`do-while`, `for` (range, counted, for-each, `enumerate`, `zip`, dict items), `switch`,
`try/catch/finally`, functions (recursion, defaults, globals), lists/arrays/vectors,
dicts/maps, sets, strings and most string/list/dict methods, slicing, comprehensions,
formatted output (`f""`, `.format`, `%`, `printf`, `cout << fixed << setprecision`),
stdin reading (`input`, `cin`, `Scanner`), classes with fields, constructors,
inheritance, static members, `toString`/`__str__`, sorting with key/comparator, and the
common `Math`/`math`/`<cmath>` functions.

## What it refuses

Anything it cannot translate faithfully raises `Unsupported` (pointers, templates,
generators, `async`, multiple inheritance, tuples when targeting C++/Java, …). It never
emits a guess: the caller falls back to the API instead.

## Extending

1. Parsing a new construct: add it in `tx_parse.py` and produce existing IR nodes where possible.
2. A new library call: add it to the `simple` table in `make_call_inner` (language neutral) or to the
   `canon_*` methods in `tx_sema.py` (receiver-type dependent), then implement `in_<name>` in each emitter.
3. Add a program to `test_transpiler.py` and run `python test_transpiler.py`.
