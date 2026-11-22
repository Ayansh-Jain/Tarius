/**
 * Multi-agent orchestration vocabulary — v1.5 "A squad of agents".
 *
 * Builds on the v0.5 single-agent foundation: agents are already origin-tagged
 * `{kind:'agent', agentId}` participants, so going from one to many is a
 * concurrency + coordination + permissions problem, not a rewrite. The
 * orchestrator routes subtasks to specialist roles; per-agent policies bound
 * what each may do; an opt-in snapshot lets an agent "try it safely" on a branch.
 */
import type { AgentId } from './protocol.js';

/** Specialist roles the orchestrator routes subtasks to (Kilo-style). */
export type AgentRole = 'architect' | 'coder' | 'debugger' | 'reviewer';

export interface Subtask {
  id: string;
  role: AgentRole;
  description: string;
  status: 'pending' | 'assigned' | 'in-progress' | 'done' | 'failed';
  assignedTo?: AgentId;
}

export interface OrchestrationTask {
  id: string;
  prompt: string;
  subtasks: Subtask[];
  createdAt: number;
  status: 'planning' | 'running' | 'done' | 'failed';
}

/** Per-agent permission policy. Deny takes precedence over allow. */
export interface AgentPolicy {
  agentId: AgentId;
  /** Tool names this agent may call; ['*'] = all. */
  allowTools: string[];
  denyTools: string[];
  /** Path prefixes the agent may write; [] = all. */
  writePaths: string[];
  denyPaths: string[];
  /** Large/destructive ops always require explicit approval. */
  requireApprovalForDestructive: boolean;
}

/** An MCP tool exposed to agents (workspace-scoped). */
export interface McpTool {
  name: string;
  description: string;
  /** JSON Schema for the tool inputs. */
  inputSchema?: unknown;
  /** The MCP server this tool came from. */
  server?: string;
}

/** Opt-in snapshot ("try it safely"): an agent works on a branch, then merges back. */
export interface AgentSnapshot {
  id: string;
  agentId: AgentId;
  branch: string;
  baseCommit: string;
  status: 'open' | 'merged' | 'discarded';
}
