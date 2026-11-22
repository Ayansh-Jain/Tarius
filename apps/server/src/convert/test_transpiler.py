"""
Round-trip tests for the offline converter.

Every sample program is run natively, converted into each other language, run
again, and the printed output compared. Toolchains that are not installed
(node, g++, javac) are skipped, so the suite runs anywhere.

    python -m unittest apps/server/src/convert/test_transpiler.py
    python apps/server/src/convert/test_transpiler.py
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from tx_core import Unsupported  # noqa: E402
from transpiler import convert  # noqa: E402

NODE = shutil.which("node")
GPP = shutil.which("g++")
JAVAC = shutil.which("javac")
JAVA = shutil.which("java")

EXT = {"python": "py", "javascript": "js", "cpp": "cpp", "java": "java"}


def _w(path, text):
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def run(lang, code, stdin=""):
    d = tempfile.mkdtemp()
    try:
        if lang == "python":
            p = os.path.join(d, "a.py")
            _w(p, code)
            cmd = [sys.executable, "-I", p]
        elif lang == "javascript":
            p = os.path.join(d, "a.js")
            _w(p, code)
            cmd = [NODE, p]
        elif lang == "cpp":
            p = os.path.join(d, "a.cpp")
            _w(p, code)
            r = subprocess.run([GPP, "-std=c++11", "-o", os.path.join(d, "a.exe"), p],
                               capture_output=True, text=True, timeout=90)
            if r.returncode:
                raise AssertionError("C++ did not compile:\n" + r.stderr[:1500] + "\n" + code)
            cmd = [os.path.join(d, "a.exe")]
        else:
            p = os.path.join(d, "Main.java")
            _w(p, code)
            r = subprocess.run([JAVAC, "-encoding", "UTF-8", "-d", d, p], capture_output=True, text=True, timeout=90)
            if r.returncode:
                raise AssertionError("Java did not compile:\n" + r.stderr[:1500] + "\n" + code)
            cmd = [JAVA, "-cp", d, "Main"]
        r = subprocess.run(cmd, input=stdin, capture_output=True, text=True, timeout=30,
                           encoding="utf-8", errors="replace")
        if r.returncode:
            raise AssertionError("%s failed:\n%s\n%s" % (lang, (r.stdout + r.stderr)[:1500], code))
        return r.stdout
    finally:
        shutil.rmtree(d, ignore_errors=True)


def norm(s):
    s = re.sub(r"(?<![\d.])(\d+)\.0(?!\d)", lambda m: m.group(1), s)
    s = s.replace("True", "true").replace("False", "false")
    return "\n".join(l.rstrip() for l in s.replace("\r\n", "\n").strip().split("\n"))


def available(lang):
    return {"python": True, "javascript": bool(NODE), "cpp": bool(GPP), "java": bool(JAVAC and JAVA)}[lang]


PROGRAMS = {
    "python": [
        ("functions", r'''
def fact(n):
    if n <= 1:
        return 1
    return n * fact(n - 1)

def is_prime(n):
    if n < 2:
        return False
    i = 2
    while i * i <= n:
        if n % i == 0:
            return False
        i += 1
    return True

print(fact(10))
for p in range(2, 30):
    if is_prime(p):
        print(p)
''', ""),
        ("lists_strings", r'''
nums = [5, 2, 9, 1]
total = 0
for n in nums:
    total += n
print("sum", total, len(nums), max(nums))
s = "hello world"
rev = ""
for ch in s:
    rev = ch + rev
print(rev.upper(), s.find("world"), s.replace("o", "0"))
squares = [i * i for i in range(1, 6)]
print(squares[4], sum(squares))
print(f"{total / 4:.2f}")
''', ""),
        ("classes", r'''
class Account:
    def __init__(self, owner, balance):
        self.owner = owner
        self.balance = balance

    def deposit(self, amount):
        self.balance += amount

    def show(self):
        print(self.owner, self.balance)

class Savings(Account):
    def __init__(self, owner, balance, rate):
        super().__init__(owner, balance)
        self.rate = rate

    def add_interest(self):
        self.balance += self.balance * self.rate // 100

a = Savings("ann", 200, 10)
a.deposit(50)
a.add_interest()
a.show()
''', ""),
        ("input_dict", r'''
n = int(input())
counts = {}
for i in range(n):
    w = input()
    counts[w] = counts.get(w, 0) + 1
for k in sorted(counts):
    print(k, counts[k])
''', "4\nb\na\nb\nc\n"),
    ],
    "cpp": [
        ("basic", r'''
#include <iostream>
#include <vector>
#include <string>
using namespace std;

int fib(int n) {
    int a = 0, b = 1;
    for (int i = 0; i < n; i++) {
        int t = a + b;
        a = b;
        b = t;
    }
    return a;
}

int main() {
    vector<int> v = {5, 2, 9};
    int sum = 0;
    for (int x : v) sum += x;
    cout << "sum " << sum << endl;
    cout << fib(15) << endl;
    string s = "abc";
    for (int i = s.length() - 1; i >= 0; i--) cout << s[i];
    cout << endl;
    return 0;
}
''', ""),
    ],
    "java": [
        ("basic", r'''
public class Main {
    static int gcd(int a, int b) {
        while (b != 0) {
            int t = b;
            b = a % b;
            a = t;
        }
        return a;
    }
    public static void main(String[] args) {
        System.out.println(gcd(48, 18));
        int[] arr = {3, 1, 2};
        int s = 0;
        for (int x : arr) s += x;
        System.out.println("s=" + s);
    }
}
''', ""),
    ],
    "javascript": [
        ("basic", r'''
function square(x) { return x * x; }
let total = 0;
for (let i = 1; i <= 5; i++) total += square(i);
console.log("total", total);
const words = ["a", "b", "c"];
console.log(words.join("-"), words.length);
''', ""),
    ],
}


def make_test(src, name, code, stdin, tgt):
    def t(self):
        if not available(src) or not available(tgt):
            self.skipTest("toolchain not installed")
        expected = run(src, code, stdin)
        try:
            out = convert(code, src, tgt)
        except Unsupported as e:
            self.fail("unsupported: %s" % e)
        got = run(tgt, out, stdin)
        self.assertEqual(norm(got), norm(expected), "converted code:\n" + out)
    return t


class RoundTrip(unittest.TestCase):
    pass


for _src, _progs in PROGRAMS.items():
    for _name, _code, _stdin in _progs:
        for _tgt in EXT:
            if _tgt != _src:
                setattr(RoundTrip, "test_%s_%s_to_%s" % (_src, _name, _tgt), make_test(_src, _name, _code, _stdin, _tgt))


class Basics(unittest.TestCase):
    def test_same_language_is_identity(self):
        self.assertEqual(convert("print(1)\n", "python", "python"), "print(1)\n")

    def test_unsupported_is_reported_not_guessed(self):
        # a construct the engine cannot translate must raise, never emit wrong code
        with self.assertRaises(Unsupported):
            convert("class A { public: virtual ~A() {} };\nint main() { return 0; }", "cpp", "python")

    def test_user_function_shadows_builtin(self):
        out = convert("def gcd(a, b):\n    return a if b == 0 else gcd(b, a % b)\nprint(gcd(12, 18))\n",
                      "python", "javascript")
        self.assertIn("function gcd(", out)
        self.assertNotIn("_gcd", out)

    def test_int_division_semantics(self):
        out = convert("#include <iostream>\nint main(){ int a = 7, b = 2; std::cout << a / b << std::endl; }",
                      "cpp", "python")
        self.assertIn("int(a / b)", out)


if __name__ == "__main__":
    unittest.main(verbosity=2)
