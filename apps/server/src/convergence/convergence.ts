/**
 * The convergence module — the CRDT ↔ filesystem ↔ git seam (ADR-000).
 *
 * THE LAW (read twice):
 *   1. The Yjs doc is the single source of truth for OPEN files.
 *   2. The filesystem working tree is PROJECTED from the doc on an explicit
 *      FLUSH, under a per-room LOCK.
 *   3. git commits are taken from the flushed working tree.
 *   4. Authorship is carried through the seam.
 *
 * This file owns the doc side: turning the bare repo's HEAD into doc state
 * (`loadRoomFromGit`) and turning doc state into a commit (`flushAndCommit`).
 * The actual git mechanics live in ./git.ts; the lock lives in ./lock.ts.
 *
 * "A collaborative IDE that loses your code" is fatal, so correctness beats
 * cleverness here: flushes are fully serialised per room, the doc's file set is
 * authoritative (deletions converge), and text is round-tripped as UTF-8 so the
 * load→flush→load cycle is identity-preserving.
 */
import * as Y from 'yjs';
import { getFiles, getFileText, getTree, transactWithOrigin } from '@ice/shared';
import type { CommitResult, FileNode } from '@ice/shared';
import {
  DEFAULT_BRANCH,
  ensureBareRepo,
  listBranches as gitListBranches,
  listCommits as gitListCommits,
  materializeAndCommit,
  normalizeRepoPath,
  readHeadFiles,
  type FileContent,
} from './git.js';
import { withRoomLock } from './lock.js';

/** Default identity for a flush that doesn't carry an explicit author. */
const SYSTEM_AUTHOR = { name: 'ICE', email: 'ice@localhost' } as const;

export interface FlushOptions {
  message: string;
  authorName?: string;
  authorEmail?: string;
}

/**
 * Hydrate a fresh (or reconnecting) room doc from the bare repo's HEAD tree.
 *
 * Populates `getFiles(doc)` (path -> Y.Text) and `getTree(doc)` (the file-tree
 * structure). No-op when the repo is new/empty. All writes happen inside one
 * `transactWithOrigin(doc, {kind:'system'}, ...)` so the hydration is a single
 * attributable, undoable unit and never races other edits mid-population.
 *
 * Hocuspocus calls this in `onLoadDocument`. It is idempotent: re-loading a doc
 * that already matches HEAD leaves content untouched (we only set a buffer when
 * its text actually differs), so awareness/cursor state isn't disturbed.
 */
export async function loadRoomFromGit(roomId: string, doc: Y.Doc): Promise<void> {
  // Make sure the canonical repo exists even for a brand-new room, so the git
  // server has something to serve and later flushes have a target.
  await ensureBareRepo(roomId);

  const files = await readHeadFiles(roomId);
  if (files.length === 0) {
    // New/empty repo: ensure the tree map exists but write nothing.
    return;
  }

  transactWithOrigin(doc, { kind: 'system' }, () => {
    const yFiles = getFiles(doc);
    const yTree = getTree(doc);

    const present = new Set<string>();
    for (const { path, content } of files) {
      present.add(path);
      applyTextIfChanged(getFileText(doc, path), content);
    }

    // Drop any doc buffers/tree entries that HEAD no longer contains, so a
    // reload after an external history change (e.g. a push) converges.
    for (const key of [...yFiles.keys()]) {
      if (!present.has(key)) yFiles.delete(key);
    }

    rebuildTree(yTree, [...present]);
  });
}

/**
 * Flush the doc's files into the working tree and commit them into the bare
 * repo. Serialised per room by the lock so concurrent flushes/pushes can't
 * interleave and corrupt a commit. Returns the standard CommitResult.
 *
 * The driver wires this behind `POST /api/rooms/:id/commit`.
 */
export async function flushAndCommit(
  roomId: string,
  doc: Y.Doc,
  opts: FlushOptions,
): Promise<CommitResult> {
  return withRoomLock(roomId, async () => {
    // Snapshot the doc's files OUTSIDE any git I/O. Reading the CRDT is sync and
    // cheap; we capture a consistent view, then do the slow fs/git work against
    // that snapshot while the lock guarantees no other flush runs for this room.
    const snapshot = snapshotDocFiles(doc);

    const author = {
      message: opts.message,
      authorName: opts.authorName?.trim() || SYSTEM_AUTHOR.name,
      authorEmail: opts.authorEmail?.trim() || SYSTEM_AUTHOR.email,
    };

    const { oid, filesChanged, branch } = await materializeAndCommit(roomId, snapshot, author);
    return { hash: oid, branch: branch || DEFAULT_BRANCH, filesChanged };
  });
}

