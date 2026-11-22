/**
 * Per-room async mutex — the LOCK behind the architectural law (ADR-000).
 *
 * The filesystem working tree is PROJECTED from the Yjs doc on an explicit
 * flush, and git commits are taken from that flushed tree. If two flushes (or a
 * flush and a push) ran concurrently for the same room they could interleave
 * file writes and `git add`/`commit` steps and produce a corrupt commit — the
 * "collaborative IDE that loses your code" failure we must never have.
 *
 * So every mutation of a room's working tree + bare repo runs inside this lock.
 * It is a fair (FIFO) async mutex: `withRoomLock(roomId, fn)` serialises all
 * callers for the same `roomId` while letting different rooms run in parallel.
 *
 * The lock is process-local. v0.3 runs one server process per deployment (the
 * Hocuspocus instance owns each room), so a single in-memory mutex is the right
 * scope; cross-process locking would be a later concern if rooms are sharded.
 */

/** One room's lock state: the tail of a promise chain callers await in turn. */
type RoomLock = {
  /** Resolves when the currently-held critical section finishes. */
  tail: Promise<void>;
  /** How many callers are queued or running; used to GC idle locks. */
  waiters: number;
};

const locks = new Map<string, RoomLock>();

/**
 * Run `fn` while holding the exclusive lock for `roomId`. Callers for the same
 * room are serialised in arrival order (FIFO); the lock is always released even
 * if `fn` throws or rejects. The resolved/rejected value of `fn` is propagated.
 */
export async function withRoomLock<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
  const lock: RoomLock = locks.get(roomId) ?? { tail: Promise.resolve(), waiters: 0 };
  locks.set(roomId, lock);
  lock.waiters += 1;

  // Chain onto the existing tail: we only start once every earlier critical
  // section for this room has settled. `.catch(() => {})` keeps a prior failure
  // from rejecting our wait — each caller's own errors surface via its own run.
  const previous = lock.tail;

  // A promise we resolve when WE are done, which becomes the next tail link.
  let releaseHeld!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseHeld = resolve;
  });
  lock.tail = held;

  try {
    await previous.catch(() => {});
    return await fn();
  } finally {
    lock.waiters -= 1;
    releaseHeld();
    // GC: when nobody is queued and our link is the current tail, drop the
    // entry so the map doesn't grow unbounded across many short-lived rooms.
    if (lock.waiters === 0 && locks.get(roomId) === lock && lock.tail === held) {
      locks.delete(roomId);
    }
  }
}

/** Test/diagnostic helper: how many lock entries are currently live. */
export function activeRoomLockCount(): number {
  return locks.size;
}
