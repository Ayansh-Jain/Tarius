/**
 * child_process terminal fallback (v0.5, Slice B).
 *
 * Dependency-free backend used when node-pty's native addon can't spawn in the
 * host environment (locked-down CI sandbox, no prebuilt binary for the
 * platform, missing build toolchain). It is NOT a real pty — there's no tty, so
 * line editing / job control / full ANSI behaviour differ — but it streams the
 * same bytes into the same shared Y.Text, so `runCommand('echo …')` works and
 * the product degrades gracefully instead of failing. stdout and stderr are
 * both forwarded so errors are visible.
 *
 * Two shapes mirror the pty backend:
 *   • {@link createChildProcessInteractive} — a persistent shell fed via stdin;
 *   • {@link runChildProcessOnce} — a discrete `shell -c cmd` with exit code.
 */
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { TerminalBackend, TerminalOptions } from './types.js';
import { commandFlag, resolveShell } from './shell.js';
import type { RunOnceResult } from './pty-backend.js';

function cleanEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/**
 * A persistent interactive-ish shell over child_process. The shell reads
 * commands from stdin (so RoomTerminal.write forwards keystrokes/lines), and
 * stdout+stderr stream back out.
 */
export function createChildProcessInteractive(opts: TerminalOptions): TerminalBackend {
  const shell = resolveShell(opts.shell);
  if (!shell) throw new Error('no usable shell found for child_process backend');

  const child: ChildProcessWithoutNullStreams = spawn(shell, [], {
    cwd: opts.cwd ?? process.cwd(),
    env: cleanEnv({ ...process.env, ...opts.env }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const dataListeners: Array<(chunk: string) => void> = [];
  const emit = (chunk: string): void => {
    for (const l of dataListeners) l(chunk);
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d: string) => emit(d));
  child.stderr.on('data', (d: string) => emit(d));

  let killed = false;

  return {
    kind: 'child-process',
    onData: (listener) => {
      dataListeners.push(listener);
    },
    onExit: (listener) => {
      child.on('exit', (code, signal) =>
        listener({
          exitCode: code ?? 0,
          signal: signal ? signalToNumber(signal) : undefined,
        }),
      );
    },
    write: (data) => {
      if (!killed && child.stdin.writable) child.stdin.write(data);
    },
    // No tty to resize; honour the interface as a no-op.
    resize: () => {},
    kill: () => {
      if (killed) return;
      killed = true;
      try {
        child.stdin.end();
      } catch {
        /* ignore */
      }
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    },
  };
}

/**
 * Run a single command in a fresh child process (`shell -c cmd`), streaming
 * stdout+stderr to `onData`, resolving with the exit code when it closes.
 */
export function runChildProcessOnce(
  cmd: string,
  opts: TerminalOptions,
  onData: (chunk: string) => void,
): Promise<RunOnceResult> {
  return new Promise<RunOnceResult>((resolve, reject) => {
    const shell = resolveShell(opts.shell);
    if (!shell) {
      reject(new Error('no usable shell found'));
      return;
    }

    let child: ChildProcess;
    try {
      child = spawn(shell, [commandFlag(shell), cmd], {
        cwd: opts.cwd ?? process.cwd(),
        env: cleanEnv({ ...process.env, ...opts.env }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => onData(d));
    child.stderr?.on('data', (d: string) => onData(d));

    child.on('error', (err) => reject(err));
    child.on('close', (code, signal) =>
      resolve({
        exitCode: code ?? 0,
        signal: signal ? signalToNumber(signal) : undefined,
      }),
    );
  });
}

/** Map a POSIX signal name to its number for the RunOnceResult shape (best-effort). */
function signalToNumber(signal: NodeJS.Signals): number {
  const table: Partial<Record<NodeJS.Signals, number>> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGKILL: 9,
    SIGTERM: 15,
  };
  return table[signal] ?? 0;
}
