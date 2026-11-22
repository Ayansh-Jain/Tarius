/**
 * Voice token tests (v1.0 Slice A).
 *
 * Proves the token contract the web client + LiveKit depend on:
 *   - a configured mint yields a NON-EMPTY JWT whose `video` grant names the
 *     exact room and allows join/publish/subscribe, with the right identity;
 *   - the JWT verifies against the same secret (so LiveKit would accept it);
 *   - an unconfigured environment returns the typed "not configured" signal
 *     (never a fabricated token), and the Hono handler turns that into a 503;
 *   - the happy-path handler returns 200 with a VoiceTokenResponse shape.
 */
import { describe, it, expect } from 'vitest';
import { decodeJwt, jwtVerify } from 'jose';
import { TokenVerifier } from 'livekit-server-sdk';
import {
  getVoiceToken,
  resolveVoiceConfig,
  isVoiceConfigured,
  DEFAULT_LIVEKIT_URL,
  type VoiceConfig,
} from './token.js';
import { makeVoiceTokenHandler } from './index.js';

const CONFIGURED: VoiceConfig = {
  configured: true,
  url: 'ws://livekit.test:7880',
  apiKey: 'test-key',
  apiSecret: 'test-secret-0123456789',
};

describe('resolveVoiceConfig', () => {
  it('uses LiveKit dev credentials + localhost URL when env is empty (dev)', () => {
    const cfg = resolveVoiceConfig({ NODE_ENV: 'development' } as NodeJS.ProcessEnv);
    expect(cfg.configured).toBe(true);
    expect(cfg.url).toBe(DEFAULT_LIVEKIT_URL);
    expect(cfg.apiKey).toBeTruthy();
    expect(cfg.apiSecret).toBeTruthy();
  });

  it('honours explicit env vars over dev defaults', () => {
    const cfg = resolveVoiceConfig({
      LIVEKIT_URL: 'wss://lk.example.com',
      LIVEKIT_API_KEY: 'real-key',
      LIVEKIT_API_SECRET: 'real-secret',
    } as NodeJS.ProcessEnv);
    expect(cfg).toMatchObject({
      configured: true,
      url: 'wss://lk.example.com',
      apiKey: 'real-key',
      apiSecret: 'real-secret',
    });
  });

  it('is NOT configured in production without explicit credentials (fails closed)', () => {
    const cfg = resolveVoiceConfig({ NODE_ENV: 'production' } as NodeJS.ProcessEnv);
    expect(cfg.configured).toBe(false);
  });
});

describe('getVoiceToken', () => {
  it('returns a non-empty token for the correct room + identity', async () => {
    const result = await getVoiceToken('room_abc', 'user_42', 'Ada', {
      config: CONFIGURED,
    });
    expect(isVoiceConfigured(result)).toBe(true);
    if (!isVoiceConfigured(result)) throw new Error('expected a token');

    expect(typeof result.token).toBe('string');
    expect(result.token.length).toBeGreaterThan(20);
    expect(result.room).toBe('room_abc');
    expect(result.identity).toBe('user_42');
    expect(result.url).toBe(CONFIGURED.url);
    // A JWT has three dot-separated segments.
    expect(result.token.split('.')).toHaveLength(3);
  });

  it('encodes a minimal room-join grant in the JWT claims', async () => {
    const result = await getVoiceToken('room_xyz', 'user_7', 'Grace', {
      config: CONFIGURED,
    });
    if (!isVoiceConfigured(result)) throw new Error('expected a token');

    const claims = decodeJwt(result.token) as {
      sub?: string;
      name?: string;
      video?: {
        room?: string;
        roomJoin?: boolean;
        canPublish?: boolean;
        canSubscribe?: boolean;
        roomAdmin?: boolean;
      };
    };
    expect(claims.sub).toBe('user_7');
    expect(claims.name).toBe('Grace');
    expect(claims.video?.room).toBe('room_xyz');
    expect(claims.video?.roomJoin).toBe(true);
    expect(claims.video?.canPublish).toBe(true);
    expect(claims.video?.canSubscribe).toBe(true);
    // Least privilege: no admin/recording rights leak into a join token.
    expect(claims.video?.roomAdmin).toBeFalsy();
  });

  it('mints a token LiveKit would accept (verifies against the same secret)', async () => {
    const result = await getVoiceToken('room_v', 'user_v', 'Verifier', {
      config: CONFIGURED,
    });
    if (!isVoiceConfigured(result)) throw new Error('expected a token');

    // 1) Raw jose verify against the shared secret succeeds (signature valid).
    const secret = new TextEncoder().encode(CONFIGURED.apiSecret);
    const { payload } = await jwtVerify(result.token, secret);
    expect(payload.sub).toBe('user_v');

    // 2) The SDK's own verifier accepts it and surfaces the grant.
    const verifier = new TokenVerifier(CONFIGURED.apiKey, CONFIGURED.apiSecret);
    const grants = await verifier.verify(result.token);
    expect(grants.video?.room).toBe('room_v');
  });

  it('defaults the display name to the identity when name is blank', async () => {
    const result = await getVoiceToken('room_n', 'user_n', '   ', {
      config: CONFIGURED,
    });
    if (!isVoiceConfigured(result)) throw new Error('expected a token');
    const claims = decodeJwt(result.token) as { name?: string };
    expect(claims.name).toBe('user_n');
  });

  it('returns the typed "not configured" signal when credentials are absent', async () => {
    const unconfigured: VoiceConfig = {
      configured: false,
      url: DEFAULT_LIVEKIT_URL,
      apiKey: '',
      apiSecret: '',
    };
    const result = await getVoiceToken('room_x', 'user_x', 'Nobody', {
      config: unconfigured,
    });
    expect(isVoiceConfigured(result)).toBe(false);
    if (isVoiceConfigured(result)) throw new Error('expected not-configured');
    expect(result.reason).toMatch(/LIVEKIT/);
  });

  it('throws VoiceArgumentError for an empty roomId or identity', async () => {
    await expect(getVoiceToken('', 'u', 'n', { config: CONFIGURED })).rejects.toThrow();
    await expect(getVoiceToken('r', '', 'n', { config: CONFIGURED })).rejects.toThrow();
  });
});

