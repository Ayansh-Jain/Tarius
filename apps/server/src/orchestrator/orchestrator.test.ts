/**
 * Orchestrator tests (v1.5 "A squad of agents", Slice A) — the moat, on a bare
 * Y.Doc with NO process/network. The squad is driven through a real
 * {@link AgentHost} instance (mock-backed), so these assert the genuine
 * multi-agent path end to end:
 *
 *   (1) one orchestration spawns >1 specialist (getAgents N>=2), distinct ids;
 *   (2) two specialists' CONCURRENT edits to DIFFERENT files BOTH land, each with
 *       its own {kind:'agent', agentId} origin — no loss, no corruption;
 *   (3) subtasks appear in getTasks(doc) and progress pending → … → done;
 *   (4) interrupt stops the squad (task + unfinished subtasks → failed).
 */
import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import {
  getAgents,
  getFileText,
  getTasks,
  type AgentState,
  type OrchestrationTask,
} from '@ice/shared';
import { AgentHost } from '../agent/index.js';
import { Orchestrator } from './orchestrator.js';
import { makeHostSquad } from './squad.js';
import { readTask } from './task-doc.js';
import type { AgentSpawnSpec, AgentSquad } from './types.js';

/** Build an orchestrator + a host-backed squad over a fresh AgentHost. */
function makeSquadOver(doc: Y.Doc, roomId = 'room1') {
  const host = new AgentHost();
  const squad = makeHostSquad({
    startAgentForRoom: (r, d, config, deps) => host.startAgentForRoom(r, d, config, deps),
    handleAgentMessage: (r, d, text, opts) => host.handleAgentMessage(r, d, text, opts),
    interruptAgent: (r, agentId) => host.interruptAgent(r, agentId),
    stopAgent: (r, agentId) => host.stopAgent(r, agentId),
  })(roomId, doc);
  return { host, squad };
}

/** Read agent states out of getAgents(doc). */
function agentStates(doc: Y.Doc): AgentState[] {
  const out: AgentState[] = [];
  for (const [, entry] of getAgents(doc) as Y.Map<unknown>) {
    if (entry instanceof Y.Map) {
      const state = entry.get('state') as AgentState | undefined;
      if (state) out.push(state);
    }
  }
  return out;
}

/** Read all orchestration tasks back out of getTasks(doc). */
function tasks(doc: Y.Doc): OrchestrationTask[] {
  const out: OrchestrationTask[] = [];
  for (const item of getTasks(doc) as Y.Array<unknown>) {
    if (item instanceof Y.Map) {
      const t = readTask(doc, String(item.get('id')));
      if (t) out.push(t);
    }
  }
  return out;
}

describe('Orchestrator — spawns a multi-agent squad', () => {
  it('(1) one orchestration spawns >= 2 distinct agents on the doc', async () => {
    const doc = new Y.Doc();
    const { host, squad } = makeSquadOver(doc);
    const orch = new Orchestrator();

    const run = await orch.start('room1', doc, 'build a login form', { squad });
    await run.done;

    const states = agentStates(doc);
    // The default mock plan yields 3 specialists → N>=2 guaranteed.
    expect(states.length).toBeGreaterThanOrEqual(2);

    // Distinct agentIds (no two specialists share an id/origin).
    const ids = states.map((s) => s.agentId);
    expect(new Set(ids).size).toBe(ids.length);

    // Distinct colors too (each specialist visually distinguishable).
    const colors = new Set(states.map((s) => s.color));
    expect(colors.size).toBe(states.length);

    await host.stopAll();
  });

  it('routes distinct roles (architect/coder/reviewer) to distinct agents', async () => {
    const doc = new Y.Doc();
    const { host, squad } = makeSquadOver(doc);
    const orch = new Orchestrator();

    const run = await orch.start('room1', doc, 'add a feature', { squad });
    const task = await run.done;

    const roles = task.subtasks.map((s) => s.role);
    expect(roles).toContain('architect');
    expect(roles).toContain('coder');
    // Every subtask is assigned to a distinct agent.
    const assigned = task.subtasks.map((s) => s.assignedTo);
    expect(assigned.every(Boolean)).toBe(true);
    expect(new Set(assigned).size).toBe(assigned.length);

    await host.stopAll();
  });
});

