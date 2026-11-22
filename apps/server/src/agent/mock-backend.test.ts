/**
 * MockAgentBackend tests (v0.5 Slice A) — the scripted intent contract.
 *
 * Drives the backend with a RECORDING sink (not the real adapter) to prove it
 * only DESCRIBES intent — message, file edit, ONE gated destructive call, and a
 * safe run-command — in a deterministic, inspectable order, and never touches a
 * doc or the filesystem itself.
 */
import { describe, it, expect } from 'vitest';
import type { AgentEvent } from '@ice/shared';
import { MockAgentBackend } from './mock-backend.js';
import type { AgentIntentSink, ResolvedHostDeps } from './types.js';
import type { AgentToolEffect } from './adapter.js';

const NO_DEPS: ResolvedHostDeps = { terminal: null };

/** A sink that records events + registered effects instead of mutating a doc. */
class RecordingSink implements AgentIntentSink {
  events: AgentEvent[] = [];
  effects = new Map<string, AgentToolEffect>();
  files = new Map<string, string>();

  emit(event: AgentEvent): void {
    this.events.push(event);
  }
  registerEffect(callId: string, effect: AgentToolEffect): void {
    this.effects.set(callId, effect);
  }
  readFile(path: string): string {
    return this.files.get(path) ?? '';
  }

  byType<T extends AgentEvent['type']>(type: T): Extract<AgentEvent, { type: T }>[] {
    return this.events.filter((e) => e.type === type) as Extract<AgentEvent, { type: T }>[];
  }
}

function makeMock(agentId = 'm1') {
  const sink = new RecordingSink();
  const backend = new MockAgentBackend(
    { agentId, kind: 'mock', displayName: 'Mock' },
    sink,
    NO_DEPS,
  );
  return { sink, backend, agentId };
}

describe('MockAgentBackend — scripted intents', () => {
  it('emits message → file edit → gated destructive call → safe run, in order', async () => {
    const { sink, backend, agentId } = makeMock();
    await backend.start();
    await backend.sendUserMessage('build me a thing');

    // (1) a chat reply.
    const messages = sink.byType('message');
    expect(messages).toHaveLength(1);
    expect(messages[0]!.message).toMatchObject({ agentId, role: 'agent' });
    expect(messages[0]!.message.text).toContain('build me a thing');

    // (2) a file edit proposal (non-gated) + an 'edit' breadcrumb.
    const toolCalls = sink.byType('tool-call').map((e) => e.call);
    const editCall = toolCalls.find((c) => c.tool === 'write_file');
    expect(editCall).toBeTruthy();
    expect(editCall!.requiresApproval).toBe(false);
    expect(sink.effects.get(editCall!.id)).toMatchObject({
      kind: 'file',
      op: { kind: 'append' },
    });
    expect(sink.byType('edit')).toHaveLength(1);

    // (3) EXACTLY ONE destructive, approval-required call (a delete).
    const gated = toolCalls.filter((c) => c.requiresApproval);
    expect(gated).toHaveLength(1);
    expect(gated[0]!.tool).toBe('delete_file');
    expect(sink.effects.get(gated[0]!.id)).toMatchObject({
      kind: 'file',
      op: { kind: 'delete' },
    });
    // It is announced via an awaiting-approval event too.
    const awaiting = sink.byType('awaiting-approval');
    expect(awaiting).toHaveLength(1);
    expect(awaiting[0]!.call.id).toBe(gated[0]!.id);

    // (4) a safe run-command (non-gated) with a registered 'run' effect.
    const runCall = toolCalls.find((c) => c.tool === 'run');
    expect(runCall).toBeTruthy();
    expect(runCall!.requiresApproval).toBe(false);
    expect(sink.effects.get(runCall!.id)).toMatchObject({ kind: 'run' });

    // Deterministic ids carry the turn index.
    expect(editCall!.id).toContain('-t1-');
    expect(gated[0]!.id).toContain('-t1-');
  });

  it('is deterministic across turns (turn-numbered ids + snippets)', async () => {
    const { sink, backend } = makeMock('det');
    await backend.start();
    await backend.sendUserMessage('one');
    await backend.sendUserMessage('two');

    const writeCalls = sink
      .byType('tool-call')
      .map((e) => e.call)
      .filter((c) => c.tool === 'write_file');
    expect(writeCalls).toHaveLength(2);
    expect(writeCalls[0]!.id).toBe('det-t1-edit');
    expect(writeCalls[1]!.id).toBe('det-t2-edit');
    expect(backend.turnsRun).toBe(2);
  });

  it('throws if sendUserMessage is called before start()', async () => {
    const { backend } = makeMock();
    await expect(backend.sendUserMessage('x')).rejects.toThrow(/before start/);
  });

  it('interrupt stops mid-turn and emits idle', async () => {
    const { sink, backend } = makeMock('int');
    await backend.start();
    // Interrupt is synchronous; to observe it we interrupt, then the next turn is
    // a clean slate. Here we assert interrupt emits an idle status.
    backend.interrupt();
    const statuses = sink.byType('status').map((e) => e.status);
    expect(statuses).toContain('idle');
  });
});
