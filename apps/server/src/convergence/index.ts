/**
 * Convergence module — public API (v0.3 Slice B).
 *
 * The CRDT ↔ filesystem ↔ git seam that enforces ADR-000: the Yjs doc is the
 * source of truth for open files; the working tree is projected from the doc on
 * an explicit flush under a per-room lock; commits are taken from that tree.
 *
 * Wiring (done by the integrator in the v0.1-owned files — see this slice's
 * wiringInstructions): `loadRoomFromGit` into Hocuspocus `onLoadDocument`;
 * `flushAndCommit` behind `POST /api/rooms/:id/commit`; `listBranches` /
 * `listCommits` behind `/branches` and `/commits`.
 */
export {
  loadRoomFromGit,
  flushAndCommit,
  listBranches,
  listCommits,
  getChanges,
  getFileVersions,
  type FileChange,
  type ChangeStatus,
  type FlushOptions,
} from './convergence.js';

// Lower-level git helpers + the per-room lock, exported for advanced callers
// (e.g. the git-server slice updating refs, or tests asserting on the lock).
export {
  ensureBareRepo,
  hasCommits,
  readHeadFiles,
  listHeadPaths,
  normalizeRepoPath,
  DEFAULT_BRANCH,
  type FileContent,
} from './git.js';

export { withRoomLock, activeRoomLockCount } from './lock.js';
