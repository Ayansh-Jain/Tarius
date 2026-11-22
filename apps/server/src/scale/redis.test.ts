/**
 * Scale-out tests (v2.0 Slice A).
 *
 * These verify the OPTIONAL switch without ever touching a real Redis server:
 *   • no REDIS_URL → maybeRedisExtension() is null (single-node default);
 *   • REDIS_URL set → a truthy extension is CONSTRUCTED (lazyConnect, so no dial)
 *     with the right prefix + parsed endpoint;
 *   • getScaleStatus reflects the mode and strips credentials from logs.
 *
 * We pass an explicit `env` into every function (rather than mutating
 * process.env) so the cases are isolated and order-independent.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  maybeRedisExtension,
  buildRedisConfiguration,
  isScaleOutEnabled,
} from './redis.js';
import { getScaleStatus } from './status.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('maybeRedisExtension', () => {
  it('returns null when REDIS_URL is not set (single-node default)', () => {
    expect(maybeRedisExtension({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it('returns null when REDIS_URL is blank/whitespace', () => {
    expect(maybeRedisExtension({ REDIS_URL: '   ' } as NodeJS.ProcessEnv)).toBeNull();
  });

  it('returns a truthy, configured extension when REDIS_URL is set (no connection)', () => {
    const ext = maybeRedisExtension({ REDIS_URL: 'redis://127.0.0.1:6379' } as NodeJS.ProcessEnv);
    expect(ext).toBeTruthy();
    // It is the Hocuspocus Redis extension: has the high priority + a configuration.
    expect(ext?.configuration.prefix).toBe('ice');
    // High priority so onStoreDocument intercepts before SQLite (priority 1000).
    expect(ext?.priority).toBeGreaterThan(1);
  });

  it('honours REDIS_PREFIX', () => {
    const ext = maybeRedisExtension({
      REDIS_URL: 'redis://localhost:6379',
      REDIS_PREFIX: 'my-cluster',
    } as NodeJS.ProcessEnv);
    expect(ext?.configuration.prefix).toBe('my-cluster');
  });
});

describe('buildRedisConfiguration', () => {
  it('is null without a URL', () => {
    expect(buildRedisConfiguration({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it('parses host, port and db from the URL', () => {
    const cfg = buildRedisConfiguration({ REDIS_URL: 'redis://example.com:6380/2' } as NodeJS.ProcessEnv);
    expect(cfg).not.toBeNull();
    expect(cfg!.redisOptions.host).toBe('example.com');
    expect(cfg!.redisOptions.port).toBe(6380);
    expect(cfg!.redisOptions.db).toBe(2);
    // Construction must be side-effect free: lazyConnect guarantees no dial.
    expect(cfg!.redisOptions.lazyConnect).toBe(true);
  });

  it('parses credentials and enables TLS for rediss://', () => {
    const cfg = buildRedisConfiguration({
      REDIS_URL: 'rediss://user:p%40ss@redis.internal:6379/0',
    } as NodeJS.ProcessEnv);
    expect(cfg!.redisOptions.username).toBe('user');
    // Password is URL-decoded (%40 -> @).
    expect(cfg!.redisOptions.password).toBe('p@ss');
    expect(cfg!.redisOptions.tls).toEqual({});
  });

  it('defaults prefix to "ice"', () => {
    const cfg = buildRedisConfiguration({ REDIS_URL: 'redis://localhost' } as NodeJS.ProcessEnv);
    expect(cfg!.prefix).toBe('ice');
  });

  it('throws a clear error on a non-redis scheme', () => {
    expect(() =>
      buildRedisConfiguration({ REDIS_URL: 'http://localhost:6379' } as NodeJS.ProcessEnv),
    ).toThrow(/redis:\/\/ or rediss:\/\//);
  });

  it('throws on a malformed URL', () => {
    expect(() =>
      buildRedisConfiguration({ REDIS_URL: 'not a url' } as NodeJS.ProcessEnv),
    ).toThrow(/not a valid URL/);
  });
});

describe('isScaleOutEnabled', () => {
  it('is false without REDIS_URL and true with it', () => {
    expect(isScaleOutEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isScaleOutEnabled({ REDIS_URL: 'redis://localhost' } as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe('getScaleStatus', () => {
  it('reports single-node without REDIS_URL', () => {
    const status = getScaleStatus({} as NodeJS.ProcessEnv);
    expect(status.mode).toBe('single-node');
    expect(status.enabled).toBe(false);
    expect(status.endpoint).toBeNull();
    expect(status.summary).toMatch(/single-node/);
  });

  it('reports clustered with a credential-stripped endpoint', () => {
    const status = getScaleStatus({
      REDIS_URL: 'rediss://user:secret@redis.internal:6380/1',
      REDIS_PREFIX: 'team',
    } as NodeJS.ProcessEnv);
    expect(status.mode).toBe('redis-clustered');
    expect(status.enabled).toBe(true);
    expect(status.prefix).toBe('team');
    // Endpoint must NOT leak credentials.
    expect(status.endpoint).toBe('redis.internal:6380/1');
    expect(status.summary).not.toMatch(/secret/);
    expect(status.summary).toMatch(/redis-clustered/);
  });
});
