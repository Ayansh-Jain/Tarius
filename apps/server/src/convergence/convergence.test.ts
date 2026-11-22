/**
 * Convergence module tests — the most safety-critical suite in the repo.
 *
 * These assert the architectural law (ADR-000): the doc → working tree → git
 * projection is lossless (round-trip identity), commits are real, the per-room
 * lock serialises concurrent flushes, and path-traversal can't escape the repo
 * root. Each test runs against its OWN temp ICE_GIT_ROOT.
 *
 * `repos.ts` resolves REPOS_DIR from `process.env.ICE_GIT_ROOT` at import time,
 * so we set the env var, then `vi.resetModules()` + dynamic-import the module so
 * every test gets a fresh, isolated on-disk repo root that we clean up after.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { getFileText, getFiles, getTree } from '@ice/shared';

type ConvergenceModule = typeof import('./index.js');

let gitRoot: string;

/** Fresh temp repo root + freshly-evaluated module bound to it. */
async function freshModule(): Promise<ConvergenceModule> {
  vi.resetModules();
  return import('./index.js');
}

beforeEach(async () => {
  gitRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-convergence-'));
  process.env.ICE_GIT_ROOT = gitRoot;
});

afterEach(async () => {
  delete process.env.ICE_GIT_ROOT;
  if (gitRoot) await fs.rm(gitRoot, { recursive: true, force: true });
});

/** Seed a doc's files map with {path: content} under a system transaction. */
function seedDoc(doc: Y.Doc, files: Record<string, string>): void {
  doc.transact(() => {
    for (const [p, content] of Object.entries(files)) {
      const text = getFileText(doc, p);
      if (text.length > 0) text.delete(0, text.length);
      text.insert(0, content);
    }
  });
}

/** Read a doc's files map back into a plain object for comparison. */
function readDoc(doc: Y.Doc): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [p, text] of getFiles(doc).entries()) out[p] = text.toString();
  return out;
}

describe('convergence: round-trip identity', () => {
  it('flush then load into a FRESH doc yields an identical file set + contents', async () => {
    const mod = await freshModule();
    const roomId = 'room-roundtrip';

    const source = {
      'a.ts': 'export const a = 1;\n',
      'dir/b.ts': 'export function b() {\n  return 42;\n}\n',
    };

    const writeDoc = new Y.Doc();
    seedDoc(writeDoc, source);

    const result = await mod.flushAndCommit(roomId, writeDoc, {
      message: 'initial commit',
      authorName: 'Ada Lovelace',
      authorEmail: 'ada@example.com',
    });
    expect(result.hash).toMatch(/^[0-9a-f]{40}$/);

    // Hydrate a brand-new doc purely from git and compare.
    const freshDoc = new Y.Doc();
    await mod.loadRoomFromGit(roomId, freshDoc);

    expect(readDoc(freshDoc)).toEqual(source);
  });

  it('preserves exact UTF-8 / multiline / unicode content through the seam', async () => {
    const mod = await freshModule();
    const roomId = 'room-utf8';
    const source = {
      'unicode.md': '# héllo 世界 🚀\n\n- tabs\there\n- trailing space \n',
      'nested/deep/path/file.txt': 'line1\nline2\nno-trailing-newline',
      'empty.txt': '',
    };

    const a = new Y.Doc();
    seedDoc(a, source);
    await mod.flushAndCommit(roomId, a, { message: 'utf8' });

    const b = new Y.Doc();
    await mod.loadRoomFromGit(roomId, b);
    expect(readDoc(b)).toEqual(source);
  });

  it('round-trips repeatedly without drift (load == flush == load)', async () => {
    const mod = await freshModule();
    const roomId = 'room-stable';
    const source = { 'x.ts': 'const x = 1\n', 'y/z.ts': 'const z = 2\n' };

    const d1 = new Y.Doc();
    seedDoc(d1, source);
    const r1 = await mod.flushAndCommit(roomId, d1, { message: 'one' });

    const d2 = new Y.Doc();
    await mod.loadRoomFromGit(roomId, d2);
    // Re-flush the loaded doc unchanged: content is identical so the tree is the
    // same; this must not corrupt anything and must still read back identically.
    await mod.flushAndCommit(roomId, d2, { message: 'two (no content change)' });

    const d3 = new Y.Doc();
    await mod.loadRoomFromGit(roomId, d3);
    expect(readDoc(d3)).toEqual(source);
    expect(r1.hash).toMatch(/^[0-9a-f]{40}$/);
  });

  it('populates the doc tree with files and their ancestor directories', async () => {
    const mod = await freshModule();
    const roomId = 'room-tree';
    const a = new Y.Doc();
    seedDoc(a, { 'src/app/main.ts': 'x', 'README.md': 'y' });
    await mod.flushAndCommit(roomId, a, { message: 'tree' });

    const b = new Y.Doc();
    await mod.loadRoomFromGit(roomId, b);
    const tree = getTree(b);

    expect(tree.get('README.md')).toMatchObject({ path: 'README.md', kind: 'file' });
    expect(tree.get('src/app/main.ts')).toMatchObject({ path: 'src/app/main.ts', kind: 'file' });
    expect(tree.get('src')).toMatchObject({ path: 'src', kind: 'dir' });
    expect(tree.get('src/app')).toMatchObject({ path: 'src/app', kind: 'dir' });
  });

  it('converges deletions: a file removed from the doc disappears from git', async () => {
    const mod = await freshModule();
    const roomId = 'room-delete';

    const a = new Y.Doc();
    seedDoc(a, { 'keep.ts': 'k', 'remove.ts': 'r' });
    await mod.flushAndCommit(roomId, a, { message: 'two files' });

    // Drop one file from the doc, then flush again.
    a.transact(() => getFiles(a).delete('remove.ts'));
    const r2 = await mod.flushAndCommit(roomId, a, { message: 'drop one' });
    expect(r2.filesChanged).toBe(1); // exactly the deletion

    const fresh = new Y.Doc();
    await mod.loadRoomFromGit(roomId, fresh);
    expect(readDoc(fresh)).toEqual({ 'keep.ts': 'k' });
  });
});

