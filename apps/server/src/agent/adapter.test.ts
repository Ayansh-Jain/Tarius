/**
 * Adapter tests (v0.5 Slice A) — THE AGENT LAW, on a plain Y.Doc.
 *
 * These assert the core boundary contract directly against {@link YjsAgentAdapter}:
 *   • an agent edit lands as a transaction whose origin is {kind:'agent', agentId};
 *   • the edited content is in getFileText(doc, path);
 *   • the edit is per-origin undoable — a Y.UndoManager scoped to the agent
 *     origin undoes ONLY the agent's edit and leaves a concurrent human edit.
 */
import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { getAgents, getFileText, transactWithOrigin, type AgentState } from '@ice/shared';
import { YjsAgentAdapter } from './adapter.js';
import type { ResolvedHostDeps } from './types.js';

const NO_DEPS: ResolvedHostDeps = { terminal: null };

function makeAdapter(agentId = 'agent_1') {
  const doc = new Y.Doc();
  const adapter = new YjsAgentAdapter(
    doc,
    { agentId, kind: 'mock', displayName: 'Mock', model: undefined },
    NO_DEPS,
  );
  adapter.registerAgent();
  return { doc, adapter, agentId };
}

describe('YjsAgentAdapter — origin-tagged edits (ADR-004)', () => {
  it('applies an agent file op inside a {kind:"agent", agentId} transaction', () => {
    const { doc, adapter, agentId } = makeAdapter('agent_origin');

    // Capture the origin of every transaction that touches the doc.
    const origins: unknown[] = [];
    doc.on('afterTransaction', (txn: Y.Transaction) => {
      origins.push(txn.origin);
    });

    adapter.applyFileOp({ kind: 'write', path: 'src/a.ts', content: 'hello world' });

    // The content is in the doc's files map (read = getFileText().toString()).
    expect(getFileText(doc, 'src/a.ts').toString()).toBe('hello world');

    // At least one transaction carried the exact agent origin, and EVERY
    // transaction this adapter made used that origin (never raw/system).
    const agentOrigins = origins.filter(
      (o): o is { kind: 'agent'; agentId: string } =>
        !!o && typeof o === 'object' && (o as { kind?: string }).kind === 'agent',
    );
    expect(agentOrigins.length).toBeGreaterThan(0);
    for (const o of agentOrigins) expect(o.agentId).toBe(agentId);

    // The adapter advertises that exact origin for external UndoManagers.
    expect(adapter.editOrigin).toEqual({ kind: 'agent', agentId });
  });

  it('append/replace/delete file ops all land via the agent origin', () => {
    const { doc, adapter } = makeAdapter();
    const origins = new Set<string>();
    doc.on('afterTransaction', (txn: Y.Transaction) => {
      const o = txn.origin as { kind?: string } | null;
      if (o?.kind) origins.add(o.kind);
    });

    adapter.applyFileOp({ kind: 'write', path: 'f.ts', content: 'a()' });
    adapter.applyFileOp({ kind: 'append', path: 'f.ts', content: '\nb()' });
    adapter.applyFileOp({ kind: 'replace', path: 'f.ts', find: 'a()', replace: 'A()' });
    expect(getFileText(doc, 'f.ts').toString()).toBe('A()\nb()');

    adapter.applyFileOp({ kind: 'delete', path: 'f.ts' });
    // Deleting removes the buffer; getFileText lazily recreates an EMPTY one.
    expect(getFileText(doc, 'f.ts').toString()).toBe('');

    // Only the agent origin was ever used for these ops (plus registerAgent).
    expect([...origins]).toEqual(['agent']);
  });
});

describe('YjsAgentAdapter — per-origin undo', () => {
  it('a Y.UndoManager scoped to the agent origin undoes ONLY the agent edit', () => {
    const agentId = 'agent_undo';
    const doc = new Y.Doc();
    const adapter = new YjsAgentAdapter(
      doc,
      { agentId, kind: 'mock', displayName: 'Mock' },
      NO_DEPS,
    );
    adapter.registerAgent();

    const file = getFileText(doc, 'shared.ts');

    // A human writes first (different origin).
    const humanOrigin = { kind: 'human' as const, participantId: 'p_human' };
    transactWithOrigin(doc, humanOrigin, () => {
      file.insert(0, 'human-line\n');
    });

    // UndoManager tracks ONLY the agent origin on the files map.
    const undo = new Y.UndoManager(doc.getMap('files'), {
      trackedOrigins: new Set([adapter.editOrigin]),
    });

    // The agent appends its line (agent origin → tracked).
    adapter.applyFileOp({ kind: 'append', path: 'shared.ts', content: 'agent-line\n' });
    expect(file.toString()).toBe('human-line\nagent-line\n');

    // Undo: only the agent's edit is reverted; the human's line survives.
    undo.undo();
    expect(file.toString()).toBe('human-line\n');

    // Redo re-applies the agent edit.
    undo.redo();
    expect(file.toString()).toBe('human-line\nagent-line\n');
  });

  it('the human edit is NOT in the agent UndoManager (cannot be undone by it)', () => {
    const agentId = 'agent_iso';
    const doc = new Y.Doc();
    const adapter = new YjsAgentAdapter(
      doc,
      { agentId, kind: 'mock', displayName: 'Mock' },
      NO_DEPS,
    );
    adapter.registerAgent();
    const file = getFileText(doc, 'iso.ts');

    const undo = new Y.UndoManager(doc.getMap('files'), {
      trackedOrigins: new Set([adapter.editOrigin]),
    });

    // Only a human edit happens — nothing tracked.
    transactWithOrigin(doc, { kind: 'human', participantId: 'p2' }, () => {
      file.insert(0, 'only-human\n');
    });

    expect(undo.canUndo()).toBe(false);
    undo.undo(); // no-op
    expect(file.toString()).toBe('only-human\n');
  });
});

describe('YjsAgentAdapter — agent state in the doc', () => {
  it('registerAgent records an AgentState clients can read', () => {
    const { doc, adapter, agentId } = makeAdapter('agent_state');
    const entry = getAgents(doc).get(agentId) as Y.Map<unknown>;
    const state = entry.get('state') as AgentState;
    expect(state.agentId).toBe(agentId);
    expect(state.kind).toBe('mock');
    expect(state.status).toBe('idle');
    expect(adapter.status).toBe('idle');
  });

  it('setStatus updates the doc entry', () => {
    const { doc, adapter, agentId } = makeAdapter('agent_status');
    adapter.setStatus('thinking');
    const entry = getAgents(doc).get(agentId) as Y.Map<unknown>;
    expect((entry.get('state') as AgentState).status).toBe('thinking');
    expect(adapter.status).toBe('thinking');
  });
});
