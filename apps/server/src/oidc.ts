/**
 * ICE OIDC login — OPTIONAL bring-your-own-IdP (v1.0 Slice D — "Hardening").
 *
 * Lets a self-host plug in any standards-compliant OpenID Connect provider
 * (Authentik, Keycloak, Auth0, Okta, Google, GitHub-via-Dex, …) alongside the
 * built-in email/password flow. It is *purely additive*: if the OIDC env vars
 * are unset, this is a no-op and email/password is unaffected — no error, no
 * network calls, `pg`-style lazy import of `openid-client` only when enabled.
 *
 * Flow (Authorization Code + PKCE, the modern default):
 *   GET /api/auth/oidc/login
 *     → 302 to the IdP's authorize endpoint. A short-lived, signed, httpOnly
 *       cookie carries the PKCE `code_verifier`, `state`, and `nonce`.
 *   GET /api/auth/oidc/callback?code=…&state=…
 *     → exchange the code, verify state+nonce, read the ID-Token claims, upsert a
 *       local user keyed by verified email, and establish the SAME httpOnly
 *       session cookie the email/password flow issues (so the rest of the app is
 *       oblivious to *how* you logged in).
 *
 * Env (all four required to enable; otherwise disabled):
 *   ICE_OIDC_ISSUER         e.g. https://idp.example.com/realms/ice
 *   ICE_OIDC_CLIENT_ID
 *   ICE_OIDC_CLIENT_SECRET  (omit for a public client; PKCE still protects the code)
 *   ICE_OIDC_REDIRECT_URI   e.g. https://ice.example.com/api/auth/oidc/callback
 *   ICE_OIDC_SCOPE          optional; defaults to "openid email profile"
 *
 * This file does NOT edit auth.ts / api.ts / config.ts. It reuses their exported
 * primitives (session signing, the session cookie name/TTL, user persistence)
 * and exposes {@link buildOidcRoutes} for the driver to mount onto the API app —
 * see wiringInstructions.
 */
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { SignJWT, jwtVerify } from 'jose';
import type { UserAccount } from '@ice/shared';
import {
  IS_PRODUCTION,
  PUBLIC_URL,
  SESSION_COOKIE,
  SESSION_SECRET,
  SESSION_TTL_SECONDS,
} from './config.js';
import { hashPassword, signSessionToken } from './auth.js';
import { createUser, findUserByEmail, toUserAccount, type UserRow } from './db.js';

// ── Configuration (env) ───────────────────────────────────────────────────────

/** Resolved, validated OIDC configuration. `null` ⇒ OIDC disabled. */
export interface OidcEnv {
  issuer: string;
  clientId: string;
  /** Undefined for a public client (PKCE-only). */
  clientSecret: string | undefined;
  redirectUri: string;
  scope: string;
}

/**
 * Read + validate OIDC settings from the environment. Returns `null` (disabled)
 * unless issuer, client id, and redirect URI are all present. Never throws.
 */
export function readOidcEnv(env: NodeJS.ProcessEnv = process.env): OidcEnv | null {
  const issuer = env.ICE_OIDC_ISSUER?.trim();
  const clientId = env.ICE_OIDC_CLIENT_ID?.trim();
  const redirectUri =
    env.ICE_OIDC_REDIRECT_URI?.trim() || `${PUBLIC_URL}/api/auth/oidc/callback`;
  const clientSecret = env.ICE_OIDC_CLIENT_SECRET?.trim() || undefined;
  const scope = env.ICE_OIDC_SCOPE?.trim() || 'openid email profile';

  if (!issuer || !clientId) return null;
  // A redirect URI is always derivable from PUBLIC_URL, so issuer+clientId gate.
  return { issuer, clientId, clientSecret, redirectUri, scope };
}

/** Cheap check the driver can use to decide whether to advertise the SSO button. */
export function isOidcEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readOidcEnv(env) != null;
}

// ── Discovery (lazy, cached) ──────────────────────────────────────────────────

// `openid-client` v6 is ESM-only and pulls in crypto-heavy deps; import it lazily
// so a deployment without OIDC never loads it. The discovered Configuration is
// cached per-process (re-discovered only if discovery previously failed).
type OidcModule = typeof import('openid-client');
type Configuration = Awaited<ReturnType<OidcModule['discovery']>>;

let modPromise: Promise<OidcModule> | null = null;
let configPromise: Promise<Configuration> | null = null;

function loadModule(): Promise<OidcModule> {
  if (!modPromise) modPromise = import('openid-client');
  return modPromise;
}

