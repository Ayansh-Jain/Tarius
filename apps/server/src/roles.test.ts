/**
 * Per-workspace role tests (v1.0 Slice D — "Teams").
 *
 * The contract:
 *   • the room creator becomes `owner` (ensureOwner is idempotent),
 *   • members can be added without demoting the owner,
 *   • owner-only guards admit the owner and reject members / strangers,
 *   • member guards admit anyone with a role and reject strangers.
 *
 * Backed by the zero-dependency InMemoryRoleStore so this runs in CI with no
 * SQLite/Postgres. The SQLite + Postgres stores implement the same RoleStore
 * interface, so passing these against the in-memory store exercises the helpers
 * every backend shares.
 */
import { describe, it, expect } from 'vitest';
import {
  InMemoryRoleStore,
  assignRole,
  ensureOwner,
  getRole,
  isMember,
  isOwner,
  listRoles,
  requireMember,
  requireOwner,
} from './roles.js';

describe('workspace roles', () => {
  it('makes the room creator the owner', async () => {
    const store = new InMemoryRoleStore();
    await ensureOwner(store, 'room1', 'user_creator');

    expect(await getRole(store, 'room1', 'user_creator')).toBe('owner');
    expect(await isOwner(store, 'room1', 'user_creator')).toBe(true);
    expect(await isMember(store, 'room1', 'user_creator')).toBe(true);
  });

  it('ensureOwner is idempotent and never demotes the owner', async () => {
    const store = new InMemoryRoleStore();
    await ensureOwner(store, 'room1', 'user_creator');
    await ensureOwner(store, 'room1', 'user_creator');

    const roles = await listRoles(store, 'room1');
    expect(roles).toEqual([{ participantId: 'user_creator', role: 'owner' }]);
  });

  it('adds members without affecting the owner', async () => {
    const store = new InMemoryRoleStore();
    await ensureOwner(store, 'room1', 'owner1');
    await assignRole(store, 'room1', 'member1', 'member');
    await assignRole(store, 'room1', 'member2', 'member');

    expect(await isOwner(store, 'room1', 'member1')).toBe(false);
    expect(await isMember(store, 'room1', 'member1')).toBe(true);
    expect(await isMember(store, 'room1', 'member2')).toBe(true);

    const roles = await listRoles(store, 'room1');
    expect(roles).toHaveLength(3);
    expect(roles.filter((r) => r.role === 'owner')).toHaveLength(1);
  });

  it('does NOT demote an owner when the join path assigns member', async () => {
    const store = new InMemoryRoleStore();
    await ensureOwner(store, 'room1', 'owner1');
    // The room-access route blindly assigns 'member' on every join.
    await assignRole(store, 'room1', 'owner1', 'member');

    expect(await isOwner(store, 'room1', 'owner1')).toBe(true);
    expect(await getRole(store, 'room1', 'owner1')).toBe('owner');
  });

  it('can promote a member to owner', async () => {
    const store = new InMemoryRoleStore();
    await ensureOwner(store, 'room1', 'owner1');
    await assignRole(store, 'room1', 'member1', 'member');
    await assignRole(store, 'room1', 'member1', 'owner');

    expect(await isOwner(store, 'room1', 'member1')).toBe(true);
    expect((await listRoles(store, 'room1')).filter((r) => r.role === 'owner')).toHaveLength(2);
  });

  it('requireOwner admits the owner and rejects members and strangers', async () => {
    const store = new InMemoryRoleStore();
    await ensureOwner(store, 'room1', 'owner1');
    await assignRole(store, 'room1', 'member1', 'member');

    const asOwner = await requireOwner(store, 'room1', 'owner1');
    expect(asOwner).toEqual({ ok: true, role: 'owner' });

    const asMember = await requireOwner(store, 'room1', 'member1');
    expect(asMember).toEqual({ ok: false, reason: 'not_owner' });

    const asStranger = await requireOwner(store, 'room1', 'nobody');
    expect(asStranger).toEqual({ ok: false, reason: 'not_member' });
  });

  it('requireMember admits owners and members, rejects strangers', async () => {
    const store = new InMemoryRoleStore();
    await ensureOwner(store, 'room1', 'owner1');
    await assignRole(store, 'room1', 'member1', 'member');

    expect(await requireMember(store, 'room1', 'owner1')).toEqual({ ok: true, role: 'owner' });
    expect(await requireMember(store, 'room1', 'member1')).toEqual({ ok: true, role: 'member' });
    expect(await requireMember(store, 'room1', 'ghost')).toEqual({
      ok: false,
      reason: 'not_member',
    });
  });

  it('removeRole revokes participation; unknown participants read as null', async () => {
    const store = new InMemoryRoleStore();
    await ensureOwner(store, 'room1', 'owner1');
    await assignRole(store, 'room1', 'member1', 'member');

    await store.removeRole('room1', 'member1');
    expect(await getRole(store, 'room1', 'member1')).toBeNull();
    expect(await isMember(store, 'room1', 'member1')).toBe(false);

    // Removing an absent participant is a no-op.
    await store.removeRole('room1', 'never_here');
    expect(await getRole(store, 'room1', 'never_here')).toBeNull();
  });

  it('keeps roles isolated per room', async () => {
    const store = new InMemoryRoleStore();
    await ensureOwner(store, 'roomA', 'alice');
    await ensureOwner(store, 'roomB', 'bob');
    await assignRole(store, 'roomA', 'bob', 'member');

    expect(await isOwner(store, 'roomA', 'alice')).toBe(true);
    expect(await isOwner(store, 'roomA', 'bob')).toBe(false);
    expect(await isMember(store, 'roomA', 'bob')).toBe(true);
    // Bob owns roomB; that doesn't leak into roomA.
    expect(await isOwner(store, 'roomB', 'bob')).toBe(true);
    expect(await isMember(store, 'roomB', 'alice')).toBe(false);
  });
});
