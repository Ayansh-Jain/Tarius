/**
 * RollbackBar — checkpoint / one-click rollback of an agent's changes (ICE v1.0
 * Slice C).
 *
 * THE agent law (ADR-004): agents write THROUGH the shared doc with an
 * `{ kind: 'agent', agentId }` transaction origin, never the raw filesystem.
 * Because every edit is origin-tagged, a per-origin `Y.UndoManager` can reverse
 * exactly the agent's edits and nothing the humans typed — the same signal that
 * makes agent edits attributable also makes them precisely undoable.
 *
 * Two affordances, two scoped managers over the room's files map:
 *
 *   1. "Undo agent's last change" — a UndoManager that captures ONLY agent
 *      transactions. We open the origin gate to plain-object origins (agent
 *      origins are plain `{kind,agentId}` objects, so their `.constructor` is
 *      `Object`) and then narrow with `captureTransaction` to keep agent-only
 *      edits. `captureTimeout: 0` makes each agent edit its own checkpoint, so
 *      one click rolls back the single most recent agent change. We label it
 *      with WHOSE change would be undone (resolved against the live roster).
 *
 *   2. "Undo last change" — a generic manager capturing any attributable edit
 *      (human or agent EditOrigin). A safety net for the room. It never touches
 *      the editor's own local-typing undo because it only tracks our tagged
 *      origins.
 *
 * Undo is a normal Yjs op: it produces a new transaction that other peers (and
 * the agent) see live, so a rollback is collaborative, not local-only.
 *
 * Self-contained: props are `{ roomId, connection }`, matching the other room
 * panels. (roomId isn't needed for the doc-local undo, but we accept it for a
 * uniform call site.)
 */