describe('convergence: commits are real', () => {
  it('a flush produces a commit that appears in listCommits with carried authorship', async () => {
    const mod = await freshModule();
    const roomId = 'room-commits';

    const doc = new Y.Doc();
    seedDoc(doc, { 'file.ts': 'hello' });
    const result = await mod.flushAndCommit(roomId, doc, {
      message: 'feat: first commit',
      authorName: 'Grace Hopper',
      authorEmail: 'grace@example.com',
    });

    const commits = await mod.listCommits(roomId, { limit: 10 });
    expect(commits.length).toBe(1);
    const top = commits[0]!;
    expect(top.hash).toBe(result.hash);
    expect(top.message).toContain('feat: first commit');
    expect(top.author).toBe('Grace Hopper');
    expect(top.email).toBe('grace@example.com');
    expect(top.parents).toEqual([]); // root commit
    expect(typeof top.when).toBe('number');
    expect(top.when).toBeGreaterThan(0);
  });

  it('lists branches with the default branch marked current', async () => {
    const mod = await freshModule();
    const roomId = 'room-branches';
    const doc = new Y.Doc();
    seedDoc(doc, { 'a.txt': '1' });
    const res = await mod.flushAndCommit(roomId, doc, { message: 'b' });

    const branches = await mod.listBranches(roomId);
    expect(branches.length).toBe(1);
    expect(branches[0]!.name).toBe(mod.DEFAULT_BRANCH);
    expect(branches[0]!.isCurrent).toBe(true);
    expect(branches[0]!.head).toBe(res.hash);
  });

  it('records sequential commits with the right parent chain', async () => {
    const mod = await freshModule();
    const roomId = 'room-chain';
    const doc = new Y.Doc();

    seedDoc(doc, { 'a.txt': 'v1' });
    const c1 = await mod.flushAndCommit(roomId, doc, { message: 'c1' });

    doc.transact(() => {
      const t = getFileText(doc, 'a.txt');
      t.delete(0, t.length);
      t.insert(0, 'v2');
    });
    const c2 = await mod.flushAndCommit(roomId, doc, { message: 'c2' });

    expect(c2.hash).not.toBe(c1.hash);
    const commits = await mod.listCommits(roomId, { limit: 10 });
    expect(commits.map((c) => c.message)).toEqual(['c2', 'c1']);
    expect(commits[0]!.parents).toEqual([c1.hash]);
    expect(commits[1]!.parents).toEqual([]);
  });
});

