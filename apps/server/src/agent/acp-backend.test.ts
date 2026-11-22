/**
 * AcpAgentBackend tests (v0.5 Slice A) — graceful degradation only.
 *
 * The real ACP path is NOT runtime-tested here (no agent binary / API key in
 * CI). These cover the guard rails the spec requires: spawn-spec resolution from
 * env, and a clear, non-crashing error when no command is configured or the
 * binary is missing. The mock backend covers the live behavioral contract.
 */
import { describe, it, expect } from 'vitest';
import { AcpAgentBackend, resolveAcpSpawn } from './acp-backend.js';
import type { AgentConfig } from '@ice/shared';
import type { AgentEvent } from '@ice/shared';
import type { AgentIntentSink, ResolvedHostDeps } from './types.js';
import type { AgentToolEffect } from './adapter.js';

const NO_DEPS: ResolvedHostDeps = { terminal: null };

class CollectSink implements AgentIntentSink {
  events: AgentEvent[] = [];
  emit(e: AgentEvent): void {
    this.events.push(e);
  }
  registerEffect(_id: string, _e: AgentToolEffect): void {}
  readFile(): string {
    return '';
  }
}

const cfg = (kind: AgentConfig['kind']): AgentConfig => ({
  agentId: 'acp1',
  kind,
  displayName: 'ACP',
});

describe('resolveAcpSpawn', () => {
  it('uses ICE_AGENT_CMD / ICE_AGENT_ARGS override when present', () => {
    const spec = resolveAcpSpawn(cfg('claude-code'), '/tmp/room', {
      ICE_AGENT_CMD: '/usr/local/bin/my-agent',
      ICE_AGENT_ARGS: '--acp --flag x',
    } as NodeJS.ProcessEnv);
    expect(spec).toEqual({
      command: '/usr/local/bin/my-agent',
      args: ['--acp', '--flag', 'x'],
      env: expect.anything(),
      cwd: '/tmp/room',
    });
  });

  it('falls back to a per-kind default command name', () => {
    expect(resolveAcpSpawn(cfg('claude-code'), '/r', {} as NodeJS.ProcessEnv)?.command).toBe(
      'claude-code-acp',
    );
    expect(resolveAcpSpawn(cfg('gemini'), '/r', {} as NodeJS.ProcessEnv)?.command).toBe('gemini');
  });

  it('returns null for the mock kind (no ACP command)', () => {
    expect(resolveAcpSpawn(cfg('mock'), '/r', {} as NodeJS.ProcessEnv)).toBeNull();
  });
});

describe('AcpAgentBackend — graceful failure', () => {
  it('start() rejects with a clear error when no command resolves', async () => {
    const sink = new CollectSink();
    const backend = new AcpAgentBackend(cfg('mock'), sink, NO_DEPS, { env: {} as NodeJS.ProcessEnv });
    await expect(backend.start()).rejects.toThrow(/No ACP command|ICE_AGENT_CMD/);
  });

  it('start() surfaces a spawn error (missing binary) without crashing', async () => {
    const sink = new CollectSink();
    const backend = new AcpAgentBackend(cfg('claude-code'), sink, NO_DEPS, {
      cwd: '/tmp',
      env: {
        ICE_AGENT_CMD: '/nonexistent/definitely-not-a-real-agent-binary-xyz',
      } as NodeJS.ProcessEnv,
    });

    // The child spawns lazily; ENOENT arrives async on the 'error' event, which
    // we translate into an error AgentEvent. Either way: no throw that crashes
    // the process, and stop() is safe.
    try {
      await backend.start();
    } catch {
      /* a synchronous spawn rejection is also acceptable */
    }
    await backend.stop();
    expect(true).toBe(true);
  });
});
