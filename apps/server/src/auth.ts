/**
 * ICE auth primitives (v0.1, Slice A).
 *
 * - Passwords: salted scrypt via `node:crypto` (no native dependency). Stored
 *   as `scrypt:N:r:p:<saltHex>:<hashHex>` so parameters travel with the hash.
 * - Tokens: signed JWTs via `jose` (HS256, secret from config). Two flavours:
 *     • session token  — identifies a logged-in UserAccount (httpOnly cookie).
 *     • room token      — grants access to a single room (issued on join).
 *   Both are opaque strings on the wire.
 *
 * Nothing here touches HTTP; `api.ts` composes these into endpoints.
 */
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import type { Participant } from '@ice/shared';
import {
  INVITE_TTL_SECONDS,
  SESSION_SECRET,
  SESSION_TTL_SECONDS,
} from './config.js';

// ── Password hashing (scrypt) ────────────────────────────────────────────────

const SCRYPT_N = 16384; // CPU/memory cost
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_MAXMEM = 64 * 1024 * 1024; // headroom for N=16384

/** Hash a plaintext password with a fresh random salt. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString('hex')}:${derived.toString(
    'hex',
  )}`;
}

/** Constant-time verify of a plaintext password against a stored hash. */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nRaw, rRaw, pRaw, saltHex, hashHex] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  const salt = Buffer.from(saltHex!, 'hex');
  const expected = Buffer.from(hashHex!, 'hex');
  let derived: Buffer;
  try {
    derived = scryptSync(password, salt, expected.length, { N, r, p, maxmem: SCRYPT_MAXMEM });
  } catch {
    return false;
  }
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

// ── JWTs ─────────────────────────────────────────────────────────────────────

const ALG = 'HS256';

/** Claims carried by a session token. */
export interface SessionClaims extends JWTPayload {
  kind: 'session';
  sub: string; // userId
  email: string;
  name: string;
}

/** Claims carried by a room-access token. */
export interface RoomClaims extends JWTPayload {
  kind: 'room';
  roomId: string;
  /** Participant id this token authorises in the room. */
  pid: string;
  name: string;
}

async function sign(claims: JWTPayload, ttlSeconds: number): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(SESSION_SECRET);
}

export function signSessionToken(user: {
  id: string;
  email: string;
  displayName: string;
}): Promise<string> {
  const claims: SessionClaims = {
    kind: 'session',
    sub: user.id,
    email: user.email,
    name: user.displayName,
  };
  return sign(claims, SESSION_TTL_SECONDS);
}

export function signRoomToken(roomId: string, participant: Participant): Promise<string> {
  const claims: RoomClaims = {
    kind: 'room',
    roomId,
    pid: participant.id,
    name: participant.name,
  };
  return sign(claims, INVITE_TTL_SECONDS);
}

export async function verifySessionToken(token: string): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, SESSION_SECRET);
    if (payload.kind !== 'session' || typeof payload.sub !== 'string') return null;
    return payload as SessionClaims;
  } catch {
    return null;
  }
}

export async function verifyRoomToken(token: string): Promise<RoomClaims | null> {
  try {
    const { payload } = await jwtVerify(token, SESSION_SECRET);
    if (payload.kind !== 'room' || typeof payload.roomId !== 'string') return null;
    return payload as RoomClaims;
  } catch {
    return null;
  }
}

// ── Participants ─────────────────────────────────────────────────────────────

/** Deterministic, pleasant cursor colour from any stable id. */
const PALETTE = [
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#14b8a6',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
];

export function colorFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return PALETTE[h % PALETTE.length]!;
}

/** Build a human Participant for a logged-in account. */
export function participantForUser(user: {
  id: string;
  displayName: string;
}): Participant {
  return {
    id: user.id,
    name: user.displayName,
    color: colorFor(user.id),
    kind: 'human',
  };
}

/** Build a guest (no account) human Participant. */
export function guestParticipant(displayName: string): Participant {
  const id = `guest_${randomUUID()}`;
  const name = displayName.trim() || 'Guest';
  return { id, name, color: colorFor(id), kind: 'human' };
}

/** New opaque invite token (URL-safe). */
export function newInviteToken(): string {
  return randomBytes(24).toString('base64url');
}
