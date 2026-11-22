/**
 * Voice (LiveKit) — public API for ICE v1.0 Slice A.
 *
 * Two surfaces:
 *   1. {@link getVoiceToken} — pure token minting (re-exported from ./token).
 *   2. {@link voiceTokenHandler} — a Hono handler the DRIVER mounts at
 *        POST /api/rooms/:roomId/voice/token
 *      (see this slice's wiringInstructions). It is deliberately self-contained
 *      and does NOT import the v0.1-owned api.ts / index.ts / config.ts, so the
 *      slice can be merged and wired without touching shared files.
 *
 * The handler reads `identity` + `name` from the JSON body (the web client sends
 * the room participant's id/name). If the body omits them it falls back to a
 * generated guest identity so a token is always usable. When LiveKit is not
 * configured it responds 503 with `{ error: 'voice_not_configured', message }`
 * so the client can render a friendly setup hint instead of failing opaquely.
 *
 * The driver may optionally pass an `identityResolver` to derive identity/name
 * from the authenticated session (so logged-in users get a stable voice
 * identity); when omitted we use the body / a guest id.
 */
import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import {
  getVoiceToken,
  isVoiceConfigured,
  resolveVoiceConfig,
  VoiceArgumentError,
  type GetVoiceTokenOptions,
  type VoiceConfig,
} from './token.js';

export {
  getVoiceToken,
  resolveVoiceConfig,
  isVoiceConfigured,
  VoiceArgumentError,
  DEFAULT_LIVEKIT_URL,
  VOICE_TOKEN_TTL_SECONDS,
} from './token.js';
export type {
  VoiceConfig,
  VoiceNotConfigured,
  VoiceTokenResult,
  GetVoiceTokenOptions,
} from './token.js';

/** How the handler decides who the caller is inside the voice room. */
export interface VoiceIdentity {
  identity: string;
  name: string;
}

/** Optional hooks the driver can supply when mounting the handler. */
export interface VoiceHandlerOptions {
  /**
   * Resolve identity/name from the request context (e.g. the auth session),
   * taking precedence over the request body. Return `null` to fall back to the
   * body / a generated guest identity.
   */
  identityResolver?: (c: Context) => VoiceIdentity | null | undefined;
  /** Inject a fixed config (tests); defaults to env-derived resolution. */
  config?: VoiceConfig;
  /** Token-minting options forwarded to {@link getVoiceToken} (tests). */
  tokenOptions?: GetVoiceTokenOptions;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

/** Tolerant JSON body reader — never throws on empty/invalid bodies. */
async function readJsonBody(c: Context): Promise<Record<string, unknown>> {
  try {
    const v = await c.req.json();
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Build the Hono handler for `POST /api/rooms/:roomId/voice/token`.
 *
 * Returns 200 `{ url, token, room, identity }` (a {@link VoiceTokenResponse})
 * on success, 503 `{ error: 'voice_not_configured', message }` when LiveKit
 * credentials are absent, and 400 on a bad request.
 */
export function makeVoiceTokenHandler(options: VoiceHandlerOptions = {}) {
  return async function voiceTokenHandler(c: Context): Promise<Response> {
    const roomId = c.req.param('roomId');
    if (!roomId) {
      return c.json({ error: 'room_required' }, 400);
    }

    const body = await readJsonBody(c);

    // Identity precedence: driver-provided resolver → request body → guest.
    const resolved = options.identityResolver?.(c) ?? null;
    const identity =
      asString(resolved?.identity) ??
      asString(body.identity) ??
      `guest_${randomUUID()}`;
    const name =
      asString(resolved?.name) ?? asString(body.name) ?? 'Guest';

    const tokenOpts: GetVoiceTokenOptions = {
      ...options.tokenOptions,
      ...(options.config ? { config: options.config } : {}),
    };

    let result;
    try {
      result = await getVoiceToken(roomId, identity, name, tokenOpts);
    } catch (err) {
      if (err instanceof VoiceArgumentError) {
        return c.json({ error: 'bad_request', message: err.message }, 400);
      }
      throw err;
    }

    if (!isVoiceConfigured(result)) {
      return c.json(
        { error: 'voice_not_configured', message: result.reason },
        503,
      );
    }
    return c.json(result);
  };
}

/**
 * Ready-to-mount default handler (env-derived config, no session resolver).
 * The driver can either use this directly:
 *   app.post('/api/rooms/:roomId/voice/token', voiceTokenHandler)
 * or build a session-aware one with {@link makeVoiceTokenHandler}.
 */
export const voiceTokenHandler = makeVoiceTokenHandler();

/** Convenience for boot logging: is voice usable with the current env? */
export function isVoiceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveVoiceConfig(env).configured;
}
