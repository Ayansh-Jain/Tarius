/**
 * Opt-in agent SNAPSHOTS (v1.5 Slice B) — "try it safely".
 *
 * This is the ONE good idea borrowed from the isolation camp, kept as an ESCAPE
 * HATCH, not the default. ICE's whole bet (ADR-004) is that humans and agents
 * co-edit ONE shared repo live — isolation-by-default would betray that. But for
 * a large or scary change, an agent (or its human) can ask to work on a side
 * BRANCH off the room's HEAD, iterate there without disturbing the live room,
 * and then either MERGE the result back in or DISCARD it.
 *
 * It is built entirely on the v0.3 convergence/git layer (ADR-000: the doc is
 * the source of truth; git commits are projected from doc state):
 *   • {@link createAgentSnapshot} flushes the room doc to a commit, then forks a
 *     `snapshots/<agent>/<id>` branch off that commit via isomorphic-git.
 *   • {@link commitSnapshotFiles} commits a file set onto the snapshot branch
 *     ONLY (the room's HEAD branch is never touched) — this is where an agent's
 *     "try it" work lands.
 *   • {@link mergeSnapshot} merges the snapshot branch back into the room's
 *     default branch (fast-forward when possible, a real merge commit otherwise),
 *     so the next doc load (loadRoomFromGit) sees the agent's work.
 *   • {@link discardSnapshot} drops the branch — the room is exactly as if the
 *     experiment never happened.
 *
 * Snapshot bookkeeping ({@link AgentSnapshot}: id, agentId, branch, baseCommit,
 * status) lives in an in-memory {@link SnapshotStore}; the branches themselves
 * are durable in the bare repo. Mutations run under the same per-room lock the
 * convergence module uses, so a snapshot create/merge can't interleave with a
 * room flush and corrupt a commit.
 */
import { promises as fs } from 'node:fs';
import git from 'isomorphic-git';
import * as Y from 'yjs';
import type { AgentId, AgentSnapshot, CommitResult } from '@ice/shared';
import { flushAndCommit } from '../convergence/index.js';
import { withRoomLock } from '../convergence/lock.js';
import { ensureBareRepo, DEFAULT_BRANCH } from '../convergence/git.js';
import { bareRepoPath, worktreePath } from '../repos.js';

/** isomorphic-git's FsClient is satisfied by fs/promises; widen once. */
const igfs = fs as unknown as Parameters<typeof git.init>[0]['fs'];

/** Author identity stamped on snapshot commits/merges. */
const SNAPSHOT_AUTHOR = { name: 'ICE Snapshot', email: 'snapshot@localhost' } as const;

/** A file's content as committed onto a snapshot branch (mirrors convergence). */
export interface SnapshotFile {
  path: string;
  content: string;
}

/** Options for {@link createAgentSnapshot}. */
export interface CreateSnapshotOptions {
  /** Commit message for the baseline flush. Defaults to a generated one. */
  message?: string;
  /** Pre-generated id (tests). Defaults to a random id. */
  id?: string;
}

/** Result of merging a snapshot back into the room. */
export interface MergeSnapshotResult {
  snapshot: AgentSnapshot;
  /** The commit now at the head of the room's default branch. */
  mergedCommit: string;
  /** True if the merge was a fast-forward (no merge commit needed). */
  fastForward: boolean;
}

/**
 * In-memory record of live snapshots, keyed by snapshot id. The branches are the
 * durable truth in git; this just tracks status + metadata so the API and UI can
 * list/resolve them without re-deriving from refs. A module-level singleton is
 * exported for the driver; the class is exported too for isolated tests.
 */
export class SnapshotStore {
  private readonly byId = new Map<string, AgentSnapshot>();
  /** snapshot id -> roomId, so merge/discard can find the repo from just an id. */
  private readonly roomOf = new Map<string, string>();

  put(roomId: string, snap: AgentSnapshot): void {
    this.byId.set(snap.id, snap);
    this.roomOf.set(snap.id, roomId);
  }

  get(id: string): AgentSnapshot | undefined {
    return this.byId.get(id);
  }

  roomFor(id: string): string | undefined {
    return this.roomOf.get(id);
  }

  /** Snapshots for a room (optionally a single agent), for a list view. */
  list(roomId: string, agentId?: AgentId): AgentSnapshot[] {
    const out: AgentSnapshot[] = [];
    for (const [id, snap] of this.byId) {
      if (this.roomOf.get(id) !== roomId) continue;
      if (agentId && snap.agentId !== agentId) continue;
      out.push(snap);
    }
    return out;
  }

  setStatus(id: string, status: AgentSnapshot['status']): AgentSnapshot | undefined {
    const snap = this.byId.get(id);
    if (!snap) return undefined;
    const next = { ...snap, status };
    this.byId.set(id, next);
    return next;
  }

