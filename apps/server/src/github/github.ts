/**
 * GitHub remote for a room's repo: connect, push, pull (fast-forward only) and
 * "publish" (create the GitHub repo), all driven from the IDE.
 *
 * Auth is a personal access token. It is stored server-side only (never sent
 * back to the browser, never put in a URL or log) in data/git-remotes/<room>.json,
 * or taken from GITHUB_TOKEN when the room has none. Only https://github.com
 * remotes are accepted.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import git from 'isomorphic-git';
import http from 'isomorphic-git/http/node';
import type * as Y from 'yjs';
import { DATA_DIR } from '../config.js';
import { sanitizeRoomId } from '../repos.js';
import { DEFAULT_BRANCH, ensureBareRepo, getChanges, loadRoomFromGit, withRoomLock } from '../convergence/index.js';

const igfs = fs as unknown as Parameters<typeof git.init>[0]['fs'];
const REMOTES_DIR = path.join(DATA_DIR, 'git-remotes');
const API = 'https://api.github.com';
const UA = 'ice-ide';

export class GithubError extends Error {
  constructor(
    readonly code:
      | 'invalid_remote'
      | 'no_remote'
      | 'no_token'
      | 'auth_failed'
      | 'no_commits'
      | 'rejected'
      | 'diverged'
      | 'dirty'
      | 'not_found'
      | 'exists'
      | 'network'
      | 'failed',
    message: string,
  ) {
    super(message);
  }
}

interface Stored {
  url?: string;
  token?: string;
  login?: string;
  /** Last commit known to be on the remote (after our push/pull). */
  syncedOid?: string;
}

function file(roomId: string): string {
  return path.join(REMOTES_DIR, `${sanitizeRoomId(roomId)}.json`);
}

async function load(roomId: string): Promise<Stored> {
  try {
    return JSON.parse(await fs.readFile(file(roomId), 'utf8')) as Stored;
  } catch {
    return {};
  }
}

async function save(roomId: string, data: Stored): Promise<void> {
  await fs.mkdir(REMOTES_DIR, { recursive: true });
  await fs.writeFile(file(roomId), JSON.stringify(data), { mode: 0o600 });
}

function envToken(): string | null {
  const t = process.env.GITHUB_TOKEN?.trim();
  return t ? t : null;
}

/** Remove any token from text that might be shown to the user. */
function scrub(text: string, token: string | null | undefined): string {
  let out = text;
  if (token) out = out.split(token).join('***');
  return out.replace(/(ghp_|github_pat_|gho_|ghu_|ghs_)[A-Za-z0-9_]+/g, '***');
}

export function normaliseRemoteUrl(raw: string): string {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(raw.trim());
  if (!m) {
    throw new GithubError('invalid_remote', 'Use a GitHub URL like https://github.com/your-name/your-repo');
  }
  return `https://github.com/${m[1]}/${m[2]}.git`;
}

// ── Remote config ────────────────────────────────────────────────────────────

export interface RemoteInfo {
  url: string | null;
  /** A token is available (stored for this room, or GITHUB_TOKEN). */
  hasToken: boolean;
  tokenSource: 'room' | 'env' | null;
  login: string | null;
}

export async function getRemote(roomId: string): Promise<RemoteInfo> {
  const s = await load(roomId);
  const source = s.token ? 'room' : envToken() ? 'env' : null;
  return { url: s.url ?? null, hasToken: source !== null, tokenSource: source, login: s.login ?? null };
}

async function tokenFor(roomId: string): Promise<{ token: string; stored: Stored }> {
  const stored = await load(roomId);
  const token = stored.token ?? envToken();
  if (!token) throw new GithubError('no_token', 'Add a GitHub personal access token first.');
  return { token, stored };
}

async function ghFetch(token: string, url: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'user-agent': UA,
        'x-github-api-version': '2022-11-28',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new GithubError('network', 'Could not reach GitHub. Check your internet connection.');
  }
}

/** Who does this token belong to? Throws auth_failed for a bad token. */
async function whoAmI(token: string): Promise<string> {
  const res = await ghFetch(token, `${API}/user`);
  if (res.status === 401) throw new GithubError('auth_failed', 'GitHub rejected this token. Check it and try again.');
  if (!res.ok) throw new GithubError('failed', `GitHub returned ${res.status}.`);
  return ((await res.json()) as { login?: string }).login ?? '';
}

