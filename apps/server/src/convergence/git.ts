/**
 * Low-level git operations for the convergence module, built on isomorphic-git.
 *
 * The repo layout (from repos.ts, the frozen v0.3 contract):
 *   • bareRepoPath(roomId) — the CANONICAL bare repo. It is the git directory:
 *     objects + refs live here and this is what the bundled git server serves
 *     over smart-HTTP, so any commit we make here is immediately clonable.
 *   • worktreePath(roomId) — the convergence WORKING TREE. We project the Yjs
 *     doc's files into it, then stage + commit with the bare repo as the gitdir.
 *
 * isomorphic-git lets `dir` (working tree) and `gitdir` (the .git) be separate
 * directories, so we point `gitdir` at the bare repo and `dir` at the worktree.
 * The bare repo then ends up holding the index file too — harmless: smart-HTTP
 * serves objects + refs, never the index. We keep `core.bare = true` so the
 * repo is unambiguously a served bare repo and never tries to touch a checkout.
 *
 * Everything here is path-pure: callers pass a roomId, we resolve the canonical
 * locations. Mutating entry points must run under the per-room lock (see
 * lock.ts); the read helpers are safe to call concurrently.
 */
import { promises as fs } from 'node:fs';
import git from 'isomorphic-git';
import type { BranchInfo, CommitInfo } from '@ice/shared';
import { bareRepoPath, worktreePath } from '../repos.js';

/** The branch we create and commit to for a brand-new room repo. */
export const DEFAULT_BRANCH = 'main';

/**
 * isomorphic-git's FsClient is structurally the node fs/promises module plus a
 * couple of optional methods it probes for. The promises API satisfies it; we
 * widen the type once here so call sites stay clean.
 */
const igfs = fs as unknown as Parameters<typeof git.init>[0]['fs'];

/** A single file's content as projected to / read from git (decoded text). */
export interface FileContent {
  path: string;
  content: string;
}

/** Recursively delete a path, tolerating ENOENT. */
async function rmrf(target: string): Promise<void> {
  await fs.rm(target, { recursive: true, force: true });
}

/**
 * Ensure a canonical bare repo exists for the room and return its path.
 * Idempotent: re-initialising an existing repo is a safe no-op for our needs
 * (isomorphic-git's init leaves existing objects/refs intact), but we guard on
 * the presence of HEAD so we don't rewrite config on every call.
 */
export async function ensureBareRepo(roomId: string): Promise<string> {
  const gitdir = bareRepoPath(roomId);
  let initialised = false;
  try {
    await fs.access(`${gitdir}/HEAD`);
    initialised = true;
  } catch {
    initialised = false;
  }
  if (!initialised) {
    await fs.mkdir(gitdir, { recursive: true });
    await git.init({ fs: igfs, gitdir, bare: true, defaultBranch: DEFAULT_BRANCH });
  }
  return gitdir;
}

