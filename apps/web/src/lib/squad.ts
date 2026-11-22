/**
 * Self-contained fetch client for the v1.5 multi-agent control plane.
 *
 * DELIBERATELY independent of `apps/web/src/lib/api.ts` (mirrors the v1.0 Slice C
 * pattern in `lib/gitui.ts`): the integrator wires the server's orchestration /
 * snapshot / MCP-tool endpoints AFTER this slice merges, so the squad surface
 * must keep working in isolation. Slice D therefore owns its OWN thin client here
 * rather than touching the app-wide api module.
 *
 * The squad's *live* state — the OrchestrationTask + subtasks, the agent roster,
 * who's doing what — flows back through the room Y.Doc (getTasks / getAgents), NOT
 * these calls. These are command/read endpoints only:
 *
 *   - POST /api/rooms/:id/orchestrate { prompt } -> { task: OrchestrationTask }
 *       Hand a high-level goal to the squad; the orchestrator plans subtasks and
 *       routes them to specialist roles. The authoritative task then appears in
 *       getTasks(doc) over the realtime channel.
 *   - POST /api/rooms/:id/orchestrate/:taskId/interrupt -> { ok }
 *       Stop a running orchestration (best-effort; status flips in the doc).
 *   - GET  /api/rooms/:id/snapshots -> { snapshots: AgentSnapshot[] }
 *   - POST /api/rooms/:id/snapshot { agentId? } -> { snapshot: AgentSnapshot }
 *       Open an opt-in "try it safely" branch for an agent.
 *   - POST /api/rooms/:id/snapshot/:snapshotId/merge   -> { ok }
 *   - POST /api/rooms/:id/snapshot/:snapshotId/discard -> { ok }
 *   - GET  /api/rooms/:id/mcp-tools -> { tools: McpTool[] }
 *       The workspace-scoped MCP tools exposed to the squad.
 *
 * Degradation contract (mirrors the app's git client): a 404 or network/parse
 * failure is a quiet `{ ok:false, notReady:true }` — "this part of the server
 * isn't wired up yet" — NOT a user-facing error. Only a real non-404 server
 * error (or an explicit failed action) surfaces a message. This keeps a
 * half-wired or absent server from ever breaking the room.
 */
import type {
  AgentRole,
  AgentSnapshot,
  McpTool,
  OrchestrationTask,
  Subtask,
} from '@ice/shared';

/** Distinguishes "no squad surface yet" (quiet) from a real, surfaced error. */
export interface SquadUnavailable {
  ok: false;
  /** True when the endpoint simply isn't wired yet (404 / network); not an error to show. */
  notReady: boolean;
  message: string;
}

export type SquadResult<T> = ({ ok: true } & T) | SquadUnavailable;

/** Ack-only result (interrupt / merge / discard): an ok flag or the unavailable shape. */
export type SquadAck = { ok: true } | SquadUnavailable;

class SquadHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'SquadHttpError';
    this.status = status;
  }
}

/** Map any thrown error into the degradation shape. */
function unavailable(err: unknown): SquadUnavailable {
  if (err instanceof SquadHttpError) {
    // 404 = route not mounted yet (pre-wiring). Quiet "not ready".
    if (err.status === 404) return { ok: false, notReady: true, message: err.message };
    return { ok: false, notReady: false, message: err.message };
  }
  // Network / parse failure (server down, dev proxy miss): also "not ready".
  return { ok: false, notReady: true, message: err instanceof Error ? err.message : String(err) };
}

/**
 * Same-origin JSON request. `/api/...` is proxied to the server in dev and served
 * by it in prod, so a relative path + `credentials: 'include'` (to carry the
 * `ice_session` cookie) works in both.
 */
async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    credentials: 'include',
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body: unknown = await res.json();
      if (body && typeof body === 'object' && 'error' in body) {
        message = String((body as { error: unknown }).error);
      }
    } catch {
      // non-JSON error body: keep the status line
    }
    throw new SquadHttpError(res.status, message);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

function roomPath(roomId: string, suffix: string): string {
  return `/api/rooms/${encodeURIComponent(roomId)}${suffix}`;
}

// ── Orchestration ─────────────────────────────────────────────────────────────

/**
 * POST /api/rooms/:id/orchestrate { prompt }. Hands a goal to the squad. The
 * server may echo the created task; either way the authoritative task lands in
 * getTasks(doc), so the caller doesn't optimistically render — it just submits.
 * Degrades to a quiet not-ready result pre-wiring.
 */
export async function orchestrate(
  roomId: string,
  prompt: string,
): Promise<SquadResult<{ task: OrchestrationTask | null }>> {
  try {
    const body = await requestJson<{ task?: OrchestrationTask }>(roomPath(roomId, '/orchestrate'), {
      method: 'POST',
      body: JSON.stringify({ prompt }),
    });
    return { ok: true, task: body.task ?? null };
  } catch (err) {
    return unavailable(err);
  }
}

