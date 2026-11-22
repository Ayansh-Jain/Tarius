/**
 * Audit recorder tests (v2.0 Slice A).
 *
 * Pure Y.Doc, no server: a fresh in-memory doc per case.
 *   • recordAudit appends a well-formed AuditEntry that readAudit returns;
 *   • the cap trims the OLDEST entries on write;
 *   • the write is origin-tagged {kind:'system'};
 *   • readAudit filters (actorKind/action/since/limit) and orders newest-first.
 */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { getAudit, type AuditEntry, type EditOrigin } from '@ice/shared';
import { recordAudit, readAudit, DEFAULT_AUDIT_CAP } from './recorder.js';

const ROOM = 'room-1';

function freshDoc(): Y.Doc {
  return new Y.Doc();
}

describe('recordAudit / readAudit', () => {
  it('appends an entry that readAudit returns', () => {
    const doc = freshDoc();
    const entry = recordAudit(doc, ROOM, {
      actor: { kind: 'agent', id: 'agent-7', name: 'Builder' },
      action: 'edit',
      detail: 'src/app.ts',
    });

    expect(entry.id).toBeTruthy();
    expect(entry.roomId).toBe(ROOM);
    expect(entry.at).toBeGreaterThan(0);

    const all = readAudit(doc);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      roomId: ROOM,
      action: 'edit',
      detail: 'src/app.ts',
      actor: { kind: 'agent', id: 'agent-7', name: 'Builder' },
    });
  });

  it('omits detail when not provided', () => {
    const doc = freshDoc();
    recordAudit(doc, ROOM, { actor: { kind: 'system', id: 'sys' }, action: 'orchestrate' });
    const all = readAudit(doc);
    expect(all).toHaveLength(1);
    expect('detail' in all[0]!).toBe(false);
  });

  it('persists onto the shared getAudit Y.Array (live/multiplayer)', () => {
    const doc = freshDoc();
    recordAudit(doc, ROOM, { actor: { kind: 'human', id: 'u1' }, action: 'commit', detail: 'abc123' });
    // The same array the rest of the app (and other clients) observe.
    const arr = getAudit(doc) as Y.Array<AuditEntry>;
    expect(arr.length).toBe(1);
    expect(arr.get(0).action).toBe('commit');
  });

  it('writes through a {kind:"system"} origin', () => {
    const doc = freshDoc();
    const origins: unknown[] = [];
    doc.on('afterTransaction', (tx: Y.Transaction) => {
      origins.push(tx.origin);
    });

    recordAudit(doc, ROOM, { actor: { kind: 'agent', id: 'a1' }, action: 'tool-call', detail: 'shell' });

    const systemOrigin = origins.find(
      (o): o is EditOrigin => !!o && typeof o === 'object' && (o as EditOrigin).kind === 'system',
    );
    expect(systemOrigin).toBeDefined();
  });

  it('keeps entries chronological (push order) in the underlying array', () => {
    const doc = freshDoc();
    recordAudit(doc, ROOM, { actor: { kind: 'system', id: 's' }, action: 'a', at: 100 });
    recordAudit(doc, ROOM, { actor: { kind: 'system', id: 's' }, action: 'b', at: 200 });
    const arr = getAudit(doc) as Y.Array<AuditEntry>;
    expect(arr.toArray().map((e) => e.action)).toEqual(['a', 'b']);
  });
});

describe('cap', () => {
  it('trims the oldest entries when over the cap', () => {
    const doc = freshDoc();
    const cap = 3;
    for (let i = 0; i < 6; i++) {
      recordAudit(doc, ROOM, { actor: { kind: 'system', id: 's' }, action: `act-${i}`, at: i }, { cap });
    }

    const arr = getAudit(doc) as Y.Array<AuditEntry>;
    expect(arr.length).toBe(cap);
    // Oldest (act-0..act-2) dropped; newest three remain, in order.
    expect(arr.toArray().map((e) => e.action)).toEqual(['act-3', 'act-4', 'act-5']);
  });

  it('does not trim at exactly the cap', () => {
    const doc = freshDoc();
    const cap = 2;
    recordAudit(doc, ROOM, { actor: { kind: 'system', id: 's' }, action: 'x' }, { cap });
    recordAudit(doc, ROOM, { actor: { kind: 'system', id: 's' }, action: 'y' }, { cap });
    expect((getAudit(doc) as Y.Array<AuditEntry>).length).toBe(2);
  });

  it('defaults the cap to DEFAULT_AUDIT_CAP', () => {
    // Sanity: the exported default is the documented 1000.
    expect(DEFAULT_AUDIT_CAP).toBe(1000);
  });
});

describe('readAudit filtering & ordering', () => {
  function seed(doc: Y.Doc): void {
    recordAudit(doc, ROOM, { actor: { kind: 'agent', id: 'a1', name: 'A' }, action: 'edit', at: 10 });
    recordAudit(doc, ROOM, { actor: { kind: 'human', id: 'u1', name: 'U' }, action: 'commit', at: 20 });
    recordAudit(doc, ROOM, { actor: { kind: 'agent', id: 'a1', name: 'A' }, action: 'tool-call', at: 30 });
    recordAudit(doc, ROOM, { actor: { kind: 'system', id: 's' }, action: 'orchestrate', at: 40 });
  }

  it('returns newest-first by default', () => {
    const doc = freshDoc();
    seed(doc);
    expect(readAudit(doc).map((e) => e.at)).toEqual([40, 30, 20, 10]);
  });

  it('returns oldest-first when newestFirst:false', () => {
    const doc = freshDoc();
    seed(doc);
    expect(readAudit(doc, { newestFirst: false }).map((e) => e.at)).toEqual([10, 20, 30, 40]);
  });

  it('limits to the most recent N', () => {
    const doc = freshDoc();
    seed(doc);
    expect(readAudit(doc, { limit: 2 }).map((e) => e.at)).toEqual([40, 30]);
  });

  it('filters by actorKind', () => {
    const doc = freshDoc();
    seed(doc);
    const agentOnly = readAudit(doc, { actorKind: 'agent' });
    expect(agentOnly.every((e) => e.actor.kind === 'agent')).toBe(true);
    expect(agentOnly).toHaveLength(2);
  });

  it('filters by action and since', () => {
    const doc = freshDoc();
    seed(doc);
    expect(readAudit(doc, { action: 'commit' }).map((e) => e.action)).toEqual(['commit']);
    expect(readAudit(doc, { since: 25 }).map((e) => e.at)).toEqual([40, 30]);
  });

  it('is a copy — sorting the result does not mutate the doc', () => {
    const doc = freshDoc();
    seed(doc);
    const out = readAudit(doc);
    out.sort((a, b) => a.at - b.at);
    // Underlying array still chronological & intact.
    expect((getAudit(doc) as Y.Array<AuditEntry>).toArray().map((e) => e.at)).toEqual([10, 20, 30, 40]);
  });
});
