/**
 * Track the most recent *agent-authored* edit to the room's files (v0.5).
 *
 * THE agent law (ADR-004): agents write through the doc with an
 * `{ kind: 'agent', agentId }` transaction origin. So we can surface a live
 * "AI teammate is editing" / "last edited by …" indicator purely by watching
 * transaction origins on the doc — no extra channel, and it's automatically
 * correct because it's the same signal that makes agent edits attributable.
 *
 * We listen on the files map's deep changes and read `transaction.origin`. When
 * the origin is an agent, we record which file path(s) changed and a timestamp,
 * and flip a transient "editing" flag that decays after a short idle window
 * (per-line blame is intentionally out of scope until v1.5 — keep it light).
 */
import { useEffect, useState } from 'react';
import type * as Y from 'yjs';
import type { AgentId, EditOrigin } from '@ice/shared';
import { getFiles } from '@ice/shared';
import type { RoomConnection } from './connection.js';

export interface AgentEditInfo {
  agentId: AgentId;
  /** The file path the agent most recently touched (best-effort). */
  path: string | null;
  at: number;
  /** True for a brief window after the last agent edit (live "typing" feel). */
  active: boolean;
}

/** Narrow an unknown transaction origin to our agent EditOrigin. */
function agentOrigin(origin: unknown): Extract<EditOrigin, { kind: 'agent' }> | null {
  if (
    origin !== null &&
    typeof origin === 'object' &&
    (origin as { kind?: unknown }).kind === 'agent' &&
    typeof (origin as { agentId?: unknown }).agentId === 'string'
  ) {
    return origin as Extract<EditOrigin, { kind: 'agent' }>;
  }
  return null;
}

/** Idle window (ms) after which an agent is considered to have stopped editing. */
const ACTIVE_WINDOW_MS = 1500;

export function useAgentEdits(connection: RoomConnection): AgentEditInfo | null {
  const [info, setInfo] = useState<AgentEditInfo | null>(null);

  useEffect(() => {
    const doc = connection.doc;
    const files: Y.Map<Y.Text> = getFiles(doc);
    let decay: number | null = null;

    const handler = (events: Y.YEvent<Y.AbstractType<unknown>>[], txn: Y.Transaction): void => {
      const origin = agentOrigin(txn.origin);
      if (!origin) return;

      // Best-effort: the changed file path is the key of the touched Y.Text in
      // the files map (or the directly-mutated entry's key for nested events).
      let path: string | null = null;
      for (const ev of events) {
        if (ev.target === files && ev.keys && ev.keys.size > 0) {
          path = [...ev.keys.keys()][0] ?? null;
        } else if (ev.path.length > 0 && typeof ev.path[0] === 'string') {
          path = ev.path[0];
        }
        if (path) break;
      }

      setInfo({ agentId: origin.agentId, path, at: Date.now(), active: true });

      if (decay !== null) clearTimeout(decay);
      decay = window.setTimeout(() => {
        decay = null;
        setInfo((prev) => (prev ? { ...prev, active: false } : prev));
      }, ACTIVE_WINDOW_MS);
    };

    // observeDeep catches edits to any file's Y.Text (agents edit text, which is
    // nested under the files map), and gives us the originating transaction.
    files.observeDeep(handler);

    return () => {
      files.unobserveDeep(handler);
      if (decay !== null) clearTimeout(decay);
    };
  }, [connection]);

  return info;
}
