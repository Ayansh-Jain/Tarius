/**
 * ICE server configuration (v0.1, Slice A).
 *
 * Centralises every environment-derived knob and on-disk path so the rest of
 * the server never reads `process.env` directly. Secrets are resolved once at
 * import time; if `ICE_SESSION_SECRET` is unset we synthesise a random one and
 * warn loudly (fine for local dev, never for production).
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** apps/server package root (…/apps/server). */
export const SERVER_ROOT = resolve(__dirname, '..');

/** Durable runtime state lives here; gitignored. One dir for all of it. */
export const DATA_DIR = process.env.ICE_DATA_DIR
  ? resolve(process.env.ICE_DATA_DIR)
  : resolve(SERVER_ROOT, 'data');

/** Metadata DB (users / rooms / invites). Separate file from Yjs docs. */
export const META_DB_PATH = resolve(DATA_DIR, 'ice.sqlite');

/** Durable Yjs documents (one row per room) persisted by Hocuspocus. */
export const YDOC_DB_PATH = resolve(DATA_DIR, 'ydoc.sqlite');

/** HTTP + WebSocket port. The same port serves the REST API and `/sync`. */
export const PORT = Number(process.env.PORT ?? 8080);

export const HOST = process.env.HOST ?? '0.0.0.0';

export const IS_PRODUCTION = process.env.NODE_ENV === 'production';

/** Public origin advertised in invite URLs (where the web app is served). */
export const PUBLIC_URL = (process.env.PUBLIC_URL ?? 'http://localhost:3000').replace(/\/$/, '');

/**
 * Resolve the JWT signing secret. Prefer the env var; otherwise generate an
 * ephemeral one so dev "just works" — but warn, because every restart rotates
 * it (invalidating outstanding tokens) and it must never ship to production.
 */
function resolveSessionSecret(): Uint8Array {
  const fromEnv = process.env.ICE_SESSION_SECRET;
  if (fromEnv && fromEnv.length > 0 && fromEnv !== 'change-me-in-production') {
    return new TextEncoder().encode(fromEnv);
  }
  const generated = randomBytes(32).toString('hex');
  if (IS_PRODUCTION) {
    // eslint-disable-next-line no-console
    console.error(
      '[ice] FATAL-ish: ICE_SESSION_SECRET is unset in production. Using a random ' +
        'per-boot secret — sessions will not survive restarts. Set ICE_SESSION_SECRET.',
    );
  } else {
    // eslint-disable-next-line no-console
    console.warn(
      '[ice] ICE_SESSION_SECRET not set — generated an ephemeral dev secret. ' +
        'Tokens reset on every restart. Set ICE_SESSION_SECRET to persist sessions.',
    );
  }
  return new TextEncoder().encode(generated);
}

export const SESSION_SECRET: Uint8Array = resolveSessionSecret();

/** Cookie name carrying the session JWT (httpOnly). Part of the wire contract. */
export const SESSION_COOKIE = 'ice_session';

/** Session lifetime. */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

/** Default invite-link lifetime. */
export const INVITE_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

/** Ensure the data directory exists before anything tries to open a DB in it. */
export function ensureDataDir(): void {
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(dirname(META_DB_PATH), { recursive: true });
}
