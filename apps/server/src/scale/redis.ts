/**
 * Redis-backed Hocuspocus scale-out (v2.0 Slice A).
 *
 * Reads `REDIS_URL` / `REDIS_PREFIX` from the environment and, when a URL is
 * present, constructs a `@hocuspocus/extension-redis` instance configured to:
 *   • build its pub + sub clients from the URL via `createClient`, so a single
 *     env var (`redis://[:pass@]host:port[/db]`, or `rediss://…` for TLS) is the
 *     whole config surface;
 *   • use `lazyConnect: true` so NOTHING dials Redis until Hocuspocus loads a
 *     document — constructing the extension (here and in tests) never needs a
 *     live server;
 *   • namespace every key under `REDIS_PREFIX` (default `ice`) so multiple ICE
 *     clusters can share one Redis without colliding.
 *
 * When `REDIS_URL` is unset, {@link maybeRedisExtension} returns `null` and the
 * server stays single-node — this is the default and must never change.
 */
import RedisClient, { type RedisOptions } from 'ioredis';
import {
  Redis as HocuspocusRedis,
  type RedisInstance,
} from '@hocuspocus/extension-redis';

/** Default key namespace; over/ridable via `REDIS_PREFIX`. */
export const DEFAULT_REDIS_PREFIX = 'ice';

/** Parsed, ready-to-use scale-out configuration derived from the environment. */
export interface RedisScaleConfig {
  /** The raw connection URL (redis:// or rediss://). */
  url: string;
  /** Key namespace shared by every node in the cluster. */
  prefix: string;
  /** ioredis options derived from the URL (host/port/db/password/tls). */
  redisOptions: RedisOptions;
}

/**
 * Translate a `redis://` / `rediss://` URL into ioredis connection options.
 *
 * We parse the URL ourselves (rather than handing the raw string to ioredis) so
 * we can force connection-safety options (`lazyConnect`, no retry storms) that
 * keep construction side-effect-free. Throws a clear error on a malformed URL so
 * a typo fails loudly at boot instead of silently disabling scale-out.
 */
function redisOptionsFromUrl(url: string): RedisOptions {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      `[ice] REDIS_URL is not a valid URL: ${JSON.stringify(url)} ` +
        '(expected e.g. redis://host:6379 or rediss://user:pass@host:6379/0)',
    );
  }

  const scheme = parsed.protocol.replace(/:$/, '');
  if (scheme !== 'redis' && scheme !== 'rediss') {
    throw new Error(
      `[ice] REDIS_URL scheme must be redis:// or rediss:// (got ${scheme}://)`,
    );
  }

  // Path is "/<dbIndex>" when present; default DB 0.
  const dbStr = parsed.pathname.replace(/^\//, '');
  const db = dbStr ? Number.parseInt(dbStr, 10) : 0;

  const options: RedisOptions = {
    host: parsed.hostname || '127.0.0.1',
    port: parsed.port ? Number.parseInt(parsed.port, 10) : 6379,
    db: Number.isFinite(db) ? db : 0,
    // Do not open a socket until something actually uses the client. This keeps
    // module import + extension construction free of network side effects.
    lazyConnect: true,
    // A connection-refused error must not throw an UNHANDLED rejection from the
    // background reconnection loop; cap retries so a misconfigured/offline Redis
    // surfaces as connection errors the operator can see, not a crash storm.
    maxRetriesPerRequest: 3,
    // Keep trying to reconnect, but back off — and stop after a bounded number of
    // attempts so we don't spin forever against a dead host.
    retryStrategy: (times) => (times > 10 ? null : Math.min(times * 200, 2000)),
  };

  if (parsed.username) options.username = decodeURIComponent(parsed.username);
  if (parsed.password) options.password = decodeURIComponent(parsed.password);
  if (scheme === 'rediss') options.tls = {};

  return options;
}

/**
 * Resolve scale-out config from the environment. Returns `null` when scale-out
 * is not requested (no `REDIS_URL`), which is the single-node default.
 *
 * @param env defaults to `process.env`; injectable for tests.
 */
export function buildRedisConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): RedisScaleConfig | null {
  const url = env.REDIS_URL?.trim();
  if (!url) return null;

  const prefix = env.REDIS_PREFIX?.trim() || DEFAULT_REDIS_PREFIX;
  return {
    url,
    prefix,
    redisOptions: redisOptionsFromUrl(url),
  };
}

/** True when `REDIS_URL` is set (i.e. the cluster should share rooms via Redis). */
export function isScaleOutEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.REDIS_URL?.trim());
}

/**
 * Build the Hocuspocus Redis extension when scale-out is configured, else `null`.
 *
 * The driver appends a non-null result to realtime.ts's `extensions` array. A
 * `null` result means "single node" — the driver simply doesn't add anything.
 *
 * Safe to call without a live Redis: the extension's pub/sub clients are created
 * with `lazyConnect`, so this only constructs objects and never dials.
 *
 * @param env defaults to `process.env`; injectable for tests.
 */
export function maybeRedisExtension(
  env: NodeJS.ProcessEnv = process.env,
): HocuspocusRedis | null {
  const config = buildRedisConfiguration(env);
  if (!config) return null;

  return new HocuspocusRedis({
    prefix: config.prefix,
    // Build BOTH the pub and sub clients ourselves from the parsed URL. The
    // extension calls `createClient()` twice (one publisher, one subscriber);
    // each gets its own lazily-connecting ioredis client.
    //
    // The cast bridges a patch-level version skew: the workspace resolves
    // ioredis@5.11 while @hocuspocus/extension-redis pins ~5.6, so the two
    // `Redis` types are structurally identical but nominally distinct. Same
    // library, same runtime — a safe boundary cast to the extension's type.
    createClient: () => new RedisClient(config.redisOptions) as unknown as RedisInstance,
  });
}
