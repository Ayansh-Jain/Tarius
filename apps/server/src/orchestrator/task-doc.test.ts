/**
 * Task ↔ doc projection tests (v1.5). The orchestration plan is shared CRDT
 * state in getTasks(doc); these assert append / patch / read round-trip and that
 * granular subtask updates don't disturb siblings.
 */
import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { getTasks, type OrchestrationTask } from '@ice/shared';
import {
  appendTask,
  patchSubtask,
  readAllTasks,
  readTask,
  setTaskStatus,
} from './task-doc.js';

function sampleTask(id = 't1'): OrchestrationTask {
  return {
    id,
    prompt: 'do the thing',
    createdAt: 1000,
    status: 'planning',
    subtasks: [
      { id: 's1', role: 'architect', description: 'design', status: 'pending', assignedTo: 'a1' },
      { id: 's2', role: 'coder', description: 'build', status: 'pending', assignedTo: 'a2' },
    ],
  };
}

describe('task-doc projection', () => {
  it('appends a task + subtasks to getTasks(doc) and reads it back', () => {
    const doc = new Y.Doc();
    appendTask(doc, sampleTask());

    expect(getTasks(doc).length).toBe(1);
    const read = readTask(doc, 't1');
    expect(read).toEqual(sampleTask());
  });

  it('does not duplicate a task with the same id', () => {
    const doc = new Y.Doc();
    appendTask(doc, sampleTask());
    appendTask(doc, sampleTask());
    expect(getTasks(doc).length).toBe(1);
  });

  it('patches a single subtask without touching siblings', () => {
    const doc = new Y.Doc();
    appendTask(doc, sampleTask());

    patchSubtask(doc, 't1', 's2', { status: 'done' });
    const read = readTask(doc, 't1')!;
    expect(read.subtasks.find((s) => s.id === 's2')!.status).toBe('done');
    // sibling unchanged
    expect(read.subtasks.find((s) => s.id === 's1')!.status).toBe('pending');
  });

  it('updates assignedTo via patch', () => {
    const doc = new Y.Doc();
    appendTask(doc, sampleTask());
    patchSubtask(doc, 't1', 's1', { assignedTo: 'reassigned' });
    expect(readTask(doc, 't1')!.subtasks[0]!.assignedTo).toBe('reassigned');
  });

  it('sets the top-level task status', () => {
    const doc = new Y.Doc();
    appendTask(doc, sampleTask());
    setTaskStatus(doc, 't1', 'done');
    expect(readTask(doc, 't1')!.status).toBe('done');
  });

  it('reads multiple tasks', () => {
    const doc = new Y.Doc();
    appendTask(doc, sampleTask('t1'));
    appendTask(doc, sampleTask('t2'));
    const all = readAllTasks(doc);
    expect(all.map((t) => t.id)).toEqual(['t1', 't2']);
  });

  it('all writes are observable by a deep watcher (UI live-update path)', () => {
    const doc = new Y.Doc();
    let updates = 0;
    getTasks(doc).observeDeep(() => {
      updates += 1;
    });
    appendTask(doc, sampleTask());
    patchSubtask(doc, 't1', 's1', { status: 'in-progress' });
    setTaskStatus(doc, 't1', 'running');
    expect(updates).toBeGreaterThanOrEqual(3);
  });

  it('no-ops gracefully on unknown task/subtask ids', () => {
    const doc = new Y.Doc();
    appendTask(doc, sampleTask());
    expect(() => patchSubtask(doc, 'nope', 's1', { status: 'done' })).not.toThrow();
    expect(() => patchSubtask(doc, 't1', 'nope', { status: 'done' })).not.toThrow();
    expect(() => setTaskStatus(doc, 'nope', 'done')).not.toThrow();
    expect(readTask(doc, 'nope')).toBeNull();
  });
});
