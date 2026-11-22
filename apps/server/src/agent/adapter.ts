/**
 * THE ACP↔Yjs ADAPTER (v0.5 Slice A) — the first-class boundary.
 *
 * THE AGENT LAW (ADR-004): an agent is a first-class participant that acts
 * THROUGH the Yjs doc. This adapter is the *only* place an agent's intent
 * becomes room state, and it does so EXCLUSIVELY via
 *   transactWithOrigin(doc, { kind:'agent', agentId }, …)
 * so every agent edit is attributable and per-origin undoable. The adapter
 * NEVER touches the filesystem — projecting the doc onto disk is the convergence
 * module's job at commit time.
 *
 * Responsibilities:
 *   • Maintain the agent's {@link AgentState} in getAgents(doc) (status + the
 *     pending approval, so every client sees the gate).
 *   • Append messages to getAgentChat(doc).
 *   • Apply file reads/writes/edits to getFileText(doc, path).
 *   • Own the APPROVAL GATE: a gated tool call is recorded as pending and is NOT
 *     applied until a human resolves it (approve → apply, reject → discard).
 *
 * The adapter is the sink a backend emits into: it turns each {@link AgentEvent}
 * into the appropriate doc mutation.
 */
import * as Y from 'yjs';
import {
  getAgentChat,
  getAgents,
  getFileText,
  transactWithOrigin,
  type AgentChatMessage,
  type AgentConfig,
  type AgentEvent,
  type AgentRunStatus,
  type AgentState,
  type AgentToolCall,
} from '@ice/shared';
import type { AgentIntentSink, ResolvedHostDeps, TerminalRunner } from './types.js';

/**
 * A file operation an agent proposes. This is the adapter's normalized view of
 * an ACP file write/edit (or a mock's scripted edit). The backend produces these
 * as part of a `tool-call` or directly; the adapter applies them to the doc.
 */
export type AgentFileOp =
  | { kind: 'write'; path: string; content: string }
  | { kind: 'append'; path: string; content: string }
  | {
      /** Replace the first occurrence of `find` with `replace`. */
      kind: 'replace';
      path: string;
      find: string;
      replace: string;
    }
  | { kind: 'delete'; path: string };

/**
 * The structured payload we attach to a tool call so the adapter knows how to
 * EXECUTE it once approved. `args` (the frozen AgentToolCall.args) carries the
 * human-facing description; this is the executable intent.
 */
export type AgentToolEffect =
  | { kind: 'file'; op: AgentFileOp }
  | { kind: 'run'; command: string };

/** A tool call plus the effect to run when it is applied. */
export interface PendingToolCall {
  call: AgentToolCall;
  effect: AgentToolEffect;
}

/**
 * Extended tool-call event a backend emits when it wants the adapter to be able
 * to execute the call. We can't widen the frozen AgentEvent union, so backends
 * emit the base `tool-call` / `awaiting-approval` event for the wire/UI AND hand
 * the adapter the executable effect via {@link YjsAgentAdapter.registerEffect}.
 */

/** How long a tool call's terminal run may take before we mark it errored. */
const RUN_TIMEOUT_MS = 5 * 60_000;

/**
 * Translates one agent's intents into Yjs transactions on one room doc. One
 * adapter instance per (room, agent). Construct it, hand it to the backend as
 * the {@link AgentEventSink}, then call {@link registerAgent} once so the agent
 * appears in getAgents(doc).
 */
export class YjsAgentAdapter implements AgentIntentSink {
  private readonly doc: Y.Doc;
  private readonly config: AgentConfig;
  private readonly origin: { kind: 'agent'; agentId: string };
  private readonly terminal: TerminalRunner | null;

  /** Pending gated tool calls by callId, awaiting a human decision. */
  private readonly pending = new Map<string, PendingToolCall>();
  /** Executable effects for calls (gated or not), by callId. */
  private readonly effects = new Map<string, AgentToolEffect>();

  constructor(doc: Y.Doc, config: AgentConfig, deps: ResolvedHostDeps) {
    this.doc = doc;
    this.config = config;
    this.origin = { kind: 'agent', agentId: config.agentId };
    this.terminal = deps.terminal;
  }

