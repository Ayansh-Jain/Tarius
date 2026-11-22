/**
 * The Orchestrator (v1.5 "A squad of agents") — the conductor.
 *
 * One prompt in, a coordinated squad out. The flow:
 *   1. PLAN  — a {@link Planner} decomposes the prompt into role-tagged subtasks.
 *   2. RECORD— the {@link OrchestrationTask} + subtasks land in getTasks(doc) so
 *              the UI watches the squad live.
 *   3. SPAWN — one specialist agent per subtask (capped by maxAgents), each a
 *              distinct origin-tagged participant on the same room doc.
 *   4. RUN   — subtasks execute CONCURRENTLY. Because each specialist edits a
 *              DIFFERENT file, their `{kind:'agent', agentId}` edits are
 *              independently attributable and conflict-free; subtasks flip
 *              pending → assigned → in-progress → done as they complete.
 *   5. SETTLE— the task goes done (or failed), agents are stopped, the run's
 *              `done` promise resolves.
 *
 * Humans stay in control: {@link RunningOrchestration.interrupt} stops the squad
 * mid-flight (every still-running agent is interrupted + stopped, the task and
 * any unfinished subtasks are marked failed).
 *
 * The class owns a per-room registry, so the module-level
 * {@link startOrchestration} / {@link getOrchestrationState} can be singletons
 * for the driver while tests construct an isolated instance.
 */
import { randomUUID } from 'node:crypto';
import type * as Y from 'yjs';
import { getFiles } from '@ice/shared';
import type {
  AgentId,
  AgentRole,
  OrchestrationTask,
  RoomId,
  Subtask,
} from '@ice/shared';
import { MockPlanner } from './planner.js';
import {
  appendTask,
  patchSubtask,
  readTask,
  setTaskStatus,
} from './task-doc.js';
import type {
  AgentSpawnSpec,
  AgentSquad,
  OrchestrationOptions,
  Planner,
  RunningOrchestration,
} from './types.js';

/** Human-facing label per role (shown as the agent's displayName). */
const ROLE_LABEL: Record<AgentRole, string> = {
  architect: 'Architect',
  coder: 'Coder',
  debugger: 'Debugger',
  reviewer: 'Reviewer',
};

/** Internal bookkeeping for a live run. */
interface RunState {
  roomId: RoomId;
  doc: Y.Doc;
  taskId: string;
  squad: AgentSquad;
  /** agentId per subtask id, so interrupt can target the right agents. */
  agents: Map<string, AgentId>;
  interrupted: boolean;
  /** When true, stop (unregister) agents on a clean finish too. */
  disband: boolean;
  task: OrchestrationTask;
}

/**
 * The orchestrator registry. A module-level singleton is exported for the
 * driver; the class is exported too so tests get fresh, isolated instances.
 */
export class Orchestrator {
  /** One live run per room (a new start replaces a settled prior run). */
  private readonly runs = new Map<RoomId, RunningOrchestration>();
  /** Mutable state for in-flight runs, keyed by room. */
  private readonly state = new Map<RoomId, RunState>();