export async function setRemote(
  roomId: string,
  input: { url?: string; token?: string },
): Promise<RemoteInfo> {
  const stored = await load(roomId);
  if (input.url !== undefined && input.url.trim()) stored.url = normaliseRemoteUrl(input.url);
  if (input.token !== undefined && input.token.trim()) {
    const token = input.token.trim();
    stored.login = await whoAmI(token); // verifies the token
    stored.token = token;
  }
  await save(roomId, stored);
  return getRemote(roomId);
}

export async function clearRemote(roomId: string): Promise<void> {
  await fs.rm(file(roomId), { force: true });
}

// ── Status ───────────────────────────────────────────────────────────────────

export async function syncStatus(roomId: string): Promise<{ branch: string; head: string | null; unpushed: number | null }> {
  const gitdir = await ensureBareRepo(roomId);
  const branch = (await git.currentBranch({ fs: igfs, gitdir, fullname: false }).catch(() => null)) || DEFAULT_BRANCH;
  let head: string | null = null;
  try {
    head = await git.resolveRef({ fs: igfs, gitdir, ref: 'HEAD' });
  } catch {
    return { branch, head: null, unpushed: 0 };
  }
  const { syncedOid, url } = await load(roomId);
  if (!url) return { branch, head, unpushed: null };
  if (!syncedOid) {
    const log = await git.log({ fs: igfs, gitdir, ref: 'HEAD', depth: 200 });
    return { branch, head, unpushed: log.length };
  }
  if (syncedOid === head) return { branch, head, unpushed: 0 };
  const log = await git.log({ fs: igfs, gitdir, ref: 'HEAD', depth: 200 });
  const idx = log.findIndex((c) => c.oid === syncedOid);
  return { branch, head, unpushed: idx === -1 ? log.length : idx };
}

// ── Push / pull ──────────────────────────────────────────────────────────────

function mapGitError(err: unknown, token: string): GithubError {
  if (err instanceof GithubError) return err;
  const raw = String((err as { message?: string })?.message ?? err);
  const msg = scrub(raw, token);
  const status = (err as { data?: { statusCode?: number } })?.data?.statusCode;
  if (status === 401 || status === 403 || /401|403|authentication|Bad credentials/i.test(raw)) {
    return new GithubError(
      'auth_failed',
      'GitHub refused access. Check the token has the "repo" permission and can write to this repository.',
    );
  }
  if (status === 404 || /404|not found/i.test(raw)) {
    return new GithubError('not_found', 'That GitHub repository was not found (or the token cannot see it).');
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|network/i.test(raw)) {
    return new GithubError('network', 'Could not reach GitHub. Check your internet connection.');
  }
  return new GithubError('failed', msg || 'The git operation failed.');
}

export async function push(roomId: string): Promise<{ branch: string; url: string; oid: string }> {
  const { token, stored } = await tokenFor(roomId);
  if (!stored.url) throw new GithubError('no_remote', 'Connect a GitHub repository first.');
  return withRoomLock(roomId, async () => {
    const gitdir = await ensureBareRepo(roomId);
    let oid: string;
    try {
      oid = await git.resolveRef({ fs: igfs, gitdir, ref: 'HEAD' });
    } catch {
      throw new GithubError('no_commits', 'Commit your changes first — there is nothing to push yet.');
    }
    const branch = (await git.currentBranch({ fs: igfs, gitdir, fullname: false })) || DEFAULT_BRANCH;
    try {
      const res = await git.push({
        fs: igfs,
        http,
        gitdir,
        url: stored.url!,
        ref: branch,
        remoteRef: branch,
        onAuth: () => ({ username: token, password: 'x-oauth-basic' }),
      });
      if (!res.ok) throw new Error(res.error ?? 'push failed');
      const refErr = res.refs?.[`refs/heads/${branch}`]?.error;
      if (refErr) {
        if (/fast-forward|non-fast|fetch first|rejected/i.test(refErr)) {
          throw new GithubError('rejected', 'GitHub has commits you do not have. Pull first, then push again.');
        }
        throw new Error(refErr);
      }
    } catch (err) {
      if (err instanceof GithubError) throw err;
      if (/fast-forward|non-fast|fetch first|rejected/i.test(String((err as Error)?.message))) {
        throw new GithubError('rejected', 'GitHub has commits you do not have. Pull first, then push again.');
      }
      throw mapGitError(err, token);
    }
    await save(roomId, { ...stored, syncedOid: oid });
    return { branch, url: stored.url!, oid };
  });
}

