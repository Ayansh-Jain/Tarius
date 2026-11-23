#!/usr/bin/env python3
"""
altern_tests.py: single-file Altern code-conversion test suite
===============================================================
Contains all 22 advanced test cases (C, C++, Python) and the runner.
Each case has: input program, hand-written expected translation, expected output.
The expected translations were verified with gcc -std=c11, g++ -std=c++17 -Wall
and Python 3 (source and expected translation print identical output).

Commands
  python altern_tests.py run <folder containing engine_v2.py>
        Translates every case with engine_v2.full_translate, runs the result,
        compares it with the expected output and writes results.csv.
  python altern_tests.py export [out_dir]
        Writes every case as files (source / expected translation / expected output)
        into out_dir (default: ./cases).
  python altern_tests.py list
        Prints the test IDs and modules.

Requires gcc, g++ and python3 on PATH.
To add a case, append one dict to CASES (keys: id, module, sl, rl, src, ref, out);
languages are "c", "cpp" or "py".
Edit LANG_NAMES if full_translate expects different language names.
"""
import csv, importlib, json, os, re, subprocess, sys, tempfile

LANG_NAMES = {"c": "c", "cpp": "cpp", "py": "python"}   # adjust to engine_v2's naming
EXT = {"c": "c", "cpp": "cpp", "py": "py"}
TIMEOUT = 10

