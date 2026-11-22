/**
 * Agent host — internal contracts (v0.5 Slice A).
 *
 * These are the seams that keep the agent host decoupled from the rest of the
 * server. A backend (mock or ACP) only describes INTENT — proposed messages,
 * edits, and tool calls — by emitting {@link AgentEvent}s. It never touches the
 * Yjs doc or the filesystem itself. The {@link YjsAgentAdapter} is the single
 * place those intents become origin-tagged Yjs transactions (ADR-004).
 *
 * Terminal execution is injected via {@link TerminalRunner} so Slice B (the PTY
 * terminal) can supply a real implementation without this module importing it.
 */
import type * as Y from 'yjs';
import type {
  AgentConfig,
  AgentEvent,
  ApprovalDecision,
  RoomId,
} from '@ice/shared';
import type { AgentToolEffect } from './adapter.js';

/**
 * Where a backend's emitted events go. The host wires this to the adapter so
 * every status change / message / edit / tool call lands on the doc. A backend
 * is handed a sink at construction and calls `sink.emit(event)` — it must never
 * import the adapter or the doc directly.
 */
export interface AgentEventSink {
  emit(event: AgentEvent): void;
}

/**
 * What the host hands a backend: the event sink PLUS the two read/execute
 * primitives a backend legitimately needs, all adapter-provided so no backend
 * ever sees the doc. `registerEffect` associates an executable effect with a
 * proposed tool call so the approval gate can run it; `readFile` lets a backend
 * inspect current file content (mock chooses where to append; ACP serves the
 * agent's fs/read requests) — always the live doc, never disk.
 */
export interface AgentIntentSink extends AgentEventSink {
  registerEffect(callId: string, effect: AgentToolEffect): void;
  readFile(path: string): string;
}

/**
 * A pluggable agent backend. Implementations: {@link MockAgentBackend} (scripted,
 * dependency-free, used in tests/CI) and {@link AcpAgentBackend} (spawns a real
 * ACP agent over stdio). The contract is intentionally tiny:
 *
 *   start()            — spin up / connect; resolve once ready to take messages.
 *   sendUserMessage()  — feed a human prompt; the backend reacts by emitting
 *                        events (status → message → edit → tool-call …).
 *   resolveApproval()  — a human resolved a gated tool call; the backend may use
 *                        this to continue a paused turn (ACP) or is a no-op for
 *                        backends whose gating is handled entirely host-side.
 *   interrupt()        — cancel the agent's current run.
 *   stop()             — tear down; resolve once fully shut down.
 *
 * A backend NEVER applies edits or tool calls itself — it only proposes them via
 * events. The adapter/host decides what actually mutates the doc.
 */
export interface AgentBackend {
  readonly config: AgentConfig;
  start(): Promise<void>;
  sendUserMessage(text: string): Promise<void>;
  /**
   * Notify the backend of a human approval decision for a previously-proposed
   * gated tool call. Optional: host-gated backends (mock) don't need it.
   */
  resolveApproval?(callId: string, decision: ApprovalDecision): void;
  /** Cancel the current run/turn. Best-effort. */
  interrupt(): void;
  stop(): Promise<void>;
}

/**
 * Injected terminal executor (Slice B). The agent host hands run-command tool
 * calls to this once approved. Decoupled so the absence of Slice B degrades
 * gracefully — see {@link AgentHostDeps.terminal}.
 */
export interface TerminalRunner {
  runCommand(roomId: RoomId, command: string): Promise<void>;
}

/**
 * Factory the host uses to build a backend for a config. The driver can inject a
 * custom factory (e.g. to force the mock in CI, or to pass a pre-built ACP
 * spawn). When omitted the host uses its built-in factory: `mock` → mock,
 * everything else → ACP (which itself falls back to a clear error if no binary).
 */
export type AgentBackendFactory = (
  config: AgentConfig,
  sink: AgentIntentSink,
  deps: ResolvedHostDeps,
) => AgentBackend;

/** Dependencies a caller may inject when starting an agent. */
export interface AgentHostDeps {
  /**
   * Real terminal executor. If absent, run-command tool calls are still
   * recorded as events/tool-calls on the doc but execute nothing (no-op).
   */
  terminal?: TerminalRunner;
  /** Override how backends are constructed (tests force the mock here). */
  backendFactory?: AgentBackendFactory;
}

/** Deps after defaults are filled in, handed to backends/adapter. */
export interface ResolvedHostDeps {
  terminal: TerminalRunner | null;
}

/**
 * A live agent on a room: its backend, the doc it acts through, and the adapter
 * translating intents into transactions. Owned by the host registry.
 */
export interface RunningAgent {
  readonly roomId: RoomId;
  readonly doc: Y.Doc;
  readonly backend: AgentBackend;
}
