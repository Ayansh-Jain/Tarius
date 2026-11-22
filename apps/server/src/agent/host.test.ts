/**
 * Host + MockAgentBackend tests (v0.5 Slice A).
 *
 * Covers the end-to-end scripted flow and the two remaining contract guarantees:
 *   • the full agent turn performs NO filesystem writes (agents act only on the
 *     doc — ADR-004),
 *   • the injected TerminalRunner receives an approved/safe run-command, and
 *     without one, run-commands no-op gracefully.
 */
import { describe, it, expect, vi } from 'vitest';
import * as Y from 'yjs';
import { getAgentChat, getFileText, type AgentChatMessage } from '@ice/shared';
import { AgentHost } from './host.js';
import { MockAgentBackend } from './mock-backend.js';
import type { AgentBackendFactory, TerminalRunner } from './types.js';

/**
 * THE LAW guard: replace every filesystem WRITE entry point of node:fs and
 * node:fs/promises with a spy, while preserving real read fns. Because the agent
 * module never imports fs at all, these spies prove that a full agent turn —
 * edit + gated delete approved + safe run — performs ZERO filesystem writes. The
 * mock is hoisted by vitest above all imports, so the agent code under test sees
 * it too (if it ever tried to write).
 */
const fsWriteSpies = vi.hoisted(() => new Map<string, ReturnType<typeof vi.fn>>());

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const patched: Record<string, unknown> = { ...actual };
  for (const name of [
    'writeFileSync',
    'appendFileSync',
    'rmSync',
    'unlinkSync',
    'mkdirSync',
    'renameSync',
    'truncateSync',
    'writeFile',
    'appendFile',
    'rm',
    'unlink',
    'mkdir',
    'rename',
    'open',
    'createWriteStream',
  ]) {
    const spy = vi.fn();
    fsWriteSpies.set(name, spy);
    patched[name] = spy;
  }
  return { ...patched, default: patched };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const patched: Record<string, unknown> = { ...actual };
  for (const name of ['writeFile', 'appendFile', 'rm', 'unlink', 'mkdir', 'rename', 'truncate']) {
    const spy = vi.fn();
    fsWriteSpies.set(`promises.${name}`, spy);
    patched[name] = spy;
  }
  return { ...patched, default: patched };
});

function chatTexts(doc: Y.Doc): AgentChatMessage[] {
  return getAgentChat(doc).toArray() as AgentChatMessage[];
}

const mockFactory =
  (opts?: ConstructorParameters<typeof MockAgentBackend>[3]): AgentBackendFactory =>
  (config, sink, deps) =>
    new MockAgentBackend(config, sink, deps, opts);

describe('AgentHost — scripted mock turn', () => {
  it('records the human prompt and the agent reply in getAgentChat', async () => {
    const host = new AgentHost({ backendFactory: mockFactory() });
    const doc = new Y.Doc();
    await host.startAgentForRoom('r', doc, { agentId: 'a1', kind: 'mock', displayName: 'A' });

    await host.handleAgentMessage('r', doc, 'please help');

    const msgs = chatTexts(doc);
    expect(msgs.length).toBeGreaterThanOrEqual(2);
    expect(msgs[0]).toMatchObject({ role: 'user', text: 'please help', agentId: 'a1' });
    expect(msgs.find((m) => m.role === 'agent')).toBeTruthy();

    await host.stopAll();
  });

  it('appends a generated function to the target file (safe, non-gated)', async () => {
    const host = new AgentHost({
      backendFactory: mockFactory({ targetFile: 'lib/x.ts' }),
    });
    const doc = new Y.Doc();
    await host.startAgentForRoom('r', doc, { agentId: 'a2', kind: 'mock', displayName: 'A' });
    await host.handleAgentMessage('r', doc, 'hi');

    const text = getFileText(doc, 'lib/x.ts').toString();
    expect(text).toContain('export function mockHelper1');

    // A second turn appends again (deterministic, turn-numbered).
    await host.handleAgentMessage('r', doc, 'again');
    const text2 = getFileText(doc, 'lib/x.ts').toString();
    expect(text2).toContain('mockHelper1');
    expect(text2).toContain('mockHelper2');

    await host.stopAll();
  });

  it('startAgentForRoom is idempotent per (room, agent)', async () => {
    const host = new AgentHost({ backendFactory: mockFactory() });
    const doc = new Y.Doc();
    const a = await host.startAgentForRoom('r', doc, { agentId: 'a', kind: 'mock', displayName: 'A' });
    const b = await host.startAgentForRoom('r', doc, { agentId: 'a', kind: 'mock', displayName: 'A' });
    expect(a).toBe(b);
    await host.stopAll();
  });
});

