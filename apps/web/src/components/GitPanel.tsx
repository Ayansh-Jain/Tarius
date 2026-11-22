/**
 * GitPanel — the polished in-UI source-control surface (ICE v1.0 Slice C).
 *
 * Builds on the EXISTING v0.3 git endpoints (commit / branches / commits) via
 * the self-contained {@link ../lib/gitui} client (we don't touch the app-wide
 * api module, so slices never conflict). Sections, top to bottom:
 *
 *   1. Commit box  — a real message <textarea> + "Commit" button →
 *      POST /commit (server flushes the doc → working tree under the per-room
 *      lock, then commits). On success we refresh branches + history.
 *   2. Changes     — a "changed this session" list derived client-side from the
 *      Yjs files map: every path whose buffer was edited since mount / the last
 *      commit. The server is authoritative for true git status, but its diff
 *      surface isn't part of v0.3, so this gives a useful at-a-glance dirty view
 *      and we label it honestly. Committing clears it.
 *   3. Branches    — a switcher over BranchInfo (current marked); changing it
 *      re-pulls history for that branch.
 *   4. History     — commit log with subject, short hash, author, relative time.
 *
 * Degradation contract (the git routes are wired by the integrator AFTER this
 * slice merges): a 404 / unreachable server is EXPECTED in isolation — reads
 * resolve to a quiet "not ready" and we show "history appears once you commit"
 * rather than crashing. Only an explicit failed commit surfaces a real error.
 *
 * Self-contained: props are `{ roomId, connection }` (the room's RoomConnection
 * — its Y.Doc + provider), matching the other room panels.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BranchInfo, CommitInfo } from '@ice/shared';
import { getFiles } from '@ice/shared';
import type { RoomConnection } from '../lib/connection.js';
import { diffLines } from '../lib/diff.js';
import { getDiff, getStatus, type FileChange, type GitStatus } from '../lib/github.js';
import { DiffView } from './DiffView.js';
import { GithubSync } from './GithubSync.js';
import {
  commitRoom,
  fetchBranches,
  fetchCommits,
  firstLine,
  relativeTime,
  shortHash,
} from '../lib/gitui.js';

interface GitPanelProps {
  roomId: string;
  connection: RoomConnection;
}

type LoadState = 'idle' | 'loading' | 'ready' | 'not-ready' | 'error';
type Notice = { kind: 'ok' | 'err'; text: string } | null;

/**
 * A counter that ticks (debounced) whenever any file in the room is edited, so
 * the Changes list can re-ask the server what differs from the last commit.
 */
function useDocActivity(connection: RoomConnection): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const files = getFiles(connection.doc);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const handler = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setTick((t) => t + 1), 1200);
    };
    files.observeDeep(handler);
    return () => {
      if (timer) clearTimeout(timer);
      files.unobserveDeep(handler);
    };
  }, [connection]);
  return tick;
}

