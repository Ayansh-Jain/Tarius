/**
 * Audit recorder (v2.0 Slice A).
 *
 * The accountable trail of who did what in a room — humans, agents, and the
 * system. It lives on the room's Y.Doc as a multiplayer `Y.Array<AuditEntry>`
 * (`getAudit`), so the trail:
 *   • is visible LIVE to every connected client (the audit panel updates as the
 *     squad works), and
 *   • survives restarts with the rest of the doc (SQLite / Redis persistence).
 *
 * Every append goes through {@link transactWithOrigin} tagged `{kind:'system'}`,
 * so writing the audit log is itself an attributable, non-agent, non-human
 * mutation — it never masquerades as the actor it's recording, and per-origin
 * undo never rewinds the trail along with a user's edits.
 *
 * The array is capped (default {@link DEFAULT_AUDIT_CAP}) by trimming the OLDEST
 * entries on write, so an always-on room can't grow the doc without bound.
 */
import type * as Y from 'yjs';
import { randomUUID } from 'node:crypto';
import {
  getAudit,
  transactWithOrigin,
  type AuditEntry,
  type AuditActor,
  type RoomId,
} from '@ice/shared';

/** Keep at most this many entries; oldest are trimmed on write. */
export const DEFAULT_AUDIT_CAP = 1000;

/**
 * Fields a caller supplies to record an action. `id`/`at` are filled in for you
 * (override `at` only to record a known event time); `roomId` is taken from the
 * recordAudit call.
 */
export interface RecordAuditInput {
  actor: AuditActor;
  /** e.g. 'edit' | 'tool-call' | 'commit' | 'snapshot-merge' | 'orchestrate'. */
  action: string;
  /** Free-form detail: file path, tool name, commit hash, prompt summary, … */
  detail?: string;
  /** Override the timestamp (defaults to Date.now()). */
  at?: number;
  /** Override the generated id (defaults to a random UUID). */
  id?: string;
}

/** Options for {@link recordAudit}. */
export interface RecordAuditOptions {
  /** Max entries to retain (oldest trimmed). Defaults to {@link DEFAULT_AUDIT_CAP}. */
  cap?: number;
}

/**
 * Append one {@link AuditEntry} to the room's audit log and return it.
 *
 * Origin-tagged `{kind:'system'}`. After appending, trims the array down to
 * `cap` by deleting the oldest entries (Y.Array is chronological: index 0 is
 * oldest). A `cap <= 0` disables capping (unbounded — not recommended).
 *
 * @param doc     the room's live Y.Doc.
 * @param roomId  the room this action belongs to.
 * @param input   the action to record (id/at auto-filled).
 */
export function recordAudit(
  doc: Y.Doc,
  roomId: RoomId,
  input: RecordAuditInput,
  options: RecordAuditOptions = {},
): AuditEntry {
  const cap = options.cap ?? DEFAULT_AUDIT_CAP;

  const entry: AuditEntry = {
    id: input.id ?? randomUUID(),
    roomId,
    actor: input.actor,
    action: input.action,
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
    at: input.at ?? Date.now(),
  };

  const log = getAudit(doc) as Y.Array<AuditEntry>;
  transactWithOrigin(doc, { kind: 'system' }, () => {
    log.push([entry]);
    if (cap > 0 && log.length > cap) {
      // Trim oldest first. Index 0 is the earliest entry.
      log.delete(0, log.length - cap);
    }
  });

  return entry;
}

/** Query options for {@link readAudit}. */
export interface ReadAuditOptions {
  /** Return at most this many entries (the most RECENT ones). */
  limit?: number;
  /** Only entries with `at >= since` (epoch ms). */
  since?: number;
  /** Only entries whose actor.kind matches. */
  actorKind?: AuditActor['kind'];
  /** Only entries with this exact action. */
  action?: string;
  /**
   * Newest-first (default `true`). The underlying Y.Array is oldest-first; we
   * return newest-first because that's what a log viewer wants.
   */
  newestFirst?: boolean;
}

/**
 * Read the room's audit trail, newest-first by default, with optional filters.
 *
 * Returns a plain array snapshot (a copy) — callers may sort/slice it freely
 * without touching the live doc.
 *
 * @param doc  the room's live Y.Doc.
 */
export function readAudit(doc: Y.Doc, options: ReadAuditOptions = {}): AuditEntry[] {
  const { limit, since, actorKind, action, newestFirst = true } = options;
  const log = getAudit(doc) as Y.Array<AuditEntry>;

  let entries = log.toArray();

  if (since !== undefined) entries = entries.filter((e) => e.at >= since);
  if (actorKind !== undefined) entries = entries.filter((e) => e.actor.kind === actorKind);
  if (action !== undefined) entries = entries.filter((e) => e.action === action);

  if (newestFirst) entries = entries.slice().reverse();

  if (limit !== undefined && limit >= 0) entries = entries.slice(0, limit);

  return entries;
}