/** Fetch and fast-forward the current branch, then refresh the live doc. Refuses over uncommitted changes. */
export async function pull(
  roomId: string,
  doc: Y.Doc,
): Promise<{ updated: boolean; branch: string; oid: string | null }> {
  const { token, stored } = await tokenFor(roomId);
  if (!stored.url) throw new GithubError('no_remote', 'Connect a GitHub repository first.');
  if ((await getChanges(roomId, doc)).length > 0) {
    throw new GithubError('dirty', 'You have uncommitted changes. Commit them before pulling.');
  }
  return withRoomLock(roomId, async () => {
    const gitdir = await ensureBareRepo(roomId);
    const branch = (await git.currentBranch({ fs: igfs, gitdir, fullname: false })) || DEFAULT_BRANCH;
    let remoteOid: string;
    try {
      const res = await git.fetch({
        fs: igfs,
        http,
        gitdir,
        url: stored.url!,
        ref: branch,
        singleBranch: true,
        tags: false,
        onAuth: () => ({ username: token, password: 'x-oauth-basic' }),
      });
      if (!res.fetchHead) throw new GithubError('not_found', `Branch "${branch}" does not exist on GitHub yet. Push first.`);
      remoteOid = res.fetchHead;
    } catch (err) {
      throw mapGitError(err, token);
    }

    let localOid: string | null = null;
    try {
      localOid = await git.resolveRef({ fs: igfs, gitdir, ref: 'HEAD' });
    } catch {
      localOid = null;
    }
    if (localOid === remoteOid) {
      await save(roomId, { ...stored, syncedOid: remoteOid });
      return { updated: false, branch, oid: remoteOid };
    }
    if (localOid) {
      const localHasRemote = await git.isDescendent({ fs: igfs, gitdir, oid: localOid, ancestor: remoteOid, depth: -1 }).catch(() => false);
      if (localHasRemote) return { updated: false, branch, oid: localOid }; // we are ahead
      const canFastForward = await git.isDescendent({ fs: igfs, gitdir, oid: remoteOid, ancestor: localOid, depth: -1 }).catch(() => false);
      if (!canFastForward) {
        throw new GithubError(
          'diverged',
          'Your commits and GitHub\'s have diverged, which needs a merge. Resolve it on GitHub or with git on your computer.',
        );
      }
    }
    await git.writeRef({ fs: igfs, gitdir, ref: `refs/heads/${branch}`, value: remoteOid, force: true });
    await git.writeRef({ fs: igfs, gitdir, ref: 'HEAD', value: `refs/heads/${branch}`, symbolic: true, force: true });
    await save(roomId, { ...stored, syncedOid: remoteOid });
    await loadRoomFromGit(roomId, doc);
    return { updated: true, branch, oid: remoteOid };
  });
}

// ── Publish (create the GitHub repository) ───────────────────────────────────

export async function createRepo(
  roomId: string,
  input: { name: string; private: boolean; description?: string },
): Promise<RemoteInfo> {
  const name = input.name.trim();
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name) || name === '.' || name === '..') {
    throw new GithubError('invalid_remote', 'Repository names may only use letters, numbers, ".", "-" and "_".');
  }
  const { token, stored } = await tokenFor(roomId);
  const res = await ghFetch(token, `${API}/user/repos`, {
    method: 'POST',
    body: JSON.stringify({
      name,
      private: input.private,
      description: input.description?.slice(0, 300) ?? '',
      auto_init: false,
    }),
  });
  if (res.status === 401) throw new GithubError('auth_failed', 'GitHub rejected this token.');
  if (res.status === 403 || res.status === 404) {
    throw new GithubError('auth_failed', 'This token cannot create repositories. It needs the "repo" permission.');
  }
  if (res.status === 422) throw new GithubError('exists', `You already have a repository named "${name}" on GitHub.`);
  if (!res.ok) throw new GithubError('failed', `GitHub returned ${res.status}.`);
  const data = (await res.json()) as { clone_url?: string };
  if (!data.clone_url) throw new GithubError('failed', 'GitHub did not return the repository address.');
  await save(roomId, { ...stored, url: normaliseRemoteUrl(data.clone_url), syncedOid: undefined });
  return getRemote(roomId);
}
