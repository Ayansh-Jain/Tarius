/**
 * Agent host — public API (v0.5 Slice A).
 *
 * THE AGENT LAW (ADR-004): agents are first-class participants that act THROUGH
 * the Yjs doc. This module is the server-side home of that law: every agent file
 * edit is an origin-tagged `{kind:'agent', agentId}` transaction (attributable +
 * undoable), and every risky tool call passes a human approval gate before it
 * applies. Agents never touch the raw filesystem.
 *
 * The driver wires this into the v0.1-owned files (api.ts / index.ts) — see the
 * slice's wiringInstructions. The module-level functions below delegate to a
 * single shared {@link AgentHost} so callers don't manage the registry; the
 * `AgentHost` class is also exported for advanced callers and tests that want an
 * isolated instance.
 *
 *   startAgentForRoom(roomId, doc, config, deps?)  — spawn + register an agent
 *   handleAgentMessage(roomId, doc, text, opts?)   — feed a human prompt
 *   resolveApproval(roomId, callId, decision)      — approve/reject a gated call
 *   stopAgent(roomId, agentId)                     — tear an agent down
 *   interruptAgent(roomId, agentId?)               — cancel the current run
 */
import type * as Y from 'yjs';
import type {
  AgentConfig,
  AgentId,
  ApprovalDecision,
  RoomId,
} from '@ice/shared';
import { AgentHost } from './host.js';
import type { AgentHostDeps, RunningAgent, TerminalRunner } from './types.js';

/**
 * Process-wide agent host. The driver may seed defaults (e.g. inject Slice B's
 * terminal once) via {@link configureAgentHost}; otherwise it starts empty and
 * each `startAgentForRoom` call supplies its own deps.
 */
let sharedHost = new AgentHost();

/**
 * Seed the shared host's default deps — call once at boot to inject the terminal
 * runner (Slice B) and/or a backend factory. Replaces the shared host, so call
 * it before starting any agents.
 */
export function configureAgentHost(defaults: AgentHostDeps): void {
  sharedHost = new AgentHost(defaults);
}

/** The process-wide host (advanced callers / graceful shutdown). */
export function getAgentHost(): AgentHost {
  return sharedHost;
}

/** Start (or return the existing) agent for a room. See {@link AgentHost}. */
export function startAgentForRoom(
  roomId: RoomId,
  doc: Y.Doc,
  config: AgentConfig,
  deps?: AgentHostDeps,
): Promise<RunningAgent> {
  return sharedHost.startAgentForRoom(roomId, doc, config, deps);
}

/** Feed a human prompt to a room's agent. */
export function handleAgentMessage(
  roomId: RoomId,
  doc: Y.Doc,
  text: string,
  opts?: { agentId?: AgentId },
): Promise<void> {
  return sharedHost.handleAgentMessage(roomId, doc, text, opts);
}

/** Approve/reject a gated tool call. Returns true if a matching call existed. */
export function resolveApproval(
  roomId: RoomId,
  callId: string,
  decision: ApprovalDecision,
  opts?: { agentId?: AgentId },
): Promise<boolean> {
  return sharedHost.resolveApproval(roomId, callId, decision, opts);
}

/** Cancel a room agent's current run. */
export function interruptAgent(roomId: RoomId, agentId?: AgentId): boolean {
  return sharedHost.interruptAgent(roomId, agentId);
}

/** Stop + unregister a room's agent. */
export function stopAgent(roomId: RoomId, agentId: AgentId): Promise<void> {
  return sharedHost.stopAgent(roomId, agentId);
}

// ── Types & implementations (for the driver, tests, and other slices) ──────────
export { AgentHost } from './host.js';
export { defaultBackendFactory } from './host.js';
export { YjsAgentAdapter } from './adapter.js';
export { MockAgentBackend } from './mock-backend.js';
export type { MockAgentOptions } from './mock-backend.js';
export { AcpAgentBackend, resolveAcpSpawn } from './acp-backend.js';
export type { AcpSpawnSpec } from './acp-backend.js';
export type {
  AgentBackend,
  AgentBackendFactory,
  AgentEventSink,
  AgentIntentSink,
  AgentHostDeps,
  ResolvedHostDeps,
  RunningAgent,
  TerminalRunner,
} from './types.js';
export type { AgentFileOp, AgentToolEffect, PendingToolCall } from './adapter.js';

/** Re-export the injected-terminal type at top level for the driver's wiring. */
export type { TerminalRunner as InjectedTerminalRunner };