export type ChangeStatus = 'A' | 'M' | 'D';
export interface FileChange {
  path: string;
  status: ChangeStatus;
}

/**
 * What differs between the live doc and the last commit (HEAD) — the equivalent
 * of `git status`. Empty repo: every file is "added".
 */
export async function getChanges(roomId: string, doc: Y.Doc): Promise<FileChange[]> {
  const head = new Map((await readHeadFiles(roomId)).map((f) => [f.path, f.content]));
  const cur = new Map(snapshotDocFiles(doc).map((f) => [f.path, f.content]));
  const out: FileChange[] = [];
  for (const [path, content] of cur) {
    if (!head.has(path)) out.push({ path, status: 'A' });
    else if (head.get(path) !== content) out.push({ path, status: 'M' });
  }
  for (const path of head.keys()) if (!cur.has(path)) out.push({ path, status: 'D' });
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Before (HEAD) / after (live doc) text of one file, for a diff view. */
export async function getFileVersions(
  roomId: string,
  doc: Y.Doc,
  path: string,
): Promise<{ before: string | null; after: string | null }> {
  const head = (await readHeadFiles(roomId)).find((f) => f.path === path);
  const cur = snapshotDocFiles(doc).find((f) => f.path === path);
  return { before: head?.content ?? null, after: cur?.content ?? null };
}

/** List the room's branches (BranchInfo[]). Safe on an empty repo (-> []). */
export function listBranches(roomId: string) {
  return gitListBranches(roomId);
}

/** List commits (newest first) reachable from `ref` (default HEAD). */
export function listCommits(roomId: string, opts: { ref?: string; limit?: number } = {}) {
  return gitListCommits(roomId, opts);
}

// ── doc <-> snapshot helpers ───────────────────────────────────────────────────

/**
 * Read the doc's files map into a plain, git-ready snapshot. Validates each path
 * (rejecting traversal/absolute) so a poisoned key can never escape the tree;
 * such a key is skipped rather than aborting the whole flush.
 */
export function snapshotDocFiles(doc: Y.Doc): FileContent[] {
  const yFiles = getFiles(doc);
  const out: FileContent[] = [];
  for (const [path, text] of yFiles.entries()) {
    let safe: string;
    try {
      safe = normalizeRepoPath(path);
    } catch {
      continue; // skip illegal paths; never project them onto disk
    }
    out.push({ path: safe, content: text.toString() });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

/**
 * Replace a Y.Text's content with `next`, but only touch it when it actually
 * differs. Keeping the no-op path truly no-op preserves relative positions and
 * avoids churning awareness for clients that are already in sync.
 */
function applyTextIfChanged(text: Y.Text, next: string): void {
  const current = text.toString();
  if (current === next) return;
  if (current.length > 0) text.delete(0, current.length);
  if (next.length > 0) text.insert(0, next);
}

/**
 * Rebuild the tree map to describe exactly `paths`: one FileNode per file plus
 * one per intermediate directory. Stored as path -> FileNode so the web tree UI
 * can render structure without re-deriving it from the files map.
 */
function rebuildTree(yTree: Y.Map<unknown>, paths: string[]): void {
  const nodes = new Map<string, FileNode>();
  for (const path of paths) {
    nodes.set(path, { path, kind: 'file' });
    // Register each ancestor directory.
    const segs = path.split('/');
    for (let i = 1; i < segs.length; i += 1) {
      const dir = segs.slice(0, i).join('/');
      if (dir && !nodes.has(dir)) nodes.set(dir, { path: dir, kind: 'dir' });
    }
  }

  // Reconcile: set/overwrite desired nodes, delete stale ones.
  for (const [key, node] of nodes) {
    yTree.set(key, node);
  }
  for (const key of [...yTree.keys()]) {
    if (!nodes.has(key)) yTree.delete(key);
  }
}