  /** The Yjs transaction origin used for every mutation this adapter makes. */
  get editOrigin(): { kind: 'agent'; agentId: string } {
    return this.origin;
  }

  // ── Lifecycle / state ──────────────────────────────────────────────────────

  /**
   * Register (or refresh) the agent in getAgents(doc) so every client sees it.
   * Idempotent. Status starts 'idle'.
   */
  registerAgent(): void {
    const state: AgentState = {
      agentId: this.config.agentId,
      kind: this.config.kind,
      displayName: this.config.displayName,
      color: colorForAgent(this.config.agentId),
      status: 'idle',
    };
    transactWithOrigin(this.doc, this.origin, () => {
      const agents = getAgents(this.doc);
      const entry = new Y.Map<unknown>();
      entry.set('state', state);
      // Pending tool call (if any) lives here so the gate is visible to all.
      agents.set(this.config.agentId, entry);
    });
  }

  /** Remove the agent from the doc (on stop). Clears any pending gate too. */
  unregisterAgent(): void {
    transactWithOrigin(this.doc, this.origin, () => {
      getAgents(this.doc).delete(this.config.agentId);
    });
    this.pending.clear();
    this.effects.clear();
  }

  /** Current status from the doc, or 'idle' if not registered. */
  get status(): AgentRunStatus {
    const entry = getAgents(this.doc).get(this.config.agentId);
    if (entry instanceof Y.Map) {
      const state = entry.get('state') as AgentState | undefined;
      if (state) return state.status;
    }
    return 'idle';
  }

  // ── AgentEventSink: intents → doc ──────────────────────────────────────────

  /**
   * Apply a backend event to the doc. This is the single funnel every backend
   * intent flows through. Unknown/extension events are ignored.
   */
  emit(event: AgentEvent): void {
    switch (event.type) {
      case 'status':
        this.setStatus(event.status);
        break;
      case 'message':
        this.appendMessage(event.message);
        break;
      case 'edit':
        // 'edit' is a UI breadcrumb (which file changed). The actual content
        // change is applied via applyFileOp; nothing to mutate here.
        break;
      case 'tool-call':
        this.recordToolCall(event.call);
        break;
      case 'awaiting-approval':
        this.recordPending(event.call);
        break;
      case 'error':
        this.setStatus('error');
        this.appendMessage({
          id: `msg_${randomId()}`,
          agentId: event.agentId,
          role: 'agent',
          text: `⚠️ ${event.message}`,
          createdAt: Date.now(),
        });
        break;
      default:
        break;
    }
  }

  /** Set the agent's run status on its doc entry. */
  setStatus(status: AgentRunStatus): void {
    transactWithOrigin(this.doc, this.origin, () => {
      const entry = getAgents(this.doc).get(this.config.agentId);
      if (entry instanceof Y.Map) {
        const prev = (entry.get('state') as AgentState | undefined) ?? this.baseState();
        entry.set('state', { ...prev, status });
      }
    });
  }

  /** Append a chat message to getAgentChat(doc). */
  appendMessage(message: AgentChatMessage): void {
    transactWithOrigin(this.doc, this.origin, () => {
      getAgentChat(this.doc).push([message]);
    });
  }

  // ── File ops: the ONLY way an agent's content reaches the doc ───────────────

  /**
   * Read a file's current text from the doc. This is the adapter's `read`
   * primitive — agents see exactly what the live doc holds, never the disk.
   */
  readFile(path: string): string {
    return getFileText(this.doc, path).toString();
  }

  /**
   * Apply a file op to the doc inside ONE agent-origin transaction, then emit an
   * 'edit' breadcrumb. Returns the path touched.
   *
   * THE LAW: nothing here goes near the filesystem. We mutate the Y.Text only.
   */
  applyFileOp(op: AgentFileOp): void {
    transactWithOrigin(this.doc, this.origin, () => {
      const files = this.doc.getMap<Y.Text>('files');
      switch (op.kind) {
        case 'write': {
          const text = getFileText(this.doc, op.path);
          replaceAll(text, op.content);
          break;
        }
        case 'append': {
          const text = getFileText(this.doc, op.path);
          text.insert(text.length, op.content);
          break;
        }
        case 'replace': {
          const text = getFileText(this.doc, op.path);
          const current = text.toString();
          const at = current.indexOf(op.find);
          if (at >= 0) {
            text.delete(at, op.find.length);
            text.insert(at, op.replace);
          }
          break;
        }
        case 'delete': {
          // Deleting a file == removing its buffer from the files map. Buffers
          // not present at flush time are projected as deletions by convergence.
          files.delete(op.path);
          break;
        }
        default:
          break;
      }
    });
  }