  /**
   * Start an orchestration for a room. Plans subtasks, records them on the doc,
   * spawns specialists, and drives them concurrently. Resolves as soon as the
   * run is registered + planned (the work continues in the background); await
   * the returned {@link RunningOrchestration.done} for the final task.
   *
   * If a run is already live for the room it is interrupted first (a human
   * starting a new squad supersedes the old one).
   */
  async start(
    roomId: RoomId,
    doc: Y.Doc,
    prompt: string,
    opts: OrchestrationOptions,
  ): Promise<RunningOrchestration> {
    const prior = this.runs.get(roomId);
    if (prior && !prior.interrupted) {
      prior.interrupt();
    }

    const planner: Planner = opts.planner ?? new MockPlanner();
    const maxAgents = Math.max(1, opts.maxAgents ?? 3);
    const squad = opts.squad;

    const taskId = `task_${randomUUID()}`;
    const files = [...getFiles(doc).keys()];

    // 1. PLAN.
    const planned = await planner.plan(prompt, { roomId, files });
    const capped = planned.slice(0, maxAgents);

    // Assign an agentId per subtask up front (distinct per subtask → distinct
    // origins → conflict-free concurrent edits).
    const agentIdFor =
      opts.agentIdFor ?? ((role: AgentRole, i: number) => `agent_${role}_${i}_${shortId()}`);

    const subtasks: Subtask[] = capped.map((p, i) => ({
      id: `sub_${i}_${shortId()}`,
      role: p.role,
      description: p.description,
      status: 'pending',
      assignedTo: agentIdFor(p.role, i),
    }));

    const task: OrchestrationTask = {
      id: taskId,
      prompt,
      subtasks,
      createdAt: Date.now(),
      status: 'planning',
    };

    // 2. RECORD on the doc so watchers see the plan immediately.
    appendTask(doc, task);

    const run: RunState = {
      roomId,
      doc,
      taskId,
      squad,
      agents: new Map(subtasks.map((s) => [s.id, s.assignedTo!])),
      interrupted: false,
      disband: opts.disband ?? false,
      task,
    };
    this.state.set(roomId, run);

    // The settle promise: spawn + drive everything, then finalize.
    const done = this.execute(run, capped).catch((): OrchestrationTask => {
      // Defensive: never let a background rejection escape unobserved.
      setTaskStatus(doc, taskId, 'failed');
      run.interrupted = true;
      return readTask(doc, taskId) ?? { ...task, status: 'failed' };
    });

    const running: RunningOrchestration = {
      roomId,
      task,
      done,
      get interrupted() {
        return run.interrupted;
      },
      interrupt: () => this.interruptRun(run),
    };
    this.runs.set(roomId, running);
    return running;
  }

  /**
   * Spawn the squad and drive every subtask CONCURRENTLY. Each subtask: spawn
   * its specialist, mark assigned, run one turn (the agent appends to its own
   * file), mark done. Because the files are distinct, the parallel agent-origin
   * edits never contend.
   */
  private async execute(
    run: RunState,
    planned: { targetFile?: string }[],
  ): Promise<OrchestrationTask> {
    const { doc, taskId, squad } = run;
    if (run.interrupted) return this.finalize(run);

    setTaskStatus(doc, taskId, 'running');

    await Promise.all(
      run.task.subtasks.map(async (sub, i) => {
        if (run.interrupted) return;
        const agentId = run.agents.get(sub.id)!;
        const targetFile = planned[i]?.targetFile ?? defaultFileFor(sub, i);

        const spec: AgentSpawnSpec = {
          agentId,
          role: sub.role,
          displayName: ROLE_LABEL[sub.role],
          targetFile,
        };

        // Spawn the specialist (registers it on the doc → getAgents N++).
        await squad.spawn(spec);
        if (run.interrupted) return;
        patchSubtask(doc, taskId, sub.id, { status: 'assigned', assignedTo: agentId });

        // Drive one unit of work. The agent appends to its OWN file with its OWN
        // {kind:'agent', agentId} origin — concurrent + conflict-free.
        patchSubtask(doc, taskId, sub.id, { status: 'in-progress' });
        try {
          await squad.assign(agentId, { ...sub, status: 'in-progress', assignedTo: agentId });
          if (run.interrupted) return;
          patchSubtask(doc, taskId, sub.id, { status: 'done' });
        } catch {
          patchSubtask(doc, taskId, sub.id, { status: 'failed' });
        }
      }),
    );

    return this.finalize(run);
  }

