/**
 * ICE realtime sync (v0.1, Slice A).
 *
 * Wraps Hocuspocus — the y-websocket–compatible server — with:
 *   • durable persistence via @hocuspocus/extension-sqlite (a room survives a
 *     restart; document name = roomId);
 *   • an `onUpgrade` gate that only accepts WebSocket upgrades on `/sync`;
 *   • an `onAuthenticate` hook that is permissive outside production but, when a
 *     room token is supplied, validates it and stamps the participant onto the
 *     connection context.
 *
 * ARCHITECTURAL LAW: the Yjs doc is the source of truth for open files. This
 * server only transports and persists it — it never writes file content here.
 *
 * We construct the Hocuspocus `Server`, which owns a Node http.Server with the
 * WebSocket upgrade already wired. `index.ts` then mounts the Hono REST app as
 * that same http.Server's request listener, so one port serves both.
 */
import { Server, type Extension, type Hocuspocus } from '@hocuspocus/server';
import { SQLite } from '@hocuspocus/extension-sqlite';
import { getFiles, type AwarenessState } from '@ice/shared';
import { IS_PRODUCTION, YDOC_DB_PATH, ensureDataDir } from './config.js';
import { colorFor, verifyRoomToken } from './auth.js';
import { loadRoomFromGit } from './convergence/index.js';
import { maybeRedisExtension } from './scale/index.js';

/** What we attach to each Hocuspocus connection's context. */
export interface SyncContext {
  /** Present when a valid room token was provided. */
  participant?: AwarenessState['participant'];
  /** True if access was granted via a verified room token (vs dev-permissive). */
  authenticated: boolean;
}

/** The Hocuspocus document storage schema (matches the extension default). */
const DOCUMENTS_SCHEMA = `CREATE TABLE IF NOT EXISTS "documents" (
  "name" varchar(255) NOT NULL,
  "data" blob NOT NULL,
  UNIQUE(name)
)`;

let serverInstance: Server<SyncContext> | null = null;

/**
 * Build (once) the Hocuspocus realtime server. Does not start listening — the
 * caller owns the lifecycle so the REST API can share the http.Server.
 */
export function createRealtimeServer(): Server<SyncContext> {
  if (serverInstance) return serverInstance;
  ensureDataDir();

  // Durable persistence (SQLite) + OPTIONAL Redis pub/sub for horizontal
  // scale-out: when REDIS_URL is set, multiple server replicas share rooms.
  const extensions: Extension[] = [
    new SQLite({ database: YDOC_DB_PATH, schema: DOCUMENTS_SCHEMA }),
  ];
  const redisExt = maybeRedisExtension();
  if (redisExt) extensions.push(redisExt);

  serverInstance = new Server<SyncContext>({
    name: 'ice-sync',
    quiet: true,
    // We drive http.Server.listen() ourselves and own signal handling in
    // index.ts, so don't let Hocuspocus install its own SIGINT/SIGTERM hooks.
    stopOnSignals: false,
    extensions,

    /**
     * Only `/sync` is a valid WebSocket endpoint. crossws would otherwise
     * upgrade any path; reject everything else.
     *
     * NOTE: we must NOT throw here. Hocuspocus's upgrade listener re-throws hook
     * errors from an async event handler, which would crash the process. Instead
     * we close the socket with a 400 and return normally; crossws then calls
     * handleUpgrade on the already-closed socket, which is a harmless no-op.
     */
    async onUpgrade({ request, socket }) {
      const url = request.url ?? '';
      const path = url.split('?')[0];
      if (path !== '/sync' && typeof socket?.end === 'function') {
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      }
    },

    /**
     * Auth gate. In dev (NODE_ENV !== 'production') we allow connections so the
     * two-browser demo works without ceremony. When a token is present we always
     * validate it and, if it's a room token for THIS document, bind the
     * participant. In production a valid room token is required.
     */
    async onAuthenticate({ token, documentName }): Promise<SyncContext> {
      const claims = token ? await verifyRoomToken(token) : null;

      if (claims) {
        if (claims.roomId !== documentName) {
          throw new Error('room_token_mismatch');
        }
        return {
          authenticated: true,
          participant: {
            id: claims.pid,
            name: claims.name,
            color: colorFor(claims.pid),
            kind: 'human',
          },
        };
      }

      // No (valid) token.
      if (IS_PRODUCTION) {
        throw new Error('unauthorized');
      }
      return { authenticated: false };
    },

    /**
     * Seed a room's doc from its git repo — but ONLY when the doc has no content
     * yet (a brand-new or never-opened room). The SQLite extension restores the
     * live doc first; if it already has state we must NOT let git HEAD overwrite
     * uncommitted edits — that would lose work (ADR-000, "losing code is fatal").
     * Merging external pushes into an already-open room needs a real 3-way merge
     * and is deferred (see docs/DECISIONS.md / the v0.3 spec).
     */
    async onLoadDocument({ documentName, document }) {
      if (getFiles(document).size === 0) {
        await loadRoomFromGit(documentName, document);
      }
      return document;
    },
  });

  return serverInstance;
}

/** Underlying Hocuspocus core (documents map, connection counts, hooks). */
export function getHocuspocus(): Hocuspocus<SyncContext> {
  return createRealtimeServer().hocuspocus;
}
