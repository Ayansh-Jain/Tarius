/**
 * Runner for the headless file-tree smoke (tree.smoke.ts).
 *
 * Wraps the Node flags needed to execute the project's TS source directly:
 *  - `--experimental-strip-types` : run .ts without a build step (Node >= 22.6).
 *  - `--import smoke-bootstrap.mjs`: register a resolve hook that rewrites the
 *    `.js` specifiers in @ice/shared to their adjacent `.ts` files.
 *
 * Usage:  node apps/web/src/lib/run-smoke.mjs
 * Exits non-zero if any subtest fails (CI-friendly).
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const bootstrap = join(here, 'smoke-bootstrap.mjs');
const smoke = join(here, 'tree.smoke.ts');

const res = spawnSync(
  process.execPath,
  ['--experimental-strip-types', '--import', bootstrap, '--test', smoke],
  { stdio: 'inherit' },
);

process.exit(res.status ?? 1);
