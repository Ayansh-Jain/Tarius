/**
 * Public integration surface for the ICE git server (v0.3 Slice A).
 *
 * The integrator wires exactly one of these into the server boot:
 *   • `startGitServer()` — recommended: binds a dedicated internal port
 *     (ICE_GIT_PORT, default PORT+1) and serves `/git/<roomId>.git`. Zero
 *     coupling to the REST/sync http.Server.
 *   • `handleGitRequest(req, res)` — for single-port setups: a connect-style
 *     handler to mount on the existing http.Server; returns `true` when it owns
 *     the request (`/git/*`), `false` to fall through.
 *
 * See ./server.ts for the wiring snippet.
 */
export {
  startGitServer,
  stopGitServer,
  handleGitRequest,
  getGitEngine,
  resolveRepoDir,
  GIT_PORT,
  GIT_ROUTE_PREFIX,
  type GitServerHandle,
} from './server.js';
