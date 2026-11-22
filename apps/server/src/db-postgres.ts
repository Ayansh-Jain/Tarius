/**
 * ICE metadata store — OPTIONAL Postgres backend (v1.0 Slice D — "Hardening").
 *
 * The default metadata store is SQLite (`db.ts`, via Node's built-in
 * `node:sqlite`) and is perfect for a single-node self-host. When you outgrow
 * that — multiple server instances, a managed database, point-in-time recovery
 * — point `DATABASE_URL` at Postgres and ICE uses this backend instead. It is a
 * drop-in: the SAME query surface (users / rooms / invites) plus the v1.0 role
 * assignments, behind a single {@link MetadataStore} interface.
 *
 * Selection is purely by env (see {@link selectMetadataStore}):
 *   • DATABASE_URL starts with `postgres://` or `postgresql://`  → Postgres (here)
 *   • anything else (unset, or `file:…`)                         → SQLite (db.ts)
 *
 * So with no configuration, nothing here runs and there is no `pg` connection —
 * it degrades to SQLite. `pg` is imported lazily inside the factory for the same
 * reason: a SQLite deployment never touches the driver.
 *
 * This file does NOT edit db.ts or api.ts. The driver calls
 * `await selectMetadataStore()` once at boot and threads the result through the
 * routes (see wiringInstructions).
 */
import type pg from 'pg';
import type { Room, UserAccount } from '@ice/shared';
import type { InviteRow, UserRow } from './db.js';
import {
  InMemoryRoleStore,
  type RoleStore,
} from './roles.js';

/**
 * The full metadata surface ICE needs, async so one interface fits both the
 * synchronous SQLite store and the pooled Postgres store. Mirrors db.ts's
 * function set 1:1, plus a {@link RoleStore} for v1.0 teams.
 */
export interface MetadataStore extends RoleStore {
  readonly kind: 'sqlite' | 'postgres';

  // Users
  createUser(row: UserRow): Promise<void>;
  findUserByEmail(email: string): Promise<UserRow | null>;
  findUserById(id: string): Promise<UserRow | null>;

  // Rooms
  createRoom(room: Room, createdBy: string | null): Promise<void>;
  findRoomById(id: string): Promise<Room | null>;

  // Invites
  createInvite(row: InviteRow): Promise<void>;
  findInviteByToken(token: string): Promise<InviteRow | null>;

  /** Release pooled connections (Postgres) — call on graceful shutdown. */
  close(): Promise<void>;
}

/** Strip server-only fields for the wire. Mirrors db.ts's `toUserAccount`. */
export function toUserAccount(row: UserRow): UserAccount {
  return { id: row.id, email: row.email, displayName: row.displayName };
}

/** True for connection strings this backend handles. */
export function isPostgresUrl(url: string | undefined): url is string {
  if (!url) return false;
  return url.startsWith('postgres://') || url.startsWith('postgresql://');
}

// ── Postgres implementation ───────────────────────────────────────────────────

const ROLES = new Set(['owner', 'member']);

/**
 * Postgres-backed {@link MetadataStore}. Uses a single `pg.Pool`; every method
 * is a parameterised query (no string interpolation of user data). The schema is
 * migrated lazily on first use ({@link ensureSchema}) and is idempotent, so it
 * is safe to run many instances against the same database.
 */
export class PostgresMetadataStore implements MetadataStore {
  readonly kind = 'postgres' as const;

  private readonly pool: pg.Pool;
  private migrated: Promise<void> | null = null;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  /** Build a store from a `DATABASE_URL`. Imports `pg` lazily. */
  static async fromUrl(connectionString: string): Promise<PostgresMetadataStore> {
    // Lazy import: a SQLite deployment must never load the pg driver.
    const { default: pgDefault } = await import('pg');
    const pool = new pgDefault.Pool({ connectionString });
    const store = new PostgresMetadataStore(pool);
    await store.ensureSchema();
    return store;
  }

