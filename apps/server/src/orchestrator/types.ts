/**
 * Orchestrator — internal contracts (v1.5 "A squad of agents").
 *
 * The orchestrator is the conductor: it takes one task prompt, PLANS a set of
 * subtasks, ROUTES each to a specialist role (architect / coder / debugger /
 * reviewer), and RUNS each behind its own agent (spawned via the v0.5 agent
 * host — multiple agents per room, each an origin-tagged `{kind:'agent',
 * agentId}` participant). The live {@link OrchestrationTask} + its subtasks are
 * mirrored into getTasks(doc) so the UI can watch the squad work.
 *
 * These seams keep the orchestrator decoupled from the rest of the server. It
 * never imports the agent host directly: instead it depends on the small
 * {@link AgentSquad} surface, and the driver injects a real implementation
 * (backed by startAgentForRoom). That same seam is what lets tests run an
 * entire squad on a plain Y.Doc with zero process/network setup.
 */
import type * as Y from 'yjs';
import type {
  AgentId,
  AgentRole,
  OrchestrationTask,
  RoomId,
  Subtask,
} from '@ice/shared';

/**
 * A planner turns a free-text task prompt into an ordered list of subtasks, each
 * tagged with the specialist role that should own it. The {@link MockPlanner} is
 * deterministic (no key); a real LLM-routed planner is BYO-key — see
 * {@link LlmPlanner}.
 */
export interface Planner {
  /**
   * Decompose `prompt` into subtasks. Implementations should return a stable,
   * non-empty list; the orchestrator assigns ids/agents and persists them.
   */
  plan(prompt: string, ctx: PlannerContext): Promise<PlannedSubtask[]> | PlannedSubtask[];
}

/** Read-only context a planner may use (room + a peek at existing files). */
export interface PlannerContext {
  roomId: RoomId;
  /** Current file paths in the doc (so a planner can target real files). */
  files: string[];
}

/**
 * What a planner emits per subtask — the durable {@link Subtask} fields minus the
 * id/status/assignment the orchestrator fills in. `targetFile` (optional) lets a
 * planner pin the file the subtask's agent should edit, which is how the mock
 * guarantees DIFFERENT agents touch DIFFERENT files (conflict-free by origin).
 */
export interface PlannedSubtask {
  role: AgentRole;
  description: string;
  /** File this subtask's agent should edit. Distinct per subtask in the mock. */
  targetFile?: string;
}

/**
 * The squad surface the orchestrator drives — the ONLY thing it knows about
 * agents. The driver injects {@link makeHostSquad} (backed by the v0.5 agent
 * host); tests inject the same factory pointed at an in-memory AgentHost, or a
 * fake. Keeping the orchestrator behind this interface is what makes it testable
 * on a bare Y.Doc and independent of how agents are actually hosted.
 */
export interface AgentSquad {
  /**
   * Ensure an agent with `agentId`/`role` exists on the room doc and is ready to
   * take work. Idempotent per (room, agent). Resolves once the agent is
   * registered in getAgents(doc).
   */
  spawn(spec: AgentSpawnSpec): Promise<void>;
  /**
   * Drive one agent to do a unit of work — for the mock this is a scripted turn
   * that appends to the agent's target file. The orchestrator awaits this, then
   * advances the subtask to done.
   */
  assign(agentId: AgentId, subtask: Subtask): Promise<void>;
  /** Interrupt one agent's current run (cancel its turn). */
  interrupt(agentId: AgentId): void;
  /** Stop + unregister one agent (squad teardown). */
  stop(agentId: AgentId): Promise<void>;
}

/** Everything the squad needs to bring one specialist online. */
export interface AgentSpawnSpec {
  agentId: AgentId;
  role: AgentRole;
  /** Human-facing label, e.g. "Architect". */
  displayName: string;
  /** The file this agent owns for the run (mock edits exactly this file). */
  targetFile: string;
}

/** A live, in-flight orchestration the {@link Orchestrator} tracks per room. */
export interface RunningOrchestration {
  readonly roomId: RoomId;
  readonly task: OrchestrationTask;
  /** Resolves when the whole run settles (done / failed / interrupted). */
  readonly done: Promise<OrchestrationTask>;
  /** Stop the squad and mark the run failed/interrupted. Idempotent. */
  interrupt(): void;
  /** True once interrupt() has been called. */
  readonly interrupted: boolean;
}

/** Options for {@link Orchestrator.start}. */
export interface OrchestrationOptions {
  /** Inject the squad (driver: host-backed; tests: in-memory host). */
  squad: AgentSquad;
  /** Inject the planner. Defaults to the deterministic {@link MockPlanner}. */
  planner?: Planner;
  /**
   * Max specialists to bring online for one task. The mock plan yields ~3
   * subtasks across distinct roles; this caps how many distinct agents spawn.
   * Default 3.
   */
  maxAgents?: number;
  /** Override the agentId minted per role (tests assert on stable ids). */
  agentIdFor?: (role: AgentRole, index: number) => AgentId;
  /**
   * When true, stop + unregister the specialist agents from the doc once the
   * task finishes cleanly (not just on interrupt). Default false: a finished
   * squad stays visible (idle) so the UI keeps showing who did what.
   */
  disband?: boolean;
}

/** A factory that builds the squad surface for a given room doc. */
export type SquadFactory = (roomId: RoomId, doc: Y.Doc) => AgentSquad;