  // ── Tool calls + the APPROVAL GATE ──────────────────────────────────────────

  /**
   * Register the executable effect for a tool call so the adapter can run it on
   * approval (or immediately, for non-gated calls). Backends call this alongside
   * emitting the `tool-call` / `awaiting-approval` event.
   */
  registerEffect(callId: string, effect: AgentToolEffect): void {
    this.effects.set(callId, effect);
  }

  /**
   * Record a (non-gated) tool call on the doc and apply it immediately. Used for
   * safe calls like a benign run-command. Gated calls go through {@link recordPending}.
   */
  recordToolCall(call: AgentToolCall): void {
    if (call.requiresApproval) {
      // Defensive: a gated call must never auto-apply.
      this.recordPending(call);
      return;
    }
    this.writeToolCall({ ...call, status: 'running' });
    void this.executeEffect(call);
  }

  /**
   * APPROVAL GATE. Record a gated tool call as pending: set status
   * 'awaiting-approval', store the call on the agent's doc entry (so every
   * client sees the gate), and DO NOT apply it. Resolution happens via
   * {@link resolveApproval}.
   */
  recordPending(call: AgentToolCall): void {
    const effect = this.effects.get(call.id);
    if (effect) this.pending.set(call.id, { call, effect });

    transactWithOrigin(this.doc, this.origin, () => {
      const entry = getAgents(this.doc).get(this.config.agentId);
      if (entry instanceof Y.Map) {
        const prev = (entry.get('state') as AgentState | undefined) ?? this.baseState();
        entry.set('state', { ...prev, status: 'awaiting-approval' });
        entry.set('pendingCall', { ...call, status: 'proposed' } satisfies AgentToolCall);
      }
    });
  }

  /**
   * Resolve a pending gated tool call.
   *   approve → mark approved, apply its effect, mark done (or error).
   *   reject  → mark rejected, discard; the doc is left unchanged.
   * Either way the pending marker is cleared and status returns toward idle.
   * Returns true if a matching pending call existed.
   */
  async resolveApproval(callId: string, decision: 'approve' | 'reject'): Promise<boolean> {
    const pending = this.pending.get(callId);
    // Even if we have no stored effect (e.g. effect-less gate), still clear the
    // doc marker if it matches, so the gate can't get stuck.
    const docCall = this.pendingCallOnDoc();
    if (!pending && docCall?.id !== callId) return false;

    this.pending.delete(callId);

    if (decision === 'reject') {
      this.clearPending('rejected');
      return true;
    }

    // approve
    this.clearPending('approved');
    if (pending) {
      this.writeToolCall({ ...pending.call, status: 'running' });
      await this.executeEffect(pending.call);
    }
    return true;
  }

  /** The pending tool call currently recorded on the doc, if any. */
  pendingCallOnDoc(): AgentToolCall | null {
    const entry = getAgents(this.doc).get(this.config.agentId);
    if (entry instanceof Y.Map) {
      const call = entry.get('pendingCall') as AgentToolCall | undefined;
      return call ?? null;
    }
    return null;
  }

  /** Discard the pending marker and set the agent's status back to idle. */
  private clearPending(finalCallStatus: AgentToolCall['status']): void {
    transactWithOrigin(this.doc, this.origin, () => {
      const entry = getAgents(this.doc).get(this.config.agentId);
      if (entry instanceof Y.Map) {
        const prev = (entry.get('state') as AgentState | undefined) ?? this.baseState();
        entry.set('state', { ...prev, status: 'idle' });
        const call = entry.get('pendingCall') as AgentToolCall | undefined;
        if (call) {
          // Reflect the resolution on the recorded call before clearing.
          this.writeToolCallTx({ ...call, status: finalCallStatus });
        }
        entry.delete('pendingCall');
      }
    });
  }