  delete(id: string): void {
    this.byId.delete(id);
    this.roomOf.delete(id);
  }
}

/** Process-wide snapshot store the driver wires the API routes to. */
export const snapshotStore = new SnapshotStore();

// ── lifecycle ──────────────────────────────────────────────────────────────────

/**
 * Create a snapshot for `agentId` off the room's current state. We first FLUSH
 * the doc to a real commit on the default branch (so the snapshot's base is the
 * exact live state, and nothing in the doc is lost), then fork a branch off that
 * commit. The agent can then work on the branch via {@link commitSnapshotFiles}
 * without affecting the live room.
 *
 * Runs under the per-room lock so the baseline flush + branch fork are atomic
 * relative to other room flushes. Returns the tracked {@link AgentSnapshot}
 * (status 'open').
 */
export async function createAgentSnapshot(
  roomId: string,
  doc: Y.Doc,
  agentId: AgentId,
  opts: CreateSnapshotOptions = {},
  store: SnapshotStore = snapshotStore,
): Promise<AgentSnapshot> {
  const id = opts.id ?? `snap_${rand()}`;
  const branch = snapshotBranchName(agentId, id);

  // 1) Flush the doc to a commit so the snapshot base == live room state. This
  //    takes the room lock itself; do it before we grab the lock for the fork so
  //    we don't deadlock (the lock is not re-entrant).
  const flush: CommitResult = await flushAndCommit(roomId, doc, {
    message: opts.message ?? `snapshot ${id} base (agent ${agentId})`,
    authorName: SNAPSHOT_AUTHOR.name,
    authorEmail: SNAPSHOT_AUTHOR.email,
  });
  const baseCommit = flush.hash;

  // 2) Fork the snapshot branch off that exact commit.
  await withRoomLock(roomId, async () => {
    const gitdir = await ensureBareRepo(roomId);
    await git.branch({ fs: igfs, gitdir, ref: branch, object: baseCommit, checkout: false });
  });

  const snap: AgentSnapshot = { id, agentId, branch, baseCommit, status: 'open' };
  store.put(roomId, snap);
  return snap;
}

/**
 * Commit `files` onto the snapshot's branch ONLY — the room's default branch is
 * never advanced. This is the agent's "try it safely" workspace: it stages the
 * desired file set against the scratch worktree and writes a commit whose parent
 * is the snapshot branch's current head, moving `refs/heads/<snapshot>` forward.
 *
 * The desired set is authoritative relative to the snapshot's base (deletions
 * converge): a path present at the base commit but absent from `files` is removed
 * on the branch. Returns the new branch-head commit oid. Open snapshots only.
 */
export async function commitSnapshotFiles(
  snapshotId: string,
  files: SnapshotFile[],
  opts: { message?: string } = {},
  store: SnapshotStore = snapshotStore,
): Promise<string> {
  const snap = requireOpen(store, snapshotId);
  const roomId = requireRoom(store, snapshotId);

  return withRoomLock(roomId, async () => {
    const gitdir = await ensureBareRepo(roomId);
    const dir = snapshotWorktree(roomId, snap.id);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });

    const parent = await git.resolveRef({ fs: igfs, gitdir, ref: snap.branch });

    // Materialize: lay down + stage every desired file in the scratch worktree.
    const desired = new Map<string, string>();
    for (const f of files) desired.set(normalizeRel(f.path), f.content);

    const encoder = new TextEncoder();
    for (const [path, content] of desired) {
      const abs = `${dir}/${path}`;
      await fs.mkdir(dirnameOf(abs), { recursive: true });
      await fs.writeFile(abs, encoder.encode(content));
      await git.add({ fs: igfs, dir, gitdir, filepath: path });
    }

    // Reconcile deletions against the snapshot branch's current tree.
    let basePaths: string[] = [];
    try {
      basePaths = await git.listFiles({ fs: igfs, gitdir, ref: snap.branch });
    } catch {
      basePaths = [];
    }
    for (const path of basePaths) {
      if (!desired.has(path)) {
        await git.remove({ fs: igfs, dir, gitdir, filepath: path });
      }
    }

    const now = Math.floor(Date.now() / 1000);
    const author = {
      name: SNAPSHOT_AUTHOR.name,
      email: SNAPSHOT_AUTHOR.email,
      timestamp: now,
      timezoneOffset: 0,
    };
    const oid = await git.commit({
      fs: igfs,
      dir,
      gitdir,
      message: opts.message ?? `snapshot ${snap.id} work`,
      author,
      committer: author,
      ref: `refs/heads/${snap.branch}`,
      parent: [parent],
    });
    return oid;
  });
}

