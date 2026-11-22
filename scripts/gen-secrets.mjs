#!/usr/bin/env node
/**
 * ICE — secret generator.
 *
 * Emits a single cryptographically-random secret suitable for ICE_SESSION_SECRET
 * (the HMAC key that signs the `ice_session` cookie / JWT). No dependencies — uses
 * only Node's built-in crypto, so it runs in the bare `node:22-alpine` image during
 * container startup as well as on a developer's machine.
 *
 * Usage:
 *   node scripts/gen-secrets.mjs                 # prints a raw 64-hex-char secret to stdout
 *   node scripts/gen-secrets.mjs --env           # prints ICE_SESSION_SECRET=<secret>
 *   node scripts/gen-secrets.mjs --env >> .env   # append a generated secret to .env
 *   node scripts/gen-secrets.mjs --bytes 48      # change entropy (default 32 bytes / 256 bits)
 *
 * Exit code is 0 on success; the secret is the only thing written to stdout in raw
 * mode so it is safe to capture with `$(node scripts/gen-secrets.mjs)`.
 */
import { randomBytes } from 'node:crypto';

/** Parse the tiny flag set we support without pulling in a CLI library. */
function parseArgs(argv) {
  const opts = { env: false, bytes: 32, name: 'ICE_SESSION_SECRET' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--env' || arg === '-e') {
      opts.env = true;
    } else if (arg === '--bytes' || arg === '-b') {
      const next = Number(argv[i + 1]);
      if (!Number.isInteger(next) || next < 16) {
        process.stderr.write('gen-secrets: --bytes must be an integer >= 16\n');
        process.exit(1);
      }
      opts.bytes = next;
      i += 1;
    } else if (arg === '--name' || arg === '-n') {
      const next = argv[i + 1];
      if (!next) {
        process.stderr.write('gen-secrets: --name requires a value\n');
        process.exit(1);
      }
      opts.name = next;
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'Usage: node scripts/gen-secrets.mjs [--env] [--bytes N] [--name VAR]\n',
      );
      process.exit(0);
    } else {
      process.stderr.write(`gen-secrets: unknown argument "${arg}"\n`);
      process.exit(1);
    }
  }
  return opts;
}

/** Generate a hex secret with the requested entropy. */
export function generateSecret(bytes = 32) {
  return randomBytes(bytes).toString('hex');
}

const opts = parseArgs(process.argv.slice(2));
const secret = generateSecret(opts.bytes);
process.stdout.write(opts.env ? `${opts.name}=${secret}\n` : `${secret}\n`);