describe('AgentHost — terminal injection', () => {
  it('hands an approved/safe run-command to the injected TerminalRunner', async () => {
    const runCommand = vi.fn(async () => {});
    const terminal: TerminalRunner = { runCommand };
    const host = new AgentHost({
      terminal,
      backendFactory: mockFactory({ safeCommand: 'echo injected' }),
    });
    const doc = new Y.Doc();
    await host.startAgentForRoom('roomT', doc, { agentId: 'aT', kind: 'mock', displayName: 'A' });

    await host.handleAgentMessage('roomT', doc, 'run it');

    // The safe run-command (non-gated) is applied immediately → terminal called
    // with the room id and command.
    expect(runCommand).toHaveBeenCalledWith('roomT', 'echo injected');

    await host.stopAll();
  });

  it('without a terminal, run-commands no-op (no throw)', async () => {
    const host = new AgentHost({ backendFactory: mockFactory({ safeCommand: 'echo none' }) });
    const doc = new Y.Doc();
    await host.startAgentForRoom('roomN', doc, { agentId: 'aN', kind: 'mock', displayName: 'A' });
    await expect(host.handleAgentMessage('roomN', doc, 'go')).resolves.toBeUndefined();
    await host.stopAll();
  });
});

describe('AgentHost — interrupt + stop', () => {
  it('stopAgent unregisters the agent from the doc', async () => {
    const host = new AgentHost({ backendFactory: mockFactory() });
    const doc = new Y.Doc();
    await host.startAgentForRoom('r', doc, { agentId: 'gone', kind: 'mock', displayName: 'A' });
    expect(host.getRunningAgent('r', 'gone')).toBeTruthy();
    await host.stopAgent('r', 'gone');
    expect(host.getRunningAgent('r', 'gone')).toBeUndefined();
    // Doc entry removed too.
    expect((doc.getMap('agents') as Y.Map<unknown>).get('gone')).toBeUndefined();
  });

  it('interruptAgent returns the agent to idle', async () => {
    const host = new AgentHost({ backendFactory: mockFactory() });
    const doc = new Y.Doc();
    await host.startAgentForRoom('r', doc, { agentId: 'busy', kind: 'mock', displayName: 'A' });
    await host.handleAgentMessage('r', doc, 'work'); // leaves awaiting-approval
    expect(host.interruptAgent('r', 'busy')).toBe(true);
    const entry = (doc.getMap('agents') as Y.Map<unknown>).get('busy') as Y.Map<unknown>;
    expect((entry.get('state') as { status: string }).status).toBe('idle');
    await host.stopAll();
  });
});

describe('THE LAW — agents perform NO filesystem writes', () => {
  it('a complete turn (edit + gated delete approved + safe run) touches the fs zero times', async () => {
    for (const spy of fsWriteSpies.values()) spy.mockClear();

    // A terminal that itself never writes the fs (records the call only).
    const calls: string[] = [];
    const terminal: TerminalRunner = {
      async runCommand(_room, cmd) {
        calls.push(cmd);
      },
    };

    const host = new AgentHost({
      terminal,
      backendFactory: mockFactory({ destructiveTarget: 'tmp/del.me', safeCommand: 'noop' }),
    });
    const doc = new Y.Doc();
    const agentId = 'law';

    // Seed via an agent-origin doc transaction (still no fs).
    doc.transact(() => {
      getFileText(doc, 'tmp/del.me').insert(0, 'bytes');
    }, { kind: 'agent', agentId });

    await host.startAgentForRoom('r', doc, { agentId, kind: 'mock', displayName: 'A' });
    await host.handleAgentMessage('r', doc, 'do the whole thing');

    const pending = (doc.getMap('agents').get(agentId) as Y.Map<unknown>).get(
      'pendingCall',
    ) as { id: string };
    await host.resolveApproval('r', pending.id, 'approve');

    // The safe run-command reached the (fs-free) terminal stub.
    expect(calls).toContain('noop');
    // The delete applied to the DOC (buffer gone), not the disk.
    expect(getFileText(doc, 'tmp/del.me').toString()).toBe('');

    // THE LAW: not a single filesystem write happened anywhere in the host.
    for (const [name, spy] of fsWriteSpies) {
      expect(spy, `fs.${name} must not be called`).not.toHaveBeenCalled();
    }

    await host.stopAll();
  });
});
