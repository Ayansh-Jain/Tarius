/**
 * ICE shared protocol & domain vocabulary.
 *
 * This is the contract every part of ICE builds against (web ⇄ server ⇄ agents).
 * Types are introduced in the release where they first matter; forward-looking
 * ones are tagged with the release so we keep one shared vocabulary.
 *
 * See docs/ARCHITECTURE.md → "Yjs document model".
 */

// ── Identifiers ───────────────────────────────────────────────────────────────
export type RoomId = string;
export type ParticipantId = string;
export type AgentId = string;

// ── Participants & presence (v0.1) ────────────────────────────────────────────
export type ParticipantKind = 'human' | 'agent';

export interface Participant {
  id: ParticipantId;
  name: string;
  /** CSS color used for cursor/selection/attribution. */
  color: string;
  kind: ParticipantKind;
  /** Present when kind === 'agent'. */
  agentId?: AgentId;
}

/** A cursor/selection range within a file (CodeMirror offsets). */
export interface CursorState {
  filePath: string;
  anchor: number;
  head: number;
}

/** What each client publishes via the y-protocols awareness channel. */
export interface AwarenessState {
  participant: Participant;
  cursor?: CursorState;
}

// ── Rooms / workspaces (v0.1) ─────────────────────────────────────────────────
export interface Room {
  id: RoomId;
  name: string;
  createdAt: number;
}

/** Signed share-a-room-by-link token. No account required to join via link. */
export interface InviteLink {
  token: string;
  roomId: RoomId;
  createdBy: ParticipantId;
  expiresAt?: number;
}

// ── Auth (v0.1: email/password + invite links; OIDC at v1.0) ──────────────────
export interface UserAccount {
  id: string;
  email: string;
  displayName: string;
  // passwordHash lives server-side only and is never part of the wire type.
}

export interface Session {
  userId: string;
  token: string;
  expiresAt: number;
}

// ── File tree (v0.3 vocabulary) ───────────────────────────────────────────────
export type FileNodeKind = 'file' | 'dir';

export interface FileNode {
  path: string;
  kind: FileNodeKind;
}

// ── Edit attribution (v0.1 humans; v0.5 agents) ───────────────────────────────
/**
 * Every Yjs transaction is tagged with an origin so edits are attributable and
 * per-origin undoable. THE rule (docs/DECISIONS.md ADR-000/004): agents write
 * THROUGH the doc with an 'agent' origin — never the raw filesystem.
 */
export type EditOrigin =
  | { kind: 'human'; participantId: ParticipantId }
  | { kind: 'agent'; agentId: AgentId }
  | { kind: 'system' };

// ── Chat (v1.0 vocabulary) ────────────────────────────────────────────────────
export type ChatEmbed =
  | { type: 'code'; language?: string; code: string }
  | { type: 'fileRange'; path: string; from: number; to: number };

export interface ChatMessage {
  id: string;
  authorId: ParticipantId;
  body: string;
  createdAt: number;
  /** Thread root id; absent for top-level messages. */
  threadId?: string;
  embeds?: ChatEmbed[];
}

// ── Agent surface (v0.5+ vocabulary; the ACP↔Yjs boundary) ────────────────────
export type AgentRunStatus =
  | 'idle'
  | 'thinking'
  | 'editing'
  | 'awaiting-approval'
  | 'running-tool'
  | 'error';

export interface AgentState {
  agentId: AgentId;
  /** Backing ACP agent type, e.g. 'claude-code' | 'codex' | 'gemini'. */
  kind: string;
  displayName: string;
  color: string;
  status: AgentRunStatus;
}

/** A tool call an agent wants to make; destructive ones pass the approval gate. */
export interface AgentToolCall {
  id: string;
  agentId: AgentId;
  tool: string;
  args: unknown;
  requiresApproval: boolean;
  status: 'proposed' | 'approved' | 'rejected' | 'running' | 'done' | 'error';
}
