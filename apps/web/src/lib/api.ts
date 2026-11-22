/**
 * Thin typed client for the ICE server REST surface (Hono, JSON).
 *
 * Mirrors the v0.1 WIRE CONTRACT. Every call hits a same-origin `/api/...`
 * path (Vite proxies `/api` → the server in dev; in prod the server serves the
 * built web app, so same-origin holds there too). Cookies (`ice_session`) ride
 * along automatically via `credentials: 'include'`.
 *
 * Design note: the core two-window demo must work even if the server's room
 * endpoints are permissive or briefly unavailable, so {@link createRoom}
 * degrades to a locally-generated room id rather than blocking the user. The
 * Yjs/Hocuspocus layer is what actually makes a room real.
 */
import type {
  AgentBackendKind,
  AgentState,
  ApprovalDecision,
  BranchInfo,
  CommitInfo,
  CommitResult,
  Participant,
  Room,
} from '@ice/shared';
import { randomId } from './identity.js';

/** Slug-ish id that is safe in a URL and as a Yjs document name. */
export function generateRoomId(): string {
  // Short, lowercase, URL-safe. Collisions are astronomically unlikely for a
  // self-hosted squad; the server owns authoritative uniqueness when present.
  const rand = randomId('room').replace(/[^a-z0-9]/gi, '').toLowerCase();
  return rand.slice(0, 16) || Math.random().toString(36).slice(2, 12);
}

export interface ApiError {
  status: number;
  message: string;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
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
      // ignore non-JSON error bodies
    }
    throw new HttpError(res.status, message);
  }
  // 204/empty bodies are not expected on these endpoints, but guard anyway.
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

/** GET /api/health -> { status: 'ok' } */
export async function health(): Promise<{ status: string }> {
  return request<{ status: string }>('/api/health', { method: 'GET' });
}

/**
 * POST /api/rooms { name } -> { room }.
 *
 * Falls back to a client-generated room if the server is unreachable so the
 * landing flow never dead-ends in dev.
 */
export async function createRoom(name: string): Promise<Room> {
  const trimmed = name.trim() || 'untitled room';
  try {
    const { room } = await request<{ room: Room }>('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({ name: trimmed }),
    });
    return room;
  } catch {
    const id = generateRoomId();
    return { id, name: trimmed, createdAt: Date.now() };
  }
}

/** POST /api/auth/guest { displayName } -> { participant }. Best-effort. */
export async function registerGuest(displayName: string): Promise<Participant | null> {
  try {
    const { participant } = await request<{ participant: Participant }>('/api/auth/guest', {
      method: 'POST',
      body: JSON.stringify({ displayName: displayName.trim() }),
    });
    return participant;
  } catch {
    return null;
  }
}

/** POST /api/rooms/:roomId/invites -> { token, url }. Best-effort. */
export async function createInvite(
  roomId: string,
): Promise<{ token: string; url: string } | null> {
  try {
    return await request<{ token: string; url: string }>(
      `/api/rooms/${encodeURIComponent(roomId)}/invites`,
      { method: 'POST' },
    );
  } catch {
    return null;
  }
}

// ── Git / Source Control (v0.3) ───────────────────────────────────────────────
//
// These hit the convergence + git endpoints the server gains in v0.3. They are
// wired by the integrator AFTER this slice merges, so the web MUST tolerate
// them being absent: the read calls return an empty/"not ready" result on any
// non-200 (404 included) rather than throwing, and the panel renders a friendly
// "history will appear once committed" empty state.

/** Distinguishes "server has no git surface yet" from a real, surfaced error. */
export interface GitUnavailable {
  ok: false;
  /** True when the endpoint is simply not wired yet (404 / network); not user-facing as an error. */
  notReady: boolean;
  message: string;
}

export type GitResult<T> = ({ ok: true } & T) | GitUnavailable;

function gitUnavailable(err: unknown): GitUnavailable {
  if (err instanceof HttpError) {
    // 404 = endpoint not mounted yet (pre-wiring). Treat as "not ready", quiet.
    if (err.status === 404) return { ok: false, notReady: true, message: err.message };
    return { ok: false, notReady: false, message: err.message };
  }
  // Network/parse failure (server down, dev proxy miss): also "not ready".
  return { ok: false, notReady: true, message: err instanceof Error ? err.message : String(err) };
}

/**
 * GET /api/rooms/:roomId/branches -> { branches: BranchInfo[] }.
 * Degrades to a not-ready result if the endpoint isn't wired yet.
 */
export async function listBranches(roomId: string): Promise<GitResult<{ branches: BranchInfo[] }>> {
  try {
    const { branches } = await request<{ branches: BranchInfo[] }>(
      `/api/rooms/${encodeURIComponent(roomId)}/branches`,
      { method: 'GET' },
    );
    return { ok: true, branches: Array.isArray(branches) ? branches : [] };
  } catch (err) {
    return gitUnavailable(err);
  }
}

/**
 * GET /api/rooms/:roomId/commits[?branch=] -> { commits: CommitInfo[] }.
 * Degrades to a not-ready result if the endpoint isn't wired yet.
 */
