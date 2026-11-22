/**
 * Orchestration ↔ Yjs projection (v1.5).
 *
 * The squad's plan is durable, shared state: it lives in getTasks(doc) (a
 * Y.Array) so every client — and a watching UI — sees subtasks appear and march
 * to done in real time. We model ONE {@link OrchestrationTask} as a Y.Map whose
 * `subtasks` is a Y.Array of Y.Maps, so a single subtask's status flip is a
 * granular CRDT update (not a whole-array rewrite that would thrash awareness or
 * lose concurrent edits).
 *
 * Every write goes through transactWithOrigin with a `{kind:'system'}` origin:
 * the orchestrator is system bookkeeping, distinct from the per-agent
 * `{kind:'agent', agentId}` origins that carry the actual file edits. That keeps
 * "who planned" and "who wrote code" cleanly attributable and separately
 * undoable.
 */
import * as Y from 'yjs';
import {
  getTasks,
  transactWithOrigin,
  type EditOrigin,
  type OrchestrationTask,
  type Subtask,
} from '@ice/shared';

/** The system origin for all orchestration bookkeeping writes. */
export const ORCH_ORIGIN: EditOrigin = { kind: 'system' };

/** Find the Y.Map for a task id in getTasks(doc), if present. */
function findTaskMap(doc: Y.Doc, taskId: string): Y.Map<unknown> | undefined {
  const tasks = getTasks(doc);
  for (const item of tasks) {
    if (item instanceof Y.Map && item.get('id') === taskId) return item;
  }
  return undefined;
}

/** Build the Y.Map for a subtask from its plain shape. */
function subtaskToY(sub: Subtask): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set('id', sub.id);
  m.set('role', sub.role);
  m.set('description', sub.description);
  m.set('status', sub.status);
  if (sub.assignedTo !== undefined) m.set('assignedTo', sub.assignedTo);
  return m;
}

/**
 * Append a fresh {@link OrchestrationTask} (with its subtasks) to getTasks(doc).
 * Idempotent-ish: if a task with this id already exists it is left as-is.
 */
export function appendTask(doc: Y.Doc, task: OrchestrationTask): void {
  if (findTaskMap(doc, task.id)) return;
  transactWithOrigin(doc, ORCH_ORIGIN, () => {
    const taskMap = new Y.Map<unknown>();
    taskMap.set('id', task.id);
    taskMap.set('prompt', task.prompt);
    taskMap.set('createdAt', task.createdAt);
    taskMap.set('status', task.status);
    const subs = new Y.Array<Y.Map<unknown>>();
    subs.push(task.subtasks.map(subtaskToY));
    taskMap.set('subtasks', subs);
    getTasks(doc).push([taskMap]);
  });
}

/** Update the top-level status of a task. */
export function setTaskStatus(
  doc: Y.Doc,
  taskId: string,
  status: OrchestrationTask['status'],
): void {
  const taskMap = findTaskMap(doc, taskId);
  if (!taskMap) return;
  transactWithOrigin(doc, ORCH_ORIGIN, () => {
    taskMap.set('status', status);
  });
}

/** Patch a single subtask (status and/or assignedTo) inside a task. */
export function patchSubtask(
  doc: Y.Doc,
  taskId: string,
  subtaskId: string,
  patch: Partial<Pick<Subtask, 'status' | 'assignedTo'>>,
): void {
  const taskMap = findTaskMap(doc, taskId);
  if (!taskMap) return;
  const subs = taskMap.get('subtasks');
  if (!(subs instanceof Y.Array)) return;
  transactWithOrigin(doc, ORCH_ORIGIN, () => {
    for (const item of subs as Y.Array<Y.Map<unknown>>) {
      if (item instanceof Y.Map && item.get('id') === subtaskId) {
        if (patch.status !== undefined) item.set('status', patch.status);
        if (patch.assignedTo !== undefined) item.set('assignedTo', patch.assignedTo);
        return;
      }
    }
  });
}

/** Read one task back from the doc as a plain {@link OrchestrationTask}. */
export function readTask(doc: Y.Doc, taskId: string): OrchestrationTask | null {
  const taskMap = findTaskMap(doc, taskId);
  if (!taskMap) return null;
  return taskMapToPlain(taskMap);
}

/** Read every orchestration task in the doc (newest-last, as stored). */
export function readAllTasks(doc: Y.Doc): OrchestrationTask[] {
  const out: OrchestrationTask[] = [];
  for (const item of getTasks(doc)) {
    if (item instanceof Y.Map) out.push(taskMapToPlain(item));
  }
  return out;
}

/** Convert a task Y.Map into its plain shape. */
function taskMapToPlain(taskMap: Y.Map<unknown>): OrchestrationTask {
  const subsY = taskMap.get('subtasks');
  const subtasks: Subtask[] = [];
  if (subsY instanceof Y.Array) {
    for (const s of subsY as Y.Array<Y.Map<unknown>>) {
      if (!(s instanceof Y.Map)) continue;
      const sub: Subtask = {
        id: String(s.get('id')),
        role: s.get('role') as Subtask['role'],
        description: String(s.get('description') ?? ''),
        status: s.get('status') as Subtask['status'],
      };
      const assignedTo = s.get('assignedTo');
      if (typeof assignedTo === 'string') sub.assignedTo = assignedTo;
      subtasks.push(sub);
    }
  }
  return {
    id: String(taskMap.get('id')),
    prompt: String(taskMap.get('prompt') ?? ''),
    createdAt: Number(taskMap.get('createdAt') ?? 0),
    status: taskMap.get('status') as OrchestrationTask['status'],
    subtasks,
  };
}