describe('Orchestrator — concurrent, conflict-free, attributable edits', () => {
  it('(2) two specialists edit DIFFERENT files; both land with their own agent origin', async () => {
    const doc = new Y.Doc();

    // Record, per file path, the set of agent origins that mutated it. Agent
    // edits go through transactWithOrigin(doc, {kind:'agent', agentId}, …), so we
    // read the transaction origin off each afterTransaction and map it to touched
    // files. Two cases (see Yjs change semantics): when a buffer is created+written
    // in the same tx the change registers on the `files` MAP (the changed keys are
    // the paths); when an existing buffer is edited the change registers on its
    // Y.Text (look its path up in the map). We handle both so attribution is exact.
    const fileOrigins = new Map<string, Set<string>>();
    const filesMap = doc.getMap<Y.Text>('files');
    const tag = (path: string, agentId: string) => {
      const set = fileOrigins.get(path) ?? new Set<string>();
      set.add(agentId);
      fileOrigins.set(path, set);
    };
    doc.on('afterTransaction', (tr) => {
      const origin = tr.origin as { kind?: string; agentId?: string } | undefined;
      if (!origin || origin.kind !== 'agent' || !origin.agentId) return;
      for (const [type, keys] of tr.changed) {
        if (type === (filesMap as unknown)) {
          // files map changed → each changed key is a file path
          for (const key of keys) if (typeof key === 'string') tag(key, origin.agentId);
        } else if (type instanceof Y.Text) {
          // a buffer's Y.Text changed → find its path in the files map
          for (const [path, text] of filesMap) {
            if (text === type) tag(path, origin.agentId);
          }
        }
      }
    });

    const { host, squad } = makeSquadOver(doc);
    const orch = new Orchestrator();

    const run = await orch.start('room1', doc, 'concurrency check', {
      squad,
      // Pin stable agent ids so we can assert attribution precisely.
      agentIdFor: (role, i) => `ag_${role}_${i}`,
    });
    const task = await run.done;

    // Collect each subtask's (agentId, file) pair and assert distinct files.
    const targetFiles = new Set<string>();
    for (const [path, origins] of fileOrigins) {
      // The mock also touches a per-agent scratch path for the gated delete; the
      // real generated files live under docs/ src/ test/. Only assert on those.
      if (path.startsWith('.ice/scratch/')) continue;
      expect(origins.size).toBeGreaterThanOrEqual(1);
      targetFiles.add(path);
    }
    // At least two DIFFERENT files were written by agents.
    expect(targetFiles.size).toBeGreaterThanOrEqual(2);

    // Each generated file is owned by exactly ONE agent origin (no cross-writes
    // → no contention) and content is intact (the append landed, not corrupted).
    for (const path of targetFiles) {
      const origins = fileOrigins.get(path)!;
      expect(origins.size).toBe(1);
      const content = getFileText(doc, path).toString();
      expect(content.length).toBeGreaterThan(0);
    }

    // The agent that wrote the coder's file is the coder subtask's assignee.
    const coder = task.subtasks.find((s) => s.role === 'coder')!;
    const coderFile = [...targetFiles].find((p) => fileOrigins.get(p)!.has(coder.assignedTo!));
    expect(coderFile).toBeTruthy();
    expect(getFileText(doc, coderFile!).toString()).toContain('feature');

    await host.stopAll();
  });

  it('no edit is lost when many agents append concurrently (every target file is non-empty)', async () => {
    const doc = new Y.Doc();
    const { host, squad } = makeSquadOver(doc);
    const orch = new Orchestrator();

    const run = await orch.start('room1', doc, 'parallel work', { squad, maxAgents: 3 });
    const task = await run.done;

    // Every done subtask produced a non-empty file. We re-derive the file from
    // the role mapping the squad uses (docs/ src/ test/). Simpler: assert at
    // least as many non-empty non-scratch files as done subtasks.
    const files = doc.getMap<Y.Text>('files');
    const nonEmpty = [...files.entries()].filter(
      ([p, t]) => !p.startsWith('.ice/scratch/') && (t as Y.Text).toString().length > 0,
    );
    const doneCount = task.subtasks.filter((s) => s.status === 'done').length;
    expect(doneCount).toBeGreaterThanOrEqual(2);
    expect(nonEmpty.length).toBeGreaterThanOrEqual(doneCount);

    await host.stopAll();
  });
});