  /**
   * Execute a tool call's effect (already approved or non-gated). File ops apply
   * to the doc; run-commands go to the injected terminal (or no-op if none).
   * Marks the recorded tool call done/error and returns status toward idle.
   */
  private async executeEffect(call: AgentToolCall): Promise<void> {
    const effect = this.effects.get(call.id);
    if (!effect) {
      this.writeToolCall({ ...call, status: 'done' });
      this.maybeIdle();
      return;
    }

    try {
      if (effect.kind === 'file') {
        this.transientStatus('editing');
        this.applyFileOp(effect.op);
      } else if (effect.kind === 'run') {
        this.transientStatus('running-tool');
        if (this.terminal) {
          await withTimeout(
            this.terminal.runCommand(this.roomIdHint(), effect.command),
            RUN_TIMEOUT_MS,
          );
        }
        // No terminal injected → recorded but not executed (graceful no-op).
      }
      this.writeToolCall({ ...call, status: 'done' });
    } catch (err) {
      this.writeToolCall({ ...call, status: 'error' });
      this.appendMessage({
        id: `msg_${randomId()}`,
        agentId: this.config.agentId,
        role: 'agent',
        text: `⚠️ tool '${call.tool}' failed: ${String((err as Error)?.message ?? err)}`,
        createdAt: Date.now(),
      });
    } finally {
      this.effects.delete(call.id);
      this.maybeIdle();
    }
  }

  /**
   * Set a transient working status (editing/running-tool) ONLY when no approval
   * gate is open. A pending gate is sticky: a concurrent safe tool call must not
   * clobber 'awaiting-approval', or a client would lose the gate from the UI.
   */
  private transientStatus(status: AgentRunStatus): void {
    if (this.gateOpen()) return;
    this.setStatus(status);
  }

  /** True while any gated tool call is awaiting a human decision. */
  private gateOpen(): boolean {
    return this.pending.size > 0 || this.pendingCallOnDoc() != null;
  }

  /**
   * Return status to idle once the agent is fully quiescent: no open gate. While
   * a gate is open we leave 'awaiting-approval' in place.
   */
  private maybeIdle(): void {
    if (!this.gateOpen()) {
      this.setStatus('idle');
    }
  }

  /** Persist a tool call snapshot under the agent entry (its own transaction). */
  private writeToolCall(call: AgentToolCall): void {
    transactWithOrigin(this.doc, this.origin, () => this.writeToolCallTx(call));
  }

  /** Persist a tool call snapshot — caller already holds a transaction. */
  private writeToolCallTx(call: AgentToolCall): void {
    const entry = getAgents(this.doc).get(this.config.agentId);
    if (entry instanceof Y.Map) {
      let calls = entry.get('toolCalls');
      if (!(calls instanceof Y.Map)) {
        calls = new Y.Map<unknown>();
        entry.set('toolCalls', calls);
      }
      (calls as Y.Map<unknown>).set(call.id, call);
    }
  }

  private baseState(): AgentState {
    return {
      agentId: this.config.agentId,
      kind: this.config.kind,
      displayName: this.config.displayName,
      color: colorForAgent(this.config.agentId),
      status: 'idle',
    };
  }

  /**
   * The roomId is not stored on the doc; the host knows it. For terminal runs we
   * need it, so the host injects it on the terminal call site. We stash it lazily
   * via {@link setRoomId}; default to the agentId-derived hint if unset (tests
   * inject a stub terminal that ignores it).
   */
  private roomId: string | null = null;
  setRoomId(roomId: string): void {
    this.roomId = roomId;
  }
  private roomIdHint(): string {
    return this.roomId ?? this.config.agentId;
  }
}

// ── small helpers ──────────────────────────────────────────────────────────

/** Replace a Y.Text's full content (no-op when already equal). */
function replaceAll(text: Y.Text, next: string): void {
  const current = text.toString();
  if (current === next) return;
  if (current.length > 0) text.delete(0, current.length);
  if (next.length > 0) text.insert(0, next);
}

/** Deterministic-ish color from an agent id (stable across processes). */
function colorForAgent(agentId: string): string {
  let h = 0;
  for (let i = 0; i < agentId.length; i += 1) {
    h = (h * 31 + agentId.charCodeAt(i)) >>> 0;
  }
  const hue = h % 360;
  return `hsl(${hue} 70% 55%)`;
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
