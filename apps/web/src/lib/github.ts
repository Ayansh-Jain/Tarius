/** Client for the GitHub / source-control endpoints (status, remote, push, pull, publish). */
export type ChangeStatus = 'A' | 'M' | 'D';
export interface FileChange {
  path: string;
  status: ChangeStatus;
}
export interface RemoteInfo {
  url: string | null;
  hasToken: boolean;
  tokenSource: 'room' | 'env' | null;
  login: string | null;
}
export interface GitStatus {
  changes: FileChange[];
  branch: string;
  head: string | null;
  /** Commits not yet on GitHub; null when no remote is connected. */
  unpushed: number | null;
  remote: RemoteInfo;
}

async function call<T>(roomId: string, path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/git${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
      credentials: 'include',
    });
  } catch {
    throw new Error('Could not reach the server.');
  }
  const data = (await res.json().catch(() => ({}))) as { message?: string; error?: string } & T;
  if (!res.ok) throw new Error(data.message ?? 'That did not work. Please try again.');
  return data;
}

export const getStatus = (roomId: string): Promise<GitStatus> => call(roomId, '/status');

export const getDiff = (roomId: string, path: string): Promise<{ before: string | null; after: string | null }> =>
  call(roomId, `/diff?path=${encodeURIComponent(path)}`);

export const connectRemote = (roomId: string, body: { url?: string; token?: string }): Promise<RemoteInfo> =>
  call(roomId, '/remote', { method: 'PUT', body: JSON.stringify(body) });

export const disconnectRemote = (roomId: string): Promise<{ ok: true }> =>
  call(roomId, '/remote', { method: 'DELETE' });

export const pushRoom = (roomId: string): Promise<{ branch: string; url: string; oid: string }> =>
  call(roomId, '/push', { method: 'POST', body: '{}' });

export const pullRoom = (roomId: string): Promise<{ updated: boolean; branch: string }> =>
  call(roomId, '/pull', { method: 'POST', body: '{}' });

export const publishRepo = (
  roomId: string,
  body: { name: string; private: boolean },
): Promise<RemoteInfo> => call(roomId, '/publish', { method: 'POST', body: JSON.stringify(body) });

/** "owner/repo" from a remote URL, for display. */
export function repoLabel(url: string | null): string {
  return url ? url.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '') : '';
}
