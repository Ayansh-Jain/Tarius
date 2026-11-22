/**
 * Backend selection (v0.5, Slice B).
 *
 * Prefer a real pty (node-pty) — interactive, ANSI-correct — and fall back to
 * the dependency-free child_process backend when the native addon can't spawn
 * in this environment. The decision is probed once per process (spawning a real
 * pty is the only reliable test; "can require node-pty" isn't enough because
 * `posix_spawn` of the prebuilt spawn-helper can still fail). Subsequent room
 * terminals reuse the cached decision.
 *
 * Both the persistent interactive backend and the one-shot command runner are
 * routed through here so a room's interactive shell and its `runCommand` always
 * agree on which implementation is live.
 */
import type { TerminalBackend, TerminalOptions } from './types.js';
import {
  createPtyInteractive,
  ptyIsSpawnable,
  runPtyOnce,
  type RunOnceResult,
} from './pty-backend.js';
import {
  createChildProcessInteractive,
  runChildProcessOnce,
} from './child-process-backend.js';

export type BackendKind = TerminalBackend['kind'];

let cachedKind: BackendKind | null = null;

/**
 * Decide which backend to use (memoised). `probeOpts` only influences the pty
 * spawn probe (cwd/shell); the result is cached for the process lifetime.
 */
export function selectBackendKind(probeOpts: TerminalOptions = {}): BackendKind {
  if (cachedKind) return cachedKind;
  // On Windows, node-pty's ConPTY kill path ("AttachConsole failed") crashes the
  // process when the probe pty is killed right after spawn, so default to the
  // child_process backend there. Set ICE_FORCE_PTY=1 to opt back in.
  const skipPty = process.platform === 'win32' && process.env.ICE_FORCE_PTY !== '1';
  cachedKind = !skipPty && ptyIsSpawnable(probeOpts) ? 'node-pty' : 'child-process';
  return cachedKind;
}

/** Reset the cached decision — test-only seam. */
export function resetBackendSelectionForTests(): void {
  cachedKind = null;
}

/** Force a specific backend — test-only seam (e.g. to exercise the fallback). */
export function forceBackendForTests(kind: BackendKind | null): void {
  cachedKind = kind;
}

/** Construct the persistent interactive backend for the selected kind. */
export function createInteractiveBackend(opts: TerminalOptions): TerminalBackend {
  const kind = selectBackendKind(opts);
  if (kind === 'node-pty') {
    try {
      return createPtyInteractive(opts);
    } catch {
      // A late pty failure: downgrade permanently and use the fallback.
      cachedKind = 'child-process';
    }
  }
  return createChildProcessInteractive(opts);
}

/** Run a single command via the selected backend's one-shot runner. */
export function runOnceWithSelectedBackend(
  cmd: string,
  opts: TerminalOptions,
  onData: (chunk: string) => void,
): Promise<RunOnceResult> {
  const kind = selectBackendKind(opts);
  if (kind === 'node-pty') {
    return runPtyOnce(cmd, opts, onData).catch((err) => {
      // Downgrade and retry once on the fallback so a transient pty failure
      // never breaks a command run.
      cachedKind = 'child-process';
      void err;
      return runChildProcessOnce(cmd, opts, onData);
    });
  }
  return runChildProcessOnce(cmd, opts, onData);
}

export type { RunOnceResult };