  /**
   * Settle a run: set the task's terminal status (interrupted/any-failed →
   * failed; else done), tear down agents when asked, drop it from the live
   * registry, and return the final task snapshot from the doc.
   *
   * Agent teardown policy: on a clean finish we LEAVE the specialists registered
   * on the doc (idle) so a watching UI keeps showing the squad and who wrote
   * what — they're the durable record of the run. Agents are stopped only when
   * the run was interrupted, OR when the caller opted into `disband` (e.g. the
   * driver tearing a room down). This keeps "watch the squad live" intact while
   * still letting callers reclaim resources.
   */
  private async finalize(run: RunState): Promise<OrchestrationTask> {
    const { doc, taskId } = run;

    if (run.interrupted || run.disband) {
      // Stop the squad (best-effort; never throw out of finalize).
      await Promise.all(
        [...run.agents.values()].map((agentId) =>
          run.squad.stop(agentId).catch(() => undefined),
        ),
      );
    }

    const current = readTask(doc, taskId);
    const anyFailed = current?.subtasks.some((s) => s.status === 'failed') ?? false;
    const allDone =
      (current?.subtasks.length ?? 0) > 0 &&
      (current?.subtasks.every((s) => s.status === 'done') ?? false);

    const finalStatus: OrchestrationTask['status'] =
      run.interrupted || anyFailed ? 'failed' : allDone ? 'done' : 'failed';
    setTaskStatus(doc, taskId, finalStatus);

    // Drop in-flight state; keep the RunningOrchestration entry so callers can
    // still read the settled task via getState until a new run replaces it.
    if (this.state.get(run.roomId) === run) this.state.delete(run.roomId);

    return readTask(doc, taskId) ?? { ...run.task, status: finalStatus };
  }

  /**
   * Interrupt a run: mark interrupted, then interrupt + stop every spawned agent
   * and mark any non-terminal subtask failed. The execute() loop observes the
   * flag and stops advancing; finalize() (which it still reaches) sets the task
   * failed. Idempotent.
   */
  private interruptRun(run: RunState): void {
    if (run.interrupted) return;

    const { doc, taskId } = run;
    // Don't downgrade an already-settled run: interrupting a task that has
    // already finished cleanly is a no-op (you can't un-ship done work).
    if (readTask(doc, taskId)?.status === 'done') return;
    run.interrupted = true;
    // Interrupt every agent's current turn and tear it down.
    for (const agentId of run.agents.values()) {
      run.squad.interrupt(agentId);
    }
    // Mark unfinished subtasks failed so the UI reflects the stop immediately.
    const current = readTask(doc, taskId);
    for (const sub of current?.subtasks ?? []) {
      if (sub.status !== 'done' && sub.status !== 'failed') {
        patchSubtask(doc, taskId, sub.id, { status: 'failed' });
      }
    }
    setTaskStatus(doc, taskId, 'failed');
  }

  /**
   * Current orchestration state for a room: the live run if one exists, else the
   * most-recent task snapshot read back from the doc. Returns null if the room
   * has no orchestration.
   */
  getState(roomId: RoomId): RunningOrchestration | null {
    return this.runs.get(roomId) ?? null;
  }

  /**
   * Interrupt a room's live run. Returns true iff a still-running run was
   * actually stopped (a settled run — done or already interrupted — yields
   * false). The in-flight run lives in `state`; once finalized only `runs`
   * holds it, and a cleanly-finished task must not be downgraded.
   */
  interrupt(roomId: RoomId): boolean {
    const run = this.state.get(roomId);
    if (run && !run.interrupted) {
      this.interruptRun(run);
      return run.interrupted; // false only if it had already settled 'done'
    }
    return false;
  }

  /** Interrupt + forget every run (graceful shutdown). */
  async stopAll(): Promise<void> {
    for (const run of this.state.values()) this.interruptRun(run);
    await Promise.all([...this.runs.values()].map((r) => r.done.catch(() => undefined)));
    this.runs.clear();
    this.state.clear();
  }
}

/** A sensible per-subtask file when a planner didn't pin one. */
function defaultFileFor(sub: Subtask, i: number): string {
  return `src/squad/${sub.role}-${i}.ts`;
}

function shortId(): string {
  return Math.random().toString(36).slice(2, 8);
}
