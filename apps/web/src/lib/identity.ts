/**
 * Local identity for ICE v0.1.
 *
 * A participant picks a display name + color once; we persist it in
 * localStorage and reuse it across rooms and reloads. The resulting
 * {@link Participant} is what we publish on the Yjs awareness channel so
 * remote peers can label our cursor and list us in the presence bar.
 *
 * v0.1 is intentionally accountless on the client: identity is a local
 * concern. Auth/accounts (see V0.1 WIRE CONTRACT) layer on top later without
 * changing this shape.
 */
import type { Participant } from '@ice/shared';

const STORAGE_KEY = 'ice.identity.v1';

/**
 * A tasteful, high-contrast palette that reads well as a caret/selection on a
 * dark editor. Order matters: the first colors are the most distinct.
 */
export const COLOR_PALETTE = [
  '#f97316', // orange
  '#22d3ee', // cyan
  '#a78bfa', // violet
  '#34d399', // emerald
  '#f472b6', // pink
  '#facc15', // amber
  '#60a5fa', // blue
  '#fb7185', // rose
  '#4ade80', // green
  '#c084fc', // purple
  '#2dd4bf', // teal
  '#fbbf24', // gold
] as const;

export type IdentityColor = (typeof COLOR_PALETTE)[number];

/** Friendly default-name generator so first-run isn't a blank box. */
const ADJECTIVES = [
  'swift', 'lucid', 'cosmic', 'amber', 'quiet', 'bold', 'nimble', 'lunar',
  'vivid', 'brave', 'sunny', 'mellow', 'keen', 'zesty', 'plucky', 'crisp',
] as const;
const ANIMALS = [
  'otter', 'falcon', 'koala', 'tapir', 'lynx', 'heron', 'fox', 'panda',
  'gecko', 'orca', 'raven', 'ibex', 'moth', 'newt', 'wren', 'seal',
] as const;

/** Stored identity. `id` is a stable per-browser participant id. */
export interface StoredIdentity {
  id: string;
  name: string;
  color: string;
}

function pick<T>(arr: readonly T[]): T {
  // arr is always non-empty here; the non-null assertion is safe and keeps
  // noUncheckedIndexedAccess happy.
  return arr[Math.floor(Math.random() * arr.length)]!;
}

/** A reasonably unique id without pulling in a uuid dependency. */
export function randomId(prefix = 'p'): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return `${prefix}_${cryptoObj.randomUUID()}`;
  }
  return `${prefix}_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/** Capitalize the first letter for display. */
function titleCase(s: string): string {
  return s.length ? s[0]!.toUpperCase() + s.slice(1) : s;
}

export function suggestName(): string {
  return `${titleCase(pick(ADJECTIVES))} ${titleCase(pick(ANIMALS))}`;
}

export function suggestColor(): string {
  return pick(COLOR_PALETTE);
}

function isValidStored(value: unknown): value is StoredIdentity {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    typeof v.color === 'string'
  );
}

/** Read the persisted identity, or null if none / unparseable. */
export function loadIdentity(): StoredIdentity | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isValidStored(parsed)) return null;
    const name = parsed.name.trim();
    if (!name) return null;
    return { id: parsed.id, name, color: parsed.color };
  } catch {
    return null;
  }
}

/**
 * Persist an identity. Name is trimmed; an existing id is preserved so a
 * participant keeps the same id across edits to their name/color.
 */
export function saveIdentity(input: { name: string; color: string; id?: string }): StoredIdentity {
  const existing = loadIdentity();
  const identity: StoredIdentity = {
    id: input.id ?? existing?.id ?? randomId(),
    name: input.name.trim() || suggestName(),
    color: input.color || suggestColor(),
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
  } catch {
    // Non-fatal: a private-mode browser may reject writes. We still return the
    // in-memory identity so the session works for as long as the tab lives.
  }
  return identity;
}

/** Project a stored identity into the frozen {@link Participant} wire type. */
export function toParticipant(identity: StoredIdentity): Participant {
  return {
    id: identity.id,
    name: identity.name,
    color: identity.color,
    kind: 'human',
  };
}