CASES = [
 {
  "id": "TC-F01",
  "module": "Classes: constructor, private member, methods",
  "sl": "cpp",
  "rl": "py",
  "src": "#include <iostream>\nusing namespace std;\nclass Counter {\nprivate:\n    int count;\npublic:\n    Counter(int start) : count(start) {}\n    void increment() { count++; }\n    int get() const { return count; }\n};\nint main() {\n    Counter c(5);\n    c.increment();\n    c.increment();\n    cout << c.get() << endl;\n    return 0;\n}",
  "ref": "class Counter:\n    def __init__(self, start):\n        self._count = start\n    def increment(self):\n        self._count += 1\n    def get(self):\n        return self._count\nc = Counter(5)\nc.increment()\nc.increment()\nprint(c.get())",
  "out": "7"
 },
 {
  "id": "TC-F02",
  "module": "Inheritance, virtual functions, polymorphism",
  "sl": "cpp",
  "rl": "py",
  "src": "#include <iostream>\n#include <string>\nusing namespace std;\nclass Animal {\npublic:\n    virtual string speak() { return \"...\"; }\n    virtual ~Animal() {}\n};\nclass Dog : public Animal {\npublic:\n    string speak() override { return \"Woof\"; }\n};\nclass Cat : public Animal {\npublic:\n    string speak() override { return \"Meow\"; }\n};\nint main() {\n    Animal* pets[3] = { new Dog(), new Cat(), new Animal() };\n    for (int i = 0; i < 3; i++) {\n        cout << pets[i]->speak() << endl;\n        delete pets[i];\n    }\n    return 0;\n}",
  "ref": "class Animal:\n    def speak(self):\n        return \"...\"\nclass Dog(Animal):\n    def speak(self):\n        return \"Woof\"\nclass Cat(Animal):\n    def speak(self):\n        return \"Meow\"\npets = [Dog(), Cat(), Animal()]\nfor p in pets:\n    print(p.speak())",
  "out": "Woof\nMeow\n..."
 },
 {
  "id": "TC-F03",
  "module": "Function templates (generic programming)",
  "sl": "cpp",
  "rl": "py",
  "src": "#include <iostream>\nusing namespace std;\ntemplate <typename T>\nT maxOf(T a, T b) {\n    return (a > b) ? a : b;\n}\nint main() {\n    cout << maxOf(3, 7) << \" \" << maxOf(2.5, 1.5) << \" \" << maxOf('a', 'z') << endl;\n    return 0;\n}",
  "ref": "def max_of(a, b):\n    return a if a > b else b\nprint(max_of(3, 7), max_of(2.5, 1.5), max_of('a', 'z'))",
  "out": "7 2.5 z"
 },
 {
  "id": "TC-F04",
  "module": "Class templates (generic Stack<T>)",
  "sl": "cpp",
  "rl": "py",
  "src": "#include <iostream>\n#include <string>\n#include <vector>\nusing namespace std;\ntemplate <typename T>\nclass Stack {\n    vector<T> items;\npublic:\n    void push(T x) { items.push_back(x); }\n    T pop() {\n        T x = items.back();\n        items.pop_back();\n        return x;\n    }\n    int size() const { return items.size(); }\n};\nint main() {\n    Stack<int> s;\n    s.push(10); s.push(20); s.push(30);\n    int top = s.pop();\n    cout << top << \" \" << s.size() << endl;\n    Stack<string> t;\n    t.push(\"a\"); t.push(\"b\");\n    cout << t.pop() << endl;\n    return 0;\n}",
  "ref": "class Stack:\n    def __init__(self):\n        self.items = []\n    def push(self, x):\n        self.items.append(x)\n    def pop(self):\n        return self.items.pop()\n    def size(self):\n        return len(self.items)\ns = Stack()\ns.push(10)\ns.push(20)\ns.push(30)\ntop = s.pop()\nprint(top, s.size())\nt = Stack()\nt.push(\"a\")\nt.push(\"b\")\nprint(t.pop())",
  "out": "30 2\nb"
 },
 {
  "id": "TC-F05",
  "module": "Operator overloading (+ and ==)",
  "sl": "cpp",
  "rl": "py",
  "src": "#include <iostream>\nusing namespace std;\nstruct Vec {\n    int x, y;\n    Vec(int x, int y) : x(x), y(y) {}\n    Vec operator+(const Vec& o) const { return Vec(x + o.x, y + o.y); }\n    bool operator==(const Vec& o) const { return x == o.x && y == o.y; }\n};\nint main() {\n    Vec a(1, 2), b(3, 4);\n    Vec c = a + b;\n    cout << c.x << \",\" << c.y << endl;\n    cout << (a == b ? \"equal\" : \"different\") << endl;\n    return 0;\n}",
  "ref": "class Vec:\n    def __init__(self, x, y):\n        self.x = x\n        self.y = y\n    def __add__(self, o):\n        return Vec(self.x + o.x, self.y + o.y)\n    def __eq__(self, o):\n        return self.x == o.x and self.y == o.y\na = Vec(1, 2)\nb = Vec(3, 4)\nc = a + b\nprint(str(c.x) + \",\" + str(c.y))\nprint(\"equal\" if a == b else \"different\")",
  "out": "4,6\ndifferent"
 },
 {
  "id": "TC-F06",
  "module": "STL containers: map, vector, range-for",
  "sl": "cpp",
  "rl": "py",
  "src": "#include <iostream>\n#include <map>\n#include <string>\n#include <vector>\nusing namespace std;\nint main() {\n    vector<string> words = {\"to\", \"be\", \"or\", \"not\", \"to\", \"be\"};\n    map<string, int> freq;\n    for (const string& w : words) freq[w]++;\n    for (auto& kv : freq) cout << kv.first << \":\" << kv.second << endl;\n    return 0;\n}",
  "ref": "words = [\"to\", \"be\", \"or\", \"not\", \"to\", \"be\"]\nfreq = {}\nfor w in words:\n    freq[w] = freq.get(w, 0) + 1\nfor k, v in sorted(freq.items()):\n    print(str(k) + \":\" + str(v))",
  "out": "be:2\nnot:1\nor:1\nto:2"
 },
 {
  "id": "TC-F07",
  "module": "Exception handling (throw / try / catch)",
  "sl": "cpp",
  "rl": "py",
  "src": "#include <iostream>\n#include <stdexcept>\nusing namespace std;\nint divide(int a, int b) {\n    if (b == 0) throw runtime_error(\"division by zero\");\n    return a / b;\n}\nint main() {\n    try {\n        cout << divide(8, 2) << endl;\n        cout << divide(1, 0) << endl;\n    } catch (const runtime_error& e) {\n        cout << \"Error: \" << e.what() << endl;\n    }\n    return 0;\n}",
  "ref": "def divide(a, b):\n    if b == 0:\n        raise RuntimeError(\"division by zero\")\n    return a // b\ntry:\n    print(divide(8, 2))\n    print(divide(1, 0))\nexcept RuntimeError as e:\n    print(\"Error: \" + str(e))",
  "out": "4\nError: division by zero"
 },
 {
  "id": "TC-F08",
  "module": "STL algorithms with lambda (sort, comparator)",
  "sl": "cpp",
  "rl": "py",
  "src": "#include <algorithm>\n#include <iostream>\n#include <vector>\nusing namespace std;\nint main() {\n    vector<int> v = {5, 2, 9, 1};\n    sort(v.begin(), v.end(), [](int a, int b) { return a > b; });\n    for (size_t i = 0; i < v.size(); i++) {\n        if (i) cout << \" \";\n        cout << v[i];\n    }\n    cout << endl;\n    return 0;\n}",
  "ref": "v = [5, 2, 9, 1]\nv.sort(key=lambda a: a, reverse=True)\nprint(*v)",
  "out": "9 5 2 1"
 },
 {
  "id": "TC-F09",
  "module": "String processing (isalnum, tolower, two-pointer)",
  "sl": "cpp",
  "rl": "py",
  "src": "#include <cctype>\n#include <iostream>\n#include <string>\nusing namespace std;\nbool isPal(const string& s) {\n    string t;\n    for (char c : s)\n        if (isalnum((unsigned char)c)) t += (char)tolower((unsigned char)c);\n    int i = 0, j = (int)t.size() - 1;\n    while (i < j) {\n        if (t[i] != t[j]) return false;\n        i++; j--;\n    }\n    return true;\n}\nint main() {\n    cout << (isPal(\"A man, a plan, a canal: Panama\") ? \"True\" : \"False\") << endl;\n    cout << (isPal(\"hello\") ? \"True\" : \"False\") << endl;\n    return 0;\n}",
  "ref": "def is_pal(s):\n    t = \"\"\n    for c in s:\n        if c.isalnum():\n            t += c.lower()\n    i = 0\n    j = len(t) - 1\n    while i < j:\n        if t[i] != t[j]:\n            return False\n        i += 1\n        j -= 1\n    return True\nprint(\"True\" if is_pal(\"A man, a plan, a canal: Panama\") else \"False\")\nprint(\"True\" if is_pal(\"hello\") else \"False\")",
  "out": "True\nFalse"
 },
 {
  "id": "TC-G01",
  "module": "Pointers and dynamic memory (malloc / free / pointer arithmetic)",
  "sl": "c",
  "rl": "py",
  "src": "#include <stdio.h>\n#include <stdlib.h>\nint main() {\n    int n = 5;\n    int *arr = (int*)malloc(n * sizeof(int));\n    for (int i = 0; i < n; i++) *(arr + i) = (i + 1) * (i + 1);\n    int sum = 0;\n    for (int *p = arr; p < arr + n; p++) sum += *p;\n    printf(\"%d\\n\", sum);\n    free(arr);\n    return 0;\n}",
  "ref": "n = 5\narr = [0] * n\nfor i in range(n):\n    arr[i] = (i + 1) * (i + 1)\ntotal = 0\nfor v in arr:\n    total += v\nprint(total)",
  "out": "55"
 },
 {
  "id": "TC-G02",
  "module": "Call by reference through pointers (swap)",
  "sl": "c",
  "rl": "py",
  "src": "#include <stdio.h>\nvoid swap(int *a, int *b) {\n    int t = *a;\n    *a = *b;\n    *b = t;\n}\nint main() {\n    int x = 3, y = 8;\n    swap(&x, &y);\n    printf(\"%d %d\\n\", x, y);\n    return 0;\n}",
  "ref": "def swap(a, b):\n    return b, a\nx, y = 3, 8\nx, y = swap(x, y)\nprint(x, y)",
  "out": "8 3"
 },
 {
  "id": "TC-G03",
  "module": "Self-referential struct: linked list",
  "sl": "c",
  "rl": "py",
  "src": "#include <stdio.h>\n#include <stdlib.h>\nstruct Node {\n    int data;\n    struct Node *next;\n};\nstruct Node* push(struct Node *head, int v) {\n    struct Node *n = (struct Node*)malloc(sizeof(struct Node));\n    n->data = v;\n    n->next = head;\n    return n;\n}\nint main() {\n    struct Node *head = NULL;\n    for (int i = 1; i <= 4; i++) head = push(head, i);\n    for (struct Node *p = head; p != NULL; p = p->next)\n        printf(\"%d \", p->data);\n    printf(\"\\n\");\n    while (head) {\n        struct Node *t = head;\n        head = head->next;\n        free(t);\n    }\n    return 0;\n}",
  "ref": "class Node:\n    def __init__(self, data, next=None):\n        self.data = data\n        self.next = next\ndef push(head, v):\n    return Node(v, head)\nhead = None\nfor i in range(1, 5):\n    head = push(head, i)\np = head\nwhile p is not None:\n    print(p.data, end=\" \")\n    p = p.next\nprint()",
  "out": "4 3 2 1 "
 },
 {
  "id": "TC-G04",
  "module": "Function pointers / callbacks",
  "sl": "c",
  "rl": "py",
  "src": "#include <stdio.h>\nint square(int x) { return x * x; }\nint twice(int x) { return 2 * x; }\nint apply(int (*f)(int), int v) { return f(v); }\nint main() {\n    printf(\"%d %d\\n\", apply(square, 6), apply(twice, 6));\n    return 0;\n}",
  "ref": "def square(x):\n    return x * x\ndef twice(x):\n    return 2 * x\ndef apply(f, v):\n    return f(v)\nprint(apply(square, 6), apply(twice, 6))",
  "out": "36 12"
 },
 {
  "id": "TC-G05",
  "module": "2-D arrays: nested loops (matrix multiplication)",
  "sl": "c",
  "rl": "py",
  "src": "#include <stdio.h>\nint main() {\n    int A[2][2] = {{1, 2}, {3, 4}};\n    int B[2][2] = {{5, 6}, {7, 8}};\n    int C[2][2];\n    for (int i = 0; i < 2; i++) {\n        for (int j = 0; j < 2; j++) {\n            C[i][j] = 0;\n            for (int k = 0; k < 2; k++)\n                C[i][j] += A[i][k] * B[k][j];\n        }\n    }\n    for (int i = 0; i < 2; i++)\n        printf(\"%d %d\\n\", C[i][0], C[i][1]);\n    return 0;\n}",
  "ref": "A = [[1, 2], [3, 4]]\nB = [[5, 6], [7, 8]]\nC = [[0, 0], [0, 0]]\nfor i in range(2):\n    for j in range(2):\n        C[i][j] = 0\n        for k in range(2):\n            C[i][j] += A[i][k] * B[k][j]\nfor i in range(2):\n    print(C[i][0], C[i][1])",
  "out": "19 22\n43 50"
 },
 {
  "id": "TC-G06",
  "module": "Bitwise operators and shifts (popcount)",
  "sl": "c",
  "rl": "py",
  "src": "#include <stdio.h>\nint main() {\n    unsigned int n = 29;\n    int count = 0;\n    while (n) {\n        count += n & 1;\n        n >>= 1;\n    }\n    printf(\"%d\\n\", count);\n    return 0;\n}",
  "ref": "n = 29\ncount = 0\nwhile n:\n    count += n & 1\n    n >>= 1\nprint(count)",
  "out": "4"
 },
 {
  "id": "TC-H01",
  "module": "List comprehension and lambda",
  "sl": "py",
  "rl": "cpp",
  "src": "nums = [1, 2, 3, 4, 5, 6]\nsquares = [x * x for x in nums if x % 2 == 0]\ndouble = lambda x: x * 2\nprint(squares)\nprint(double(21))",
  "ref": "#include <iostream>\n#include <vector>\nusing namespace std;\nint main() {\n    vector<int> nums = {1, 2, 3, 4, 5, 6};\n    vector<int> squares;\n    for (int x : nums)\n        if (x % 2 == 0) squares.push_back(x * x);\n    auto dbl = [](int x) { return x * 2; };\n    cout << \"[\";\n    for (size_t i = 0; i < squares.size(); i++) {\n        if (i) cout << \", \";\n        cout << squares[i];\n    }\n    cout << \"]\" << endl;\n    cout << dbl(21) << endl;\n    return 0;\n}",
  "out": "[4, 16, 36]\n42"
 },
 {
  "id": "TC-H02",
  "module": "Class inheritance with super()",
  "sl": "py",
  "rl": "cpp",
  "src": "class Account:\n    def __init__(self, balance):\n        self.balance = balance\n    def deposit(self, amt):\n        self.balance += amt\nclass Savings(Account):\n    def __init__(self, balance, rate):\n        super().__init__(balance)\n        self.rate = rate\n    def add_interest(self):\n        self.balance += self.balance * self.rate // 100\ns = Savings(1000, 5)\ns.deposit(200)\ns.add_interest()\nprint(s.balance)",
  "ref": "#include <iostream>\nusing namespace std;\nclass Account {\npublic:\n    int balance;\n    Account(int b) : balance(b) {}\n    void deposit(int amt) { balance += amt; }\n};\nclass Savings : public Account {\npublic:\n    int rate;\n    Savings(int b, int r) : Account(b), rate(r) {}\n    void add_interest() { balance += balance * rate / 100; }\n};\nint main() {\n    Savings s(1000, 5);\n    s.deposit(200);\n    s.add_interest();\n    cout << s.balance << endl;\n    return 0;\n}",
  "out": "1260"
 },
 {
  "id": "TC-H03",
  "module": "Dictionary (insert, update, sorted iteration)",
  "sl": "py",
  "rl": "cpp",
  "src": "stock = {\"apple\": 3, \"pear\": 5}\nstock[\"apple\"] += 2\nstock[\"kiwi\"] = 1\nfor k in sorted(stock):\n    print(k, stock[k])",
  "ref": "#include <iostream>\n#include <map>\n#include <string>\nusing namespace std;\nint main() {\n    map<string, int> stock = {{\"apple\", 3}, {\"pear\", 5}};\n    stock[\"apple\"] += 2;\n    stock[\"kiwi\"] = 1;\n    for (auto& kv : stock)\n        cout << kv.first << \" \" << kv.second << endl;\n    return 0;\n}",
  "out": "apple 5\nkiwi 1\npear 5"
 },
 {
  "id": "TC-H04",
  "module": "Exception handling (try / except)",
  "sl": "py",
  "rl": "cpp",
  "src": "def safe_div(a, b):\n    try:\n        return a // b\n    except ZeroDivisionError:\n        return -1\nprint(safe_div(9, 3))\nprint(safe_div(9, 0))",
  "ref": "#include <iostream>\n#include <stdexcept>\nusing namespace std;\nint safe_div(int a, int b) {\n    try {\n        if (b == 0) throw runtime_error(\"division by zero\");\n        return a / b;\n    } catch (const runtime_error&) {\n        return -1;\n    }\n}\nint main() {\n    cout << safe_div(9, 3) << endl;\n    cout << safe_div(9, 0) << endl;\n    return 0;\n}",
  "out": "3\n-1"
 },
 {
  "id": "TC-H05",
  "module": "In-place list sorting (bubble sort, element swap)",
  "sl": "py",
  "rl": "c",
  "src": "def bubble_sort(arr):\n    n = len(arr)\n    for i in range(n - 1):\n        for j in range(n - 1 - i):\n            if arr[j] > arr[j + 1]:\n                arr[j], arr[j + 1] = arr[j + 1], arr[j]\ndata = [64, 25, 12, 22, 11]\nbubble_sort(data)\nprint(data)",
  "ref": "#include <stdio.h>\nvoid bubble_sort(int arr[], int n) {\n    for (int i = 0; i < n - 1; i++) {\n        for (int j = 0; j < n - 1 - i; j++) {\n            if (arr[j] > arr[j + 1]) {\n                int t = arr[j];\n                arr[j] = arr[j + 1];\n                arr[j + 1] = t;\n            }\n        }\n    }\n}\nint main() {\n    int data[] = {64, 25, 12, 22, 11};\n    int n = 5;\n    bubble_sort(data, n);\n    printf(\"[\");\n    for (int i = 0; i < n; i++) {\n        if (i) printf(\", \");\n        printf(\"%d\", data[i]);\n    }\n    printf(\"]\\n\");\n    return 0;\n}",
  "out": "[11, 12, 22, 25, 64]"
 },
 {
  "id": "TC-I01",
  "module": "Struct + functions to class with member functions",
  "sl": "c",
  "rl": "cpp",
  "src": "#include <stdio.h>\nstruct Rect {\n    int w;\n    int h;\n};\nint area(struct Rect *r) { return r->w * r->h; }\nvoid scale(struct Rect *r, int k) {\n    r->w *= k;\n    r->h *= k;\n}\nint main() {\n    struct Rect r = {2, 3};\n    scale(&r, 2);\n    printf(\"%d\\n\", area(&r));\n    return 0;\n}",
  "ref": "#include <iostream>\nusing namespace std;\nclass Rect {\npublic:\n    int w, h;\n    Rect(int w, int h) : w(w), h(h) {}\n    int area() const { return w * h; }\n    void scale(int k) { w *= k; h *= k; }\n};\nint main() {\n    Rect r(2, 3);\n    r.scale(2);\n    cout << r.area() << endl;\n    return 0;\n}",
  "out": "24"
 },
 {
  "id": "TC-I02",
  "module": "Class with methods to struct + free functions",
  "sl": "cpp",
  "rl": "c",
  "src": "#include <iostream>\nusing namespace std;\nclass Account {\n    int balance;\npublic:\n    Account(int b) : balance(b) {}\n    bool withdraw(int amt) {\n        if (amt > balance) return false;\n        balance -= amt;\n        return true;\n    }\n    int get() const { return balance; }\n};\nint main() {\n    Account acc(100);\n    bool r1 = acc.withdraw(30);\n    bool r2 = acc.withdraw(100);\n    cout << r1 << \" \" << r2 << \" \" << acc.get() << endl;\n    return 0;\n}",
  "ref": "#include <stdio.h>\n#include <stdbool.h>\nstruct Account {\n    int balance;\n};\nvoid account_init(struct Account *a, int b) { a->balance = b; }\nbool account_withdraw(struct Account *a, int amt) {\n    if (amt > a->balance) return false;\n    a->balance -= amt;\n    return true;\n}\nint account_get(const struct Account *a) { return a->balance; }\nint main() {\n    struct Account acc;\n    account_init(&acc, 100);\n    bool r1 = account_withdraw(&acc, 30);\n    bool r2 = account_withdraw(&acc, 100);\n    printf(\"%d %d %d\\n\", r1, r2, account_get(&acc));\n    return 0;\n}",
  "out": "1 0 70"
 }
]

