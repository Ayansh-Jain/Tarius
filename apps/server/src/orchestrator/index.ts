/**
 * Orchestrator — public API (v1.5 "A squad of agents", Slice A).
 *
 * THE MOAT: going from one agent to a coordinating SQUAD. This module is the
 * server-side conductor. A single task prompt is decomposed into role-tagged
 * subtasks (architect / coder / debugger / reviewer); each is routed to its own
 * specialist agent — spawned through the v0.5 agent host, so every specialist is
 * a distinct `{kind:'agent', agentId}` participant on the SAME room doc. The
 * specialists work CONCURRENTLY, each editing a DIFFERENT file, so their edits
 * are independently attributable and conflict-free by construction. The plan and
 * its subtasks live in getTasks(doc) so the UI watches the squad in real time;
 * humans can interrupt the whole squad at any moment.
 *
 * The driver wires this into the v0.1-owned api.ts behind
 *   POST /api/rooms/:id/orchestrate   — see this slice's wiringInstructions.
 * The module-level functions delegate to a shared {@link Orchestrator}; the
 * class (and the squad/planner pieces) are exported for the driver and tests.
 *
 *   startOrchestration(roomId, doc, prompt, opts?) — plan + spawn + run a squad
 *   getOrchestrationState(roomId)                  — the live/last run for a room
 *   interruptOrchestration(roomId)                 — stop the squad (human-in-control)
 */
import type * as Y from 'yjs';
import type { RoomId } from '@ice/shared';
import {
  getAgentHost,
  handleAgentMessage as hostHandleAgentMessage,
  interruptAgent as hostInterruptAgent,
  startAgentForRoom as hostStartAgentForRoom,
  stopAgent as hostStopAgent,
} from '../agent/index.js';
import { Orchestrator } from './orchestrator.js';
import { HostBackedSquad, makeHostSquad, type HostLike } from './squad.js';
import type {
  AgentSquad,
  OrchestrationOptions,
  RunningOrchestration,
  SquadFactory,
} from './types.js';

/** Process-wide orchestrator the driver routes calls into. */
let sharedOrchestrator = new Orchestrator();

/** The process-wide orchestrator (advanced callers / graceful shutdown). */
export function getOrchestrator(): Orchestrator {
  return sharedOrchestrator;
}

/** Replace the shared orchestrator (tests / re-init). */
export function configureOrchestrator(orch: Orchestrator): void {
  sharedOrchestrator = orch;
}

/**
 * The default squad: backed by the real v0.5 agent host module-level functions.
 * Bundling them into a {@link HostLike} keeps {@link HostBackedSquad} decoupled
 * from the singleton while giving the driver a zero-config path.
 */
const defaultHost: HostLike = {
  startAgentForRoom: (roomId, doc, config, deps) =>
    hostStartAgentForRoom(roomId, doc, config, deps),
  handleAgentMessage: (roomId, doc, text, opts) =>
    hostHandleAgentMessage(roomId, doc, text, opts),
  interruptAgent: (roomId, agentId) => hostInterruptAgent(roomId, agentId),
  stopAgent: (roomId, agentId) => hostStopAgent(roomId, agentId),
};

/** Default squad factory (host-backed). Touch {@link getAgentHost} so the */
/* shared host is initialized lazily on first use, matching the agent slice. */
const defaultSquadFactory: SquadFactory = (roomId, doc) => {
  void getAgentHost();
  return new HostBackedSquad(defaultHost, roomId, doc);
};

/**
 * Start an orchestration for a room. With no `opts.squad` the real agent host is
 * used (the driver's path); tests inject a squad over an isolated `AgentHost`.
 *
 * Resolves once the squad is planned + launched; await the returned run's `done`
 * for the final {@link OrchestrationTask}. Starting a new orchestration for a
 * room interrupts any still-running one.
 */
export function startOrchestration(
  roomId: RoomId,
  doc: Y.Doc,
  prompt: string,
  opts?: Partial<OrchestrationOptions>,
): Promise<RunningOrchestration> {
  const squad: AgentSquad = opts?.squad ?? defaultSquadFactory(roomId, doc);
  return sharedOrchestrator.start(roomId, doc, prompt, {
    ...opts,
    squad,
  });
}

/** The live (or most-recent) orchestration for a room, or null. */
export function getOrchestrationState(roomId: RoomId): RunningOrchestration | null {
  return sharedOrchestrator.getState(roomId);
}

/** Interrupt a room's running squad. Returns true if one was running. */
export function interruptOrchestration(roomId: RoomId): boolean {
  return sharedOrchestrator.interrupt(roomId);
}

// ── Types & implementations (for the driver and tests) ─────────────────────────
export { Orchestrator } from './orchestrator.js';
export { MockPlanner, LlmPlanner } from './planner.js';
export type { PlannerLlmClient, LlmPlanItem } from './planner.js';
export { HostBackedSquad, makeHostSquad } from './squad.js';
export type { HostLike } from './squad.js';
export {
  appendTask,
  patchSubtask,
  readTask,
  readAllTasks,
  setTaskStatus,
  ORCH_ORIGIN,
} from './task-doc.js';
export type {
  AgentSpawnSpec,
  AgentSquad,
  OrchestrationOptions,
  Planner,
  PlannedSubtask,
  PlannerContext,
  RunningOrchestration,
  SquadFactory,
} from './types.js';
