/**
 * Git vocabulary shared by server (git server + convergence module) and web
 * (branch/history UI). Introduced in v0.3 "Git comes home".
 *
 * Reminder (ADR-000): the Yjs doc is the source of truth for OPEN files; git
 * commits are PROJECTED from the doc via the convergence module's explicit
 * flush. These types describe what the web renders and what the server reports.
 */

export interface CommitInfo {
  hash: string;
  message: string;
  author: string;
  email: string;
  /** Commit time, epoch milliseconds. */
  when: number;
  parents: string[];
}

export interface BranchInfo {
  name: string;
  /** Commit hash the branch points at. */
  head: string;
  isCurrent: boolean;
}

export type GitFileStatusKind =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'untracked'
  | 'unmodified';

export interface GitFileStatus {
  path: string;
  status: GitFileStatusKind;
}

/** Result of a convergence flush+commit (doc → working tree → git). */
export interface CommitResult {
  hash: string;
  branch: string;
  filesChanged: number;
}
