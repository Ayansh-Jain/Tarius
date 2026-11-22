/**
 * Audit log of actions in a room — v2.0 "Scale out and integrate".
 *
 * Records who (human / agent / system) did what (edit, tool-call, commit,
 * snapshot-merge, orchestrate, …) so a self-hoster has an accountable trail —
 * especially for agent actions. Stored as a durable, multiplayer Y.Array
 * (getAudit) so the trail is visible live and survives restarts.
 */
import type { RoomId } from './protocol.js';

export type AuditActorKind = 'human' | 'agent' | 'system';

export interface AuditActor {
  kind: AuditActorKind;
  /** participantId for humans, agentId for agents. */
  id: string;
  /** Display name when known. */
  name?: string;
}

export interface AuditEntry {
  id: string;
  roomId: RoomId;
  actor: AuditActor;
  /** e.g. 'edit' | 'tool-call' | 'commit' | 'snapshot-merge' | 'orchestrate' | 'policy-set'. */
  action: string;
  /** Free-form detail (path, tool name, commit hash, …). */
  detail?: string;
  at: number;
}
