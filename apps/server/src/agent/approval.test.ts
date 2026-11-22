/**
 * Approval-gate tests (v0.5 Slice A) — the human-in-the-loop boundary.
 *
 * A destructive tool call must:
 *   • set the agent's status to 'awaiting-approval',
 *   • record the pending call on the doc (so every client sees the gate),
 *   • NOT mutate the doc until a human approves;
 * and on:
 *   • approve → the effect applies (the file is deleted),
 *   • reject  → the doc is left unchanged and the gate clears.
 *
 * Tested both directly on the adapter and end-to-end through the host with the
 * scripted MockAgentBackend.
 */
import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { getAgents, getFileText, type AgentState, type AgentToolCall } from '@ice/shared';
import { YjsAgentAdapter } from './adapter.js';
import { AgentHost } from './host.js';
import type { AgentBackendFactory, ResolvedHostDeps } from './types.js';
import { MockAgentBackend } from './mock-backend.js';

const NO_DEPS: ResolvedHostDeps = { terminal: null };

function statusOf(doc: Y.Doc, agentId: string): string {
  const entry = getAgents(doc).get(agentId) as Y.Map<unknown>;
  return (entry.get('state') as AgentState).status;
}

function pendingOf(doc: Y.Doc, agentId: string): AgentToolCall | undefined {
  const entry = getAgents(doc).get(agentId) as Y.Map<unknown>;
  return entry.get('pendingCall') as AgentToolCall | undefined;
}

describe('approval gate — adapter level', () => {
  it('a gated tool call sets awaiting-approval and does NOT apply until approve', async () => {
    const agentId = 'agent_gate';
    const doc = new Y.Doc();
    const adapter = new YjsAgentAdapter(
      doc,
      { agentId, kind: 'mock', displayName: 'Mock' },
      NO_DEPS,
    );
    adapter.registerAgent();

    // Seed a file the destructive call will delete.
    adapter.applyFileOp({ kind: 'write', path: 'victim.txt', content: 'precious' });
    expect(getFileText(doc, 'victim.txt').toString()).toBe('precious');

    // Register the destructive effect + record it as a gated call.
    const call: AgentToolCall = {
      id: 'call_del',
      agentId,
      tool: 'delete_file',
      args: { path: 'victim.txt' },
      requiresApproval: true,
      status: 'proposed',
    };
    adapter.registerEffect(call.id, { kind: 'file', op: { kind: 'delete', path: 'victim.txt' } });
    adapter.recordPending(call);

    // Gate is up: status awaiting-approval, pending recorded, file UNTOUCHED.
    expect(statusOf(doc, agentId)).toBe('awaiting-approval');
    expect(pendingOf(doc, agentId)?.id).toBe('call_del');
    expect(getFileText(doc, 'victim.txt').toString()).toBe('precious');

    // Approve → effect applies (file deleted), gate clears, status idle.
    const ok = await adapter.resolveApproval('call_del', 'approve');
    expect(ok).toBe(true);
    expect(getFileText(doc, 'victim.txt').toString()).toBe(''); // buffer removed
    expect(pendingOf(doc, agentId)).toBeUndefined();
    expect(statusOf(doc, agentId)).toBe('idle');
  });

  it('reject leaves the doc unchanged and clears the gate', async () => {
    const agentId = 'agent_reject';
    const doc = new Y.Doc();
    const adapter = new YjsAgentAdapter(
      doc,
      { agentId, kind: 'mock', displayName: 'Mock' },
      NO_DEPS,
    );
    adapter.registerAgent();
    adapter.applyFileOp({ kind: 'write', path: 'keep.txt', content: 'stay' });

    const call: AgentToolCall = {
      id: 'call_del2',
      agentId,
      tool: 'delete_file',
      args: { path: 'keep.txt' },
      requiresApproval: true,
      status: 'proposed',
    };
    adapter.registerEffect(call.id, { kind: 'file', op: { kind: 'delete', path: 'keep.txt' } });
    adapter.recordPending(call);
    expect(statusOf(doc, agentId)).toBe('awaiting-approval');

    const ok = await adapter.resolveApproval('call_del2', 'reject');
    expect(ok).toBe(true);
    // Unchanged: the file is still there with its content.
    expect(getFileText(doc, 'keep.txt').toString()).toBe('stay');
    expect(pendingOf(doc, agentId)).toBeUndefined();
    expect(statusOf(doc, agentId)).toBe('idle');
  });

  it('resolving an unknown call id is a no-op (returns false)', async () => {
    const agentId = 'agent_unknown';
    const doc = new Y.Doc();
    const adapter = new YjsAgentAdapter(
      doc,
      { agentId, kind: 'mock', displayName: 'Mock' },
      NO_DEPS,
    );
    adapter.registerAgent();
    expect(await adapter.resolveApproval('nope', 'approve')).toBe(false);
  });
});

describe('approval gate — end to end through the host + MockAgentBackend', () => {
  const forceMock: AgentBackendFactory = (config, sink, deps) =>
    new MockAgentBackend(config, sink, deps, {
      targetFile: 'src/out.ts',
      destructiveTarget: 'doomed.txt',
      safeCommand: 'echo hi',
    });

  it('a mock turn proposes a gated delete that only applies on approve', async () => {
    const host = new AgentHost({ backendFactory: forceMock });
    const doc = new Y.Doc();
    const agentId = 'agent_e2e';

    // Pre-seed the file the mock will try to delete.
    const adapterSeedOrigin = { kind: 'agent' as const, agentId };
    doc.transact(() => {
      getFileText(doc, 'doomed.txt').insert(0, 'delete me maybe');
    }, adapterSeedOrigin);

    await host.startAgentForRoom('room1', doc, {
      agentId,
      kind: 'mock',
      displayName: 'Mock',
    });

    await host.handleAgentMessage('room1', doc, 'do some work');

    // After the turn: the gated delete is pending; the file edit (append) DID
    // apply (safe, non-gated); the destructive target is still present.
    expect(statusOf(doc, agentId)).toBe('awaiting-approval');
    const pending = pendingOf(doc, agentId);
    expect(pending?.tool).toBe('delete_file');
    expect(pending?.requiresApproval).toBe(true);
    expect(getFileText(doc, 'doomed.txt').toString()).toBe('delete me maybe');
    // The safe append landed:
    expect(getFileText(doc, 'src/out.ts').toString()).toContain('mockHelper1');

    // Approve via the host (it finds the right agent by call id).
    const ok = await host.resolveApproval('room1', pending!.id, 'approve');
    expect(ok).toBe(true);
    expect(getFileText(doc, 'doomed.txt').toString()).toBe('');
    expect(statusOf(doc, agentId)).toBe('idle');

    await host.stopAll();
  });

  it('rejecting the mock’s gated delete preserves the file', async () => {
    const host = new AgentHost({ backendFactory: forceMock });
    const doc = new Y.Doc();
    const agentId = 'agent_e2e_rej';
    doc.transact(() => {
      getFileText(doc, 'doomed.txt').insert(0, 'survivor');
    }, { kind: 'agent', agentId });

    await host.startAgentForRoom('room2', doc, { agentId, kind: 'mock', displayName: 'M' });
    await host.handleAgentMessage('room2', doc, 'go');

    const pending = pendingOf(doc, agentId)!;
    const ok = await host.resolveApproval('room2', pending.id, 'reject');
    expect(ok).toBe(true);
    expect(getFileText(doc, 'doomed.txt').toString()).toBe('survivor');
    expect(statusOf(doc, agentId)).toBe('idle');

    await host.stopAll();
  });
});
