/**
 * Bootstrap for the headless smoke: registers the `.js`→`.ts` resolve hook so
 * Node (with type stripping) can import the project's TS source. Referenced via
 * `node --import ./smoke-bootstrap.mjs`. No dependencies.
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, 'ts-resolve-hook.mjs')).href, pathToFileURL('./'));
