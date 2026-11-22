/**
 * SnapshotBar — the opt-in "try it safely" control (v1.5).
 *
 * A snapshot lets an agent work on a throwaway branch instead of the live shared
 * tree, so the squad can attempt something risky without disturbing everyone
 * else's editing. You start one, watch the open snapshots, then either merge the
 * branch back into the room or discard it.
 *
 * Server contract (POST .../snapshot to open; .../merge, .../discard to resolve;
 * GET .../snapshots to list). The open list also flows through the doc in some
 * server layouts, but the authoritative read here is the GET — we poll it lightly
 * and refetch after every action. Like the rest of the squad surface, every call
 * degrades on 404/unreachable to a quiet "not ready" note, so the bar never
 * breaks the room when the snapshot endpoints aren't wired yet.
 *
 * Self-contained: props `{ roomId, connection, me? }`, matching the other room
 * panels. `connection` powers the agent roster (so we can show whose snapshot it
 * is, in their color); `me` is accepted for a uniform call site.
 */
import { Bot, GitBranch } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentSnapshot, Participant } from '@ice/shared';
import type { RoomConnection } from '../lib/connection.js';
import { useAgents } from '../lib/useAgents.js';
import type { AgentView } from '../lib/agentTypes.js';
import { initials, readableOn } from '../lib/color.js';
import {
  discardSnapshot,
  fetchSnapshots,
  mergeSnapshot,
  startSnapshot,
} from '../lib/squad.js';

interface SnapshotBarProps {
  roomId: string;
  connection: RoomConnection;
  me?: Participant;
}

type Notice = { kind: 'ok' | 'err' | 'info'; text: string } | null;

/** How often we refetch the open-snapshot list (cheap GET, degrades quietly). */
const POLL_MS = 5000;

/** Status → presentation for a snapshot chip. */
const SNAPSHOT_STATUS_META: Record<
  AgentSnapshot['status'],
  { label: string; dot: string; text: string }
> = {
  open: { label: 'Open', dot: 'bg-sky-400 animate-pulse', text: 'text-sky-300' },
  merged: { label: 'Merged', dot: 'bg-emerald-400', text: 'text-emerald-300' },
  discarded: { label: 'Discarded', dot: 'bg-slate-500', text: 'text-slate-400' },
};