/** Discover (once) the provider's endpoints and build a client Configuration. */
export async function getOidcConfiguration(cfg: OidcEnv): Promise<Configuration> {
  if (configPromise) return configPromise;
  configPromise = (async () => {
    const oidc = await loadModule();
    const config = await oidc.discovery(
      new URL(cfg.issuer),
      cfg.clientId,
      // `metadata` accepts the client secret string for confidential clients;
      // omitting it yields a public client (PKCE still secures the exchange).
      cfg.clientSecret,
    );
    // Allow http issuers only outside production (local IdP during dev).
    if (!IS_PRODUCTION && cfg.issuer.startsWith('http://')) {
      oidc.allowInsecureRequests(config);
    }
    return config;
  })().catch((err) => {
    // Reset so a transient discovery failure can be retried on the next request.
    configPromise = null;
    throw err;
  });
  return configPromise;
}

// ── Transaction cookie (PKCE verifier + state + nonce) ─────────────────────────

const TXN_COOKIE = 'ice_oidc_txn';
const TXN_TTL_SECONDS = 600; // 10 minutes to complete the round-trip

interface OidcTxn {
  /** PKCE code_verifier. */
  v: string;
  /** CSRF state. */
  s: string;
  /** Replay-protection nonce. */
  n: string;
  /** Optional post-login redirect target (path only, validated on callback). */
  r?: string;
}

async function signTxn(txn: OidcTxn): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ kind: 'oidc-txn', ...txn })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + TXN_TTL_SECONDS)
    .sign(SESSION_SECRET);
}

async function verifyTxn(token: string | undefined): Promise<OidcTxn | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, SESSION_SECRET);
    if (payload.kind !== 'oidc-txn') return null;
    const { v, s, n, r } = payload as Record<string, unknown>;
    if (typeof v !== 'string' || typeof s !== 'string' || typeof n !== 'string') return null;
    return { v, s, n, r: typeof r === 'string' ? r : undefined };
  } catch {
    return null;
  }
}

// ── Session + user upsert ──────────────────────────────────────────────────────

/** Per-request state we read off the Hono context (set elsewhere). */
type OidcRouteEnv = { Variables: Record<string, never> };

function setSessionCookie(c: Parameters<typeof setCookie>[0], token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: IS_PRODUCTION,
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
}

/** Claims we care about from the ID Token / userinfo. */
interface OidcIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | undefined;
}

/**
 * How a local user is provisioned from a verified OIDC identity, overridable for
 * tests / alternative metadata backends. Defaults to db.ts.
 */
export interface OidcUserStore {
  findUserByEmail(email: string): UserRow | null | Promise<UserRow | null>;
  createUser(row: UserRow): void | Promise<void>;
}

const DEFAULT_USER_STORE: OidcUserStore = { findUserByEmail, createUser };

/**
 * Map a verified OIDC identity to a local UserRow, creating one on first login
 * (JIT provisioning). Users are keyed by email; the random password is never
 * usable for login (OIDC users don't have a local password) but keeps the
 * NOT NULL column satisfied and the row shaped like every other user.
 */
async function upsertUserFromIdentity(
  id: OidcIdentity,
  store: OidcUserStore,
): Promise<UserRow> {
  const email = id.email.toLowerCase();
  const existing = await store.findUserByEmail(email);
  if (existing) return existing;

  const row: UserRow = {
    id: `user_${randomUUID()}`,
    email,
    displayName: id.name?.trim() || email.split('@')[0] || 'User',
    // Unusable local password: a long random secret the user never sees.
    passwordHash: hashPassword(`oidc:${randomUUID()}:${randomUUID()}`),
    createdAt: Date.now(),
  };
  await store.createUser(row);
  return row;
}

/** Only allow same-origin path redirects (defend against open redirects). */
function safeReturnPath(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  // Must be an absolute path on our own origin, not a protocol-relative `//host`.
  if (!raw.startsWith('/') || raw.startsWith('//')) return undefined;
  return raw;
}

// ── Routes ─────────────────────────────────────────────────────────────────────

/** Dependencies the driver may inject; all optional with sensible defaults. */
export interface OidcRoutesOptions {
  env?: NodeJS.ProcessEnv;
  /** Override the IdP config (skips env reading). */
  config?: OidcEnv | null;
  /** Override how local users are provisioned (e.g. a Postgres-backed store). */
  userStore?: OidcUserStore;
  /** Where to send the browser after a successful login. Default: PUBLIC_URL root. */
  successRedirect?: string;
}

/**
 * Build the OIDC sub-app: `GET /login` and `GET /callback`.
 *
 * Returns `null` when OIDC is disabled, so the driver can do:
 *
 *   const oidc = buildOidcRoutes();
 *   if (oidc) app.route('/api/auth/oidc', oidc);
 *
 * When enabled, mounting it at `/api/auth/oidc` yields the documented
 * `/api/auth/oidc/login` and `/api/auth/oidc/callback` endpoints.
 */
