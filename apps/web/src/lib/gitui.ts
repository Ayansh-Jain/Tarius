/**
 * Self-contained git/source-control fetch helpers for the in-UI git surface
 * (ICE v1.0 Slice C). DELIBERATELY independent of `apps/web/src/lib/api.ts`:
 * the integrator wires the server's git endpoints AFTER this slice merges, so
 * the source-control panel must keep working in isolation. To stay decoupled
 * (no edits to shared files), Slice C owns its OWN thin client here instead of
 * importing the app-wide api module.
 *
 * Endpoints (all introduced in v0.3 "Git comes home"):
 *   - GET  /api/rooms/:id/branches  -> { branches: BranchInfo[] }
 *   - GET  /api/rooms/:id/commits   -> { commits: CommitInfo[] }   (?branch=…)
 *   - POST /api/rooms/:id/commit    -> CommitResult                 ({ message })
 *
 * Degradation contract (mirrors the app's git client): a 404 or network/parse
 * failure is a quiet `{ ok:false, notReady:true }` — "the git server isn't
 * wired up yet" — NOT a user-facing error. Only a real non-404 server error
 * (or an explicit failed commit) surfaces a message. This keeps a half-wired
 * or absent server from ever breaking the room.
 */
import type { BranchInfo, CommitInfo, CommitResult } from '@ice/shared';

/** Distinguishes "no git surface yet" (quiet) from a real, surfaced error. */
export interface GitUnavailable {
  ok: false;
  /** True when the endpoint simply isn't wired yet (404 / network); not an error to show. */
  notReady: boolean;
  message: string;
}

export type GitResult<T> = ({ ok: true } & T) | GitUnavailable;

class GitHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'GitHttpError';
    this.status = status;
  }
}

/** Map any thrown error into the degradation shape. */
function unavailable(err: unknown): GitUnavailable {
  if (err instanceof GitHttpError) {
    // 404 = route not mounted yet (pre-wiring). Quiet "not ready".
    if (err.status === 404) return { ok: false, notReady: true, message: err.message };
    return { ok: false, notReady: false, message: err.message };
  }
  // Network / parse failure (server down, dev proxy miss): also "not ready".
  return { ok: false, notReady: true, message: err instanceof Error ? err.message : String(err) };
}

/**
 * Same-origin JSON request. `/api/...` is proxied to the server in dev and
 * served by it in prod, so a relative path + `credentials: 'include'` (to carry
 * the `ice_session` cookie) works in both.
 */
async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    credentials: 'include',
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body: unknown = await res.json();
      if (body && typeof body === 'object' && 'error' in body) {
        message = String((body as { error: unknown }).error);
      }
    } catch {
      // non-JSON error body: keep the status line
    }
    throw new GitHttpError(res.status, message);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

function roomPath(roomId: string, suffix: string): string {
  return `/api/rooms/${encodeURIComponent(roomId)}${suffix}`;
}

/**
 * GET /api/rooms/:id/branches. Degrades to a quiet not-ready result so the
 * panel renders an empty/branchless state instead of crashing pre-wiring.
 */
export async function fetchBranches(
  roomId: string,
): Promise<GitResult<{ branches: BranchInfo[] }>> {
  try {
    const { branches } = await requestJson<{ branches: BranchInfo[] }>(
      roomPath(roomId, '/branches'),
      { method: 'GET' },
    );
    return { ok: true, branches: Array.isArray(branches) ? branches : [] };
  } catch (err) {
    return unavailable(err);
  }
}

/**
 * GET /api/rooms/:id/commits[?branch=…]. Degrades to a quiet not-ready result.
 */
export async function fetchCommits(
  roomId: string,
  branch?: string,
): Promise<GitResult<{ commits: CommitInfo[] }>> {
  const qs = branch ? `?branch=${encodeURIComponent(branch)}` : '';
  try {
    const { commits } = await requestJson<{ commits: CommitInfo[] }>(
      roomPath(roomId, `/commits${qs}`),
      { method: 'GET' },
    );
    return { ok: true, commits: Array.isArray(commits) ? commits : [] };
  } catch (err) {
    return unavailable(err);
  }
}

/**
 * POST /api/rooms/:id/commit { message }. Triggers the server's convergence
 * flush (doc → working tree, under the per-room lock) + git commit. Unlike the
 * reads, a failed commit is an explicit user action, so we return the result
 * (or the degradation shape) and let the caller surface success/error.
 */
export async function commitRoom(
  roomId: string,
  message: string,
): Promise<GitResult<{ result: CommitResult }>> {
  try {
    const result = await requestJson<CommitResult>(roomPath(roomId, '/commit'), {
      method: 'POST',
      body: JSON.stringify({ message }),
    });
    return { ok: true, result };
  } catch (err) {
    return unavailable(err);
  }
}

// ── Local "dirty" derivation (doc vs. last commit) ────────────────────────────
//
// The server is authoritative for git status, but its diff endpoint isn't part
// of the v0.3 surface this slice builds on. To still give a useful "changed
// files" view, we derive a lightweight client-side dirty set: the set of file
// paths whose Yjs buffer has been touched in THIS session since the last commit
// (or since mount). It's a heuristic — it can't see changes made before the tab
// opened — so the panel labels it "changed this session" and falls back to the
// commit history as the source of truth. No server round-trip required.

export interface DirtyFile {
  path: string;
  /** Best-effort: has the buffer been edited since the last observed commit. */
  status: 'modified';
}

// ── Time formatting ───────────────────────────────────────────────────────────

/** Relative "3m ago" style timestamp; falls back to a locale date string. */
export function relativeTime(when: number): string {
  const diff = Date.now() - when;
  if (!Number.isFinite(diff)) return '';
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${Math.max(sec, 0)}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(when).toLocaleDateString();
}

/** First line of a (possibly multi-line) commit message. */
export function firstLine(message: string): string {
  const nl = message.indexOf('\n');
  return (nl === -1 ? message : message.slice(0, nl)).trim();
}

/** Short 7-char hash for display. */
export function shortHash(hash: string): string {
  return hash.slice(0, 7);
}

export { GitHttpError };
