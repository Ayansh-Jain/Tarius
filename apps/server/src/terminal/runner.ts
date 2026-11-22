/**
 * Terminal runner + room registry (v0.5, Slice B).
 *
 * `createTerminalRunner` is the object the DRIVER builds once and injects into
 * the agent runtime (Slice A) and, optionally, a human REST route. It owns the
 * map of live per-room terminals and satisfies the {@link TerminalRunner}
 * contract Slice A depends on: `runCommand(roomId, cmd)` looks up (or lazily
 * creates) that room's shared terminal and runs the command there.
 *
 * Doc resolution is INJECTED, not imported, so this slice doesn't depend on the
 * realtime/Hocuspocus internals (decoupling per the integration model). The
 * driver passes a `resolveDoc(roomId) => Y.Doc` — typically backed by
 * `getHocuspocus().openDirectConnection(roomId).document` — and an optional
 * `release(roomId)` for connection cleanup on dispose.
 */
import type * as Y from 'yjs';
import type { RoomTerminal, TerminalOptions, TerminalRunner } from './types.js';
import { createRoomTerminal } from './room-terminal.js';
import { roomWorkspaceDir } from './workspace.js';

/**
 * How the runner obtains a room's live Y.Doc. The driver supplies this so the
 * terminal slice stays ignorant of how docs are hosted.
 */
export interface TerminalRunnerDeps {
  /**
   * Resolve (or open) the live Y.Doc for a room. May be async — e.g. opening a
   * Hocuspocus direct connection. Returning null/undefined means the room is
   * unavailable and the runner will no-op for it.
   */
  resolveDoc(roomId: string): Y.Doc | null | undefined | Promise<Y.Doc | null | undefined>;
  /** Optional: called when a room terminal is disposed, to release the doc handle. */
  release?(roomId: string): void | Promise<void>;
  /** Default terminal options applied to every room (e.g. a shared cwd). */
  defaultOptions?: TerminalOptions;
}

/** The runner plus lifecycle controls the driver needs for shutdown/routes. */
export interface TerminalRunnerHandle extends TerminalRunner {
  /** Get (creating + spawning lazily inside) the shared terminal for a room. */
  getOrCreateTerminal(roomId: string): Promise<RoomTerminal | null>;
  /** The currently-live terminal for a room, if any (no creation). */
  getTerminal(roomId: string): RoomTerminal | undefined;
  /** Dispose one room's terminal and release its doc handle. */
  disposeRoom(roomId: string): Promise<void>;
  /** Dispose every terminal — call on server shutdown. */
  disposeAll(): Promise<void>;
}

export function createTerminalRunner(deps: TerminalRunnerDeps): TerminalRunnerHandle {
  const terminals = new Map<string, RoomTerminal>();
  // De-dupe concurrent creates for the same room (resolveDoc may be async).
  const pending = new Map<string, Promise<RoomTerminal | null>>();

  const getTerminal = (roomId: string): RoomTerminal | undefined => terminals.get(roomId);

  const getOrCreateTerminal = (roomId: string): Promise<RoomTerminal | null> => {
    const existing = terminals.get(roomId);
    if (existing) return Promise.resolve(existing);

    const inFlight = pending.get(roomId);
    if (inFlight) return inFlight;

    const create = (async (): Promise<RoomTerminal | null> => {
      try {
        const doc = await deps.resolveDoc(roomId);
        if (!doc) return null;
        // A second caller may have won the race while we awaited the doc.
        const raced = terminals.get(roomId);
        if (raced) return raced;
        const term = createRoomTerminal(roomId, doc, {
          ...deps.defaultOptions,
          workspaceDir: deps.defaultOptions?.workspaceDir ?? roomWorkspaceDir(roomId),
        });
        terminals.set(roomId, term);
        return term;
      } finally {
        pending.delete(roomId);
      }
    })();

    pending.set(roomId, create);
    return create;
  };

  const runCommand = async (roomId: string, cmd: string): Promise<void> => {
    const term = await getOrCreateTerminal(roomId);
    if (!term) return; // Room unavailable: no-op rather than throw.
    await term.runCommand(cmd);
  };

  const disposeRoom = async (roomId: string): Promise<void> => {
    const term = terminals.get(roomId);
    if (term) {
      term.dispose();
      terminals.delete(roomId);
    }
    if (deps.release) await deps.release(roomId);
  };

  const disposeAll = async (): Promise<void> => {
    const ids = [...terminals.keys()];
    await Promise.all(ids.map((id) => disposeRoom(id)));
  };

  return {
    runCommand,
    getOrCreateTerminal,
    getTerminal,
    disposeRoom,
    disposeAll,
  };
}