/** Does the room's bare repo have at least one commit on HEAD? */
export async function hasCommits(roomId: string): Promise<boolean> {
  const gitdir = bareRepoPath(roomId);
  try {
    await git.resolveRef({ fs: igfs, gitdir, ref: 'HEAD' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Read every file in the bare repo's HEAD commit as decoded text.
 * Returns an empty array for a new/empty repo (no commits yet).
 */
export async function readHeadFiles(roomId: string): Promise<FileContent[]> {
  const gitdir = bareRepoPath(roomId);
  let headOid: string;
  try {
    headOid = await git.resolveRef({ fs: igfs, gitdir, ref: 'HEAD' });
  } catch {
    return []; // empty repo
  }

  let paths: string[];
  try {
    paths = await git.listFiles({ fs: igfs, gitdir, ref: 'HEAD' });
  } catch {
    return [];
  }

  const decoder = new TextDecoder();
  const out: FileContent[] = [];
  for (const path of paths) {
    const { blob } = await git.readBlob({ fs: igfs, gitdir, oid: headOid, filepath: path });
    out.push({ path, content: decoder.decode(blob) });
  }
  // Deterministic ordering keeps callers (and tests) stable.
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

/** The set of file paths tracked in the bare repo's HEAD commit. */
export async function listHeadPaths(roomId: string): Promise<string[]> {
  const gitdir = bareRepoPath(roomId);
  try {
    await git.resolveRef({ fs: igfs, gitdir, ref: 'HEAD' });
  } catch {
    return [];
  }
  try {
    return await git.listFiles({ fs: igfs, gitdir, ref: 'HEAD' });
  } catch {
    return [];
  }
}

/**
 * Materialise `files` into the working tree and produce a commit in the bare
 * repo. Returns the new commit oid plus how many tree entries changed.
 *
 * MUST be called under the per-room lock. The desired file set is authoritative:
 * any path tracked at HEAD but absent from `files` is removed from the tree, so
 * deletions in the doc converge into git.
 */
export async function materializeAndCommit(
  roomId: string,
  files: FileContent[],
  meta: { message: string; authorName: string; authorEmail: string },
): Promise<{ oid: string; filesChanged: number; branch: string }> {
  const gitdir = await ensureBareRepo(roomId);
  const dir = worktreePath(roomId);
  await fs.mkdir(dir, { recursive: true });

  const desired = new Map<string, string>();
  for (const f of files) desired.set(f.path, f.content);

  const previousPaths = await listHeadPaths(roomId);
  const previousSet = new Set(previousPaths);

  // 1) Write/update every desired file into the working tree and stage it.
  const encoder = new TextEncoder();
  for (const [path, content] of desired) {
    const abs = joinWithin(dir, path);
    await fs.mkdir(dirnameOf(abs), { recursive: true });
    await fs.writeFile(abs, encoder.encode(content));
    await git.add({ fs: igfs, dir, gitdir, filepath: path });
  }

  // 2) Reconcile deletions: anything tracked before but no longer desired is
  //    unstaged from the index and removed from the working tree on disk.
  let removed = 0;
  for (const path of previousSet) {
    if (!desired.has(path)) {
      await git.remove({ fs: igfs, dir, gitdir, filepath: path });
      await rmrf(joinWithin(dir, path));
      removed += 1;
    }
  }

  // 3) Commit. The author and committer carry the requested authorship so
  //    attribution survives the CRDT → git seam.
  const now = Math.floor(Date.now() / 1000);
  const author = {
    name: meta.authorName,
    email: meta.authorEmail,
    timestamp: now,
    timezoneOffset: 0,
  };
  const oid = await git.commit({
    fs: igfs,
    dir,
    gitdir,
    message: meta.message,
    author,
    committer: author,
  });

  // filesChanged: union of touched + removed paths is an over-approximation, but
  // the precise "changed since parent" count requires a tree diff. Compute it
  // from the parent tree so the number is meaningful.
  const filesChanged = await countChangedAgainstParent(roomId, oid, desired, previousSet, removed);

  const branch =
    (await git.currentBranch({ fs: igfs, gitdir, fullname: false })) ?? DEFAULT_BRANCH;

  return { oid, filesChanged, branch };
}

/**
 * Count how many file paths actually changed between the new commit and its
 * first parent: added, deleted, or content-modified. Falls back to the size of
 * the desired set for a root commit (no parent).
 */
async function countChangedAgainstParent(
  roomId: string,
  newOid: string,
  desired: Map<string, string>,
  previousSet: Set<string>,
  removed: number,
): Promise<number> {
  const gitdir = bareRepoPath(roomId);
  const { commit } = await git.readCommit({ fs: igfs, gitdir, oid: newOid });
  const parent = commit.parent[0];
  if (!parent) {
    // Root commit: every desired file is new.
    return desired.size;
  }

  // Build oid maps for new and parent commits at the file level.
  const newOids = await fileOidMap(gitdir, newOid);
  const parentOids = await fileOidMap(gitdir, parent);

  let changed = 0;
  for (const [path, oid] of newOids) {
    if (parentOids.get(path) !== oid) changed += 1; // added or modified
  }
  for (const path of parentOids.keys()) {
    if (!newOids.has(path)) changed += 1; // deleted
  }
  // `previousSet`/`removed` are already reflected via the tree diff above; they
  // are accepted as params to document intent and keep the signature explicit.
  void previousSet;
  void removed;
  return changed;
}

/** Map of filepath -> blob oid for every file in a commit (recursive). */
async function fileOidMap(gitdir: string, commitOid: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const paths = await git.listFiles({ fs: igfs, gitdir, ref: commitOid });
  for (const path of paths) {
    const { oid } = await git.readBlob({ fs: igfs, gitdir, oid: commitOid, filepath: path });
    map.set(path, oid);
  }
  return map;
}

/** List the room's branches with their head oids; empty for a new repo. */
export async function listBranches(roomId: string): Promise<BranchInfo[]> {
  const gitdir = bareRepoPath(roomId);
  let names: string[];
  try {
    names = await git.listBranches({ fs: igfs, gitdir });
  } catch {
    return [];
  }
  let current: string | undefined;
  try {
    current = (await git.currentBranch({ fs: igfs, gitdir, fullname: false })) ?? undefined;
  } catch {
    current = undefined;
  }

  const out: BranchInfo[] = [];
  for (const name of names) {
    let head = '';
    try {
      head = await git.resolveRef({ fs: igfs, gitdir, ref: name });
    } catch {
      head = '';
    }
    out.push({ name, head, isCurrent: name === current });
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/**
 * List commits reachable from `ref` (default HEAD), newest first, up to `limit`.
 * Returns an empty array for a new/empty repo.
 */
export async function listCommits(
  roomId: string,
  opts: { ref?: string; limit?: number } = {},
): Promise<CommitInfo[]> {
  const gitdir = bareRepoPath(roomId);
  const ref = opts.ref ?? 'HEAD';
  const depth = opts.limit ?? 50;

  let entries: Awaited<ReturnType<typeof git.log>>;
  try {
    entries = await git.log({ fs: igfs, gitdir, ref, depth });
  } catch {
    return []; // empty repo or unknown ref
  }

  return entries.map(({ oid, commit }) => ({
    hash: oid,
    // git canonically stores a trailing newline on the message; strip trailing
    // whitespace so the history UI gets a clean string, but keep internal
    // newlines (multi-paragraph commit bodies) intact.
    message: commit.message.replace(/\s+$/, ''),
    author: commit.author.name,
    email: commit.author.email,
    when: commit.author.timestamp * 1000, // epoch seconds -> ms (CommitInfo.when)
    parents: commit.parent,
  }));
}

// ── tiny path helpers (no node:path import churn; keep behaviour explicit) ─────

function dirnameOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

/**
 * Join a repo-relative POSIX path under `base`, refusing anything that would
 * escape the working tree. Doc file paths are server-mediated, but this is a
 * defence-in-depth guard against a poisoned path ('../', absolute, etc.).
 */
function joinWithin(base: string, rel: string): string {
  const normalised = normalizeRepoPath(rel);
  return `${base}/${normalised}`;
}

/** Normalise + validate a repo-relative path; throws on traversal/absolute. */
export function normalizeRepoPath(rel: string): string {
  if (rel.length === 0) throw new Error('empty file path');
  if (rel.startsWith('/')) throw new Error(`absolute file path not allowed: ${rel}`);
  const parts: string[] = [];
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') throw new Error(`path traversal not allowed: ${rel}`);
    parts.push(seg);
  }
  if (parts.length === 0) throw new Error(`invalid file path: ${rel}`);
  return parts.join('/');
}