  /** Idempotent migration. Postgres-flavoured DDL mirroring db.ts's SQLite schema. */
  private ensureSchema(): Promise<void> {
    if (this.migrated) return this.migrated;
    this.migrated = (async () => {
      // `BIGINT` for epoch-millis timestamps (matches the JS `number` we store).
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS users (
          id            TEXT PRIMARY KEY,
          email         TEXT NOT NULL UNIQUE,
          display_name  TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          created_at    BIGINT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS rooms (
          id         TEXT PRIMARY KEY,
          name       TEXT NOT NULL,
          created_by TEXT,
          created_at BIGINT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS invites (
          token      TEXT PRIMARY KEY,
          room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
          created_by TEXT NOT NULL,
          expires_at BIGINT,
          created_at BIGINT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_invites_room ON invites(room_id);

        CREATE TABLE IF NOT EXISTS room_roles (
          room_id        TEXT NOT NULL,
          participant_id TEXT NOT NULL,
          role           TEXT NOT NULL,
          PRIMARY KEY (room_id, participant_id)
        );
      `);
    })();
    return this.migrated;
  }

  // Users
  async createUser(row: UserRow): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `INSERT INTO users (id, email, display_name, password_hash, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [row.id, row.email.toLowerCase(), row.displayName, row.passwordHash, row.createdAt],
    );
  }

  async findUserByEmail(email: string): Promise<UserRow | null> {
    await this.ensureSchema();
    const { rows } = await this.pool.query(
      `SELECT id, email, display_name, password_hash, created_at
       FROM users WHERE email = $1`,
      [email.toLowerCase()],
    );
    return rows[0] ? rowToUser(rows[0]) : null;
  }

  async findUserById(id: string): Promise<UserRow | null> {
    await this.ensureSchema();
    const { rows } = await this.pool.query(
      `SELECT id, email, display_name, password_hash, created_at
       FROM users WHERE id = $1`,
      [id],
    );
    return rows[0] ? rowToUser(rows[0]) : null;
  }

  // Rooms
  async createRoom(room: Room, createdBy: string | null): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `INSERT INTO rooms (id, name, created_by, created_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [room.id, room.name, createdBy, room.createdAt],
    );
  }

  async findRoomById(id: string): Promise<Room | null> {
    await this.ensureSchema();
    const { rows } = await this.pool.query(
      `SELECT id, name, created_at FROM rooms WHERE id = $1`,
      [id],
    );
    const r = rows[0];
    if (!r) return null;
    return { id: String(r.id), name: String(r.name), createdAt: Number(r.created_at) };
  }

  // Invites
  async createInvite(row: InviteRow): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `INSERT INTO invites (token, room_id, created_by, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [row.token, row.roomId, row.createdBy, row.expiresAt, row.createdAt],
    );
  }

  async findInviteByToken(token: string): Promise<InviteRow | null> {
    await this.ensureSchema();
    const { rows } = await this.pool.query(
      `SELECT token, room_id, created_by, expires_at, created_at
       FROM invites WHERE token = $1`,
      [token],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      token: String(r.token),
      roomId: String(r.room_id),
      createdBy: String(r.created_by),
      expiresAt: r.expires_at == null ? null : Number(r.expires_at),
      createdAt: Number(r.created_at),
    };
  }

  // Roles (RoleStore)
  async setRole(roomId: string, participantId: string, role: 'owner' | 'member'): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `INSERT INTO room_roles (room_id, participant_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (room_id, participant_id) DO UPDATE SET role = EXCLUDED.role`,
      [roomId, participantId, role],
    );
  }

  async getRole(roomId: string, participantId: string): Promise<'owner' | 'member' | null> {
    await this.ensureSchema();
    const { rows } = await this.pool.query(
      `SELECT role FROM room_roles WHERE room_id = $1 AND participant_id = $2`,
      [roomId, participantId],
    );
    const role = rows[0]?.role;
    return ROLES.has(role) ? (role as 'owner' | 'member') : null;
  }

  async listRoles(roomId: string): Promise<{ participantId: string; role: 'owner' | 'member' }[]> {
    await this.ensureSchema();
    const { rows } = await this.pool.query(
      `SELECT participant_id, role FROM room_roles WHERE room_id = $1`,
      [roomId],
    );
    return rows
      .filter((r) => ROLES.has(r.role))
      .map((r) => ({ participantId: String(r.participant_id), role: r.role as 'owner' | 'member' }));
  }

  async removeRole(roomId: string, participantId: string): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `DELETE FROM room_roles WHERE room_id = $1 AND participant_id = $2`,
      [roomId, participantId],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function rowToUser(r: Record<string, unknown>): UserRow {
  return {
    id: String(r.id),
    email: String(r.email),
    displayName: String(r.display_name),
    passwordHash: String(r.password_hash),
    createdAt: Number(r.created_at),
  };
}

// ── SQLite adapter (drop-in over db.ts) ───────────────────────────────────────

/**
 * Wraps the synchronous SQLite functions from `db.ts` in the async
 * {@link MetadataStore} interface so the rest of the server only ever talks to
 * one shape, regardless of backend. The role methods delegate to an injected
 * {@link RoleStore} (db.ts can provide a SQLite-backed one, or — as a zero-extra
 * -table fallback — the {@link InMemoryRoleStore}).
 */
export class SqliteMetadataStore implements MetadataStore {
  readonly kind = 'sqlite' as const;

  constructor(
    private readonly sqlite: {
      createUser(row: UserRow): void;
      findUserByEmail(email: string): UserRow | null;
      findUserById(id: string): UserRow | null;
      createRoom(room: Room, createdBy: string | null): void;
      findRoomById(id: string): Room | null;
      createInvite(row: InviteRow): void;
      findInviteByToken(token: string): InviteRow | null;
    },
    private readonly roles: RoleStore = new InMemoryRoleStore(),
  ) {}

  createUser(row: UserRow): Promise<void> {
    this.sqlite.createUser(row);
    return Promise.resolve();
  }
  findUserByEmail(email: string): Promise<UserRow | null> {
    return Promise.resolve(this.sqlite.findUserByEmail(email));
  }
  findUserById(id: string): Promise<UserRow | null> {
    return Promise.resolve(this.sqlite.findUserById(id));
  }
  createRoom(room: Room, createdBy: string | null): Promise<void> {
    this.sqlite.createRoom(room, createdBy);
    return Promise.resolve();
  }
  findRoomById(id: string): Promise<Room | null> {
    return Promise.resolve(this.sqlite.findRoomById(id));
  }
  createInvite(row: InviteRow): Promise<void> {
    this.sqlite.createInvite(row);
    return Promise.resolve();
  }
  findInviteByToken(token: string): Promise<InviteRow | null> {
    return Promise.resolve(this.sqlite.findInviteByToken(token));
  }

  setRole(roomId: string, participantId: string, role: 'owner' | 'member'): Promise<void> {
    return this.roles.setRole(roomId, participantId, role);
  }
  getRole(roomId: string, participantId: string): Promise<'owner' | 'member' | null> {
    return this.roles.getRole(roomId, participantId);
  }
  listRoles(roomId: string): Promise<{ participantId: string; role: 'owner' | 'member' }[]> {
    return this.roles.listRoles(roomId);
  }
  removeRole(roomId: string, participantId: string): Promise<void> {
    return this.roles.removeRole(roomId, participantId);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/** Options for {@link selectMetadataStore}; everything optional for easy DI in tests. */
export interface SelectStoreOptions {
  /** Override the connection string (defaults to `process.env.DATABASE_URL`). */
  databaseUrl?: string;
  /**
   * SQLite function bag (defaults to lazily importing `./db.js`). Lets tests or
   * the driver inject an alternative without a real database file.
   */
  sqlite?: ConstructorParameters<typeof SqliteMetadataStore>[0];
  /** Role store backing the SQLite path (defaults to {@link InMemoryRoleStore}). */
  sqliteRoles?: RoleStore;
}

/**
 * Pick the metadata backend from the environment and return a ready
 * {@link MetadataStore}. The driver calls this once at boot:
 *
 *   const store = await selectMetadataStore();
 *   // …thread `store` through the routes; `await store.close()` on shutdown.
 *
 * Postgres is chosen iff `DATABASE_URL` is a `postgres://` / `postgresql://`
 * URL; otherwise SQLite (the default) is used and `pg` is never loaded.
 */
export async function selectMetadataStore(
  options: SelectStoreOptions = {},
): Promise<MetadataStore> {
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;

  if (isPostgresUrl(databaseUrl)) {
    return PostgresMetadataStore.fromUrl(databaseUrl);
  }

  const sqlite = options.sqlite ?? (await import('./db.js'));
  return new SqliteMetadataStore(sqlite, options.sqliteRoles);
}
