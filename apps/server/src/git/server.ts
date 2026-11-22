/**
 * ICE smart-HTTP git server (v0.3 Slice A — "Git comes home").
 *
 * Serves each room's BARE repository over git's smart-HTTP protocol so any plain
 * git client can `clone` / `fetch` / `push` / `pull` a room:
 *
 *     git clone http://<host>:<gitPort>/git/<roomId>.git
 *
 * Repos live at {@link bareRepoPath} (one room ↔ one bare repo) and are
 * auto-created on first access (`git init --bare` equivalent). This is the
 * read/write face of representation (3) in ADR-000 (committed git history); the
 * convergence slice commits the flushed working tree into these same bare repos.
 *
 * Implementation: thin wrapper over `node-git-server` (pure JS apart from
 * shelling out to the `git` CLI). We supply:
 *   • a custom `dirMap` that routes a request path to {@link bareRepoPath}; and
 *   • an `authenticate` hook that reuses {@link verifyRoomToken} /
 *     {@link verifySessionToken} from `../auth.js`.
 *
 * Auth policy:
 *   • dev (NODE_ENV !== 'production'): unauthenticated access is allowed so the
 *     demo "just works";
 *   • production: a valid ICE token is required (Bearer header or HTTP basic,
 *     username or password carrying the token), otherwise a 401 challenge.
 *
 * This module owns NO global side effects at import time. Call
 * {@link startGitServer} to bind a port, or mount {@link handleGitRequest} onto
 * an existing http.Server for single-port deployments.
 */
import type http from 'node:http';
import { Git, type GitAuthenticateOptions } from 'node-git-server';
import { bareRepoPath, sanitizeRoomId } from '../repos.js';
import { IS_PRODUCTION, PORT } from '../config.js';
import { verifyRoomToken, verifySessionToken } from '../auth.js';

/** Path prefix under which repos are advertised: `/git/<roomId>.git`. */
export const GIT_ROUTE_PREFIX = '/git';

/**
 * Internal port the standalone git server binds. Defaults to PORT+1 so it never
 * collides with the main REST/sync port. Overridable via ICE_GIT_PORT.
 */
export const GIT_PORT = Number(process.env.ICE_GIT_PORT ?? PORT + 1);

/**
 * Map an incoming request repo path to the room's bare-repo directory on disk.
 *
 * `node-git-server` hands us whatever it matched out of the URL, e.g. for
 * `/git/<roomId>.git/info/refs` it passes `"git/<roomId>.git"`. We normalise
 * that down to a roomId and resolve it through {@link bareRepoPath}, so the
 * server's `exists()`/`create()` and our routing all agree on one location.
 *
 * Accepts both the canonical `/git/<roomId>.git` form and a bare
 * `/<roomId>.git` form. Returns `null` for paths we refuse to serve (e.g. the
 * collection root, or a roomId that fails sanitisation), which the caller turns
 * into a 404 so a bad path can never auto-create a junk repo.
 */
export function resolveRepoDir(rawRepo: string | undefined): string | null {
  if (!rawRepo) return null;
  // Strip leading/trailing slashes and an optional `git/` mount prefix.
  let name = rawRepo.replace(/^\/+/, '').replace(/\/+$/, '');
  if (name === 'git') return null; // the mount root itself is not a repo
  if (name.startsWith('git/')) name = name.slice('git/'.length);
  // Drop a single trailing `.git` (git clients always send it).
  name = name.replace(/\.git$/, '');
  if (!name) return null;
  try {
    // sanitizeRoomId both validates and normalises; bareRepoPath re-applies it.
    sanitizeRoomId(name);
    return bareRepoPath(name);
  } catch {
    return null;
  }
}

/**
 * Pull an ICE token out of a git smart-HTTP request's Authorization header. Git
 * clients can carry a credential two ways:
 *   • `Authorization: Bearer <token>` — set via `git -c http.extraHeader=...`;
 *   • HTTP basic auth — username:password from a credential helper or a URL like
 *     `http://x-access-token:<token>@host/...`. We accept the token as the
 *     password (any username) or, when the password is empty, as the username.
 *
 * We parse the header ourselves rather than calling node-git-server's
 * `opts.user()` because that helper (a) only understands the Basic scheme, so a
 * Bearer header would never resolve its callback, and (b) writes its own 401 +
 * WWW-Authenticate when no header is present, which races our own rejection.
 */
function extractToken(headers: http.IncomingHttpHeaders): string | null {
  const raw = headers['authorization'];
  const auth = Array.isArray(raw) ? raw[0] : raw;
  if (typeof auth !== 'string') return null;

  const bearer = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (bearer && bearer[1]) return bearer[1].trim();

  const basic = /^Basic\s+(.+)$/i.exec(auth.trim());
  if (basic && basic[1]) {
    let decoded: string;
    try {
      decoded = Buffer.from(basic[1], 'base64').toString('utf8');
    } catch {
      return null;
    }
    const sep = decoded.indexOf(':');
    const username = sep >= 0 ? decoded.slice(0, sep) : decoded;
    const password = sep >= 0 ? decoded.slice(sep + 1) : '';
    if (password.length > 0) return password;
    if (username.length > 0 && username !== 'x-access-token' && username !== 'ice') {
      return username;
    }
  }
  return null;
}