describe('voiceTokenHandler', () => {
  /** Minimal Hono-like Context stub exercising the handler in isolation. */
  function makeCtx(roomId: string | undefined, body: unknown) {
    let statusOut = 200;
    let jsonOut: unknown = null;
    const c = {
      req: {
        param: (_k: string) => roomId,
        json: async () => body,
      },
      json: (data: unknown, status?: number) => {
        statusOut = status ?? 200;
        jsonOut = data;
        return new Response(JSON.stringify(data), { status: statusOut });
      },
    };
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      c: c as any,
      get status() {
        return statusOut;
      },
      get data() {
        return jsonOut;
      },
    };
  }

  it('responds 200 with a VoiceTokenResponse on the happy path', async () => {
    const handler = makeVoiceTokenHandler({ config: CONFIGURED });
    const ctx = makeCtx('room_h', { identity: 'user_h', name: 'Hank' });
    await handler(ctx.c);
    expect(ctx.status).toBe(200);
    const data = ctx.data as { url: string; token: string; room: string; identity: string };
    expect(data.room).toBe('room_h');
    expect(data.identity).toBe('user_h');
    expect(data.token.length).toBeGreaterThan(20);
    expect(data.url).toBe(CONFIGURED.url);
  });

  it('falls back to a guest identity when the body omits one', async () => {
    const handler = makeVoiceTokenHandler({ config: CONFIGURED });
    const ctx = makeCtx('room_g', {});
    await handler(ctx.c);
    expect(ctx.status).toBe(200);
    const data = ctx.data as { identity: string };
    expect(data.identity).toMatch(/^guest_/);
  });

  it('prefers an identityResolver over the request body', async () => {
    const handler = makeVoiceTokenHandler({
      config: CONFIGURED,
      identityResolver: () => ({ identity: 'session_user', name: 'Session Sam' }),
    });
    const ctx = makeCtx('room_s', { identity: 'body_user', name: 'Body Bob' });
    await handler(ctx.c);
    const data = ctx.data as { identity: string };
    expect(data.identity).toBe('session_user');
  });

  it('responds 503 voice_not_configured when LiveKit is absent', async () => {
    const handler = makeVoiceTokenHandler({
      config: { configured: false, url: DEFAULT_LIVEKIT_URL, apiKey: '', apiSecret: '' },
    });
    const ctx = makeCtx('room_503', { identity: 'u', name: 'n' });
    await handler(ctx.c);
    expect(ctx.status).toBe(503);
    const data = ctx.data as { error: string; message: string };
    expect(data.error).toBe('voice_not_configured');
    expect(data.message).toMatch(/LIVEKIT/);
  });
});