describe('Orchestrator — subtasks on the doc progress to done', () => {
  it('(3) subtasks appear in getTasks(doc) and end up done; task done', async () => {
    const doc = new Y.Doc();
    const { host, squad } = makeSquadOver(doc);
    const orch = new Orchestrator();

    // Watch the task array: it must be populated right after start (planning),
    // before the run settles.
    const run = await orch.start('room1', doc, 'ship it', { squad });

    const planned = tasks(doc);
    expect(planned).toHaveLength(1);
    expect(planned[0]!.subtasks.length).toBeGreaterThanOrEqual(2);
    expect(planned[0]!.subtasks.every((s) => s.status === 'pending' || s.status !== 'done'));

    const finished = await run.done;
    expect(finished.status).toBe('done');
    expect(finished.subtasks.length).toBeGreaterThanOrEqual(2);
    expect(finished.subtasks.every((s) => s.status === 'done')).toBe(true);

    // The doc reflects the same terminal state (UI watchers converge).
    const onDoc = tasks(doc)[0]!;
    expect(onDoc.status).toBe('done');
    expect(onDoc.subtasks.every((s) => s.status === 'done')).toBe(true);
    // Each subtask carries its assignee (the agent that did it).
    expect(onDoc.subtasks.every((s) => typeof s.assignedTo === 'string')).toBe(true);

    await host.stopAll();
  });

  it('emits subtask status transitions observable by a doc watcher', async () => {
    const doc = new Y.Doc();
    const { host, squad } = makeSquadOver(doc);
    const orch = new Orchestrator();

    const seenStatuses = new Set<string>();
    getTasks(doc).observeDeep(() => {
      for (const t of tasks(doc)) {
        for (const s of t.subtasks) seenStatuses.add(s.status);
      }
    });

    const run = await orch.start('room1', doc, 'watch me', { squad });
    await run.done;

    // We should have observed the subtask reaching at least 'done'. (Depending
    // on batching we may also see assigned/in-progress.)
    expect(seenStatuses.has('done')).toBe(true);

    await host.stopAll();
  });
});

