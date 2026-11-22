/**
 * Scale-out status — for boot logging (v2.0 Slice A).
 *
 * A tiny, dependency-free read of the environment so `index.ts` can print one
 * honest line at startup: are we single-node, or sharing rooms across replicas
 * via Redis? Never connects; never throws.
 */
import { buildRedisConfiguration, DEFAULT_REDIS_PREFIX } from './redis.js';

export type ScaleMode = 'single-node' | 'redis-clustered';

export interface ScaleStatus {
  mode: ScaleMode;
  /** True when REDIS_URL is configured. */
  enabled: boolean;
  /** Key namespace in use (only meaningful when clustered). */
  prefix: string;
  /**
   * The Redis host:port (clustered mode only), with any credentials stripped so
   * it's safe to log. `null` single-node.
   */
  endpoint: string | null;
  /** Human-readable one-liner for boot logs. */
  summary: string;
}

/** Strip credentials from a redis URL so it's safe to log (host:port[/db] only). */
function safeEndpoint(url: string): string | null {
  try {
    const u = new URL(url);
    const db = u.pathname && u.pathname !== '/' ? u.pathname : '';
    return `${u.hostname}:${u.port || '6379'}${db}`;
  } catch {
    return null;
  }
}

/**
 * Describe the current scale-out posture from the environment.
 *
 * @param env defaults to `process.env`; injectable for tests.
 */
export function getScaleStatus(env: NodeJS.ProcessEnv = process.env): ScaleStatus {
  const config = buildRedisConfiguration(env);

  if (!config) {
    return {
      mode: 'single-node',
      enabled: false,
      prefix: DEFAULT_REDIS_PREFIX,
      endpoint: null,
      summary: 'single-node (set REDIS_URL to share rooms across replicas)',
    };
  }

  const endpoint = safeEndpoint(config.url);
  return {
    mode: 'redis-clustered',
    enabled: true,
    prefix: config.prefix,
    endpoint,
    summary: `redis-clustered via ${endpoint ?? 'REDIS_URL'} (prefix "${config.prefix}")`,
  };
}
