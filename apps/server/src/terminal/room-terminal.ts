/**
 * Per-room shared terminal (v0.5, Slice B).
 *
 * `createRoomTerminal(roomId, doc)` gives a room ONE shared shell whose I/O is
 * mirrored into the room's Yjs doc (`doc.getText('terminal')`), so every
 * participant's xterm — and the agent — sees identical output. The shell is
 * spawned lazily on first use (first write/runCommand), keeping idle rooms
 * cheap.
 *
 * Design notes
 * ────────────
 * • Two paths, one shared view. Raw interactive typing goes to a long-lived
 *   shell via `write()`. `runCommand()` instead runs the command as a discrete
 *   process so it has a PRECISE completion signal + exit code (interactive ptys
 *   give no reliable "command done" marker). Both stream into the same Y.Text,
 *   so the shared terminal stays a single coherent transcript.
 * • The doc is the only output surface. Output is appended through the
 *   system-origin sink (ADR-000: no raw, untagged mutation). The web renders the
 *   Y.Text; the server never has to push bytes another way.
 * • Robust by construction. The scrollback is capped; a missing shell or an
 *   unspawnable pty degrades to a clear message / the child_process fallback
 *   rather than crashing; dispose() is idempotent and tears the shell down.
 */
import * as Y from 'yjs';
import type { RoomTerminal, TerminalBackend, TerminalOptions } from './types.js';
import {
  createInteractiveBackend,
  runOnceWithSelectedBackend,
  selectBackendKind,
} from './backend.js';
import { appendTerminalOutput } from './ydoc-sink.js';
import { materializeRoomFiles } from './workspace.js';

const DEFAULT_MAX_BUFFER_CHARS = 200_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

/** Normalise a command line to a single trailing newline for echoing. */
function withNewline(s: string): string {
  return s.endsWith('\n') ? s : `${s}\n`;
}

/**
 * Create the shared terminal for one room. Pure constructor — no process is
 * spawned until the first `write`/`runCommand` (lazy), so creating a terminal
 * for a room that's never used costs nothing.
 */
export function createRoomTerminal(
  roomId: string,
  doc: Y.Doc,
  rawOptions: TerminalOptions = {},
): RoomTerminal {
  // Run in the room's materialised workspace so files in the editor are real
  // files on disk for the shell (python x.py, node x.js, npm/pip install...).
  const options: TerminalOptions = rawOptions.workspaceDir
    ? { ...rawOptions, cwd: rawOptions.cwd ?? rawOptions.workspaceDir }
    : rawOptions;
  const syncWorkspace = (): void => {
    if (!rawOptions.workspaceDir) return;
    try {
      materializeRoomFiles(doc, rawOptions.workspaceDir);
    } catch {
      /* fall back to whatever is on disk */
    }
  };
  const maxBufferChars = options.maxBufferChars ?? DEFAULT_MAX_BUFFER_CHARS;
  const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const backendKind = selectBackendKind(options);

  /** The persistent interactive shell, created on demand. */
  let interactive: TerminalBackend | null = null;
  let disposed = false;

  const append = (chunk: string): void => {
    if (disposed) return;
    appendTerminalOutput(doc, chunk, maxBufferChars);
  };

  /** Lazily spawn (once) the persistent interactive shell and pipe it to the doc. */
  const ensureInteractive = (): TerminalBackend | null => {
    if (disposed) return null;
    if (interactive) return interactive;
    try {
      syncWorkspace();
      const backend = createInteractiveBackend(options);
      backend.onData(append);
      backend.onExit(({ exitCode }) => {
        append(`\r\n[process exited: code ${exitCode}]\r\n`);
        if (interactive === backend) interactive = null;
      });
      interactive = backend;
      return backend;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      append(`\r\n[terminal unavailable: ${msg}]\r\n`);
      return null;
    }
  };

  const runCommand = async (cmd: string): Promise<void> => {
    if (disposed) return;
    const trimmed = cmd.trim();
    if (trimmed.length === 0) return;

    // Echo the command into the shared transcript with a shell-like prompt so
    // every participant sees what ran (the agent's actions are visible to all).
    append(`$ ${withNewline(trimmed)}`);
    syncWorkspace();

    let settled = false;
    const finish = (): void => {
      settled = true;
    };

    // Cap how long we await; the run keeps going server-side, we just stop
    // blocking the caller (the agent shouldn't hang on a runaway command).
    const timeout = new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        if (!settled) append(`\r\n[command still running after ${commandTimeoutMs}ms]\r\n`);
        resolve();
      }, commandTimeoutMs);
      // Don't keep the event loop alive solely for this timer.
      if (typeof t.unref === 'function') t.unref();
    });

    const run = runOnceWithSelectedBackend(trimmed, options, append)
      .then((res) => {
        finish();
        if (res.exitCode !== 0) {
          append(`\r\n[exit code ${res.exitCode}]\r\n`);
        }
      })
      .catch((err) => {
        finish();
        const msg = err instanceof Error ? err.message : String(err);
        append(`\r\n[command failed: ${msg}]\r\n`);
      });

    await Promise.race([run, timeout]);
  };

  const write = (data: string): void => {
    if (disposed) return;
    const backend = ensureInteractive();
    if (backend) backend.write(data);
  };

  const resize = (cols: number, rows: number): void => {
    if (disposed) return;
    interactive?.resize(cols, rows);
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (interactive) {
      try {
        interactive.kill();
      } catch {
        /* already gone */
      }
      interactive = null;
    }
  };

  return {
    roomId,
    backendKind,
    runCommand,
    write,
    resize,
    dispose,
  };
}
