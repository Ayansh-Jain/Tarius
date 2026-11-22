/**
 * Communications & access vocabulary — v1.0 "Code with friends, out loud".
 *
 * Human comms (group + DM chat, voice) and per-workspace roles. Chat is
 * Yjs-backed (so it's durable + multiplayer like everything else); voice rides
 * LiveKit (the server only mints tokens — media never touches ICE).
 */
import type { ParticipantId } from './protocol.js';

/** A text channel in a workspace. A DM is a channel with kind 'dm'. */
export interface Channel {
  id: string;
  kind: 'group' | 'dm';
  name: string;
  /** For DMs: the participant ids in the conversation. */
  members?: ParticipantId[];
  createdAt: number;
}

/** Server response for joining a workspace's LiveKit voice room. */
export interface VoiceTokenResponse {
  /** LiveKit server ws URL the client connects to. */
  url: string;
  /** Short-lived access token (LiveKit JWT). */
  token: string;
  /** Room name (the workspace/roomId). */
  room: string;
  /** The participant identity inside the voice room. */
  identity: string;
}

/** Per-workspace role. Owner can manage; member can participate. */
export type WorkspaceRole = 'owner' | 'member';

export interface RoleAssignment {
  participantId: ParticipantId;
  role: WorkspaceRole;
}
