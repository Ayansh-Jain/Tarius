/**
 * Local, per-device memory of rooms this browser has created or joined.
 * Real data only: written when the user actually creates/enters a room.
 */
const KEY = 'ice.rooms.v1';
const MAX = 6;

export interface RecentRoom {
  id: string;
  name?: string;
  at: number;
}

function read(): RecentRoom[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is RecentRoom => !!r && typeof r === 'object' && typeof (r as RecentRoom).id === 'string',
    );
  } catch {
    return [];
  }
}

export function getRecentRooms(): RecentRoom[] {
  return read().sort((a, b) => b.at - a.at);
}

export function rememberRoom(id: string, name?: string): void {
  try {
    const existing = read().find((r) => r.id === id);
    const next: RecentRoom = { id, name: name ?? existing?.name, at: Date.now() };
    const rest = read().filter((r) => r.id !== id);
    window.localStorage.setItem(KEY, JSON.stringify([next, ...rest].slice(0, MAX)));
  } catch {
    /* storage unavailable: recents are a convenience only */
  }
}

export function roomNameFor(id: string): string | undefined {
  return read().find((r) => r.id === id)?.name;
}

/** Accepts a bare room code or a full invite link; returns the room id or null. */
export function parseRoomInput(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  const fromUrl = /\/r\/([^/?#\s]+)/.exec(text);
  const id = fromUrl ? decodeURIComponent(fromUrl[1]!) : text;
  return /^[A-Za-z0-9_-]{3,80}$/.test(id) ? id : null;
}
