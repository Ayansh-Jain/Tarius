/**
 * node-pty terminal backend (v0.5, Slice B).
 *
 * A real pseudo-terminal: interactive, ANSI-correct — the right thing for a
 * shared shell humans type into. node-pty is loaded lazily via `createRequire`
 * (not a static ESM import) so that an environment where the native addon can't
 * load/spawn throws HERE, at construction, letting the selector fall back to the
 * dependency-free child_process backend instead of crashing the server.
 *
 * Two shapes are exported:
 *   • {@link createPtyInteractive} — a long-lived shell for raw write()/resize();
 *   • {@link runPtyOnce} — a discrete `shell -c cmd` run with a precise
 *     completion signal + exit code (used by RoomTerminal.runCommand).
 * Both stream output the same way, so the shared view stays coherent.
 */
import { createRequire } from 'node:module';
import type { TerminalBackend, TerminalOptions } from './types.js';
import {
  commandFlag,
  ensurePtySpawnHelperExecutable,
  resolveShell,
} from './shell.js';

/** Minimal structural type of the bits of node-pty we use. */
interface IPtyProcess {
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}
interface NodePtyModule {
  spawn(
    file: string,
    args: string[] | string,
    opts: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string>;
    },
  ): IPtyProcess;
}

/** Strip undefined values so we can hand node-pty a clean string→string env. */
function cleanEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/**
 * Load node-pty + repair its prebuilt spawn-helper. Throws if the native addon
 * can't be required — caught by the selector. Memoised resolution is cheap.
 */
function loadPty(): NodePtyModule {
  ensurePtySpawnHelperExecutable();
  const require = createRequire(import.meta.url);
  return require('node-pty') as NodePtyModule;
}

/**
 * Construct a long-lived, interactive node-pty shell. Throws if node-pty cannot
 * load, no shell is available, or the pty fails to spawn — all treated by the
 * selector as "fall back to child_process".
 */
export function createPtyInteractive(opts: TerminalOptions): TerminalBackend {
  const pty = loadPty();

  const shell = resolveShell(opts.shell);
  if (!shell) throw new Error('no usable shell found for node-pty backend');

  const env = cleanEnv({ ...process.env, ...opts.env });
  const proc = pty.spawn(shell, [], {
    name: 'xterm-color',
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 24,
    cwd: opts.cwd ?? process.cwd(),
    env,
  });

  let killed = false;

  return {
    kind: 'node-pty',
    onData: (listener) => proc.onData(listener),
    onExit: (listener) =>
      proc.onExit(({ exitCode, signal }) => listener({ exitCode, signal })),
    write: (data) => {
      if (!killed) proc.write(data);
    },
    resize: (cols, rows) => {
      if (!killed) {
        try {
          proc.resize(Math.max(1, cols), Math.max(1, rows));
        } catch {
          /* resizing a just-exited pty can throw; ignore */
        }
      }
    },
    kill: () => {
      if (killed) return;
      killed = true;
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
    },
  };
}

/** Probe: can we construct AND spawn a node-pty shell here? Used by the selector. */
export function ptyIsSpawnable(opts: TerminalOptions): boolean {
  try {
    const probe = createPtyInteractive(opts);
    probe.kill();
    return true;
  } catch {
    return false;
  }
}

/** Result of a one-shot command run: how it terminated. */
export interface RunOnceResult {
  exitCode: number;
  signal?: number;
}

/**
 * Run a single command in a fresh pty (`shell -c cmd`), streaming output to
 * `onData`, and resolve when it exits. Rejects if node-pty can't spawn.
 */
export function runPtyOnce(
  cmd: string,
  opts: TerminalOptions,
  onData: (chunk: string) => void,
): Promise<RunOnceResult> {
  return new Promise<RunOnceResult>((resolve, reject) => {
    let pty: NodePtyModule;
    try {
      pty = loadPty();
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    const shell = resolveShell(opts.shell);
    if (!shell) {
      reject(new Error('no usable shell found'));
      return;
    }

    let proc: IPtyProcess;
    try {
      proc = pty.spawn(shell, [commandFlag(shell), cmd], {
        name: 'xterm-color',
        cols: opts.cols ?? 80,
        rows: opts.rows ?? 24,
        cwd: opts.cwd ?? process.cwd(),
        env: cleanEnv({ ...process.env, ...opts.env }),
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    proc.onData((d) => onData(d));
    proc.onExit(({ exitCode, signal }) => resolve({ exitCode, signal }));
  });
}
