/**
 * Shell resolution + node-pty native-addon repair (v0.5, Slice B).
 *
 * Two concerns that both backends share:
 *
 *  1. Pick a shell. Prefer $SHELL, then common login shells, finally /bin/sh —
 *     and on Windows %COMSPEC% / cmd.exe. We probe the filesystem so a missing
 *     shell degrades gracefully instead of throwing deep inside a backend.
 *
 *  2. Make node-pty's prebuilt `spawn-helper` executable. node-pty 1.x ships
 *     prebuilt binaries via prebuildify, but some package managers (pnpm in
 *     particular) unpack the `spawn-helper` without its execute bit. node-pty
 *     then `posix_spawn`s a non-executable file and fails with the opaque
 *     "posix_spawnp failed." We best-effort `chmod +x` the helper for the
 *     current platform before the first spawn. Idempotent and silent on
 *     failure (the caller falls back to child_process if pty still can't spawn).
 */
import { accessSync, chmodSync, constants, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const IS_WINDOWS = process.platform === 'win32';

/** Candidate shells in preference order for the current platform. */
function shellCandidates(): string[] {
  if (IS_WINDOWS) {
    return [process.env.COMSPEC, 'C:\\Windows\\System32\\cmd.exe', 'cmd.exe'].filter(
      (s): s is string => Boolean(s),
    );
  }
  return [process.env.SHELL, '/bin/bash', '/bin/zsh', '/bin/sh'].filter(
    (s): s is string => Boolean(s),
  );
}

/** True if `p` exists and is executable (or, on Windows, simply exists). */
function isUsableShell(p: string): boolean {
  try {
    if (IS_WINDOWS) {
      // On Windows an absolute path must exist; a bare "cmd.exe" is resolved via PATH.
      return path.isAbsolute(p) ? existsSync(p) : true;
    }
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a usable shell, honouring an explicit override first. Returns the
 * first candidate that exists and is executable, or `null` if none do — callers
 * treat `null` as "no shell available" and surface a clear message into the
 * terminal rather than crashing.
 */
export function resolveShell(preferred?: string): string | null {
  const ordered = preferred ? [preferred, ...shellCandidates()] : shellCandidates();
  for (const candidate of ordered) {
    if (isUsableShell(candidate)) return candidate;
  }
  return null;
}

/** The `-c`-style flag this shell uses to run a single command string. */
export function commandFlag(shell: string): string {
  return IS_WINDOWS && /cmd\.exe$/i.test(shell) ? '/c' : '-c';
}

let helperRepairAttempted = false;

/**
 * Ensure node-pty's prebuilt `spawn-helper` is executable. Best-effort and
 * memoised (runs its filesystem work at most once per process). Returns true if
 * the helper now looks runnable (or if there's nothing to repair, e.g. on
 * Windows which has no spawn-helper), false if we couldn't make it executable.
 */
export function ensurePtySpawnHelperExecutable(): boolean {
  if (IS_WINDOWS) return true; // No spawn-helper on Windows.
  if (helperRepairAttempted) return true;
  helperRepairAttempted = true;

  try {
    // Resolve node-pty relative to THIS module so we find the same install the
    // backend will load, regardless of cwd.
    const require = createRequire(import.meta.url);
    const ptyPkgJson = require.resolve('node-pty/package.json');
    const ptyDir = path.dirname(ptyPkgJson);

    const platformDir = `${process.platform}-${process.arch}`;
    const helper = path.join(ptyDir, 'prebuilds', platformDir, 'spawn-helper');
    if (!existsSync(helper)) return true; // Built-from-source installs have none here.

    const mode = statSync(helper).mode;
    const hasExec = (mode & 0o111) !== 0;
    if (!hasExec) {
      // Add execute for user/group/other, preserving read bits.
      chmodSync(helper, mode | 0o755);
    }
    return true;
  } catch {
    // If anything goes wrong we simply let the backend try; on failure the
    // selector falls through to the child_process backend.
    return false;
  }
}