/** Leaf name of a path, for a compact changed-file row. */
function baseName(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

function dirName(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

export function GitPanel({ roomId, connection }: GitPanelProps): React.ReactElement {
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [selectedBranch, setSelectedBranch] = useState<string | null>(null);
  const [state, setState] = useState<LoadState>('idle');
  const [message, setMessage] = useState('');
  const [committing, setCommitting] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const activity = useDocActivity(connection);

  const loadStatus = useCallback(async (): Promise<void> => {
    try {
      setStatus(await getStatus(roomId));
    } catch {
      /* keep the last known status */
    }
  }, [roomId]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus, activity]);

  const dirty: FileChange[] = status?.changes ?? [];

  const refresh = useCallback(
    async (branch?: string): Promise<void> => {
      setState((s) => (s === 'ready' ? 'ready' : 'loading'));
      const [b, c] = await Promise.all([fetchBranches(roomId), fetchCommits(roomId, branch)]);

      if (!b.ok) {
        setBranches([]);
        if (c.ok) setCommits(c.commits);
        setState(b.notReady ? 'not-ready' : 'error');
        if (!b.notReady) setNotice({ kind: 'err', text: b.message });
        return;
      }

      setBranches(b.branches);
      setSelectedBranch((prev) => {
        if (prev && b.branches.some((x) => x.name === prev)) return prev;
        const current = b.branches.find((x) => x.isCurrent);
        return current?.name ?? b.branches[0]?.name ?? null;
      });

      if (c.ok) {
        setCommits(c.commits);
        setState('ready');
      } else {
        setCommits([]);
        setState(c.notReady ? 'ready' : 'error');
        if (!c.notReady) setNotice({ kind: 'err', text: c.message });
      }
    },
    [roomId],
  );

  // Load on mount / room change.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Re-pull history when the user picks a different branch (after first load).
  useEffect(() => {
    if (state === 'idle' || selectedBranch === null) return;
    let cancelled = false;
    void (async () => {
      const c = await fetchCommits(roomId, selectedBranch);
      if (cancelled) return;
      if (c.ok) setCommits(c.commits);
      else if (!c.notReady) setNotice({ kind: 'err', text: c.message });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBranch, roomId]);

  const handleCommit = useCallback(async (): Promise<void> => {
    const trimmed = message.trim();
    if (!trimmed) {
      setNotice({ kind: 'err', text: 'A commit needs a message.' });
      return;
    }
    setCommitting(true);
    setNotice(null);
    try {
      const res = await commitRoom(roomId, trimmed);
      if (res.ok) {
        const n = res.result.filesChanged;
        setNotice({
          kind: 'ok',
          text: `Committed ${n} file${n === 1 ? '' : 's'} → ${shortHash(res.result.hash)}`,
        });
        setMessage('');
        await Promise.all([refresh(selectedBranch ?? undefined), loadStatus()]);
      } else if (res.notReady) {
        setNotice({
          kind: 'err',
          text: "The git server isn't available yet — try again once it's wired up.",
        });
      } else {
        setNotice({ kind: 'err', text: res.message });
      }
    } finally {
      setCommitting(false);
    }
  }, [message, refresh, roomId, selectedBranch]);

  const currentBranch = useMemo(
    () => branches.find((b) => b.name === selectedBranch) ?? null,
    [branches, selectedBranch],
  );

  const canCommit = message.trim().length > 0 && !committing;
  const showEmptyHistory = commits.length === 0;

  // Focus the message box when the user starts a commit via keyboard elsewhere.
  const messageRef = useRef<HTMLTextAreaElement | null>(null);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex shrink-0 items-center justify-between px-3 pb-2 pt-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          Source Control
        </h2>
        <button
          type="button"
          onClick={() => void refresh(selectedBranch ?? undefined)}
          title="Refresh"
          aria-label="Refresh source control"
          className="flex h-6 w-6 items-center justify-center rounded text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-100"
        >
          <span className="text-[13px] leading-none">⟳</span>
        </button>
      </div>

      {/* ── GitHub ──────────────────────────────────────────────────────── */}
      <div className="shrink-0 px-3 pb-3">
        <GithubSync
          roomId={roomId}
          status={status}
          onNotice={setNotice}
          onChanged={async () => {
            await Promise.all([refresh(selectedBranch ?? undefined), loadStatus()]);
          }}
        />
      </div>

      {/* ── Commit box ──────────────────────────────────────────────────── */}
      <div className="shrink-0 space-y-2 px-3">
        <textarea
          ref={messageRef}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            // Cmd/Ctrl+Enter commits (matches editor conventions).
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              if (canCommit) void handleCommit();
            }
          }}
          rows={2}
          placeholder="Message (what changed & why)"
          className="w-full resize-none rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-[12px] leading-relaxed text-slate-100 outline-none placeholder:text-slate-600 focus:border-indigo-400"
        />
        <button
          type="button"
          onClick={() => void handleCommit()}
          disabled={!canCommit}
          className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-emerald-500 px-3 py-1.5 text-xs font-medium text-white shadow-sm transition-colors hover:bg-emerald-400 active:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-60"
          title="Flush the live doc to the working tree and commit"
        >
          {committing ? 'Committing…' : 'Commit'}
          {currentBranch && !committing && (
            <span className="font-mono text-[10px] opacity-80">({currentBranch.name})</span>
          )}
        </button>

        {/* Branch switcher */}
        {branches.length > 0 && (
          <label className="flex items-center gap-2 text-[11px] text-slate-400">
            <span className="shrink-0">Branch</span>
            <select
              value={selectedBranch ?? ''}
              onChange={(e) => setSelectedBranch(e.target.value || null)}
              className="min-w-0 flex-1 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[12px] text-slate-200 outline-none focus:border-indigo-400"
            >
              {branches.map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name}
                  {b.isCurrent ? ' (current)' : ''}
                </option>
              ))}
            </select>
          </label>
        )}

        {notice && (
          <p
            role="status"
            className={`rounded px-2 py-1 text-[11px] ${
              notice.kind === 'ok'
                ? 'bg-emerald-500/10 text-emerald-300'
                : 'bg-rose-500/10 text-rose-300'
            }`}
          >
            {notice.text}
          </p>
        )}
      </div>

      {/* ── Changes (vs the last commit) ────────────────────────────────── */}
      {dirty.length > 0 && (
        <div className="mt-3 flex max-h-[45%] shrink-0 flex-col border-t border-slate-800/80 pt-2">
          <div className="flex items-center justify-between px-3 pb-1">
            <h3 className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Changes</h3>
            <span className="rounded-full bg-amber-500/15 px-1.5 text-[10px] font-medium text-amber-300">
              {dirty.length}
            </span>
          </div>
          <ul className="min-h-0 space-y-0.5 overflow-y-auto px-1.5 pb-1">
            {dirty.map((c) => (
              <ChangeRow key={c.path} roomId={roomId} change={c} tick={activity} />
            ))}
          </ul>
        </div>
      )}

      {/* ── History ─────────────────────────────────────────────────────── */}
      <div className="mt-3 flex min-h-0 flex-1 flex-col border-t border-slate-800/80">
        <h3 className="shrink-0 px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          History
        </h3>
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
          {state === 'loading' && commits.length === 0 ? (
            <p className="px-2 py-3 text-[11px] text-slate-500">Loading history…</p>
          ) : showEmptyHistory ? (
            <p className="px-2 py-3 text-[11px] leading-relaxed text-slate-500">
              {state === 'error'
                ? 'Could not load history.'
                : 'No commits yet — history appears here once you commit.'}
            </p>
          ) : (
            <ul className="space-y-0.5">
              {commits.map((c, i) => (
                <li
                  key={c.hash}
                  className="relative rounded px-2 py-1.5 transition-colors hover:bg-slate-800/60"
                  title={`${c.hash}\n${c.author} <${c.email}>\n${c.message}`}
                >
                  <p className="truncate text-[12px] text-slate-200">{firstLine(c.message)}</p>
                  <p className="mt-0.5 flex items-center gap-1.5 text-[10px] text-slate-500">
                    <span className="rounded bg-slate-800 px-1 font-mono text-slate-400">
                      {shortHash(c.hash)}
                    </span>
                    {i === 0 && (
                      <span className="rounded bg-indigo-500/15 px-1 font-medium text-indigo-300">
                        latest
                      </span>
                    )}
                    <span aria-hidden>·</span>
                    <span className="truncate">{c.author}</span>
                    <span aria-hidden>·</span>
                    <span className="shrink-0">{relativeTime(c.when)}</span>
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

const STATUS_STYLE: Record<FileChange['status'], { label: string; cls: string; title: string }> = {
  M: { label: 'M', cls: 'bg-amber-500/15 text-amber-400', title: 'Modified' },
  A: { label: 'A', cls: 'bg-emerald-500/15 text-emerald-400', title: 'Added' },
  D: { label: 'D', cls: 'bg-rose-500/15 text-rose-400', title: 'Deleted' },
};

/** One changed file; click to expand the line-by-line diff against the last commit. */
function ChangeRow({ roomId, change, tick }: { roomId: string; change: FileChange; tick: number }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<ReturnType<typeof diffLines> | null>(null);
  const st = STATUS_STYLE[change.status];

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void getDiff(roomId, change.path)
      .then((v) => {
        if (!cancelled) setRows(diffLines(v.before ?? '', v.after ?? ''));
      })
      .catch(() => {
        if (!cancelled) setRows(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, roomId, change.path, change.status, tick]);

  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title={change.path}
        className="flex w-full items-center gap-2 rounded px-2 py-1 text-left transition-colors hover:bg-slate-800/60"
      >
        <span
          className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm font-mono text-[10px] font-bold ${st.cls}`}
          title={st.title}
        >
          {st.label}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-slate-200">
          {baseName(change.path)}
          {dirName(change.path) && <span className="ml-1.5 text-[10px] text-slate-500">{dirName(change.path)}</span>}
        </span>
      </button>
      {open && (
        <div className="mx-1 mb-1 overflow-hidden rounded-md border border-slate-800 bg-slate-950">
          {rows ? (
            rows.hunks === 0 ? (
              <p className="px-2.5 py-2 text-[11px] text-slate-500">No line changes.</p>
            ) : (
              <DiffView rows={rows.rows} />
            )
          ) : (
            <p className="px-2.5 py-2 text-[11px] text-slate-500">Loading…</p>
          )}
        </div>
      )}
    </li>
  );
}
