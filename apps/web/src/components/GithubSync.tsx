/**
 * GitHub connection + sync bar for the Source Control panel.
 *
 * Not connected: paste a personal access token, then either link an existing
 * repo (URL) or publish a new one. Connected: shows the repo, how many commits
 * are waiting to be pushed, and Push / Pull buttons. The token is sent once to
 * the server and never shown again.
 */
import { ArrowDown, ArrowUp, ExternalLink, GitBranch, Loader2, Unplug } from 'lucide-react';
import { useState } from 'react';
import {
  connectRemote,
  disconnectRemote,
  publishRepo,
  pullRoom,
  pushRoom,
  repoLabel,
  type GitStatus,
} from '../lib/github.js';

interface Props {
  roomId: string;
  status: GitStatus | null;
  /** Reload status/history after something changed. */
  onChanged: () => Promise<void> | void;
  onNotice: (n: { kind: 'ok' | 'err'; text: string }) => void;
}

const input =
  'w-full rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-[12px] text-slate-100 outline-none placeholder:text-slate-600 focus:border-indigo-400';

export function GithubSync({ roomId, status, onChanged, onNotice }: Props): React.ReactElement {
  const remote = status?.remote ?? null;
  const [busy, setBusy] = useState<null | 'connect' | 'push' | 'pull' | 'publish'>(null);
  const [token, setToken] = useState('');
  const [mode, setMode] = useState<'link' | 'new'>('new');
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [isPrivate, setIsPrivate] = useState(true);

  async function run(kind: NonNullable<typeof busy>, fn: () => Promise<string>): Promise<void> {
    setBusy(kind);
    try {
      onNotice({ kind: 'ok', text: await fn() });
      await onChanged();
    } catch (e) {
      onNotice({ kind: 'err', text: e instanceof Error ? e.message : 'Something went wrong.' });
    } finally {
      setBusy(null);
    }
  }

  const needsToken = !remote?.hasToken;
  const needsRepo = !remote?.url;

  async function submitConnect(): Promise<void> {
    await run('connect', async () => {
      if (needsToken && !token.trim()) throw new Error('Paste your GitHub token first.');
      let info = await connectRemote(roomId, token.trim() ? { token: token.trim() } : {});
      setToken('');
      if (needsRepo) {
        if (mode === 'link') {
          if (!url.trim()) throw new Error('Enter the repository URL.');
          info = await connectRemote(roomId, { url: url.trim() });
        } else {
          if (!name.trim()) throw new Error('Choose a repository name.');
          info = await publishRepo(roomId, { name: name.trim(), private: isPrivate });
        }
      }
      return `Connected to ${repoLabel(info.url)}${info.login ? ` as ${info.login}` : ''}.`;
    });
  }

  // ── Connected ──────────────────────────────────────────────────────────────
  if (remote && remote.url && remote.hasToken) {
    const ahead = status?.unpushed ?? 0;
    return (
      <div className="space-y-2 rounded-md border border-slate-800 bg-slate-900/60 p-2.5">
        <div className="flex items-center gap-2">
          <GitBranch size={14} className="shrink-0 text-slate-300" aria-hidden />
          <a
            href={remote.url.replace(/\.git$/, '')}
            target="_blank"
            rel="noreferrer"
            className="flex min-w-0 flex-1 items-center gap-1 truncate text-[12px] font-medium text-slate-100 hover:text-indigo-300"
            title={remote.url}
          >
            <span className="truncate">{repoLabel(remote.url)}</span>
            <ExternalLink size={11} className="shrink-0 text-slate-500" aria-hidden />
          </a>
          <button
            type="button"
            onClick={() => {
              if (window.confirm('Disconnect this room from GitHub? Your commits stay in the IDE.')) {
                void run('connect', async () => {
                  await disconnectRemote(roomId);
                  return 'Disconnected from GitHub.';
                });
              }
            }}
            title="Disconnect from GitHub"
            aria-label="Disconnect from GitHub"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-500 hover:bg-slate-800 hover:text-rose-300"
          >
            <Unplug size={13} aria-hidden />
          </button>
        </div>
        <p className="text-[10px] text-slate-500">
          {remote.login ? `Signed in as ${remote.login} · ` : ''}branch <span className="font-mono">{status?.branch}</span>
          {ahead > 0 ? ` · ${ahead} commit${ahead === 1 ? '' : 's'} to push` : status?.head ? ' · up to date' : ''}
        </p>
        <div className="flex gap-1.5">
          <button
            type="button"
            disabled={busy !== null || !status?.head || ahead === 0}
            onClick={() =>
              void run('push', async () => {
                const r = await pushRoom(roomId);
                return `Pushed ${r.branch} to GitHub.`;
              })
            }
            className="inline-flex flex-1 items-center justify-center gap-1 rounded-md bg-indigo-500 px-2 py-1.5 text-[12px] font-medium text-white hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy === 'push' ? <Loader2 size={12} className="animate-spin" aria-hidden /> : <ArrowUp size={13} aria-hidden />}
            Push{ahead > 0 ? ` (${ahead})` : ''}
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() =>
              void run('pull', async () => {
                const r = await pullRoom(roomId);
                return r.updated ? 'Pulled the latest changes from GitHub.' : 'Already up to date.';
              })
            }
            className="inline-flex flex-1 items-center justify-center gap-1 rounded-md border border-slate-700 px-2 py-1.5 text-[12px] font-medium text-slate-200 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy === 'pull' ? <Loader2 size={12} className="animate-spin" aria-hidden /> : <ArrowDown size={13} aria-hidden />}
            Pull
          </button>
        </div>
      </div>
    );
  }

  // ── Not connected ──────────────────────────────────────────────────────────
  return (
    <form
      className="space-y-2 rounded-md border border-slate-800 bg-slate-900/60 p-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        void submitConnect();
      }}
    >
      <p className="flex items-center gap-2 text-[12px] font-medium text-slate-100">
        <GitBranch size={14} aria-hidden /> Connect to GitHub
      </p>

      {needsToken && (
        <label className="block space-y-1">
          <span className="text-[10px] text-slate-400">
            Personal access token (needs the <span className="font-mono">repo</span> permission) —{' '}
            <a
              href="https://github.com/settings/tokens/new?scopes=repo&description=ICE%20IDE"
              target="_blank"
              rel="noreferrer"
              className="text-indigo-300 underline"
            >
              create one
            </a>
          </span>
          <input
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="ghp_…"
            className={input}
          />
        </label>
      )}

      {needsRepo && (
        <>
          <div className="flex rounded-md border border-slate-700 p-0.5 text-[11px]" role="tablist">
            {(['new', 'link'] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={mode === m}
                onClick={() => setMode(m)}
                className={`flex-1 rounded px-2 py-1 ${mode === m ? 'bg-slate-700 text-slate-50' : 'text-slate-400 hover:text-slate-200'}`}
              >
                {m === 'new' ? 'Create new repo' : 'Use existing repo'}
              </button>
            ))}
          </div>
          {mode === 'new' ? (
            <>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="repository-name"
                className={input}
              />
              <label className="flex items-center gap-2 text-[11px] text-slate-300">
                <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} />
                Private repository
              </label>
            </>
          ) : (
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://github.com/you/your-repo"
              className={input}
            />
          )}
        </>
      )}

      <button
        type="submit"
        disabled={busy !== null}
        className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-slate-100 px-3 py-1.5 text-[12px] font-medium text-slate-900 hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy === 'connect' && <Loader2 size={12} className="animate-spin" aria-hidden />}
        {needsRepo && mode === 'new' ? 'Create & connect' : 'Connect'}
      </button>
      <p className="text-[10px] leading-relaxed text-slate-500">
        The token is stored on your server only and is never shown again.
      </p>
    </form>
  );
}