/** A token is valid if it verifies as either a room token or a session token. */
async function isValidToken(token: string): Promise<boolean> {
  if (await verifyRoomToken(token)) return true;
  if (await verifySessionToken(token)) return true;
  return false;
}

/**
 * Build the `authenticate` hook node-git-server calls for every operation.
 *
 * In dev we short-circuit to allow. In production we require a valid ICE token
 * parsed from the Authorization header; failure throws, which node-git-server
 * renders as a 401 challenge so the git client can retry with credentials.
 */
async function authenticate(opts: GitAuthenticateOptions): Promise<void> {
  if (!IS_PRODUCTION) return; // dev: permissive, no challenge

  const token = extractToken(opts.headers);
  if (!token || !(await isValidToken(token))) {
    throw new Error('unauthorized: provide a valid ICE token');
  }
}

let gitInstance: Git | null = null;

/**
 * The shared {@link Git} engine (built once). Routes every repo path through
 * {@link resolveRepoDir} and auto-creates bare repos on first access.
 */
export function getGitEngine(): Git {
  if (gitInstance) return gitInstance;

  // `dirMap` MUST be deterministic and return the same dir for the same repo
  // string every time (node-git-server calls it repeatedly per request).
  const dirMap = (dir?: string): string => {
    const resolved = resolveRepoDir(dir);
    // For an unmappable path, hand back a sentinel that cannot exist and lives
    // OUTSIDE the repos tree, so exists() is false and auto-create can't write
    // anything meaningful. handleGitRequest rejects these up front anyway.
    return resolved ?? '/dev/null/ice-invalid-repo';
  };

  gitInstance = new Git(dirMap, {
    autoCreate: true,
    // Callback style ONLY: invoke `next` exactly once and return `undefined`.
    // (Returning the promise too would make node-git-server ALSO call its own
    // `next` via `promise.then(next)`, double-triggering infoResponse.)
    authenticate: (opts, next): void => {
      void authenticate(opts).then(
        () => next(),
        (err: Error) => next(err),
      );
    },
  });
  return gitInstance;
}

/**
 * Connect-style request handler for git smart-HTTP. Mount this on any
 * http.Server (single-port deployments) to serve repos under `/git/*`.
 *
 * Returns `true` if it handled (or claimed) the request, `false` if the path is
 * not a git route and the caller should fall through to other handlers. Bad
 * repo paths under `/git` are answered with 404 here (returning `true`) so they
 * never reach node-git-server's auto-create.
 */
export function handleGitRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  const url = req.url ?? '';
  const path = url.split('?')[0] ?? '';
  if (path !== GIT_ROUTE_PREFIX && !path.startsWith(`${GIT_ROUTE_PREFIX}/`)) {
    return false; // not ours
  }

  // Validate the target room before delegating, so an unmappable path is a clean
  // 404 instead of an attempted auto-create of a garbage directory.
  const repoSegment = path.replace(/\/(info\/refs|HEAD|git-[\w-]+)$/, '');
  if (resolveRepoDir(repoSegment) === null) {
    res.statusCode = 404;
    res.setHeader('content-type', 'text/plain');
    res.end('repository not found');
    return true;
  }

  getGitEngine().handle(req, res);
  return true;
}

/** Handle returned by {@link startGitServer} for lifecycle control. */
export interface GitServerHandle {
  /** The port the server is listening on. */
  port: number;
  /** The underlying node-git-server engine (exposes `push`/`fetch` events). */
  git: Git;
  /** Stop accepting connections and close the listener. */
  close: () => Promise<void>;
}

/**
 * Start the standalone smart-HTTP git server on its own internal port. This is
 * the reliable, zero-coupling integration: it never touches the REST/sync
 * http.Server. Clients clone `http://<host>:<port>/git/<roomId>.git`.
 *
 * @param port - port to bind; defaults to {@link GIT_PORT} (PORT+1 / ICE_GIT_PORT).
 */
export function startGitServer(port: number = GIT_PORT): Promise<GitServerHandle> {
  const git = getGitEngine();
  return new Promise<GitServerHandle>((resolve, reject) => {
    // node-git-server's listen() doesn't surface bind errors via callback, so
    // attach our own one-shot error handler around the initial listen.
    const onError = (err: Error): void => reject(err);
    git.listen(port, { type: 'http' }, () => {
      git.server?.off('error', onError);
      // Read the actually-bound port from the listener — important when the
      // caller passed 0 to request an ephemeral port.
      const addr = git.server?.address();
      const boundPort =
        addr && typeof addr === 'object' && typeof addr.port === 'number' ? addr.port : port;
      resolve({
        port: boundPort,
        git,
        close: () => stopGitServer(),
      });
    });
    git.server?.once('error', onError);
  });
}

/** Stop the standalone git server if one was started. Safe to call when idle. */
export async function stopGitServer(): Promise<void> {
  if (gitInstance?.server) {
    await gitInstance.close();
  }
}
