/**
 * Audit route tests (v2.0 Slice A).
 *
 * Drives the Hono sub-app via `app.request` with an injected `resolveDoc`, so no
 * real realtime server is needed. Verifies the read-only GET, query filters, the
 * limit ceiling, and the empty-when-not-loaded behaviour.
 */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { makeAuditRoutes } from './routes.js';
import { recordAudit } from './recorder.js';

const ROOM = 'room-x';

function docWithEntries(): Y.Doc {
  const doc = new Y.Doc();
  recordAudit(doc, ROOM, { actor: { kind: 'agent', id: 'a1', name: 'A' }, action: 'edit', at: 10, detail: 'a.ts' });
  recordAudit(doc, ROOM, { actor: { kind: 'human', id: 'u1', name: 'U' }, action: 'commit', at: 20, detail: 'abc' });
  recordAudit(doc, ROOM, { actor: { kind: 'agent', id: 'a1', name: 'A' }, action: 'tool-call', at: 30 });
  return doc;
}

describe('GET /api/rooms/:roomId/audit', () => {
  it('returns the trail newest-first', async () => {
    const doc = docWithEntries();
    const app = makeAuditRoutes({ resolveDoc: () => doc });

    const res = await app.request(`/api/rooms/${ROOM}/audit`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { roomId: string; count: number; entries: { at: number }[] };
    expect(body.roomId).toBe(ROOM);
    expect(body.count).toBe(3);
    expect(body.entries.map((e) => e.at)).toEqual([30, 20, 10]);
  });

  it('supports order=asc', async () => {
    const doc = docWithEntries();
    const app = makeAuditRoutes({ resolveDoc: () => doc });
    const res = await app.request(`/api/rooms/${ROOM}/audit?order=asc`);
    const body = (await res.json()) as { entries: { at: number }[] };
    expect(body.entries.map((e) => e.at)).toEqual([10, 20, 30]);
  });

  it('filters by actorKind and action', async () => {
    const doc = docWithEntries();
    const app = makeAuditRoutes({ resolveDoc: () => doc });

    const agents = (await (await app.request(`/api/rooms/${ROOM}/audit?actorKind=agent`)).json()) as {
      count: number;
    };
    expect(agents.count).toBe(2);

    const commits = (await (await app.request(`/api/rooms/${ROOM}/audit?action=commit`)).json()) as {
      entries: { action: string }[];
    };
    expect(commits.entries.map((e) => e.action)).toEqual(['commit']);
  });

  it('honours ?limit= and caps it at maxLimit', async () => {
    const doc = docWithEntries();
    const app = makeAuditRoutes({ resolveDoc: () => doc, maxLimit: 2 });

    const limited = (await (await app.request(`/api/rooms/${ROOM}/audit?limit=1`)).json()) as {
      entries: unknown[];
    };
    expect(limited.entries).toHaveLength(1);

    // Asking for more than maxLimit is clamped down to maxLimit.
    const clamped = (await (await app.request(`/api/rooms/${ROOM}/audit?limit=999`)).json()) as {
      entries: unknown[];
    };
    expect(clamped.entries).toHaveLength(2);
  });

  it('accepts an async resolveDoc', async () => {
    const doc = docWithEntries();
    const app = makeAuditRoutes({ resolveDoc: async () => doc });
    const res = await app.request(`/api/rooms/${ROOM}/audit`);
    const body = (await res.json()) as { count: number };
    expect(body.count).toBe(3);
  });

  it('returns an empty trail (200) when the room is not loaded', async () => {
    const app = makeAuditRoutes({ resolveDoc: () => null });
    const res = await app.request(`/api/rooms/${ROOM}/audit`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number; entries: unknown[] };
    expect(body.count).toBe(0);
    expect(body.entries).toEqual([]);
  });
});
