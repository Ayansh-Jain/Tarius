/**
 * ICE per-workspace roles (v1.0 Slice D — "Teams").
 *
 * A workspace (room) has exactly two roles, from `@ice/shared`'s
 * {@link WorkspaceRole}:
 *
 *   • owner  — the room creator; may manage members, rotate invites, delete the
 *              room. There is always at most-one canonical owner (the creator),
 *              though additional owners can be promoted.
 *   • member — anyone else who has joined; may participate (edit, chat, voice).
 *
 * Roles are intentionally tiny and storage-agnostic. They are *metadata* (who
 * may do what), NOT collaborative document state, so they live in the metadata
 * DB next to users/rooms/invites — never in the room's Y.Doc (which any client
 * can mutate). This module defines:
 *
 *   • {@link RoleStore} — the minimal persistence seam (assign / get / list /
 *     remove). Implemented by SQLite (db.ts), Postgres (db-postgres.ts), and the
 *     in-process {@link InMemoryRoleStore} used by tests and as a dev fallback.
 *   • A set of pure helper functions ({@link ensureOwner}, {@link assignRole},
 *     {@link getRole}, {@link isOwner}, {@link isMember}, {@link listRoles},
 *     {@link requireOwner}) that routes call. They take the store as their first
 *     argument so the HTTP layer can inject whichever backend is active.
 *
 * Wiring (done by the driver, NOT here — see wiringInstructions):
 *   - On room creation, call `await ensureOwner(store, roomId, creatorId)`.
 *   - On room join/access, call `await assignRole(store, roomId, pid, 'member')`
 *     (a no-op if they are already the owner).
 *   - Guard owner-only routes with `await requireOwner(store, roomId, pid)`.
 */
import type { ParticipantId, RoleAssignment, WorkspaceRole } from '@ice/shared';

/**
 * Persistence seam for role assignments. Async so a single interface fits both
 * the synchronous SQLite store and the connection-pooled Postgres store. All
 * methods are idempotent / safe to call repeatedly.
 */
export interface RoleStore {
  /** Upsert a participant's role in a room. Re-assigning overwrites the prior role. */
  setRole(roomId: string, participantId: ParticipantId, role: WorkspaceRole): Promise<void>;
  /** The participant's role, or `null` if they have no assignment in this room. */
  getRole(roomId: string, participantId: ParticipantId): Promise<WorkspaceRole | null>;
  /** Every assignment in a room. Order is unspecified. */
  listRoles(roomId: string): Promise<RoleAssignment[]>;
  /** Remove a participant's assignment. No-op if absent. */
  removeRole(roomId: string, participantId: ParticipantId): Promise<void>;
}

/**
 * Zero-dependency in-process {@link RoleStore}. Backed by a nested Map keyed by
 * `roomId → participantId → role`. Used directly by the role tests and as a
 * safe fallback when no durable metadata store is configured.
 *
 * Not shared across processes — for multi-instance deployments back roles with
 * the SQLite or Postgres store instead.
 */
export class InMemoryRoleStore implements RoleStore {
  private readonly byRoom = new Map<string, Map<ParticipantId, WorkspaceRole>>();

  setRole(roomId: string, participantId: ParticipantId, role: WorkspaceRole): Promise<void> {
    let room = this.byRoom.get(roomId);
    if (!room) {
      room = new Map();
      this.byRoom.set(roomId, room);
    }
    room.set(participantId, role);
    return Promise.resolve();
  }

  getRole(roomId: string, participantId: ParticipantId): Promise<WorkspaceRole | null> {
    return Promise.resolve(this.byRoom.get(roomId)?.get(participantId) ?? null);
  }

  listRoles(roomId: string): Promise<RoleAssignment[]> {
    const room = this.byRoom.get(roomId);
    if (!room) return Promise.resolve([]);
    return Promise.resolve(
      [...room.entries()].map(([participantId, role]) => ({ participantId, role })),
    );
  }

  removeRole(roomId: string, participantId: ParticipantId): Promise<void> {
    this.byRoom.get(roomId)?.delete(participantId);
    return Promise.resolve();
  }
}

// ── Helpers (routes call these) ───────────────────────────────────────────────

/**
 * Establish the room creator as `owner`. Idempotent: calling it again for the
 * same creator is a no-op, and it will *not* demote an existing owner. Call this
 * exactly once when a room is created.
 */
export async function ensureOwner(
  store: RoleStore,
  roomId: string,
  creatorId: ParticipantId,
): Promise<void> {
  const existing = await store.getRole(roomId, creatorId);
  if (existing === 'owner') return;
  await store.setRole(roomId, creatorId, 'owner');
}

/**
 * Assign a role, but never silently demote an owner. Assigning `'member'` to a
 * participant who is already `owner` is a no-op (so the join path can blindly
 * call `assignRole(store, roomId, pid, 'member')`). Promoting to `'owner'`
 * always applies.
 */
export async function assignRole(
  store: RoleStore,
  roomId: string,
  participantId: ParticipantId,
  role: WorkspaceRole,
): Promise<void> {
  if (role === 'member') {
    const current = await store.getRole(roomId, participantId);
    if (current === 'owner') return; // don't demote an owner via the join path
  }
  await store.setRole(roomId, participantId, role);
}

/** A participant's role in a room, or `null` if they have none. */
export function getRole(
  store: RoleStore,
  roomId: string,
  participantId: ParticipantId,
): Promise<WorkspaceRole | null> {
  return store.getRole(roomId, participantId);
}

/** All role assignments in a room. */
export function listRoles(store: RoleStore, roomId: string): Promise<RoleAssignment[]> {
  return store.listRoles(roomId);
}

/** True iff the participant is the (or an) owner of the room. */
export async function isOwner(
  store: RoleStore,
  roomId: string,
  participantId: ParticipantId,
): Promise<boolean> {
  return (await store.getRole(roomId, participantId)) === 'owner';
}

/**
 * True iff the participant may participate in the room — i.e. has *any* role
 * (owner or member). Use this for "are they on the team?" checks.
 */
export async function isMember(
  store: RoleStore,
  roomId: string,
  participantId: ParticipantId,
): Promise<boolean> {
  return (await store.getRole(roomId, participantId)) != null;
}

/** Result of an authorization check, suitable for mapping onto an HTTP status. */
export type RoleCheck =
  | { ok: true; role: WorkspaceRole }
  | { ok: false; reason: 'not_member' | 'not_owner' };

/**
 * Guard for owner-only actions. Returns a discriminated result the route can map
 * to `403` on `{ ok: false }`. Does not throw, so it composes cleanly in Hono
 * handlers:
 *
 *   const check = await requireOwner(store, roomId, pid);
 *   if (!check.ok) return c.json({ error: check.reason }, 403);
 */
export async function requireOwner(
  store: RoleStore,
  roomId: string,
  participantId: ParticipantId,
): Promise<RoleCheck> {
  const role = await store.getRole(roomId, participantId);
  if (role == null) return { ok: false, reason: 'not_member' };
  if (role !== 'owner') return { ok: false, reason: 'not_owner' };
  return { ok: true, role };
}

/**
 * Guard for member-or-owner actions (any team member). Returns the same
 * discriminated result shape as {@link requireOwner}.
 */
export async function requireMember(
  store: RoleStore,
  roomId: string,
  participantId: ParticipantId,
): Promise<RoleCheck> {
  const role = await store.getRole(roomId, participantId);
  if (role == null) return { ok: false, reason: 'not_member' };
  return { ok: true, role };
}