describe('Orchestrator — humans can interrupt the squad', () => {
  it('(4) interrupt() stops the squad: task failed, unfinished subtasks failed', async () => {
    const doc = new Y.Doc();

    // A squad that BLOCKS on assign so we can interrupt mid-flight. Spawn still
    // registers the agents on the doc (so getAgents is populated), but assign
    // never resolves until released — modeling a long-running agent turn.
    const released: Array<() => void> = [];
    const spawned: AgentSpawnSpec[] = [];
    const interrupted: string[] = [];
    const stopped: string[] = [];

    const blockingSquad: AgentSquad = {
      async spawn(spec) {
        spawned.push(spec);
        // Mirror a real spawn: put a minimal agent state on the doc.
        const agents = getAgents(doc);
        doc.transact(() => {
          const m = new Y.Map<unknown>();
          m.set('state', {
            agentId: spec.agentId,
            kind: 'mock',
            displayName: spec.displayName,
            color: '#abc',
            status: 'idle',
          } satisfies AgentState);
          agents.set(spec.agentId, m);
        }, { kind: 'agent', agentId: spec.agentId });
      },
      assign() {
        return new Promise<void>((resolve) => {
          released.push(resolve);
        });
      },
      interrupt(agentId) {
        interrupted.push(agentId);
      },
      async stop(agentId) {
        stopped.push(agentId);
      },
    };

    const orch = new Orchestrator();
    const run = await orch.start('room1', doc, 'long job', { squad: blockingSquad });

    // Agents were spawned + are on the doc; the run is in flight.
    expect(spawned.length).toBeGreaterThanOrEqual(2);
    expect(agentStates(doc).length).toBeGreaterThanOrEqual(2);
    expect(run.interrupted).toBe(false);

    // Human hits stop.
    run.interrupt();
    expect(run.interrupted).toBe(true);

    // Every spawned agent was interrupted.
    expect(new Set(interrupted)).toEqual(new Set(spawned.map((s) => s.agentId)));

    // Release the blocked assigns so finalize() can run to completion.
    for (const r of released) r();
    const finished = await run.done;

    // The task is failed and no subtask is left dangling in a non-terminal state.
    expect(finished.status).toBe('failed');
    expect(finished.subtasks.some((s) => s.status === 'failed')).toBe(true);
    expect(
      finished.subtasks.every((s) => s.status === 'failed' || s.status === 'done'),
    ).toBe(true);

    // Every agent was stopped during finalize.
    expect(new Set(stopped)).toEqual(new Set(spawned.map((s) => s.agentId)));
  });

  it('interruptOrchestration via the registry stops a live run', async () => {
    const doc = new Y.Doc();
    const released: Array<() => void> = [];
    const blockingSquad: AgentSquad = {
      async spawn() {},
      assign: () => new Promise<void>((r) => released.push(r)),
      interrupt() {},
      async stop() {},
    };
    const orch = new Orchestrator();
    const run = await orch.start('roomX', doc, 'job', { squad: blockingSquad });

    expect(orch.getState('roomX')).toBe(run);
    expect(orch.interrupt('roomX')).toBe(true);
    expect(run.interrupted).toBe(true);

    for (const r of released) r();
    const finished = await run.done;
    expect(finished.status).toBe('failed');
  });

  it('interrupting an already-finished (done) run is a no-op (stays done)', async () => {
    const doc = new Y.Doc();
    const { host, squad } = makeSquadOver(doc);
    const orch = new Orchestrator();

    const run = await orch.start('room1', doc, 'quick', { squad });
    const finished = await run.done;
    expect(finished.status).toBe('done');

    // A late interrupt must not downgrade completed work.
    run.interrupt();
    expect(orch.interrupt('room1')).toBe(false);
    expect(readTask(doc, finished.id)!.status).toBe('done');

    await host.stopAll();
  });

  it('starting a new orchestration interrupts the previous one for the room', async () => {
    const doc = new Y.Doc();
    const released: Array<() => void> = [];
    const blockingSquad: AgentSquad = {
      async spawn() {},
      assign: () => new Promise<void>((r) => released.push(r)),
      interrupt() {},
      async stop() {},
    };
    const orch = new Orchestrator();
    const first = await orch.start('roomR', doc, 'first', { squad: blockingSquad });
    expect(first.interrupted).toBe(false);

    // Second start supersedes the first.
    const second = await orch.start('roomR', doc, 'second', { squad: blockingSquad });
    expect(first.interrupted).toBe(true);
    expect(second.interrupted).toBe(false);

    for (const r of released) r();
    await first.done;
    await second.done;
  });
});

describe('Orchestrator — planning', () => {
  it('records the prompt and a non-empty plan on the doc immediately', async () => {
    const doc = new Y.Doc();
    const { host, squad } = makeSquadOver(doc);
    const orch = new Orchestrator();

    const run = await orch.start('room1', doc, 'my big task', { squad });
    const onDoc = tasks(doc);
    expect(onDoc).toHaveLength(1);
    expect(onDoc[0]!.prompt).toBe('my big task');
    expect(onDoc[0]!.subtasks.length).toBeGreaterThan(0);

    await run.done;
    await host.stopAll();
  });

  it('respects maxAgents (caps spawned specialists)', async () => {
    const doc = new Y.Doc();
    const { host, squad } = makeSquadOver(doc);
    const orch = new Orchestrator();

    const run = await orch.start('room1', doc, 'capped', { squad, maxAgents: 2 });
    const task = await run.done;
    expect(task.subtasks.length).toBe(2);
    expect(agentStates(doc).length).toBe(2);

    await host.stopAll();
  });
});