export async function listCommits(
  roomId: string,
  branch?: string,
): Promise<GitResult<{ commits: CommitInfo[] }>> {
  const qs = branch ? `?branch=${encodeURIComponent(branch)}` : '';
  try {
    const { commits } = await request<{ commits: CommitInfo[] }>(
      `/api/rooms/${encodeURIComponent(roomId)}/commits${qs}`,
      { method: 'GET' },
    );
    return { ok: true, commits: Array.isArray(commits) ? commits : [] };
  } catch (err) {
    return gitUnavailable(err);
  }
}

/**
 * POST /api/rooms/:roomId/commit { message } -> CommitResult.
 *
 * Triggers the server's flush (doc → working tree, under the per-room lock) +
 * git commit. Unlike the read calls, a failed commit is surfaced to the user
 * (it's an explicit action), so we return the structured result and let the
 * caller show success or the error message.
 */
export async function commitRoom(
  roomId: string,
  message: string,
): Promise<GitResult<{ result: CommitResult }>> {
  try {
    const result = await request<CommitResult>(`/api/rooms/${encodeURIComponent(roomId)}/commit`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    });
    return { ok: true, result };
  } catch (err) {
    return gitUnavailable(err);
  }
}

// ── Agents (v0.5) ─────────────────────────────────────────────────────────────
//
// The agent control-plane lives on the server: spawning an agent, relaying a
// human prompt into the ACP session, and resolving the approval gate are POSTs
// here. The *live* agent state (presence, run status, pending tool call) and the
// chat transcript flow back through the Yjs doc (getAgents / getAgentChat), NOT
// these calls — so the UI subscribes to the doc for reads and uses these only to
// issue commands.
//
// As with the git surface, these routes are wired by the integrator AFTER this
// slice merges. Every call therefore degrades to a structured "not ready" result
// on any non-200 (404 included) instead of throwing, so the room keeps working
// in isolation and the panel can show a friendly empty/disabled state.

/** Reuses the git degradation shape: a 404/network miss is a quiet "not ready". */
export type AgentResult<T> = GitResult<T>;

/**
 * Result for command calls with no payload (message send, approval decision):
 * either an ack or the same "unavailable" shape. We don't reuse
 * `GitResult<{}>` because its `{ ok: true } & T` intersection trips an empty
 * index-signature object; a plain union is cleaner here.
 */
export type AgentAck = { ok: true } | GitUnavailable;

/**
 * POST /api/rooms/:roomId/agent { kind } -> { agent: AgentState }.
 *
 * Adds an AI teammate to the room. Defaults to the built-in dependency-free
 * `mock` backend so the feature is demoable with no API key. The authoritative
 * agent then appears in getAgents(doc) over the realtime channel.
 */
export async function addAgent(
  roomId: string,
  // Omit `kind` to let the server pick its default (ICE_DEFAULT_AGENT_KIND, else 'mock').
  kind?: AgentBackendKind,
): Promise<AgentResult<{ agent: AgentState }>> {
  try {
    const { agent } = await request<{ agent: AgentState }>(
      `/api/rooms/${encodeURIComponent(roomId)}/agent`,
      { method: 'POST', body: JSON.stringify(kind ? { kind } : {}) },
    );
    return { ok: true, agent };
  } catch (err) {
    return gitUnavailable(err);
  }
}

/**
 * POST /api/rooms/:roomId/agent/message { text } -> { ok: true }.
 *
 * Relays a human prompt into the agent's ACP session. The message (and the
 * agent's streamed reply) are appended to getAgentChat(doc), so the caller does
 * NOT optimistically render — it just sends and lets the doc echo it back.
 *
 * `agentId` is forwarded when present so multi-agent rooms can address a
 * specific teammate; the server may also infer the sole/active agent.
 */
export async function sendAgentMessage(
  roomId: string,
  text: string,
  agentId?: string,
): Promise<AgentAck> {
  try {
    await request<unknown>(`/api/rooms/${encodeURIComponent(roomId)}/agent/message`, {
      method: 'POST',
      body: JSON.stringify(agentId ? { text, agentId } : { text }),
    });
    return { ok: true };
  } catch (err) {
    return gitUnavailable(err);
  }
}

/**
 * POST /api/rooms/:roomId/agent/approve { callId, decision } -> { ok: true }.
 *
 * Resolves the human approval gate for a pending (status 'awaiting-approval')
 * tool call: 'approve' lets the agent apply it, 'reject' interrupts it. The
 * resulting status change arrives via getAgents(doc).
 */
export async function decideApproval(
  roomId: string,
  callId: string,
  decision: ApprovalDecision,
  agentId?: string,
): Promise<AgentAck> {
  try {
    await request<unknown>(`/api/rooms/${encodeURIComponent(roomId)}/agent/approve`, {
      method: 'POST',
      body: JSON.stringify(agentId ? { callId, decision, agentId } : { callId, decision }),
    });
    return { ok: true };
  } catch (err) {
    return gitUnavailable(err);
  }
}

export { HttpError };
