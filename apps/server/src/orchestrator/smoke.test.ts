/**
 * Module-level API smoke test (v1.5) — exercises the EXACT surface the driver
 * wires (startOrchestration / getOrchestrationState / interruptOrchestration)
 * with an injected squad over an isolated AgentHost, proving the public entry
 * points (not just the class) drive a real multi-agent run on a bare Y.Doc.
 */
import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { getAgents, getTasks } from '@ice/shared';
import { AgentHost } from '../agent/index.js';
import {
  startOrchestration,
  getOrchestrationState,
  interruptOrchestration,
  makeHostSquad,
  configureOrchestrator,
  Orchestrator,
} from './index.js';

describe('module-level orchestrator API (driver surface)', () => {
  it('startOrchestration spawns a squad, records tasks, and settles done', async () => {
    // Fresh shared orchestrator so this test is isolated from any other.
    configureOrchestrator(new Orchestrator());
    const doc = new Y.Doc();
    const host = new AgentHost();
    const squad = makeHostSquad({
      startAgentForRoom: (r, d, c, deps) => host.startAgentForRoom(r, d, c, deps),
      handleAgentMessage: (r, d, t, o) => host.handleAgentMessage(r, d, t, o),
      interruptAgent: (r, a) => host.interruptAgent(r, a),
      stopAgent: (r, a) => host.stopAgent(r, a),
    })('roomMod', doc);

    const run = await startOrchestration('roomMod', doc, 'wire me up', { squad });
    // getOrchestrationState returns the live run for the room.
    expect(getOrchestrationState('roomMod')).toBe(run);

    const task = await run.done;
    expect(task.status).toBe('done');
    expect((getTasks(doc) as Y.Array<unknown>).length).toBe(1);
    expect((getAgents(doc) as Y.Map<unknown>).size).toBeGreaterThanOrEqual(2);

    await host.stopAll();
  });

  it('interruptOrchestration stops a live run via the module API', async () => {
    configureOrchestrator(new Orchestrator());
    const doc = new Y.Doc();
    const released: Array<() => void> = [];
    const squad = {
      async spawn() {},
      assign: () => new Promise<void>((r) => released.push(r)),
      interrupt() {},
      async stop() {},
    };
    const run = await startOrchestration('roomInt', doc, 'job', { squad });
    expect(interruptOrchestration('roomInt')).toBe(true);
    expect(run.interrupted).toBe(true);
    for (const r of released) r();
    const finished = await run.done;
    expect(finished.status).toBe('failed');
  });
});
