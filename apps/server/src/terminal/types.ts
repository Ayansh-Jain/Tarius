/**
 * Shared terminal — public types (v0.5, Slice B).
 *
 * A per-room SHARED terminal: one shell process per room whose output is
 * streamed into a single Yjs channel (`doc.getText('terminal')`) so every
 * participant's xterm — and the agent — sees the exact same bytes. Humans type
 * into it; the agent runs commands through it (its `run_terminal`-style tool
 * goes through {@link TerminalRunner}, so terminal activity is shared state, not
 * a private side-channel).
 *
 * These types are the seam other slices build against. Slice A (the agent
 * runtime) depends ONLY on {@link TerminalRunner}; it never imports a concrete
 * terminal. The driver constructs a runner here and injects it into
 * `startAgentForRoom`.
 */
import type * as Y from 'yjs';

/**
 * The well-known Y.Text key the web's xterm renders. This is NOT one of the
 * frozen `YDOC_KEYS` (those live in @ice/shared and own files/tree/agents/…);
 * the shared terminal owns this top-level key and is its single writer.
 */
export const TERMINAL_TEXT_KEY = 'terminal' as const;

/**
 * Tuning knobs for a room terminal. All optional with safe defaults; the driver
 * may override (e.g. point `cwd` at the room's checked-out working tree).
 */
export interface TerminalOptions {
  /** Working directory for the shell. Defaults to the server process cwd. */
  cwd?: string;
  /**
   * If set, the room's Yjs files are written here before each command/shell and
   * it becomes the cwd (unless `cwd` is given). Set by the runner per room.
   */
  workspaceDir?: string;
  /** Extra environment for the shell, merged over `process.env`. */
  env?: Record<string, string | undefined>;
  /** Shell to spawn. Defaults to $SHELL, then /bin/bash, then /bin/sh (or COMSPEC on Windows). */
  shell?: string;
  /** Terminal columns reported to the pty. Default 80. */
  cols?: number;
  /** Terminal rows reported to the pty. Default 24. */
  rows?: number;
  /**
   * Max characters retained in the shared Y.Text. When output exceeds this the
   * oldest bytes are trimmed (a scrollback cap) so a long-running room can't
   * grow the doc — and memory — without bound. Default 200_000.
   */
  maxBufferChars?: number;
  /**
   * How long {@link RoomTerminal.runCommand} waits for a command to finish
   * before resolving anyway (the shell keeps running; we just stop awaiting).
   * Milliseconds. Default 120_000.
   */
  commandTimeoutMs?: number;
}

/**
 * A low-level terminal process abstraction. Two implementations exist: a
 * node-pty backend (a real pty — interactive, ANSI-correct) and a dependency-
 * free `child_process` fallback used when node-pty's native addon can't spawn
 * in the host environment (e.g. a locked-down CI sandbox). Both stream bytes
 * the same way so callers don't care which is live.
 */
export interface TerminalBackend {
  /** Which implementation is live — useful for diagnostics and tests. */
  readonly kind: 'node-pty' | 'child-process';
  /** Subscribe to output bytes (already decoded to a string). */
  onData(listener: (chunk: string) => void): void;
  /** Subscribe to process exit. */
  onExit(listener: (info: { exitCode: number; signal?: number }) => void): void;
  /** Write raw input to the process (e.g. keystrokes, or a command + "\n"). */
  write(data: string): void;
  /** Best-effort resize (no-op for the child_process fallback). */
  resize(cols: number, rows: number): void;
  /** Terminate the process and release its resources. Idempotent. */
  kill(): void;
}

/**
 * A room's shared terminal: a live shell plus the plumbing that mirrors its I/O
 * into the room's Yjs doc.
 */
export interface RoomTerminal {
  readonly roomId: string;
  /** Which backend ended up live for this room. */
  readonly backendKind: TerminalBackend['kind'];
  /**
   * Run a single command end-to-end: echo it into the shared terminal, execute
   * it in the room shell, and stream its output into the terminal Y.Text.
   * Resolves when the command finishes (or after `commandTimeoutMs`). This is
   * how both the agent (via {@link TerminalRunner}) and an optional human REST
   * route invoke work.
   */
  runCommand(cmd: string): Promise<void>;
  /** Raw input to the pty (interactive typing from a human's xterm). */
  write(data: string): void;
  /** Resize the underlying pty to match a client's viewport. */
  resize(cols: number, rows: number): void;
  /** Kill the shell and detach from the doc. Idempotent. */
  dispose(): void;
}

/**
 * The narrow contract Slice A (the agent runtime) expects: give it a room id
 * and a command and it runs in that room's shared terminal, creating the
 * terminal lazily on first use. Implemented by {@link createTerminalRunner}.
 */
export interface TerminalRunner {
  /** Run `cmd` in `roomId`'s shared terminal (creating it if needed). */
  runCommand(roomId: string, cmd: string): Promise<void>;
}
