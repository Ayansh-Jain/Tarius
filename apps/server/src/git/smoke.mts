/**
 * Manual smoke test for the ICE git server (not part of the test suite).
 * Run from apps/server with an isolated ICE_GIT_ROOT, e.g.:
 *
 *   ICE_DATA_DIR=$(mktemp -d) ICE_GIT_ROOT=$ICE_DATA_DIR/repos \
 *     node --import tsx src/git/smoke.mts
 *
 * Exercises the full smart-HTTP surface against a freshly-bound server:
 *   1. clone an auto-created (empty) room repo;
 *   2. push a commit into it;
 *   3. clone again elsewhere and verify the pushed content survived.
 *
 * IMPORTANT: the git server runs in THIS process and shares the event loop, so
 * we must invoke the `git` client ASYNCHRONOUSLY (never execFileSync, which
 * would block the loop and deadlock against our own in-process server). A real
 * client is a separate process, so this constraint is test-only.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { startGitServer } from './server.js';
import { bareRepoPath } from '../repos.js';

const execFileAsync = promisify(execFile);

function git(cwd: string, ...args: string[]): Promise<string> {
  return execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'ICE Smoke',
      GIT_AUTHOR_EMAIL: 'smoke@ice.test',
      GIT_COMMITTER_NAME: 'ICE Smoke',
      GIT_COMMITTER_EMAIL: 'smoke@ice.test',
    },
  }).then((r) => r.stdout.trim());
}

async function main(): Promise<void> {
  const roomId = `room_smoke_${Date.now()}`;
  const handle = await startGitServer(0); // ephemeral port
  const base = `http://127.0.0.1:${handle.port}/git/${roomId}.git`;
  // eslint-disable-next-line no-console
  console.log(`[smoke] server on :${handle.port}  base=${base}`);

  try {
    const work = mkdtempSync(path.join(tmpdir(), 'ice-smoke-'));

    // 1) Clone the not-yet-existing repo → auto-create, empty clone succeeds.
    const cloneA = path.join(work, 'cloneA');
    await git(work, 'clone', base, cloneA);
    if (!existsSync(bareRepoPath(roomId))) {
      throw new Error('bare repo was not auto-created on first clone');
    }
    // eslint-disable-next-line no-console
    console.log('[smoke] step 1 OK: auto-created + cloned empty repo');

    // 2) Commit + push into the room repo.
    writeFileSync(path.join(cloneA, 'README.md'), '# hello from ICE\n');
    await git(cloneA, 'add', 'README.md');
    await git(cloneA, 'commit', '-m', 'first commit');
    await git(cloneA, 'branch', '-M', 'main'); // deterministic branch name
    await git(cloneA, 'push', '-u', 'origin', 'main');
    // eslint-disable-next-line no-console
    console.log('[smoke] step 2 OK: pushed a commit');

    // 3) Fresh clone elsewhere → content must round-trip through the server.
    const cloneB = path.join(work, 'cloneB');
    await git(work, 'clone', base, cloneB);
    const got = readFileSync(path.join(cloneB, 'README.md'), 'utf8');
    if (got !== '# hello from ICE\n') {
      throw new Error(`round-trip mismatch: ${JSON.stringify(got)}`);
    }
    const log = await git(cloneB, 'log', '--oneline');
    // eslint-disable-next-line no-console
    console.log(`[smoke] step 3 OK: re-cloned, content matches, log=${JSON.stringify(log)}`);

    // eslint-disable-next-line no-console
    console.log('SMOKE_RESULT=PASS');
  } finally {
    await handle.close();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('SMOKE_RESULT=FAIL', err);
  process.exit(1);
});
