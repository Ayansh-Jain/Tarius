/**
 * Realtime room connection for ICE v0.1.
 *
 * One room ↔ one Yjs document (named by roomId) ↔ one HocuspocusProvider, per
 * the architectural law and the v0.1 WIRE CONTRACT. This module owns that
 * lifecycle and the awareness wiring, and exposes a small React hook so
 * components can render presence + connection status without touching Yjs
 * internals.
 *
 * Awareness shape (so it interops with y-codemirror.next AND our presence UI):
 *   - `user`        : { name, color, colorLight } — read by y-codemirror.next
 *                     to draw named remote carets/selections.
 *   - `participant` : the frozen {@link Participant} wire type — read by our
 *                     presence list (and, later, the server).
 *   - `cursor`      : OWNED by y-codemirror.next (Yjs relative positions). We
 *                     never write it ourselves.
 */
import { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import type { Awareness } from 'y-protocols/awareness';
import type { Participant } from '@ice/shared';

/** Coarse connection state surfaced in the UI. */
export type ConnectionStatus = 'connecting' | 'connected' | 'offline';

/** A peer currently present in the room (derived from awareness). */
export interface PresencePeer {
  clientId: number;
  participant: Participant;
  /** True for our own local entry. */
  isSelf: boolean;
}

/** What we publish under the awareness `user` field for y-codemirror.next. */
interface AwarenessUser {
  name: string;
  color: string;
  colorLight: string;
}

/** Build the websocket URL for the sync endpoint from the current origin. */
export function syncUrl(): string {
  // location.origin.replace(/^http/, 'ws') turns http→ws and https→wss.
  // The server mounts the Hocuspocus websocket at /sync (see WIRE CONTRACT).
  return `${window.location.origin.replace(/^http/, 'ws')}/sync`;
}

/** Lighten a hex color for selection backgrounds (caret highlight). */
function colorLightFor(color: string): string {
  // y-codemirror.next defaults to `${color}33`; we mirror that for a subtle
  // translucent selection that matches the caret.
  return `${color}33`;
}

/**
 * Owns the Y.Doc + provider + awareness for a single room. Construct once per
 * room mount; call {@link destroy} on unmount.
 */
export class RoomConnection {
  readonly roomId: string;
  readonly doc: Y.Doc;
  readonly provider: HocuspocusProvider;

  private statusListeners = new Set<(s: ConnectionStatus) => void>();
  private _status: ConnectionStatus = 'connecting';

  constructor(roomId: string, participant: Participant) {
    this.roomId = roomId;
    this.doc = new Y.Doc();

    this.provider = new HocuspocusProvider({
      url: syncUrl(),
      name: roomId,
      document: this.doc,
      onStatus: ({ status }) => {
        // WebSocketStatus: 'connecting' | 'connected' | 'disconnected'.
        this.setStatus(status === 'connected' ? 'connected' : status === 'connecting' ? 'connecting' : 'offline');
      },
      onConnect: () => this.setStatus('connected'),
      onDisconnect: () => this.setStatus('offline'),
      onClose: () => this.setStatus('offline'),
    });

    this.setLocalParticipant(participant);
  }

  get status(): ConnectionStatus {
    return this._status;
  }

  /** The awareness instance (always present: we let the provider create one). */
  get awareness(): Awareness | null {
    return this.provider.awareness;
  }

  private setStatus(next: ConnectionStatus): void {
    if (next === this._status) return;
    this._status = next;
    for (const fn of this.statusListeners) fn(next);
  }

  onStatus(fn: (s: ConnectionStatus) => void): () => void {
    this.statusListeners.add(fn);
    // Emit current value immediately so subscribers don't miss the first state.
    fn(this._status);
    return () => this.statusListeners.delete(fn);
  }

  /** Publish (or update) our local identity on the awareness channel. */
  setLocalParticipant(participant: Participant): void {
    const awareness = this.provider.awareness;
    if (!awareness) return;
    const user: AwarenessUser = {
      name: participant.name,
      color: participant.color,
      colorLight: colorLightFor(participant.color),
    };
    awareness.setLocalStateField('user', user);
    awareness.setLocalStateField('participant', participant);
  }

  /** Snapshot the currently-present peers from awareness state. */
  peers(): PresencePeer[] {
    const awareness = this.provider.awareness;
    if (!awareness) return [];
    const selfId = awareness.clientID;
    const out: PresencePeer[] = [];
    awareness.getStates().forEach((state, clientId) => {
      const participant = state?.participant as Participant | undefined;
      const user = state?.user as AwarenessUser | undefined;
      // Prefer the structured participant; fall back to the y-codemirror user
      // field so a peer is still listed even mid-handshake.
      const resolved: Participant | undefined = participant
        ? participant
        : user
          ? { id: `client-${clientId}`, name: user.name, color: user.color, kind: 'human' }
          : undefined;
      if (!resolved) return;
      out.push({ clientId, participant: resolved, isSelf: clientId === selfId });
    });
    // Stable order: self first, then by name.
    out.sort((a, b) => {
      if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
      return a.participant.name.localeCompare(b.participant.name);
    });
    return out;
  }

  /** Subscribe to awareness changes (presence list updates). */
  onPeersChange(fn: (peers: PresencePeer[]) => void): () => void {
    const awareness = this.provider.awareness;
    if (!awareness) return () => {};
    const handler = () => fn(this.peers());
    awareness.on('change', handler);
    handler();
    return () => awareness.off('change', handler);
  }

  destroy(): void {
    this.statusListeners.clear();
    // Tearing down the provider also clears our awareness state for peers.
    this.provider.destroy();
    this.doc.destroy();
  }
}

/**
 * React hook: create a {@link RoomConnection} for `roomId`/`participant`, track
 * status + presence, and tear it down on unmount or room/identity change.
 *
 * The connection is recreated when roomId or the participant *identity* changes;
 * a pure name/color edit updates awareness in place (cheaper, no reconnect).
 */
export interface UseRoomConnection {
  connection: RoomConnection;
  status: ConnectionStatus;
  peers: PresencePeer[];
}

export function useRoomConnection(roomId: string, participant: Participant): UseRoomConnection {
  // Identity of the connection: room + participant id. A pure name/color edit
  // does NOT change this (we push those via awareness without reconnecting).
  const key = `${roomId}::${participant.id}`;

  // Hold the live connection in a ref so it survives React 19 StrictMode's
  // mount→unmount→mount probe. We recreate only when `key` changes.
  const ref = useRef<{ key: string; conn: RoomConnection; pendingTeardown: number | null } | null>(
    null,
  );
  if (ref.current === null || ref.current.key !== key) {
    ref.current?.conn.destroy();
    ref.current = { key, conn: new RoomConnection(roomId, participant), pendingTeardown: null };
  }
  const entry = ref.current;
  const connection = entry.conn;

  const [status, setStatus] = useState<ConnectionStatus>(() => connection.status);
  const [peers, setPeers] = useState<PresencePeer[]>(() => connection.peers());

  useEffect(() => {
    // A real remount (StrictMode's second mount) cancels any teardown the
    // previous unmount scheduled — we keep the same socket + awareness.
    if (entry.pendingTeardown !== null) {
      clearTimeout(entry.pendingTeardown);
      entry.pendingTeardown = null;
    }

    // Re-sync React state with the (possibly advanced) connection.
    setStatus(connection.status);
    setPeers(connection.peers());

    const offStatus = connection.onStatus(setStatus);
    const offPeers = connection.onPeersChange(setPeers);

    return () => {
      offStatus();
      offPeers();
      // Defer destruction past the synchronous StrictMode remount. If no
      // remount cancels this, it's a real unmount and we tear the socket down.
      entry.pendingTeardown = window.setTimeout(() => {
        entry.pendingTeardown = null;
        if (ref.current === entry) ref.current = null;
        connection.destroy();
      }, 0);
    };
  }, [connection, entry]);

  // Live-update name/color without reconnecting when they change in place.
  useEffect(() => {
    connection.setLocalParticipant(participant);
  }, [connection, participant.name, participant.color, participant]);

  return { connection, status, peers };
}
