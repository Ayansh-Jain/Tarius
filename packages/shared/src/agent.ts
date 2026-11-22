/**
 * Agent vocabulary — v0.5 "Your first AI teammate".
 *
 * Agents are first-class participants that act THROUGH the Yjs doc (ADR-004):
 * every file edit an agent makes is an origin-tagged `{kind:'agent', agentId}`
 * Yjs transaction (attributable, undoable), and every risky tool call passes a
 * human approval gate. Agents NEVER touch the raw filesystem.
 */
import type { AgentId, AgentRunStatus, AgentToolCall } from './protocol.js';

/**
 * Which ACP-compatible backend powers an agent. `mock` is the built-in,
 * dependency-free scripted agent used for tests/demos and when no real agent
 * binary/key is configured.
 */
export type AgentBackendKind = 'claude-code' | 'codex' | 'gemini' | 'mock';

export interface AgentConfig {
  agentId: AgentId;
  kind: AgentBackendKind;
  displayName: string;
  /** Model hint handed to the backend (BYO-key / model-agnostic). */
  model?: string;
}

/** A message in the agent chat: a human's prompt or the agent's reply. */
export interface AgentChatMessage {
  id: string;
  agentId: AgentId;
  role: 'user' | 'agent';
  text: string;
  createdAt: number;
}

/** A human's decision on a gated (approval-required) tool call. */
export type ApprovalDecision = 'approve' | 'reject';

/**
 * Streamed agent activity for the chat panel / live tool-call view. Mirrors the
 * ACP event surface, reduced to what the ICE UI renders.
 */
export type AgentEvent =
  | { type: 'status'; agentId: AgentId; status: AgentRunStatus }
  | { type: 'message'; message: AgentChatMessage }
  | { type: 'edit'; agentId: AgentId; path: string }
  | { type: 'tool-call'; call: AgentToolCall }
  | { type: 'awaiting-approval'; call: AgentToolCall }
  | { type: 'error'; agentId: AgentId; message: string };
