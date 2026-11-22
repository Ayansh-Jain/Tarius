/**
 * Repo path conventions for v0.3 "Git comes home" — the shared seam between the
 * git server (serves bare repos over smart-HTTP) and the convergence module
 * (flushes the Yjs doc into a working tree and commits into the bare repo).
 *
 * One room ↔ one bare repo. Both subsystems import these helpers so they agree
 * on where a room's git data lives. Defined on `main` (v0.3 Slice 0) so the
 * git-server and convergence worktree slices build against a frozen contract.
 */
import path from 'node:path';
import { DATA_DIR } from './config.js';

/** Root under which every room's git data lives. Overridable via ICE_GIT_ROOT. */
export const REPOS_DIR = process.env.ICE_GIT_ROOT
  ? path.resolve(process.env.ICE_GIT_ROOT)
  : path.join(DATA_DIR, 'repos');

/** Bare repository for a room — served over smart-HTTP, committed to by convergence. */
export function bareRepoPath(roomId: string): string {
  return path.join(REPOS_DIR, `${sanitizeRoomId(roomId)}.git`);
}

/** Server-side working tree the convergence module materializes the Yjs doc into before committing. */
export function worktreePath(roomId: string): string {
  return path.join(REPOS_DIR, 'worktrees', sanitizeRoomId(roomId));
}

/**
 * Room ids are server-generated, but defend against path traversal regardless:
 * only allow a safe filename charset.
 */
export function sanitizeRoomId(roomId: string): string {
  const safe = roomId.replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!safe || safe === '.' || safe === '..') {
    throw new Error(`invalid roomId for repo path: ${JSON.stringify(roomId)}`);
  }
  return safe;
}
