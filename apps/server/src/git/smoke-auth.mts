/**
 * Auth smoke for the ICE git server in PRODUCTION mode (manual, not in suite).
 * Verifies:
 *   • unauthenticated clone is rejected (git fails, server sent 401); and
 *   • a clone carrying a valid ICE session token in an Authorization header
 *     succeeds.
 *
 * Run from apps/server with NODE_ENV=production and a fixed ICE_SESSION_SECRET:
 *   NODE_ENV=production ICE_SESSION_SECRET=test-secret \
 *   ICE_DATA_DIR=$(mktemp -d) ICE_GIT_ROOT=$ICE_DATA_DIR/repos \
 *     node --import tsx src/git/smoke-auth.mts
 */
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { startGitServer } from './server.js';
import { signSessionToken } from '../auth.js';

const execFileAsync = promisify(execFile);

async function cloneWithHeader(
  base: string,
  dest: string,
  authHeader: string | null,
): Promise<{ ok: boolean; stderr: string }> {
  const args = ['clone'];
  if (authHeader) args.push('-c', `http.extraHeader=${authHeader}`);
  args.push(base, dest);
  try {
    await execFileAsync('git', args, {
      encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return { ok: true, stderr: '' };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    return { ok: false, stderr: e.stderr ?? e.message ?? '' };
  }
}

async function main(): Promise<void> {
  const roomId = `room_auth_${Date.now()}`;
  const handle = await startGitServer(0);
  const base = `http://127.0.0.1:${handle.port}/git/${roomId}.git`;
  const work = mkdtempSync(path.join(tmpdir(), 'ice-auth-'));
  // eslint-disable-next-line no-console
  console.log(`[auth] PROD server on :${handle.port}`);

  try {
    // (a) No credentials → must be rejected. A correct rejection manifests as
    // the server returning 401 + WWW-Authenticate, after which git either prints
    // an auth/403 error or (with prompts disabled) refuses for lack of a
    // username. All of these mean "the server denied anonymous access".
    const noAuth = await cloneWithHeader(base, path.join(work, 'noauth'), null);
    const rejected =
      !noAuth.ok &&
      /401|403|Authentication|authorization|Unauthorized|unauthorized|could not read Username|terminal prompts disabled/i.test(
        noAuth.stderr,
      );
    // eslint-disable-next-line no-console
    console.log(`[auth] unauthenticated clone rejected=${rejected}`);
    if (!rejected) throw new Error(`expected rejection, got: ok=${noAuth.ok} stderr=${noAuth.stderr}`);

    // (b) Valid ICE token in Authorization header → must succeed.
    const token = await signSessionToken({ id: 'user_test', email: 'a@b.c', displayName: 'A' });
    const withAuth = await cloneWithHeader(
      base,
      path.join(work, 'withauth'),
      `Authorization: Bearer ${token}`,
    );
    // eslint-disable-next-line no-console
    console.log(`[auth] tokened clone ok=${withAuth.ok}${withAuth.ok ? '' : ' stderr=' + withAuth.stderr}`);
    if (!withAuth.ok) throw new Error(`expected tokened clone to succeed: ${withAuth.stderr}`);

    // eslint-disable-next-line no-console
    console.log('AUTH_RESULT=PASS');
  } finally {
    await handle.close();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('AUTH_RESULT=FAIL', err);
  process.exit(1);
});
