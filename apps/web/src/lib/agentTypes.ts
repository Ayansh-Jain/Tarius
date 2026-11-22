/**
 * Read-side shapes for the agent surface that flows through the Yjs doc.
 *
 * WHY a defensive reader: the *server* slice owns the exact value it writes into
 * `getAgents(doc)` / `getAgentChat(doc)`, and it merges AFTER this web slice. To
 * stay decoupled (INTEGRATION MODEL) we don't import its module or hard-code one
 * storage layout — we accept any reasonable encoding and normalize to the frozen
 * `@ice/shared` types the UI renders. Anything malformed is skipped, never
 * thrown, so a half-wired server can't crash the room.
 *
 * The frozen contracts are the source of truth for the *fields*:
 *   - AgentState     { agentId, kind, displayName, color, status }
 *   - AgentToolCall  { id, agentId, tool, args, requiresApproval, status }
 *   - AgentChatMessage { id, agentId, role, text, createdAt }
 */
import type { AgentChatMessage, AgentRunStatus, AgentState, AgentToolCall } from '@ice/shared';

/** One agent as the UI consumes it: its live state plus any pending tool call. */
export interface AgentView {
  state: AgentState;
  /** Present when the agent is blocked on the human approval gate. */
  pendingCall: AgentToolCall | null;
}

const RUN_STATUSES: ReadonlySet<string> = new Set<AgentRunStatus>([
  'idle',
  'thinking',
  'editing',
  'awaiting-approval',
  'running-tool',
  'error',
]);

const TOOL_STATUSES: ReadonlySet<string> = new Set<AgentToolCall['status']>([
  'proposed',
  'approved',
  'rejected',
  'running',
  'done',
  'error',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Coerce an unknown run status to a known one, defaulting to 'idle'. */
function asRunStatus(value: unknown): AgentRunStatus {
  return typeof value === 'string' && RUN_STATUSES.has(value)
    ? (value as AgentRunStatus)
    : 'idle';
}

/**
 * Pull an AgentState out of an unknown value. We require at minimum an id we can
 * key on; the rest get sane fallbacks so a partially-populated record still
 * renders (e.g. mid-spawn, before the backend reports a color/name).
 */
function parseState(raw: unknown, keyHint: string): AgentState | null {
  if (!isRecord(raw)) return null;
  // The state may be the record itself, or nested under `state`.
  const src = isRecord(raw.state) ? (raw.state as Record<string, unknown>) : raw;
  const agentId = str(src.agentId) ?? str(raw.agentId) ?? (keyHint || null);
  if (!agentId) return null;
  return {
    agentId,
    kind: str(src.kind) ?? 'mock',
    displayName: str(src.displayName) ?? 'Agent',
    color: str(src.color) ?? '#8b5cf6',
    status: asRunStatus(src.status),
  };
}

/** Parse an AgentToolCall, requiring an id + tool; otherwise treat as absent. */
function parseToolCall(raw: unknown, agentId: string): AgentToolCall | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  const tool = str(raw.tool);
  if (!id || !tool) return null;
  const status = raw.status;
  return {
    id,
    agentId: str(raw.agentId) ?? agentId,
    tool,
    args: 'args' in raw ? raw.args : undefined,
    requiresApproval: raw.requiresApproval !== false,
    status:
      typeof status === 'string' && TOOL_STATUSES.has(status)
        ? (status as AgentToolCall['status'])
        : 'proposed',
  };
}

/**
 * Find the pending (gate-blocking) tool call on a per-agent record, tolerating
 * several plausible keys the server might use (`pendingCall`, `pendingToolCall`,
 * `toolCall`, `pending`). A call only counts as pending if it's still proposed.
 */
function parsePendingCall(raw: unknown, agentId: string): AgentToolCall | null {
  if (!isRecord(raw)) return null;
  const candidate =
    raw.pendingCall ?? raw.pendingToolCall ?? raw.toolCall ?? raw.pending ?? null;
  // A "done"/"error"/"rejected" call is resolved — don't keep showing the gate.
  const call = parseToolCall(candidate, agentId);
  if (!call) return null;
  return call.status === 'done' || call.status === 'error' || call.status === 'rejected'
    ? null
    : call;
}

/**
 * Normalize the raw `getAgents(doc)` snapshot (a plain object from
 * `Y.Map.toJSON()`) into a stable, sorted list of {@link AgentView}.
 *
 * Accepts both layouts the server might pick:
 *   - agentId -> AgentState (with pending call merged alongside), or
 *   - agentId -> { state: AgentState, pendingCall?: AgentToolCall }.
 */
export function readAgents(snapshot: Record<string, unknown>): AgentView[] {
  const out: AgentView[] = [];
  for (const [key, raw] of Object.entries(snapshot)) {
    const state = parseState(raw, key);
    if (!state) continue;
    out.push({ state, pendingCall: parsePendingCall(raw, state.agentId) });
  }
  // Deterministic order: by display name, then id, so the list doesn't jump.
  out.sort((a, b) => {
    const byName = a.state.displayName.localeCompare(b.state.displayName);
    return byName !== 0 ? byName : a.state.agentId.localeCompare(b.state.agentId);
  });
  return out;
}

/** Normalize a raw `getAgentChat(doc)` array (from `Y.Array.toJSON()`). */
export function readChat(items: unknown[]): AgentChatMessage[] {
  const out: AgentChatMessage[] = [];
  for (const raw of items) {
    if (!isRecord(raw)) continue;
    const id = str(raw.id);
    const text = str(raw.text);
    const agentId = str(raw.agentId);
    if (id === null || text === null) continue;
    const role = raw.role === 'user' || raw.role === 'agent' ? raw.role : 'agent';
    const createdAt = typeof raw.createdAt === 'number' ? raw.createdAt : Date.now();
    out.push({ id, agentId: agentId ?? '', role, text, createdAt });
  }
  return out;
}

/** Human-readable label + accent for each run status (chat header / chips). */
export const RUN_STATUS_META: Record<
  AgentRunStatus,
  { label: string; dot: string; text: string }
> = {
  idle: { label: 'Idle', dot: 'bg-slate-500', text: 'text-slate-400' },
  thinking: { label: 'Thinking…', dot: 'bg-sky-400 animate-pulse', text: 'text-sky-300' },
  editing: { label: 'Editing', dot: 'bg-violet-400 animate-pulse', text: 'text-violet-300' },
  'awaiting-approval': {
    label: 'Needs approval',
    dot: 'bg-amber-400 animate-pulse',
    text: 'text-amber-300',
  },
  'running-tool': { label: 'Running tool', dot: 'bg-cyan-400 animate-pulse', text: 'text-cyan-300' },
  error: { label: 'Error', dot: 'bg-rose-500', text: 'text-rose-300' },
};
