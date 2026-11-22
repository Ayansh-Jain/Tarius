/**
 * Shared per-room live Y.Doc handles (v0.5 wiring).
 *
 * Agents (Slice A) and the shared terminal (Slice B) both need a room's LIVE
 * Y.Doc to stay loaded and synced for as long as they're active — not a
 * transient open/close like the /commit route. This module keeps one Hocuspocus
 * `openDirectConnection` per room alive and hands out its `.document`, so agent
 * edits and terminal output stream to every `/sync` client.
 *
 * Connections are released on shutdown (closeAllRoomDocs) or explicitly.
 */
import type * as Y from 'yjs';
import { getHocuspocus } from './realtime.js';

type RoomDocConnection = Awaited<ReturnType<ReturnType<typeof getHocuspocus>['openDirectConnection']>>;

const conns = new Map<string, RoomDocConnection>();
const pending = new Map<string, Promise<RoomDocConnection>>();

/** Get the room's live Y.Doc, opening (and caching) a direct connection if needed. */
export async function getRoomDoc(roomId: string): Promise<Y.Doc | null> {
  const existing = conns.get(roomId);
  if (existing) return existing.document ?? null;

  let p = pending.get(roomId);
  if (!p) {
    p = getHocuspocus().openDirectConnection(roomId);
    pending.set(roomId, p);
    p.then(
      (c) => {
        conns.set(roomId, c);
        pending.delete(roomId);
      },
      () => pending.delete(roomId),
    );
  }
  const conn = await p;
  return conn.document ?? null;
}

/** Release one room's live-doc handle (e.g. when its last agent/terminal stops). */
export async function releaseRoomDoc(roomId: string): Promise<void> {
  const c = conns.get(roomId);
  if (!c) return;
  conns.delete(roomId);
  await c.disconnect();
}

/** Disconnect every held room-doc handle — call on server shutdown. */
export async function closeAllRoomDocs(): Promise<void> {
  const all = [...conns.values()];
  conns.clear();
  await Promise.all(all.map((c) => c.disconnect().catch(() => undefined)));
}
