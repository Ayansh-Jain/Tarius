/**
 * Agent host registry (v0.5 Slice A) — the public entry point.
 *
 * Owns the live agents keyed by (roomId, agentId): for each it constructs a
 * backend (mock or ACP), wires it to a {@link YjsAgentAdapter} (the ACP↔Yjs
 * boundary), and exposes the lifecycle the driver calls from API routes:
 *
 *   startAgentForRoom(roomId, doc, config, deps?)  — spawn + register an agent.
 *   handleAgentMessage(roomId, doc, text, opts?)   — feed a human prompt.
 *   resolveApproval(roomId, callId, decision)      — resolve a gated tool call.
 *   stopAgent(roomId, agentId)                     — tear an agent down.
 *
 * The host injects the optional {@link TerminalRunner} (Slice B) into the
 * adapter so approved run-commands execute; absent one, they no-op. Approval
 * resolution is dual-dispatched: the adapter applies any host-side effect AND
 * the backend is notified (so an ACP agent's parked permission request unblocks).
 */
import type * as Y from 'yjs';
import {
  getAgentChat,
  transactWithOrigin,
  type AgentChatMessage,
  type AgentConfig,
  type AgentId,
  type ApprovalDecision,
  type RoomId,
} from '@ice/shared';
import { YjsAgentAdapter } from './adapter.js';
import { MockAgentBackend } from './mock-backend.js';
import { AcpAgentBackend } from './acp-backend.js';
import type {
  AgentBackend,
  AgentBackendFactory,
  AgentHostDeps,
  AgentIntentSink,
  ResolvedHostDeps,
  RunningAgent,
} from './types.js';

/** One running agent plus its adapter, owned by the registry. */
interface AgentEntry extends RunningAgent {
  adapter: YjsAgentAdapter;
}

/**
 * The host registry. A module-level singleton is exported for the driver, but
 * the class is exported too so tests get fresh, isolated instances.
 */
export class AgentHost {
  private readonly agents = new Map<string, AgentEntry>();

  /** Default deps merged into every start() unless overridden per call. */
  constructor(private readonly defaults: AgentHostDeps = {}) {}

  private key(roomId: RoomId, agentId: AgentId): string {
    return `${roomId}::${agentId}`;
  }

  /** Resolve a config's deps, layering call-level over host-level defaults. */
  private resolveDeps(deps?: AgentHostDeps): {
    resolved: ResolvedHostDeps;
    factory: AgentBackendFactory;
  } {
    const terminal = deps?.terminal ?? this.defaults.terminal ?? null;
    const factory =
      deps?.backendFactory ?? this.defaults.backendFactory ?? defaultBackendFactory;
    return { resolved: { terminal }, factory };
  }

  /**
   * Start (or return the existing) agent for a room. Constructs the adapter,
   * registers the agent on the doc, builds the backend, and starts it. Safe to
   * call twice for the same (room, agent): the existing instance is returned.
   */
  async startAgentForRoom(
    roomId: RoomId,
    doc: Y.Doc,
    config: AgentConfig,
    deps?: AgentHostDeps,
  ): Promise<RunningAgent> {
    const k = this.key(roomId, config.agentId);
    const existing = this.agents.get(k);
    if (existing) return existing;

    const { resolved, factory } = this.resolveDeps(deps);

    const adapter = new YjsAgentAdapter(doc, config, resolved);
    adapter.setRoomId(roomId);
    adapter.registerAgent();

    const sink: AgentIntentSink = adapter;
    const backend: AgentBackend = factory(config, sink, resolved);

    const entry: AgentEntry = { roomId, doc, backend, adapter };
    this.agents.set(k, entry);

    try {
      await backend.start();
    } catch (err) {
      // A failed start must not leave a half-registered agent around. Surface
      // the error on the doc, then unregister so a retry is clean.
      adapter.emit({
        type: 'error',
        agentId: config.agentId,
        message: `failed to start agent: ${String((err as Error)?.message ?? err)}`,
      });
      adapter.unregisterAgent();
      this.agents.delete(k);
      throw err;
    }

    return entry;
  }

