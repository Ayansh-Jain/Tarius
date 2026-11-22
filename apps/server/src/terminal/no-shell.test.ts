/**
 * Missing-shell robustness (v0.5, Slice B).
 *
 * The spec requires the terminal to "handle a missing shell". When no shell can
 * be resolved at all, the terminal must NOT throw — it must surface a clear
 * message into the shared doc so participants see why nothing ran. We force that
 * condition by mocking the shell resolver to return null (a host with no usable
 * shell), then assert both the interactive (write) and command (runCommand)
 * paths degrade gracefully.
 *
 * This lives in its own file so the module-level `vi.mock` (hoisted) only
 * affects these cases, not the rest of the suite.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

// Mock the shell resolver so NO shell is ever found, while keeping the real
// commandFlag / spawn-helper behaviour (they're harmless here).
vi.mock('./shell.js', async () => {
  const actual = await vi.importActual<typeof import('./shell.js')>('./shell.js');
  return {
    ...actual,
    resolveShell: () => null,
  };
});

import { createRoomTerminal } from './room-terminal.js';
import { forceBackendForTests, resetBackendSelectionForTests } from './backend.js';

const TERMINAL_KEY = 'terminal';
const termText = (doc: Y.Doc): string => doc.getText(TERMINAL_KEY).toString();

beforeEach(() => {
  // The child_process backend reaches resolveShell synchronously; force it so
  // we don't depend on the (mocked-away) pty probe.
  forceBackendForTests('child-process');
});

describe('missing shell', () => {
  it('write() surfaces "terminal unavailable" instead of throwing', () => {
    const doc = new Y.Doc();
    const term = createRoomTerminal('room-no-shell-write', doc);

    expect(() => term.write('echo hi\n')).not.toThrow();
    expect(termText(doc)).toContain('terminal unavailable');

    term.dispose();
    resetBackendSelectionForTests();
  });

  it('runCommand() reports the failure into the transcript instead of throwing', async () => {
    const doc = new Y.Doc();
    const term = createRoomTerminal('room-no-shell-run', doc);

    await expect(term.runCommand('echo ice-ok')).resolves.toBeUndefined();
    const text = termText(doc);
    // The command is still echoed, and the failure is made visible.
    expect(text).toContain('echo ice-ok');
    expect(text.toLowerCase()).toContain('no usable shell');

    term.dispose();
    resetBackendSelectionForTests();
  });
});