import { Undo2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import type { AgentId, EditOrigin, ParticipantId } from '@ice/shared';
import { getFiles } from '@ice/shared';
import type { RoomConnection } from '../lib/connection.js';
import { useAgents } from '../lib/useAgents.js';

interface RollbackBarProps {
  roomId: string;
  connection: RoomConnection;
}

/** Narrow an unknown transaction origin to the agent EditOrigin. */
function asAgentOrigin(origin: unknown): Extract<EditOrigin, { kind: 'agent' }> | null {
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

/** Narrow an unknown origin to any of OUR attributable EditOrigins. */
function asEditOrigin(origin: unknown): EditOrigin | null {
  if (origin === null || typeof origin !== 'object') return null;
  const kind = (origin as { kind?: unknown }).kind;
  if (kind === 'agent' && typeof (origin as { agentId?: unknown }).agentId === 'string') {
    return origin as EditOrigin;
  }
  if (kind === 'human' && typeof (origin as { participantId?: unknown }).participantId === 'string') {
    return origin as EditOrigin;
  }
  if (kind === 'system') return { kind: 'system' };
  return null;
}

/**
 * Structural view of a UndoManager `stack-item-added` / `-popped` event. yjs
 * doesn't export `StackItem` from its public index, so we model just the parts
 * we touch: the item's metadata map and the originating transaction origin.
 */
interface StackEvent {
  stackItem: { meta: Map<unknown, unknown> };
  origin: unknown;
}

/** A compact description of who authored the change at the top of a stack. */
type Attribution =
  | { kind: 'agent'; agentId: AgentId }
  | { kind: 'human'; participantId: ParticipantId }
  | { kind: 'system' }
  | null;

const META_ATTRIBUTION = 'ice:attribution';

/**
 * Own a pair of UndoManagers (agent-only + any-attributable) over the room's
 * files map, and expose their live "can undo / who's next" state to React.
 *
 * The managers are recreated whenever the connection changes. We stash the
 * authoring EditOrigin into each pushed StackItem's `meta`, then surface the top
 * item's attribution so the UI can say *whose* change a click would reverse.
 */
function useScopedUndo(connection: RoomConnection): {
  agentCanUndo: boolean;
  agentNext: Attribution;
  agentDepth: number;
  anyCanUndo: boolean;
  anyNext: Attribution;
  undoAgent: () => Attribution;
  undoAny: () => Attribution;
} {
  const [agentCanUndo, setAgentCanUndo] = useState(false);
  const [agentNext, setAgentNext] = useState<Attribution>(null);
  const [agentDepth, setAgentDepth] = useState(0);
  const [anyCanUndo, setAnyCanUndo] = useState(false);
  const [anyNext, setAnyNext] = useState<Attribution>(null);

  const agentMgrRef = useRef<Y.UndoManager | null>(null);
  const anyMgrRef = useRef<Y.UndoManager | null>(null);

  useEffect(() => {
    const doc = connection.doc;
    const files = getFiles(doc);

    // ── Agent-only manager ──────────────────────────────────────────────
    // Open the origin gate to plain-object origins (Object covers our agent
    // origin literal), then keep ONLY agent transactions via captureTransaction.
    // captureTimeout: 0 → each agent edit is a discrete, individually-undoable
    // checkpoint.
    const agentMgr = new Y.UndoManager(files, {
      trackedOrigins: new Set<unknown>([Object]),
      captureTransaction: (txn) => asAgentOrigin(txn.origin) !== null,
      captureTimeout: 0,
    });

    // ── Any-attributable manager ────────────────────────────────────────
    // Tracks human + agent + system edits (all plain-object EditOrigins). The
    // editor's own local typing (y-codemirror's origin) is NOT one of ours, so
    // this stays clear of the editor's undo and only reverses tagged edits.
    const anyMgr = new Y.UndoManager(files, {
      trackedOrigins: new Set<unknown>([Object]),
      captureTransaction: (txn) => asEditOrigin(txn.origin) !== null,
      captureTimeout: 0,
    });

    agentMgrRef.current = agentMgr;
    anyMgrRef.current = anyMgr;

    const topAttribution = (mgr: Y.UndoManager): Attribution => {
      const top = mgr.undoStack[mgr.undoStack.length - 1];
      if (!top) return null;
      return (top.meta.get(META_ATTRIBUTION) as Attribution) ?? null;
    };

    const syncAgent = (): void => {
      setAgentCanUndo(agentMgr.canUndo());
      setAgentDepth(agentMgr.undoStack.length);
      setAgentNext(topAttribution(agentMgr));
    };
    const syncAny = (): void => {
      setAnyCanUndo(anyMgr.canUndo());
      setAnyNext(topAttribution(anyMgr));
    };

    // Stamp the authoring origin onto each new stack item so we can name it.
    // `StackItem` isn't part of yjs's public type surface, so we accept the
    // event structurally (only its `meta` map matters to us).
    const onAgentAdded = (e: StackEvent): void => {
      const o = asAgentOrigin(e.origin);
      if (o) e.stackItem.meta.set(META_ATTRIBUTION, { kind: 'agent', agentId: o.agentId });
      syncAgent();
    };
    const onAnyAdded = (e: StackEvent): void => {
      const o = asEditOrigin(e.origin);
      if (o) {
        const attribution: Attribution =
          o.kind === 'agent'
            ? { kind: 'agent', agentId: o.agentId }
            : o.kind === 'human'
              ? { kind: 'human', participantId: o.participantId }
              : { kind: 'system' };
        e.stackItem.meta.set(META_ATTRIBUTION, attribution);
      }
      syncAny();
    };

    agentMgr.on('stack-item-added', onAgentAdded);
    agentMgr.on('stack-item-popped', syncAgent);
    agentMgr.on('stack-cleared', syncAgent);
    anyMgr.on('stack-item-added', onAnyAdded);
    anyMgr.on('stack-item-popped', syncAny);
    anyMgr.on('stack-cleared', syncAny);

    syncAgent();
    syncAny();

    return () => {
      agentMgr.destroy();
      anyMgr.destroy();
      agentMgrRef.current = null;
      anyMgrRef.current = null;
    };
  }, [connection]);

  const undoAgent = useCallback((): Attribution => {
    const mgr = agentMgrRef.current;
    if (!mgr || !mgr.canUndo()) return null;
    const top = mgr.undoStack[mgr.undoStack.length - 1];
    const who = (top?.meta.get(META_ATTRIBUTION) as Attribution) ?? null;
    mgr.undo();
    return who;
  }, []);

  const undoAny = useCallback((): Attribution => {
    const mgr = anyMgrRef.current;
    if (!mgr || !mgr.canUndo()) return null;
    const top = mgr.undoStack[mgr.undoStack.length - 1];
    const who = (top?.meta.get(META_ATTRIBUTION) as Attribution) ?? null;
    mgr.undo();
    return who;
  }, []);

  return {
    agentCanUndo,
    agentNext,
    agentDepth,
    anyCanUndo,
    anyNext,
    undoAgent,
    undoAny,
  };
}

export function RollbackBar({ connection }: RollbackBarProps): React.ReactElement {
  const agents = useAgents(connection);
  const { agentCanUndo, agentNext, agentDepth, anyCanUndo, anyNext, undoAgent, undoAny } =
    useScopedUndo(connection);

  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<number | null>(null);

  const showFlash = useCallback((text: string) => {
    setFlash(text);
    if (flashTimer.current !== null) clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => {
      flashTimer.current = null;
      setFlash(null);
    }, 2600);
  }, []);

  useEffect(
    () => () => {
      if (flashTimer.current !== null) clearTimeout(flashTimer.current);
    },
    [],
  );

  // Resolve an attribution to a display name + color via the live roster (for
  // agents) or a generic label (for humans/system — the human roster lives in
  // awareness/peers, but a clear "a teammate" label keeps this self-contained).
  const agentById = useMemo(() => {
    const map = new Map<string, (typeof agents)[number]>();
    for (const a of agents) map.set(a.state.agentId, a);
    return map;
  }, [agents]);

  const label = useCallback(
    (who: Attribution): { text: string; color: string | null } => {
      if (!who) return { text: 'No tracked changes yet', color: null };
      if (who.kind === 'agent') {
        const a = agentById.get(who.agentId);
        return {
          text: a ? a.state.displayName : 'AI teammate',
          color: a ? a.state.color : '#8b5cf6',
        };
      }
      if (who.kind === 'human') return { text: 'a teammate', color: null };
      return { text: 'the system', color: null };
    },
    [agentById],
  );

  const agentLabel = label(agentNext);
  const anyLabel = label(anyNext);

  const handleUndoAgent = useCallback(() => {
    const who = undoAgent();
    const l = label(who);
    showFlash(who ? `Rolled back ${l.text}'s change` : 'Nothing to roll back');
  }, [label, showFlash, undoAgent]);

  const handleUndoAny = useCallback(() => {
    const who = undoAny();
    const l = label(who);
    showFlash(who ? `Undid ${l.text}'s change` : 'Nothing to undo');
  }, [label, showFlash, undoAny]);

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-slate-800/80 bg-slate-900/40 p-2.5">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          <Undo2 size={13} aria-hidden />
          Checkpoint
        </h3>
        {agentDepth > 0 && (
          <span
            className="rounded-full bg-violet-500/15 px-1.5 text-[10px] font-medium text-violet-300"
            title={`${agentDepth} agent edit${agentDepth === 1 ? '' : 's'} can be rolled back`}
          >
            {agentDepth}
          </span>
        )}
      </div>

      {/* Primary: roll back the agent's most recent change. */}
      <button
        type="button"
        onClick={handleUndoAgent}
        disabled={!agentCanUndo}
        className="group flex w-full items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-left transition-colors hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:border-slate-700/60 disabled:bg-slate-800/40 disabled:opacity-60"
        title={
          agentCanUndo
            ? `Reverse the last edit made by ${agentLabel.text}`
            : 'No agent edits to roll back yet'
        }
      >
        <span
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[12px]"
          style={
            agentCanUndo && agentLabel.color
              ? { backgroundColor: `${agentLabel.color}22`, color: agentLabel.color }
              : { backgroundColor: 'rgb(30 41 59 / 0.6)', color: '#94a3b8' }
          }
          aria-hidden
        >
          ↩
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[12px] font-medium text-slate-100">Roll back agent edit</span>
          <span className="block truncate text-[10px] text-slate-400">
            {agentCanUndo ? (
              <>
                undo{' '}
                <span style={agentLabel.color ? { color: agentLabel.color } : undefined}>
                  {agentLabel.text}
                </span>
                ’s last change
              </>
            ) : (
              'no agent changes yet'
            )}
          </span>
        </span>
      </button>

      {/* Secondary: generic undo of the last attributable change. */}
      <button
        type="button"
        onClick={handleUndoAny}
        disabled={!anyCanUndo}
        className="flex w-full items-center gap-2 rounded-md px-2.5 py-1 text-left text-[11px] text-slate-400 transition-colors hover:bg-slate-800/60 hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
        title={anyCanUndo ? `Undo the last change by ${anyLabel.text}` : 'Nothing to undo'}
      >
        <span aria-hidden className="shrink-0 text-[12px]">
          ↺
        </span>
        <span className="min-w-0 flex-1 truncate">
          Undo last change
          {anyCanUndo && anyLabel.text ? <span className="text-slate-500"> · {anyLabel.text}</span> : null}
        </span>
      </button>

      {flash && (
        <p
          role="status"
          className="rounded bg-emerald-500/10 px-2 py-1 text-[10px] text-emerald-300"
        >
          {flash}
        </p>
      )}
    </div>
  );
}
