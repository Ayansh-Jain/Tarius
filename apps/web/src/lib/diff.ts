/**
 * Line + intra-line diff used to show exactly what the AI changed.
 *
 * `diffLines` compares old/new text and returns unified rows. Lines that were
 * modified (a removed line paired with an added line) also carry word-level
 * segments so the precise edited tokens can be highlighted inside the line.
 */
export interface Seg {
  text: string;
  /** True for the part of the line that actually differs. */
  changed: boolean;
}

export interface DiffRow {
  kind: 'eq' | 'del' | 'add';
  /** 1-based line numbers (undefined on the side where the line does not exist). */
  oldNo?: number;
  newNo?: number;
  segs: Seg[];
}

export interface DiffResult {
  rows: DiffRow[];
  added: number;
  removed: number;
  /** Count of changed regions (hunks). */
  hunks: number;
}

/** Same-length-pair LCS on arrays; returns matched index pairs. */
function lcsPairs<T>(a: T[], b: T[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1]! + 1 : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
    }
  }
  const out: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push([i, j]);
      i++;
      j++;
    } else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) i++;
    else j++;
  }
  return out;
}

/** Generic diff of two token arrays into eq/del/add ops, with prefix/suffix trimming. */
function diffArrays<T>(a: T[], b: T[]): Array<{ op: 'eq' | 'del' | 'add'; i?: number; j?: number }> {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const ops: Array<{ op: 'eq' | 'del' | 'add'; i?: number; j?: number }> = [];
  for (let k = 0; k < start; k++) ops.push({ op: 'eq', i: k, j: k });

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length * midB.length > 4_000_000) {
    // Too big for the DP table: treat the whole middle as replaced.
    midA.forEach((_, k) => ops.push({ op: 'del', i: start + k }));
    midB.forEach((_, k) => ops.push({ op: 'add', j: start + k }));
  } else {
    let pi = 0;
    let pj = 0;
    for (const [mi, mj] of lcsPairs(midA, midB)) {
      while (pi < mi) ops.push({ op: 'del', i: start + pi++ });
      while (pj < mj) ops.push({ op: 'add', j: start + pj++ });
      ops.push({ op: 'eq', i: start + mi, j: start + mj });
      pi = mi + 1;
      pj = mj + 1;
    }
    while (pi < midA.length) ops.push({ op: 'del', i: start + pi++ });
    while (pj < midB.length) ops.push({ op: 'add', j: start + pj++ });
  }
  for (let k = endA; k < a.length; k++) ops.push({ op: 'eq', i: k, j: endB + (k - endA) });
  return ops;
}

const TOKEN_RE = /[A-Za-z0-9_]+|\s+|[^\sA-Za-z0-9_]/g;

/** Word-level segments for a removed/added line pair. */
function intraLine(oldLine: string, newLine: string): { oldSegs: Seg[]; newSegs: Seg[] } {
  const a = oldLine.match(TOKEN_RE) ?? [];
  const b = newLine.match(TOKEN_RE) ?? [];
  const oldSegs: Seg[] = [];
  const newSegs: Seg[] = [];
  const push = (segs: Seg[], text: string, changed: boolean): void => {
    const last = segs[segs.length - 1];
    if (last && last.changed === changed) last.text += text;
    else segs.push({ text, changed });
  };
  for (const o of diffArrays(a, b)) {
    if (o.op === 'eq') {
      push(oldSegs, a[o.i!]!, false);
      push(newSegs, b[o.j!]!, false);
    } else if (o.op === 'del') push(oldSegs, a[o.i!]!, true);
    else push(newSegs, b[o.j!]!, true);
  }
  return { oldSegs, newSegs };
}

/** Lines are only worth pairing for word-level highlighting if they are alike enough. */
function similar(a: string, b: string): boolean {
  const ta = new Set(a.match(TOKEN_RE) ?? []);
  const tb = b.match(TOKEN_RE) ?? [];
  if (ta.size === 0 || tb.length === 0) return false;
  let hit = 0;
  for (const t of tb) if (ta.has(t)) hit++;
  return hit / Math.max(tb.length, ta.size) >= 0.4;
}

export function diffLines(oldText: string, newText: string): DiffResult {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const ops = diffArrays(a, b);

  const rows: DiffRow[] = [];
  let added = 0;
  let removed = 0;
  let hunks = 0;

  let k = 0;
  while (k < ops.length) {
    const op = ops[k]!;
    if (op.op === 'eq') {
      rows.push({ kind: 'eq', oldNo: op.i! + 1, newNo: op.j! + 1, segs: [{ text: a[op.i!]!, changed: false }] });
      k++;
      continue;
    }
    // Collect one run of consecutive del/add ops (a hunk).
    const dels: number[] = [];
    const adds: number[] = [];
    while (k < ops.length && ops[k]!.op !== 'eq') {
      const o = ops[k]!;
      if (o.op === 'del') dels.push(o.i!);
      else adds.push(o.j!);
      k++;
    }
    hunks++;
    removed += dels.length;
    added += adds.length;

    const delRows: DiffRow[] = dels.map((i) => ({ kind: 'del', oldNo: i + 1, segs: [{ text: a[i]!, changed: true }] }));
    const addRows: DiffRow[] = adds.map((j) => ({ kind: 'add', newNo: j + 1, segs: [{ text: b[j]!, changed: true }] }));
    // Pair modified lines positionally to expose the exact edited tokens.
    const pairs = Math.min(delRows.length, addRows.length);
    for (let p = 0; p < pairs; p++) {
      const oi = dels[p]!;
      const nj = adds[p]!;
      if (similar(a[oi]!, b[nj]!)) {
        const { oldSegs, newSegs } = intraLine(a[oi]!, b[nj]!);
        delRows[p]!.segs = oldSegs;
        addRows[p]!.segs = newSegs;
      }
    }
    rows.push(...delRows, ...addRows);
  }
  return { rows, added, removed, hunks };
}

/**
 * Smallest single replacement turning `oldText` into `newText`:
 * the common prefix/suffix stay untouched (keeps cursors and history intact).
 */
export function minimalReplace(
  oldText: string,
  newText: string,
): { index: number; remove: number; insert: string } {
  let start = 0;
  const max = Math.min(oldText.length, newText.length);
  while (start < max && oldText[start] === newText[start]) start++;
  let endOld = oldText.length;
  let endNew = newText.length;
  while (endOld > start && endNew > start && oldText[endOld - 1] === newText[endNew - 1]) {
    endOld--;
    endNew--;
  }
  return { index: start, remove: endOld - start, insert: newText.slice(start, endNew) };
}
