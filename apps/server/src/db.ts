/**
 * ICE metadata store (v0.1, Slice A).
 *
 * Users, rooms, and invite links live in a small SQLite database. We use Node's
 * built-in `node:sqlite` (`DatabaseSync`) so there is NO native dependency to
 * compile — it ships with Node 22. The collaborative file content does NOT live
 * here: that is the Yjs document, persisted separately by Hocuspocus.
 *
 * Everything is synchronous (better-sqlite3-style), which is fine: these are
 * tiny point lookups on a local file, off the realtime hot path.
 */
import { DatabaseSync } from 'node:sqlite';
import type { Room, UserAccount } from '@ice/shared';
import { META_DB_PATH, ensureDataDir } from './config.js';

/** A user row, including the server-only password hash. */
export interface UserRow {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string;
  createdAt: number;
}

/** A persisted invite link. */
export interface InviteRow {
  token: string;
  roomId: string;
  createdBy: string;
  expiresAt: number | null;
  createdAt: number;
}

let db: DatabaseSync | null = null;

/** Open (once) and migrate the metadata database. Idempotent. */
export function getDb(): DatabaseSync {
  if (db) return db;
  ensureDataDir();
  db = new DatabaseSync(META_DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

function migrate(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      email         TEXT NOT NULL UNIQUE,
      display_name  TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rooms (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      created_by TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS invites (
      token      TEXT PRIMARY KEY,
      room_id    TEXT NOT NULL,
      created_by TEXT NOT NULL,
      expires_at INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_invites_room ON invites(room_id);
  `);
}

// ── Users ───────────────────────────────────────────────────────────────────

export function createUser(row: UserRow): void {
  getDb()
    .prepare(
      `INSERT INTO users (id, email, display_name, password_hash, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(row.id, row.email, row.displayName, row.passwordHash, row.createdAt);
}

export function findUserByEmail(email: string): UserRow | null {
  const r = getDb()
    .prepare(
      `SELECT id, email, display_name AS displayName, password_hash AS passwordHash, created_at AS createdAt
       FROM users WHERE email = ?`,
    )
    .get(email.toLowerCase()) as Record<string, unknown> | undefined;
  return r ? rowToUser(r) : null;
}

export function findUserById(id: string): UserRow | null {
  const r = getDb()
    .prepare(
      `SELECT id, email, display_name AS displayName, password_hash AS passwordHash, created_at AS createdAt
       FROM users WHERE id = ?`,
    )
    .get(id) as Record<string, unknown> | undefined;
  return r ? rowToUser(r) : null;
}

function rowToUser(r: Record<string, unknown>): UserRow {
  return {
    id: String(r.id),
    email: String(r.email),
    displayName: String(r.displayName),
    passwordHash: String(r.passwordHash),
    createdAt: Number(r.createdAt),
  };
}

/** Strip server-only fields for the wire. */
export function toUserAccount(row: UserRow): UserAccount {
  return { id: row.id, email: row.email, displayName: row.displayName };
}

// ── Rooms ───────────────────────────────────────────────────────────────────

export function createRoom(room: Room, createdBy: string | null): void {
  getDb()
    .prepare(`INSERT INTO rooms (id, name, created_by, created_at) VALUES (?, ?, ?, ?)`)
    .run(room.id, room.name, createdBy, room.createdAt);
}

export function findRoomById(id: string): Room | null {
  const r = getDb()
    .prepare(`SELECT id, name, created_at AS createdAt FROM rooms WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined;
  if (!r) return null;
  return { id: String(r.id), name: String(r.name), createdAt: Number(r.createdAt) };
}

// ── Invites ─────────────────────────────────────────────────────────────────

export function createInvite(row: InviteRow): void {
  getDb()
    .prepare(
      `INSERT INTO invites (token, room_id, created_by, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(row.token, row.roomId, row.createdBy, row.expiresAt, row.createdAt);
}

export function findInviteByToken(token: string): InviteRow | null {
  const r = getDb()
    .prepare(
      `SELECT token, room_id AS roomId, created_by AS createdBy, expires_at AS expiresAt, created_at AS createdAt
       FROM invites WHERE token = ?`,
    )
    .get(token) as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    token: String(r.token),
    roomId: String(r.roomId),
    createdBy: String(r.createdBy),
    expiresAt: r.expiresAt == null ? null : Number(r.expiresAt),
    createdAt: Number(r.createdAt),
  };
}