export function buildOidcRoutes(options: OidcRoutesOptions = {}): Hono<OidcRouteEnv> | null {
  const cfg = options.config !== undefined ? options.config : readOidcEnv(options.env);
  if (!cfg) return null;

  const userStore = options.userStore ?? DEFAULT_USER_STORE;
  const successRedirect = options.successRedirect ?? `${PUBLIC_URL}/`;
  const app = new Hono<OidcRouteEnv>();

  // Kick off login: build the authorize URL with PKCE + state + nonce.
  app.get('/login', async (c) => {
    let oidc: OidcModule;
    let config: Configuration;
    try {
      oidc = await loadModule();
      config = await getOidcConfiguration(cfg);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[ice] oidc discovery failed:', err);
      return c.json({ error: 'oidc_unavailable' }, 503);
    }

    const codeVerifier = oidc.randomPKCECodeVerifier();
    const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();

    const params: Record<string, string> = {
      redirect_uri: cfg.redirectUri,
      scope: cfg.scope,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      nonce,
    };
    const authUrl = oidc.buildAuthorizationUrl(config, params);

    const ret = safeReturnPath(c.req.query('returnTo'));
    const txn = await signTxn({ v: codeVerifier, s: state, n: nonce, r: ret });
    setCookie(c, TXN_COOKIE, txn, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: IS_PRODUCTION,
      path: '/api/auth/oidc',
      maxAge: TXN_TTL_SECONDS,
    });

    return c.redirect(authUrl.href);
  });

  // Complete login: exchange the code, verify, upsert the user, set the session.
  app.get('/callback', async (c) => {
    const txn = await verifyTxn(getCookie(c, TXN_COOKIE));
    deleteCookie(c, TXN_COOKIE, { path: '/api/auth/oidc' });
    if (!txn) return c.json({ error: 'oidc_state_missing' }, 400);

    // Surface IdP-side errors (user denied consent, etc.) cleanly.
    const idpError = c.req.query('error');
    if (idpError) {
      return c.json({ error: 'oidc_denied', detail: idpError }, 400);
    }

    let oidc: OidcModule;
    let config: Configuration;
    try {
      oidc = await loadModule();
      config = await getOidcConfiguration(cfg);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[ice] oidc discovery failed:', err);
      return c.json({ error: 'oidc_unavailable' }, 503);
    }

    // Reconstruct the exact callback URL the IdP redirected to.
    const currentUrl = new URL(cfg.redirectUri);
    currentUrl.search = new URL(c.req.url).search;

    let identity: OidcIdentity;
    try {
      const tokens = await oidc.authorizationCodeGrant(config, currentUrl, {
        pkceCodeVerifier: txn.v,
        expectedState: txn.s,
        expectedNonce: txn.n,
        idTokenExpected: true,
      });

      const claims = tokens.claims();
      if (!claims?.sub) return c.json({ error: 'oidc_no_subject' }, 400);

      // Prefer ID-Token claims; fall back to the userinfo endpoint for email/name.
      let email = typeof claims.email === 'string' ? claims.email : undefined;
      let emailVerified = claims.email_verified === true;
      let name = typeof claims.name === 'string' ? claims.name : undefined;

      if (!email) {
        const info = await oidc.fetchUserInfo(config, tokens.access_token, claims.sub);
        if (typeof info.email === 'string') email = info.email;
        if (info.email_verified === true) emailVerified = true;
        if (typeof info.name === 'string') name = info.name;
      }

      if (!email) return c.json({ error: 'oidc_no_email' }, 400);

      identity = { sub: claims.sub, email, emailVerified, name };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[ice] oidc code exchange failed:', err);
      return c.json({ error: 'oidc_exchange_failed' }, 401);
    }

    // In production, require a verified email so SSO can't be spoofed by an IdP
    // that hands out unverified addresses. Dev is lenient for local IdPs.
    if (IS_PRODUCTION && !identity.emailVerified) {
      return c.json({ error: 'oidc_email_unverified' }, 403);
    }

    const user = await upsertUserFromIdentity(identity, userStore);
    const sessionToken = await signSessionToken(user);
    setSessionCookie(c, sessionToken);

    const dest = txn.r ? `${PUBLIC_URL}${txn.r}` : successRedirect;
    return c.redirect(dest);
  });

  return app;
}

/** Convenience: the wire shape the driver may surface to the SPA login screen. */
export function oidcStatus(env: NodeJS.ProcessEnv = process.env): {
  enabled: boolean;
  loginUrl?: string;
} {
  if (!isOidcEnabled(env)) return { enabled: false };
  return { enabled: true, loginUrl: '/api/auth/oidc/login' };
}

// Re-exported so the driver can convert a provisioned UserRow to the wire type
// without importing db.ts separately.
export { toUserAccount };
export type { UserAccount };
