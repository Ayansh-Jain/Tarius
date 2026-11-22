/**
 * Source Control panel — the git surface for a room (v0.3 "Git comes home").
 *
 * - Commit: prompts for a message and POSTs /api/rooms/:id/commit, which makes
 *   the server flush the Yjs doc → working tree (under the per-room lock) and
 *   take a git commit. On success we refresh branches + history.
 * - Branch dropdown + commit history: fetched from /branches and /commits and
 *   rendered from the frozen BranchInfo / CommitInfo shapes.
 *
 * The git endpoints are wired by the integrator AFTER this slice merges, so a
 * 404 / unreachable server is EXPECTED in isolation: we show "history will
 * appear once committed" instead of crashing. Only an explicit failed commit
 * surfaces a real error to the user.
 */
import { useCallback, useEffect, useState } from 'react';
import type { BranchInfo, CommitInfo } from '@ice/shared';
import { commitRoom, listBranches, listCommits } from '../lib/api.js';

interface SourceControlProps {
  roomId: string;
}

type LoadState = 'idle' | 'loading' | 'ready' | 'not-ready' | 'error';

/** Relative "3m ago" style timestamp; falls back to a locale date. */
function relativeTime(when: number): string {
  const diff = Date.now() - when;
  if (!Number.isFinite(diff)) return '';
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${Math.max(sec, 0)}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(when).toLocaleDateString();
}

export function SourceControl({ roomId }: SourceControlProps): React.ReactElement {
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [selectedBranch, setSelectedBranch] = useState<string | null>(null);
  const [state, setState] = useState<LoadState>('idle');
  const [committing, setCommitting] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const refresh = useCallback(
    async (branch?: string): Promise<void> => {
      setState((s) => (s === 'ready' ? 'ready' : 'loading'));
      const [b, c] = await Promise.all([listBranches(roomId), listCommits(roomId, branch)]);

      // If branches isn't wired yet, the whole panel is "not ready".
      if (!b.ok) {
        setBranches([]);
        if (c.ok) setCommits(c.commits);
        setState(b.notReady ? 'not-ready' : 'error');
        if (!b.notReady) setNotice({ kind: 'err', text: b.message });
        return;
      }

      setBranches(b.branches);
      // Track the current branch unless the user already chose one.
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

  // Re-pull history when the selected branch changes (after first load).
  useEffect(() => {
    if (state === 'idle' || selectedBranch === null) return;
    let cancelled = false;
    void (async () => {
      const c = await listCommits(roomId, selectedBranch);
      if (cancelled) return;
      if (c.ok) setCommits(c.commits);
      else if (!c.notReady) setNotice({ kind: 'err', text: c.message });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBranch, roomId]);

  async function handleCommit(): Promise<void> {
    setNotice(null);
    const message = window.prompt('Commit message:', '');
    if (message === null) return; // cancelled
    const trimmed = message.trim();
    if (!trimmed) {
      setNotice({ kind: 'err', text: 'A commit needs a message.' });
      return;
    }
    setCommitting(true);
    try {
      const res = await commitRoom(roomId, trimmed);
      if (res.ok) {
        setNotice({
          kind: 'ok',
          text: `Committed ${res.result.filesChanged} file${res.result.filesChanged === 1 ? '' : 's'} → ${res.result.hash.slice(0, 7)}`,
        });
        await refresh(selectedBranch ?? undefined);
      } else if (res.notReady) {
        setNotice({
          kind: 'err',
          text: 'The git server isn’t available yet — try again once it’s wired up.',
        });
      } else {
        setNotice({ kind: 'err', text: res.message });
      }
    } finally {
      setCommitting(false);
    }
  }

  const showEmptyHistory = commits.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between px-3 pb-2 pt-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          Source Control
        </h2>
        <button
          type="button"
          onClick={() => void refresh(selectedBranch ?? undefined)}
          title="Refresh"
          className="flex h-6 w-6 items-center justify-center rounded text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-100"
        >
          <span className="text-[13px] leading-none">⟳</span>
        </button>
      </div>

      <div className="space-y-2 px-3">
        <button
          type="button"
          onClick={() => void handleCommit()}
          disabled={committing}
          className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-emerald-500 px-3 py-1.5 text-xs font-medium text-white shadow-sm transition-colors hover:bg-emerald-400 active:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {committing ? 'Committing…' : 'Commit all changes'}
        </button>

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

      <div className="mt-3 flex min-h-0 flex-1 flex-col">
        <h3 className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          History
        </h3>
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
          {state === 'loading' && commits.length === 0 ? (
            <p className="px-2 py-3 text-[11px] text-slate-500">Loading history…</p>
          ) : showEmptyHistory ? (
            <p className="px-2 py-3 text-[11px] leading-relaxed text-slate-500">
              {state === 'error'
                ? 'Could not load history.'
                : 'No commits yet — history will appear once you commit.'}
            </p>
          ) : (
            <ul className="space-y-0.5">
              {commits.map((c) => (
                <li
                  key={c.hash}
                  className="rounded px-2 py-1.5 transition-colors hover:bg-slate-800/60"
                  title={`${c.hash}\n${c.author} <${c.email}>`}
                >
                  <p className="truncate text-[12px] text-slate-200">
                    {firstLine(c.message)}
                  </p>
                  <p className="flex items-center gap-1.5 text-[10px] text-slate-500">
                    <span className="font-mono">{c.hash.slice(0, 7)}</span>
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

function firstLine(message: string): string {
  const nl = message.indexOf('\n');
  return nl === -1 ? message : message.slice(0, nl);
}