/**
 * POST /api/rooms/:id/orchestrate/:taskId/interrupt. Stops a running
 * orchestration; the resulting status change arrives via getTasks(doc).
 */
export async function interruptTask(roomId: string, taskId: string): Promise<SquadAck> {
  try {
    await requestJson<unknown>(
      roomPath(roomId, `/orchestrate/${encodeURIComponent(taskId)}/interrupt`),
      { method: 'POST' },
    );
    return { ok: true };
  } catch (err) {
    return unavailable(err);
  }
}

// ── Snapshots ("try it safely") ───────────────────────────────────────────────

/**
 * GET /api/rooms/:id/snapshots -> { snapshots }. Degrades to an empty not-ready
 * result so the bar renders a friendly "no open snapshots" state pre-wiring.
 */
export async function fetchSnapshots(
  roomId: string,
): Promise<SquadResult<{ snapshots: AgentSnapshot[] }>> {
  try {
    const { snapshots } = await requestJson<{ snapshots: AgentSnapshot[] }>(
      roomPath(roomId, '/snapshots'),
      { method: 'GET' },
    );
    return { ok: true, snapshots: Array.isArray(snapshots) ? snapshots : [] };
  } catch (err) {
    return unavailable(err);
  }
}

/**
 * POST /api/rooms/:id/snapshot { agentId? } -> { snapshot }. Opens an opt-in
 * branch for an agent to work on safely. `agentId` is forwarded when present so
 * a specific teammate can be scoped; the server may infer the active agent.
 */
export async function startSnapshot(
  roomId: string,
  agentId?: string,
): Promise<SquadResult<{ snapshot: AgentSnapshot | null }>> {
  try {
    const body = await requestJson<{ snapshot?: AgentSnapshot }>(roomPath(roomId, '/snapshot'), {
      method: 'POST',
      body: JSON.stringify(agentId ? { agentId } : {}),
    });
    return { ok: true, snapshot: body.snapshot ?? null };
  } catch (err) {
    return unavailable(err);
  }
}

/** POST /api/rooms/:id/snapshot/:snapshotId/merge. Lands the snapshot's branch. */
export async function mergeSnapshot(roomId: string, snapshotId: string): Promise<SquadAck> {
  try {
    await requestJson<unknown>(
      roomPath(roomId, `/snapshot/${encodeURIComponent(snapshotId)}/merge`),
      { method: 'POST' },
    );
    return { ok: true };
  } catch (err) {
    return unavailable(err);
  }
}

/** POST /api/rooms/:id/snapshot/:snapshotId/discard. Throws the branch away. */
export async function discardSnapshot(roomId: string, snapshotId: string): Promise<SquadAck> {
  try {
    await requestJson<unknown>(
      roomPath(roomId, `/snapshot/${encodeURIComponent(snapshotId)}/discard`),
      { method: 'POST' },
    );
    return { ok: true };
  } catch (err) {
    return unavailable(err);
  }
}

// ── MCP tools ─────────────────────────────────────────────────────────────────

/**
 * GET /api/rooms/:id/mcp-tools -> { tools }. The workspace-scoped MCP tools the
 * squad can call. Degrades to an empty not-ready result pre-wiring.
 */
export async function fetchMcpTools(roomId: string): Promise<SquadResult<{ tools: McpTool[] }>> {
  try {
    const { tools } = await requestJson<{ tools: McpTool[] }>(roomPath(roomId, '/mcp-tools'), {
      method: 'GET',
    });
    return { ok: true, tools: Array.isArray(tools) ? tools : [] };
  } catch (err) {
    return unavailable(err);
  }
}

// ── Live task reading (defensive, doc-sourced) ────────────────────────────────
//
// Like lib/agentTypes.ts, the *server* owns the exact value it writes into
// getTasks(doc), and it merges AFTER this web slice. To stay decoupled we don't
// import its module or hard-code one storage layout — we accept any reasonable
// encoding and normalize to the frozen @ice/shared OrchestrationTask/Subtask
// types the UI renders. Anything malformed is skipped, never thrown.

const TASK_STATUSES: ReadonlySet<string> = new Set<OrchestrationTask['status']>([
  'planning',
  'running',
  'done',
  'failed',
]);

const SUBTASK_STATUSES: ReadonlySet<string> = new Set<Subtask['status']>([
  'pending',
  'assigned',
  'in-progress',
  'done',
  'failed',
]);