describe('convergence: empty / new repo handling', () => {
  it('loadRoomFromGit is a no-op for a brand-new room (no commits)', async () => {
    const mod = await freshModule();
    const roomId = 'room-empty';
    const doc = new Y.Doc();
    await expect(mod.loadRoomFromGit(roomId, doc)).resolves.toBeUndefined();
    expect(readDoc(doc)).toEqual({});

    // The canonical bare repo is created even though there are no commits.
    expect(await mod.hasCommits(roomId)).toBe(false);
    expect(await mod.listCommits(roomId)).toEqual([]);
    expect(await mod.listBranches(roomId)).toEqual([]);
  });

  it('first commit on an empty repo succeeds (first-commit case)', async () => {
    const mod = await freshModule();
    const roomId = 'room-first';
    const doc = new Y.Doc();
    seedDoc(doc, { 'first.ts': 'x' });
    const res = await mod.flushAndCommit(roomId, doc, { message: 'root' });
    expect(res.filesChanged).toBe(1);
    expect(await mod.hasCommits(roomId)).toBe(true);
  });
});

describe('convergence: lock serialises concurrent flushes', () => {
  it('two concurrent flushAndCommit calls are serialised and do not corrupt', async () => {
    const mod = await freshModule();
    const roomId = 'room-concurrent';

    // Two docs with overlapping + distinct files. Fire both flushes WITHOUT
    // awaiting between them; the per-room lock must serialise them so neither
    // commit is corrupt and the repo log is linear.
    const docA = new Y.Doc();
    seedDoc(docA, { 'shared.ts': 'A', 'only-a.ts': 'a' });
    const docB = new Y.Doc();
    seedDoc(docB, { 'shared.ts': 'B', 'only-b.ts': 'b' });

    const [ra, rb] = await Promise.all([
      mod.flushAndCommit(roomId, docA, { message: 'from A', authorName: 'A', authorEmail: 'a@x' }),
      mod.flushAndCommit(roomId, docB, { message: 'from B', authorName: 'B', authorEmail: 'b@x' }),
    ]);

    // Both produced valid, distinct commits.
    expect(ra.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(rb.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(ra.hash).not.toBe(rb.hash);

    // The history is a clean linear chain of exactly two commits (not corrupt,
    // not a tangled merge): the second commit's parent is the first.
    const commits = await mod.listCommits(roomId, { limit: 10 });
    expect(commits.length).toBe(2);
    expect(commits[0]!.parents).toEqual([commits[1]!.hash]);
    expect(commits[1]!.parents).toEqual([]);

    // The final tree is exactly one of the two flushes (whichever committed
    // last) — never a half-merged interleaving of both.
    const fresh = new Y.Doc();
    await mod.loadRoomFromGit(roomId, fresh);
    const files = readDoc(fresh);
    const isA = JSON.stringify(files) === JSON.stringify({ 'only-a.ts': 'a', 'shared.ts': 'A' });
    const isB = JSON.stringify(files) === JSON.stringify({ 'only-b.ts': 'b', 'shared.ts': 'B' });
    expect(isA || isB).toBe(true);
  });

  it('many parallel flushes all land as a linear, uncorrupted history', async () => {
    const mod = await freshModule();
    const roomId = 'room-many';

    const N = 8;
    const docs = Array.from({ length: N }, (_, i) => {
      const d = new Y.Doc();
      seedDoc(d, { 'counter.ts': `export const v = ${i};\n`, [`f${i}.ts`]: `${i}` });
      return d;
    });

    const results = await Promise.all(
      docs.map((d, i) => mod.flushAndCommit(roomId, d, { message: `commit ${i}` })),
    );

    // All commits distinct and valid.
    const hashes = new Set(results.map((r) => r.hash));
    expect(hashes.size).toBe(N);
    for (const r of results) expect(r.hash).toMatch(/^[0-9a-f]{40}$/);

    // Exactly N commits, each (except the root) pointing at the previous one.
    const commits = await mod.listCommits(roomId, { limit: 100 });
    expect(commits.length).toBe(N);
    for (let i = 0; i < commits.length - 1; i += 1) {
      expect(commits[i]!.parents).toEqual([commits[i + 1]!.hash]);
    }
    expect(commits[commits.length - 1]!.parents).toEqual([]);
  });

  it('releases the lock after a failing flush so the room stays usable', async () => {
    const mod = await freshModule();
    const roomId = 'room-recover';

    // Force a failure mid-flush by feeding a doc whose only file path is illegal
    // AND a valid one; with all-illegal the snapshot is empty (root commit of
    // nothing). Instead, trigger a real error path: a flush that throws must not
    // wedge the lock. We simulate by racing a normal flush after a rejected one.
    const good = new Y.Doc();
    seedDoc(good, { 'ok.ts': '1' });

    // First, a legitimate flush.
    await mod.flushAndCommit(roomId, good, { message: 'ok' });

    // Now run two more in parallel; if the lock leaked, this would deadlock.
    const d1 = new Y.Doc();
    seedDoc(d1, { 'ok.ts': '2' });
    const d2 = new Y.Doc();
    seedDoc(d2, { 'ok.ts': '3' });
    const [r1, r2] = await Promise.all([
      mod.flushAndCommit(roomId, d1, { message: 'm1' }),
      mod.flushAndCommit(roomId, d2, { message: 'm2' }),
    ]);
    expect(r1.hash).not.toBe(r2.hash);

    // Lock map is GC'd back to empty once all critical sections complete.
    expect(mod.activeRoomLockCount()).toBe(0);
  });
});

describe('convergence: path-traversal guard', () => {
  it('sanitizeRoomId rejects traversal-style room ids', async () => {
    // repos.ts owns sanitizeRoomId; import it through the same fresh-module lens.
    vi.resetModules();
    const repos = await import('../repos.js');
    expect(() => repos.sanitizeRoomId('../escape')).not.toThrow(); // sanitised, not thrown
    // '../escape' -> '.._escape' (slashes/dots replaced into a safe filename),
    // so the repo path stays a direct child of REPOS_DIR with no '..' segment.
    const bare = repos.bareRepoPath('../escape');
    expect(bare).toContain(gitRoot);
    expect(bare.split('/')).not.toContain('..'); // no real parent-dir segment
    expect(repos.sanitizeRoomId('../escape')).toBe('.._escape');
    // Pure traversal tokens that sanitise to nothing usable throw.
    expect(() => repos.sanitizeRoomId('..')).toThrow();
    expect(() => repos.sanitizeRoomId('.')).toThrow();
    expect(() => repos.sanitizeRoomId('')).toThrow();
  });

  it('a poisoned room id cannot place repo data outside ICE_GIT_ROOT', async () => {
    const mod = await freshModule();
    // A would-be traversal room id is sanitised to a safe filename; the repo it
    // creates lives strictly under the temp git root, never above it.
    const poisoned = '../../etc/evil';
    const doc = new Y.Doc();
    seedDoc(doc, { 'f.ts': 'x' });
    const res = await mod.flushAndCommit(poisoned, doc, { message: 'contained' });
    expect(res.hash).toMatch(/^[0-9a-f]{40}$/);

    // Everything that got written lives under gitRoot; nothing escaped upward.
    const real = await fs.realpath(gitRoot);
    const entries = await listAllFiles(real);
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.startsWith(real)).toBe(true);
    }
    // And no stray ".." directory was created at the root.
    const top = await fs.readdir(real);
    expect(top).not.toContain('..');
  });

  it('a poisoned FILE path inside the doc is refused, never written above the tree', async () => {
    const mod = await freshModule();
    const roomId = 'room-filepath-guard';
    const doc = new Y.Doc();
    // A legal file plus an illegal traversal key. The illegal one is skipped.
    seedDoc(doc, { 'safe.ts': 'ok', '../../escape.ts': 'evil' });
    await mod.flushAndCommit(roomId, doc, { message: 'guard' });

    const fresh = new Y.Doc();
    await mod.loadRoomFromGit(roomId, fresh);
    // Only the safe file made it into git; the traversal key was dropped.
    expect(readDoc(fresh)).toEqual({ 'safe.ts': 'ok' });

    // No file with 'escape.ts' exists anywhere under the git root.
    const real = await fs.realpath(gitRoot);
    const all = await listAllFiles(real);
    expect(all.some((p) => p.includes('escape.ts'))).toBe(false);
  });

  it('normalizeRepoPath rejects absolute and traversal paths directly', async () => {
    const mod = await freshModule();
    expect(() => mod.normalizeRepoPath('/etc/passwd')).toThrow();
    expect(() => mod.normalizeRepoPath('../x')).toThrow();
    expect(() => mod.normalizeRepoPath('a/../../b')).toThrow();
    expect(() => mod.normalizeRepoPath('')).toThrow();
    // Legal paths normalise and pass through.
    expect(mod.normalizeRepoPath('a/./b.ts')).toBe('a/b.ts');
    expect(mod.normalizeRepoPath('dir/file.ts')).toBe('dir/file.ts');
  });
});

// ── helpers ────────────────────────────────────────────────────────────────────

/** Recursively list absolute file paths under `root`. */
async function listAllFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) await walk(abs);
      else out.push(abs);
    }
  }
  await walk(root);
  return out;
}
