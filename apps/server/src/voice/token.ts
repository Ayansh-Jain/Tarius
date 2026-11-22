/**
 * Voice token minting — ICE v1.0 "Code with friends, out loud" (Slice A).
 *
 * ICE never carries voice MEDIA. The only server responsibility is to mint a
 * short-lived LiveKit access token scoped to a single room-join; the browser
 * then talks WebRTC straight to the LiveKit SFU (self-hosted or LiveKit Cloud).
 * This keeps the architectural law intact — the room's truth is the Yjs doc; a
 * voice huddle is an ephemeral side-channel that leaves no state behind.
 *
 * Config is read from the environment ONCE, here, so the rest of the server
 * never touches `process.env` for voice:
 *   LIVEKIT_URL        ws(s):// URL the client connects to (default localhost).
 *   LIVEKIT_API_KEY    API key   (LiveKit dev default: "devkey").
 *   LIVEKIT_API_SECRET API secret(LiveKit dev default: "secret").
 *
 * If the key/secret are not configured we DO NOT throw or fabricate a token —
 * we return a typed "not configured" signal the route handler turns into a 503,
 * so the web client can show a friendly "voice needs LIVEKIT_* env" state rather
 * than failing opaquely. The localhost defaults match the example LiveKit dev
 * server (`livekit-server --dev`) so a self-hoster's first run "just works".
 */
import { AccessToken } from 'livekit-server-sdk';
import type { VoiceTokenResponse } from '@ice/shared';

/** The well-known LiveKit dev server URL (matches `livekit-server --dev`). */
export const DEFAULT_LIVEKIT_URL = 'ws://localhost:7880';

/** LiveKit's documented dev-mode credentials (NEVER use these in production). */
const DEV_API_KEY = 'devkey';
const DEV_API_SECRET = 'secret';

/** How long a minted join token stays valid. Long enough for a huddle, short
 *  enough to be unattractive if leaked. The token only grants room-join. */
export const VOICE_TOKEN_TTL_SECONDS = 60 * 60 * 6; // 6 hours

/** Resolved voice configuration, derived from the environment. */
export interface VoiceConfig {
  /** Whether voice is usable: a key + secret are present (defaults count). */
  readonly configured: boolean;
  /** ws(s):// URL advertised to the client. */
  readonly url: string;
  readonly apiKey: string;
  readonly apiSecret: string;
}

/** Returned instead of a token when LiveKit credentials are absent. */
export interface VoiceNotConfigured {
  readonly configured: false;
  /** Human-readable reason the route surfaces in its 503 body. */
  readonly reason: string;
}

/** Discriminated result of {@link getVoiceToken}: a token, or "not configured". */
export type VoiceTokenResult = VoiceTokenResponse | VoiceNotConfigured;

/** Narrowing helper: true when the result is a real token (not the 503 signal). */
export function isVoiceConfigured(
  result: VoiceTokenResult,
): result is VoiceTokenResponse {
  return (result as VoiceNotConfigured).configured !== false;
}

function trimOrUndefined(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t && t.length > 0 ? t : undefined;
}

/**
 * Resolve voice configuration from an env bag (defaults to `process.env`).
 *
 * Voice counts as "configured" whenever BOTH a key and a secret resolve. In
 * local dev they resolve to LiveKit's published dev credentials so the huddle
 * works against `livekit-server --dev` with zero setup; in production the
 * operator MUST set real `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`.
 *
 * `requireExplicitCreds` (set when NODE_ENV=production) suppresses the dev
 * fallback so a misconfigured prod deploy fails closed (503 "not configured")
 * instead of silently minting tokens signed with the public dev secret.
 */
export function resolveVoiceConfig(
  env: NodeJS.ProcessEnv = process.env,
): VoiceConfig {
  const url = trimOrUndefined(env.LIVEKIT_URL) ?? DEFAULT_LIVEKIT_URL;
  const explicitKey = trimOrUndefined(env.LIVEKIT_API_KEY);
  const explicitSecret = trimOrUndefined(env.LIVEKIT_API_SECRET);

  const requireExplicitCreds = env.NODE_ENV === 'production';
  const apiKey = explicitKey ?? (requireExplicitCreds ? undefined : DEV_API_KEY);
  const apiSecret =
    explicitSecret ?? (requireExplicitCreds ? undefined : DEV_API_SECRET);

  if (!apiKey || !apiSecret) {
    return { configured: false, url, apiKey: '', apiSecret: '' };
  }
  return { configured: true, url, apiKey, apiSecret };
}

/** Options for {@link getVoiceToken} (mainly to inject env/config in tests). */
export interface GetVoiceTokenOptions {
  /** Pre-resolved config; when omitted we derive it from {@link env}. */
  config?: VoiceConfig;
  /** Environment bag used to resolve config when {@link config} is absent. */
  env?: NodeJS.ProcessEnv;
  /** Token lifetime override (seconds). */
  ttlSeconds?: number;
}

/**
 * Mint a LiveKit room-join token for `identity` in the voice room named by
 * `roomId`. The voice room name is exactly the ICE roomId, so the huddle maps
 * 1:1 to the workspace.
 *
 * The grant is intentionally minimal: join the named room and publish/subscribe
 * audio. No room-admin, no recording, no other rooms. If LiveKit isn't
 * configured we return {@link VoiceNotConfigured} so the caller can 503.
 *
 * @param roomId   The ICE room / workspace id; becomes the LiveKit room name.
 * @param identity Stable per-user identity inside the voice room (e.g. the
 *                 participant id). LiveKit dedupes/reconnects by identity.
 * @param name     Display name shown to other huddle members.
 */
export async function getVoiceToken(
  roomId: string,
  identity: string,
  name: string,
  options: GetVoiceTokenOptions = {},
): Promise<VoiceTokenResult> {
  const room = roomId.trim();
  const who = identity.trim();
  if (!room) throw new VoiceArgumentError('roomId is required');
  if (!who) throw new VoiceArgumentError('identity is required');

  const config = options.config ?? resolveVoiceConfig(options.env);
  if (!config.configured) {
    return {
      configured: false,
      reason:
        'Voice is not configured. Set LIVEKIT_API_KEY and LIVEKIT_API_SECRET ' +
        '(and optionally LIVEKIT_URL) to enable voice huddles.',
    };
  }

  const at = new AccessToken(config.apiKey, config.apiSecret, {
    identity: who,
    // Fall back to the identity if no display name was supplied.
    name: name.trim() || who,
    ttl: options.ttlSeconds ?? VOICE_TOKEN_TTL_SECONDS,
  });
  at.addGrant({
    roomJoin: true,
    room,
    canPublish: true, // publish own mic
    canSubscribe: true, // hear everyone else
    canPublishData: true, // (push-to-talk state, future presence pings)
  });

  const token = await at.toJwt();
  return { url: config.url, token, room, identity: who };
}

/** Thrown for caller mistakes (empty roomId/identity) — distinct from "not
 *  configured", which is a normal, expected 503 condition. */
export class VoiceArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoiceArgumentError';
  }
}