const AGENT_ROLES: ReadonlySet<string> = new Set<AgentRole>([
  'architect',
  'coder',
  'debugger',
  'reviewer',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asRole(value: unknown): AgentRole {
  return typeof value === 'string' && AGENT_ROLES.has(value) ? (value as AgentRole) : 'coder';
}

function asTaskStatus(value: unknown): OrchestrationTask['status'] {
  return typeof value === 'string' && TASK_STATUSES.has(value)
    ? (value as OrchestrationTask['status'])
    : 'planning';
}

function asSubtaskStatus(value: unknown): Subtask['status'] {
  return typeof value === 'string' && SUBTASK_STATUSES.has(value)
    ? (value as Subtask['status'])
    : 'pending';
}

function parseSubtask(raw: unknown, idx: number): Subtask | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id) ?? `sub-${idx}`;
  const assignedTo = str(raw.assignedTo);
  return {
    id,
    role: asRole(raw.role),
    description: str(raw.description) ?? '',
    status: asSubtaskStatus(raw.status),
    ...(assignedTo ? { assignedTo } : {}),
  };
}

/**
 * Normalize a raw `getTasks(doc)` array (from `Y.Array.toJSON()`) into stable
 * OrchestrationTasks. Requires an id we can key on; everything else gets sane
 * fallbacks so a half-planned task still renders.
 */
export function readTasks(items: unknown[]): OrchestrationTask[] {
  const out: OrchestrationTask[] = [];
  items.forEach((raw, i) => {
    if (!isRecord(raw)) return;
    const id = str(raw.id);
    if (!id) return;
    const rawSubs = Array.isArray(raw.subtasks) ? raw.subtasks : [];
    const subtasks: Subtask[] = [];
    rawSubs.forEach((s, j) => {
      const parsed = parseSubtask(s, j);
      if (parsed) subtasks.push(parsed);
    });
    out.push({
      id,
      prompt: str(raw.prompt) ?? '',
      subtasks,
      createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now() + i,
      status: asTaskStatus(raw.status),
    });
  });
  // Newest first so the active goal is on top.
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

const SNAPSHOT_STATUSES: ReadonlySet<string> = new Set<AgentSnapshot['status']>([
  'open',
  'merged',
  'discarded',
]);

/** Coerce an unknown snapshot record to the frozen AgentSnapshot, or null. */
export function parseSnapshot(raw: unknown): AgentSnapshot | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  if (!id) return null;
  const status = raw.status;
  return {
    id,
    agentId: str(raw.agentId) ?? '',
    branch: str(raw.branch) ?? '',
    baseCommit: str(raw.baseCommit) ?? '',
    status:
      typeof status === 'string' && SNAPSHOT_STATUSES.has(status)
        ? (status as AgentSnapshot['status'])
        : 'open',
  };
}

// ── Display helpers shared across the squad components ─────────────────────────

/** Per-role accent (Tailwind classes) + glyph for subtask chips and legends. */
export const ROLE_META: Record<AgentRole, { label: string; glyph: string; chip: string }> = {
  architect: { label: 'Architect', glyph: '▣', chip: 'bg-sky-500/15 text-sky-300 ring-sky-500/30' },
  coder: { label: 'Coder', glyph: '⌨', chip: 'bg-violet-500/15 text-violet-300 ring-violet-500/30' },
  debugger: { label: 'Debugger', glyph: '🐞', chip: 'bg-amber-500/15 text-amber-300 ring-amber-500/30' },
  reviewer: { label: 'Reviewer', glyph: '✓', chip: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30' },
};

/** Per-subtask-status presentation (dot color + label). */
export const SUBTASK_STATUS_META: Record<
  Subtask['status'],
  { label: string; dot: string; text: string }
> = {
  pending: { label: 'Pending', dot: 'bg-slate-500', text: 'text-slate-400' },
  assigned: { label: 'Assigned', dot: 'bg-sky-400', text: 'text-sky-300' },
  'in-progress': { label: 'In progress', dot: 'bg-violet-400 animate-pulse', text: 'text-violet-300' },
  done: { label: 'Done', dot: 'bg-emerald-400', text: 'text-emerald-300' },
  failed: { label: 'Failed', dot: 'bg-rose-500', text: 'text-rose-300' },
};

/** Per-orchestration-status presentation for the task header badge. */
export const TASK_STATUS_META: Record<
  OrchestrationTask['status'],
  { label: string; dot: string; text: string }
> = {
  planning: { label: 'Planning', dot: 'bg-sky-400 animate-pulse', text: 'text-sky-300' },
  running: { label: 'Running', dot: 'bg-violet-400 animate-pulse', text: 'text-violet-300' },
  done: { label: 'Done', dot: 'bg-emerald-400', text: 'text-emerald-300' },
  failed: { label: 'Failed', dot: 'bg-rose-500', text: 'text-rose-300' },
};

/** True while a task is still actively being worked (so we offer "interrupt"). */
export function isTaskActive(task: OrchestrationTask): boolean {
  return task.status === 'planning' || task.status === 'running';
}

export { SquadHttpError };
