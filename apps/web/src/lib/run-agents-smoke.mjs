/**
 * Runner for the headless agent-model smoke (agents.smoke.ts).
 *
 * Same flags as run-smoke.mjs: type-strip the TS source directly and register
 * the `.js`→`.ts` resolve hook so `@ice/shared`'s internal specifiers resolve.
 *
 * Usage:  node apps/web/src/lib/run-agents-smoke.mjs
 * Exits non-zero if any subtest fails (CI-friendly).
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const bootstrap = join(here, 'smoke-bootstrap.mjs');
const smoke = join(here, 'agents.smoke.ts');

const res = spawnSync(
  process.execPath,
  ['--experimental-strip-types', '--import', bootstrap, '--test', smoke],
  { stdio: 'inherit' },
);

process.exit(res.status ?? 1);
