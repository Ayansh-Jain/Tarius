/**
 * Horizontal scale-out — public API (v2.0 Slice A).
 *
 * ICE runs single-node out of the box: one Hocuspocus process owns every room
 * in memory and persists it to SQLite. To scale OUT — run N server replicas
 * behind a load balancer and have a `/sync` client land on ANY of them and still
 * see the same live room — those replicas must share document updates and
 * awareness with each other. Hocuspocus does this with its Redis extension: a
 * Redis pub/sub fan-out where every node publishes the Yjs updates + awareness
 * it receives and subscribes to the rest.
 *
 * This module is the OPTIONAL, SAFE switch for that:
 *   • REDIS_URL set  → {@link maybeRedisExtension} returns a configured Redis
 *     extension the driver appends to realtime.ts's `extensions` array; the
 *     cluster now shares rooms.
 *   • REDIS_URL unset → returns `null`; the server behaves EXACTLY as today
 *     (single node, SQLite only). Zero behavioural change for self-hosters who
 *     don't need scale.
 *
 * Nothing here connects on import — the Redis clients are created lazily (see
 * {@link buildRedisConfiguration}) and only dial when Hocuspocus actually loads
 * a document, so importing this module (and constructing the extension in tests)
 * never requires a live Redis.
 *
 * ── DRIVER WIRING (apps/server/src/realtime.ts) ──────────────────────────────
 *   import { maybeRedisExtension, getScaleStatus } from './scale/index.js';
 *
 *   const extensions = [ new SQLite({ ... }) ];
 *   const redis = maybeRedisExtension();
 *   if (redis) extensions.push(redis);   // higher priority than SQLite (1000)
 *
 *   new Server<SyncContext>({ ..., extensions });
 *
 * and at boot logging (apps/server/src/index.ts):
 *   const scale = getScaleStatus();
 *   console.log(`[ice] scale-out: ${scale.summary}`);
 *
 * The extension's `priority` (1000) is already higher than SQLite's, so it
 * intercepts `onStoreDocument` first — exactly what its docs require. The driver
 * does NOT need to order the array.
 */
export {
  maybeRedisExtension,
  buildRedisConfiguration,
  isScaleOutEnabled,
} from './redis.js';
export type { RedisScaleConfig } from './redis.js';

export { getScaleStatus } from './status.js';
export type { ScaleStatus, ScaleMode } from './status.js';