/**
 * Merge the snapshot branch back into the room's default branch and mark it
 * 'merged'. Fast-forwards when the default branch hasn't moved since the base;
 * otherwise produces a real merge commit. After this returns, the next
 * `loadRoomFromGit(roomId, doc)` reflects the agent's snapshot work in the room.
 *
 * `abortOnConflict` is set: a content conflict rejects the merge (leaving the
 * room untouched) rather than writing conflict markers into the canonical repo —
 * the human resolves by re-trying after reconciling, or discards. Throws if the
 * snapshot isn't open. Runs under the per-room lock.
 */
export async function mergeSnapshot(
  snapshotId: string,
  store: SnapshotStore = snapshotStore,
): Promise<MergeSnapshotResult> {
  const snap = requireOpen(store, snapshotId);
  const roomId = requireRoom(store, snapshotId);

  return withRoomLock(roomId, async () => {
    const gitdir = await ensureBareRepo(roomId);
    const now = Math.floor(Date.now() / 1000);
    const author = {
      name: SNAPSHOT_AUTHOR.name,
      email: SNAPSHOT_AUTHOR.email,
      timestamp: now,
      timezoneOffset: 0,
    };

    const result = await git.merge({
      fs: igfs,
      gitdir,
      ours: DEFAULT_BRANCH,
      theirs: snap.branch,
      fastForward: true,
      abortOnConflict: true,
      author,
      committer: author,
      message: `merge snapshot ${snap.id} (agent ${snap.agentId})`,
    });

    // After a non-dryRun merge, `oid` is the branch head; fall back to resolving
    // the ref so the return is always a concrete commit.
    const mergedCommit = result.oid ?? (await git.resolveRef({ fs: igfs, gitdir, ref: DEFAULT_BRANCH }));

    const merged = store.setStatus(snap.id, 'merged') ?? { ...snap, status: 'merged' };
    return { snapshot: merged, mergedCommit, fastForward: Boolean(result.fastForward) };
  });
}

/**
 * Discard the snapshot: delete its branch and mark it 'discarded'. The room's
 * default branch is untouched — it's exactly as if the experiment never ran.
 * Idempotent on the branch (a missing branch is fine). Throws only if the id is
 * unknown.
 */
export async function discardSnapshot(
  snapshotId: string,
  store: SnapshotStore = snapshotStore,
): Promise<AgentSnapshot> {
  const snap = store.get(snapshotId);
  if (!snap) throw new Error(`unknown snapshot '${snapshotId}'`);
  const roomId = requireRoom(store, snapshotId);

  await withRoomLock(roomId, async () => {
    const gitdir = await ensureBareRepo(roomId);
    try {
      await git.deleteBranch({ fs: igfs, gitdir, ref: snap.branch });
    } catch {
      // Branch already gone (double-discard / never committed) — fine.
    }
  });

  return store.setStatus(snapshotId, 'discarded') ?? { ...snap, status: 'discarded' };
}

// ── naming + small helpers ──────────────────────────────────────────────────────

/** Branch name for a snapshot: namespaced so it never collides with room branches. */
export function snapshotBranchName(agentId: AgentId, id: string): string {
  return `snapshots/${sanitizeRef(agentId)}/${sanitizeRef(id)}`;
}

/** A dedicated scratch worktree per snapshot, beside the convergence worktree. */
function snapshotWorktree(roomId: string, snapshotId: string): string {
  return `${worktreePath(roomId)}__snap__${sanitizeRef(snapshotId)}`;
}

/** Throw unless the snapshot exists and is still open. */
function requireOpen(store: SnapshotStore, id: string): AgentSnapshot {
  const snap = store.get(id);
  if (!snap) throw new Error(`unknown snapshot '${id}'`);
  if (snap.status !== 'open') {
    throw new Error(`snapshot '${id}' is ${snap.status}, not open`);
  }
  return snap;
}

/** Throw unless we know which room the snapshot belongs to. */
function requireRoom(store: SnapshotStore, id: string): string {
  const roomId = store.roomFor(id);
  if (!roomId) throw new Error(`snapshot '${id}' has no associated room`);
  return roomId;
}

/** Keep ref components to a git-safe, traversal-free charset. */
function sanitizeRef(s: string): string {
  const safe = s.replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!safe || safe === '.' || safe === '..') {
    throw new Error(`invalid ref component: ${JSON.stringify(s)}`);
  }
  return safe;
}

/** Normalize a repo-relative path; reject absolute/traversal (defence in depth). */
function normalizeRel(rel: string): string {
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

function dirnameOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

function rand(): string {
  return Math.random().toString(36).slice(2, 10);
}
