/**
 * Audit log — HTTP surface (v2.0 Slice A).
 *
 * A small, self-contained Hono sub-app the driver mounts onto the main API:
 *
 *   GET /api/rooms/:roomId/audit
 *       ?limit=<n>&since=<epochMs>&actorKind=human|agent|system&action=<a>
 *       &order=desc|asc
 *     → { roomId, count, entries: AuditEntry[] }   // newest-first by default
 *
 * Read-only: the trail is written exclusively by {@link recordAudit} at the
 * server's own action sites (agent edit / tool-call / commit / snapshot-merge /
 * orchestrate). There is deliberately no POST — clients can't forge entries.
 *
 * Decoupled by injection: the factory takes a `resolveDoc(roomId)` that returns
 * the room's live Y.Doc (the driver passes Slice-A's `getRoomDoc` from
 * room-doc.ts), so this file never imports the realtime server or room-doc
 * wiring. When the room isn't loaded (`resolveDoc` returns null) the trail is
 * simply empty — opening it for audit shouldn't spin up a room.
 *
 * ── DRIVER WIRING (apps/server/src/api.ts) ───────────────────────────────────
 *   import { makeAuditRoutes } from './audit/index.js';
 *   import { getRoomDoc } from './room-doc.js';
 *   app.route('/', makeAuditRoutes({ resolveDoc: getRoomDoc }));
 *
 * The paths are absolute (`/api/...`), so the mount prefix is just '/'.
 */
import { Hono } from 'hono';
import type * as Y from 'yjs';
import type { AuditActor } from '@ice/shared';
import { readAudit, type ReadAuditOptions } from './recorder.js';

/** Resolve a room's live Y.Doc (or null when it isn't loaded). May be async. */
export type AuditDocResolver = (roomId: string) => Promise<Y.Doc | null> | Y.Doc | null;

export interface AuditRoutesDeps {
  /** How to get a room's live doc — the driver passes `getRoomDoc`. */
  resolveDoc: AuditDocResolver;
  /**
   * Optional hard ceiling on `?limit=` so a client can't ask for an unbounded
   * response. Defaults to 1000 (the array cap).
   */
  maxLimit?: number;
}

const VALID_ACTOR_KINDS: ReadonlySet<string> = new Set(['human', 'agent', 'system']);

/** Parse a positive integer query param, or undefined when absent/invalid. */
function intParam(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Build the audit routes sub-app. Mount with
 * `app.route('/', makeAuditRoutes({ resolveDoc: getRoomDoc }))`.
 */
export function makeAuditRoutes(deps: AuditRoutesDeps): Hono {
  const app = new Hono();
  const maxLimit = deps.maxLimit ?? 1000;

  app.get('/api/rooms/:roomId/audit', async (c) => {
    const roomId = c.req.param('roomId');

    const doc = await deps.resolveDoc(roomId);
    if (!doc) {
      // Room not loaded → no trail to show. Empty, not an error: auditing an
      // idle room shouldn't force it into memory.
      return c.json({ roomId, count: 0, entries: [] });
    }

    const limitParam = intParam(c.req.query('limit'));
    const opts: ReadAuditOptions = {
      newestFirst: c.req.query('order') !== 'asc',
    };

    if (limitParam !== undefined) opts.limit = Math.min(limitParam, maxLimit);
    else opts.limit = maxLimit;

    const since = intParam(c.req.query('since'));
    if (since !== undefined) opts.since = since;

    const actorKind = c.req.query('actorKind');
    if (actorKind && VALID_ACTOR_KINDS.has(actorKind)) {
      opts.actorKind = actorKind as AuditActor['kind'];
    }

    const action = c.req.query('action');
    if (action) opts.action = action;

    const entries = readAudit(doc, opts);
    return c.json({ roomId, count: entries.length, entries });
  });

  return app;
}