  /**
   * Feed a human prompt to a room's agent. Appends the user's message to
   * getAgentChat(doc) (attributed to the agent's transcript) and drives the
   * backend. If the agent isn't started yet this throws — the driver should
   * startAgentForRoom first.
   */
  async handleAgentMessage(
    roomId: RoomId,
    doc: Y.Doc,
    text: string,
    opts: { agentId?: AgentId } = {},
  ): Promise<void> {
    const entry = this.resolveEntry(roomId, opts.agentId);
    if (!entry) {
      throw new Error(
        `no agent running for room '${roomId}'` +
          (opts.agentId ? ` with id '${opts.agentId}'` : ''),
      );
    }

    // Record the human's prompt in the transcript first, with the agent origin
    // (the chat is the agent's surface; attribution of the human author is in
    // the message's role/agentId, not the Yjs origin).
    const message: AgentChatMessage = {
      id: `msg_${rand()}`,
      agentId: entry.backend.config.agentId,
      role: 'user',
      text,
      createdAt: Date.now(),
    };
    transactWithOrigin(doc, entry.adapter.editOrigin, () => {
      getAgentChat(doc).push([message]);
    });

    await entry.backend.sendUserMessage(text);
  }

  /**
   * Resolve a gated tool call. Dual-dispatch:
   *   1. the adapter applies any host-side effect (mock) / clears the gate, then
   *   2. the backend is notified (ACP unblocks its parked permission request).
   * Returns true if a matching pending call was found in this room.
   */
  async resolveApproval(
    roomId: RoomId,
    callId: string,
    decision: ApprovalDecision,
    opts: { agentId?: AgentId } = {},
  ): Promise<boolean> {
    // Find the agent that actually has this pending call (so callers don't have
    // to know which agent it belongs to).
    const candidates = opts.agentId
      ? [this.agents.get(this.key(roomId, opts.agentId))].filter(Boolean as never)
      : [...this.agents.values()].filter((e) => e.roomId === roomId);

    for (const entry of candidates as AgentEntry[]) {
      const pending = entry.adapter.pendingCallOnDoc();
      if (pending?.id !== callId) continue;
      const applied = await entry.adapter.resolveApproval(callId, decision);
      entry.backend.resolveApproval?.(callId, decision);
      return applied;
    }
    return false;
  }

  /** Interrupt a room agent's current run (cancel the turn). */
  interruptAgent(roomId: RoomId, agentId?: AgentId): boolean {
    const entry = this.resolveEntry(roomId, agentId);
    if (!entry) return false;
    entry.backend.interrupt();
    entry.adapter.setStatus('idle');
    return true;
  }

  /** Stop + unregister a room's agent. Idempotent. */
  async stopAgent(roomId: RoomId, agentId: AgentId): Promise<void> {
    const k = this.key(roomId, agentId);
    const entry = this.agents.get(k);
    if (!entry) return;
    this.agents.delete(k);
    try {
      await entry.backend.stop();
    } finally {
      entry.adapter.unregisterAgent();
    }
  }

  /** Stop every agent (graceful shutdown). */
  async stopAll(): Promise<void> {
    const all = [...this.agents.values()];
    this.agents.clear();
    await Promise.all(
      all.map(async (e) => {
        try {
          await e.backend.stop();
        } finally {
          e.adapter.unregisterAgent();
        }
      }),
    );
  }

  /** Inspect a running agent (tests / introspection). */
  getRunningAgent(roomId: RoomId, agentId: AgentId): RunningAgent | undefined {
    return this.agents.get(this.key(roomId, agentId));
  }

  private resolveEntry(roomId: RoomId, agentId?: AgentId): AgentEntry | undefined {
    if (agentId) return this.agents.get(this.key(roomId, agentId));
    // No id given: if exactly one agent runs in the room, use it.
    const inRoom = [...this.agents.values()].filter((e) => e.roomId === roomId);
    return inRoom.length === 1 ? inRoom[0] : undefined;
  }
}

/**
 * Built-in backend factory: 'mock' → {@link MockAgentBackend}; any other kind →
 * {@link AcpAgentBackend} (which fails gracefully if no binary/key). The driver
 * can override this via AgentHostDeps.backendFactory (e.g. to force the mock in
 * CI, or to pin a cwd for the ACP child).
 */
export const defaultBackendFactory: AgentBackendFactory = (config, sink, deps) => {
  if (config.kind === 'mock') return new MockAgentBackend(config, sink, deps);
  return new AcpAgentBackend(config, sink, deps);
};

function rand(): string {
  return Math.random().toString(36).slice(2, 10);
}