export function SnapshotBar({ roomId, connection }: SnapshotBarProps): React.ReactElement {
  const agents = useAgents(connection);
  const agentById = useMemo(() => {
    const map = new Map<string, AgentView>();
    for (const a of agents) map.set(a.state.agentId, a);
    return map;
  }, [agents]);

  const [snapshots, setSnapshots] = useState<AgentSnapshot[]>([]);
  const [notReady, setNotReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  // Per-snapshot in-flight action so only the acted row shows a spinner.
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  // Keep the latest agent so a default snapshot can be scoped to "the" agent.
  const soleAgentId = agents.length === 1 ? agents[0]!.state.agentId : undefined;

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const res = await fetchSnapshots(roomId);
    if (!mounted.current) return;
    if (res.ok) {
      setSnapshots(res.snapshots);
      setNotReady(false);
    } else {
      // Quiet when not wired; only flip the "not ready" hint, never an error toast.
      setNotReady(res.notReady);
    }
    setLoading(false);
  }, [roomId]);

  // Initial load + light polling so merges/opens from elsewhere show up.
  useEffect(() => {
    setLoading(true);
    void refresh();
    const id = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  const handleStart = useCallback(async () => {
    setStarting(true);
    setNotice(null);
    try {
      const res = await startSnapshot(roomId, soleAgentId);
      if (res.ok) {
        setNotice({ kind: 'ok', text: 'Snapshot opened — the agent is on a safe branch.' });
        await refresh();
      } else if (res.notReady) {
        setNotice({ kind: 'err', text: 'Snapshots aren’t wired up yet — try again later.' });
      } else {
        setNotice({ kind: 'err', text: res.message });
      }
    } finally {
      setStarting(false);
    }
  }, [refresh, roomId, soleAgentId]);

  const resolve = useCallback(
    async (snapshot: AgentSnapshot, action: 'merge' | 'discard') => {
      setBusyId(snapshot.id);
      setNotice(null);
      try {
        const res =
          action === 'merge'
            ? await mergeSnapshot(roomId, snapshot.id)
            : await discardSnapshot(roomId, snapshot.id);
        if (res.ok) {
          setNotice({
            kind: 'info',
            text: action === 'merge' ? 'Snapshot merged into the room.' : 'Snapshot discarded.',
          });
          await refresh();
        } else if (res.notReady) {
          setNotice({ kind: 'err', text: 'The snapshot server isn’t available yet.' });
        } else {
          setNotice({ kind: 'err', text: res.message });
        }
      } finally {
        setBusyId(null);
      }
    },
    [refresh, roomId],
  );

  // Show open snapshots first; resolved ones (merged/discarded) fade below.
  const open = snapshots.filter((s) => s.status === 'open');
  const resolved = snapshots.filter((s) => s.status !== 'open');

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ── Header + start ──────────────────────────────────────────────── */}
      <div className="shrink-0 space-y-2 px-3 pb-2 pt-3">
        <div className="flex items-center justify-between">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Snapshots
          </h2>
          <span className="text-[10px] text-slate-500">{open.length} open</span>
        </div>

        <p className="text-[11px] leading-relaxed text-slate-500">
          Let an agent “try it safely” on a throwaway branch, then merge or discard.
        </p>

        <button
          type="button"
          onClick={() => void handleStart()}
          disabled={starting}
          className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-sky-500 px-3 py-1.5 text-xs font-medium text-white shadow-sm transition-colors hover:bg-sky-400 active:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <GitBranch size={14} aria-hidden />
          {starting ? 'Opening…' : 'Start a snapshot'}
        </button>

        {notice && (
          <p
            className={`rounded px-2 py-1 text-[11px] ${
              notice.kind === 'ok'
                ? 'bg-emerald-500/10 text-emerald-300'
                : notice.kind === 'info'
                  ? 'bg-sky-500/10 text-sky-300'
                  : 'bg-rose-500/10 text-rose-300'
            }`}
          >
            {notice.text}
          </p>
        )}
      </div>

      {/* ── Snapshot list ───────────────────────────────────────────────── */}
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto border-t border-slate-800/80 px-3 py-2">
        {loading ? (
          <p className="px-1 py-3 text-[11px] text-slate-500">Loading snapshots…</p>
        ) : open.length === 0 && resolved.length === 0 ? (
          <p className="px-1 py-3 text-[11px] leading-relaxed text-slate-500">
            {notReady
              ? 'Snapshots will appear here once the server’s snapshot endpoints are wired up.'
              : 'No snapshots yet. Start one above to let an agent experiment without touching the shared tree.'}
          </p>
        ) : (
          <>
            {open.map((s) => {
              const agent = agentById.get(s.agentId);
              const meta = SNAPSHOT_STATUS_META[s.status];
              const busy = busyId === s.id;
              return (
                <div
                  key={s.id}
                  className="rounded-md border border-sky-500/25 bg-sky-500/5 p-2.5"
                >
                  <div className="flex items-center gap-2">
                    {agent ? (
                      <span
                        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold"
                        style={{
                          backgroundColor: agent.state.color,
                          color: readableOn(agent.state.color),
                        }}
                        title={agent.state.displayName}
                      >
                        {initials(agent.state.displayName) || <Bot size={12} aria-hidden />}
                      </span>
                    ) : (
                      <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-700 text-slate-200">
                        <Bot size={13} aria-hidden />
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[12px] text-slate-100">
                        {agent?.state.displayName ?? 'Agent'}
                      </p>
                      <p
                        className="truncate font-mono text-[10px] text-slate-500"
                        title={`${s.branch} @ ${s.baseCommit}`}
                      >
                        {s.branch || s.id}
                      </p>
                    </div>
                    <span className={`inline-flex items-center gap-1 text-[10px] ${meta.text}`}>
                      <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
                      {meta.label}
                    </span>
                  </div>

                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      onClick={() => void resolve(s, 'merge')}
                      disabled={busy}
                      className="inline-flex flex-1 items-center justify-center rounded-md bg-emerald-500 px-2 py-1 text-[11px] font-medium text-white transition-colors hover:bg-emerald-400 active:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {busy ? '…' : 'Merge'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void resolve(s, 'discard')}
                      disabled={busy}
                      className="inline-flex flex-1 items-center justify-center rounded-md border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-[11px] font-medium text-rose-200 transition-colors hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {busy ? '…' : 'Discard'}
                    </button>
                  </div>
                </div>
              );
            })}

            {resolved.length > 0 && (
              <div className="space-y-1 pt-1">
                <h3 className="px-1 text-[10px] font-semibold uppercase tracking-wider text-slate-600">
                  Resolved
                </h3>
                {resolved.map((s) => {
                  const agent = agentById.get(s.agentId);
                  const meta = SNAPSHOT_STATUS_META[s.status];
                  return (
                    <div
                      key={s.id}
                      className="flex items-center gap-2 rounded-md bg-slate-800/30 px-2 py-1.5 opacity-70"
                    >
                      <span
                        className="h-5 w-1 shrink-0 rounded-full"
                        style={{ backgroundColor: agent?.state.color ?? '#475569' }}
                        aria-hidden
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-mono text-[10px] text-slate-400">
                          {s.branch || s.id}
                        </p>
                      </div>
                      <span className={`inline-flex items-center gap-1 text-[10px] ${meta.text}`}>
                        <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
                        {meta.label}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