def strip_fences(t):
    m = re.search(r"```[a-zA-Z+]*\n(.*?)```", t, re.S)
    return m.group(1) if m else t

def norm(s):
    return "\n".join(l.rstrip() for l in s.strip().splitlines())

def execute(code, lang, d, name):
    p = os.path.join(d, f"{name}.{EXT[lang]}")
    open(p, "w").write(code)
    if lang == "py":
        cmd = [sys.executable, p]
    else:
        exe = os.path.join(d, name + ".bin")
        cc = ["gcc", "-std=c11"] if lang == "c" else ["g++", "-std=c++17"]
        c = subprocess.run(cc + [p, "-o", exe], capture_output=True, text=True)
        if c.returncode:
            first = c.stderr.strip().splitlines()[0][:300] if c.stderr.strip() else ""
            return None, "Compile error: " + first
        cmd = [exe]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=TIMEOUT)
    except subprocess.TimeoutExpired:
        return None, "Runtime error: timeout"
    if r.returncode:
        return r.stdout, f"Runtime error (exit {r.returncode}): {r.stderr.strip()[:200]}"
    return r.stdout, ""

def run(engine_dir):
    sys.path.insert(0, engine_dir)
    engine = importlib.import_module("engine_v2")
    rows = []
    with tempfile.TemporaryDirectory() as d:
        for c in CASES:
            actual, err, status = "", "", "FAIL"
            try:
                res = engine.full_translate(c["src"], LANG_NAMES[c["sl"]], LANG_NAMES[c["rl"]])
                if isinstance(res, (tuple, list)):
                    res = res[0]
                out, err = execute(strip_fences(str(res)), c["rl"], d, c["id"].replace("-", "_"))
                actual = (out or "").strip()
                if not err:
                    if norm(actual) == norm(c["out"]): status = "PASS"
                    else: err = "Output mismatch"
            except Exception as e:
                err = "Translator exception: " + str(e)[:200]
            rows.append([c["id"], status, actual, err])
            print(c["id"], status, err)
    with open("results.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["Test ID", "Status", "Actual output", "Error"])
        w.writerows(rows)
    print(f"\n{sum(r[1] == 'PASS' for r in rows)}/{len(rows)} passed. Wrote results.csv")

def export(out_dir):
    for c in CASES:
        d = os.path.join(out_dir, c["id"]); os.makedirs(d, exist_ok=True)
        open(os.path.join(d, f"source.{EXT[c['sl']]}"), "w").write(c["src"] + "\n")
        open(os.path.join(d, f"expected_translation.{EXT[c['rl']]}"), "w").write(c["ref"] + "\n")
        open(os.path.join(d, "expected_output.txt"), "w").write(c["out"] + "\n")
        json.dump({"id": c["id"], "module": c["module"], "source_language": c["sl"],
                   "target_language": c["rl"]}, open(os.path.join(d, "meta.json"), "w"), indent=2)
    print(f"Exported {len(CASES)} cases to {out_dir}")

if __name__ == "__main__":
    a = sys.argv[1:]
    if a[:1] == ["run"]: run(a[1] if len(a) > 1 else ".")
    elif a[:1] == ["export"]: export(a[1] if len(a) > 1 else "cases")
    elif a[:1] == ["list"]:
        for c in CASES: print(c["id"], c["sl"], "->", c["rl"], "|", c["module"])
    else: print(__doc__)
