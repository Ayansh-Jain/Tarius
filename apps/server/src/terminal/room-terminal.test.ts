/**
 * Shared-terminal tests (v0.5, Slice B).
 *
 * The headline assertion the spec asks for: `runCommand('echo ice-ok')` lands
 * 'ice-ok' in the room's `doc.getText('terminal')`. We assert it on whatever
 * backend the environment selects (node-pty when its native addon can spawn,
 * otherwise the child_process fallback) AND explicitly on the forced fallback,
 * so the suite is deterministic even in a sandbox where pty can't spawn.
 *
 * We also cover: the TerminalRunner registry (lazy create + same instance per
 * room), the system-origin of terminal writes (ADR-000), the scrollback cap,
 * and graceful behaviour when no shell is available.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createRoomTerminal } from './room-terminal.js';
import { createTerminalRunner } from './runner.js';
import { getTerminalText } from './ydoc-sink.js';
import {
  forceBackendForTests,
  resetBackendSelectionForTests,
  selectBackendKind,
  type BackendKind,
} from './backend.js';

const TERMINAL_KEY = 'terminal';

afterEach(() => {
  resetBackendSelectionForTests();
});

function termText(doc: Y.Doc): string {
  return doc.getText(TERMINAL_KEY).toString();
}

/** Poll the doc's terminal text until `needle` shows up or we time out. */
async function waitForOutput(doc: Y.Doc, needle: string, timeoutMs = 8000): Promise<string> {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const text = termText(doc);
    if (text.includes(needle)) return text;
    if (Date.now() - start > timeoutMs) return text;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('createRoomTerminal.runCommand', () => {
  it('uses doc.getText("terminal") as the shared output channel key', () => {
    const doc = new Y.Doc();
    const term = createRoomTerminal('room-key', doc);
    // The sink writes to exactly this key.
    expect(getTerminalText(doc)).toBe(doc.getText('terminal'));
    term.dispose();
  });

  it('streams `echo ice-ok` output into the room doc terminal (auto backend)', async () => {
    const doc = new Y.Doc();
    const term = createRoomTerminal('room-echo', doc);

    await term.runCommand('echo ice-ok');
    const text = await waitForOutput(doc, 'ice-ok');

    expect(text).toContain('ice-ok');
    // The command itself is echoed into the shared transcript.
    expect(text).toContain('echo ice-ok');
    term.dispose();
  });

  it('streams `echo ice-ok` via the child_process FALLBACK backend', async () => {
    forceBackendForTests('child-process');
    const doc = new Y.Doc();
    const term = createRoomTerminal('room-echo-fallback', doc);
    expect(term.backendKind).toBe<BackendKind>('child-process');

    await term.runCommand('echo ice-ok');
    const text = await waitForOutput(doc, 'ice-ok');

    expect(text).toContain('ice-ok');
    term.dispose();
  });

  it('writes terminal output under a system origin (ADR-000)', async () => {
    forceBackendForTests('child-process');
    const doc = new Y.Doc();
    const term = createRoomTerminal('room-origin', doc);

    const origins: unknown[] = [];
    doc.on('afterTransaction', (tr: Y.Transaction) => {
      if (tr.changed.size > 0) origins.push(tr.origin);
    });

    await term.runCommand('echo origin-check');
    await waitForOutput(doc, 'origin-check');

    expect(origins.length).toBeGreaterThan(0);
    for (const o of origins) {
      expect(o).toEqual({ kind: 'system' });
    }
    term.dispose();
  });

  it('reports a non-zero exit code into the transcript', async () => {
    forceBackendForTests('child-process');
    const doc = new Y.Doc();
    const term = createRoomTerminal('room-exit', doc);

    await term.runCommand('sh -c "exit 3"');
    const text = await waitForOutput(doc, 'exit code 3');

    expect(text).toContain('exit code 3');
    term.dispose();
  });

  it('ignores empty commands (no transcript churn)', async () => {
    forceBackendForTests('child-process');
    const doc = new Y.Doc();
    const term = createRoomTerminal('room-empty', doc);

    await term.runCommand('   ');
    expect(termText(doc)).toBe('');
    term.dispose();
  });

  it('caps the scrollback buffer to maxBufferChars', async () => {
    forceBackendForTests('child-process');
    const doc = new Y.Doc();
    const term = createRoomTerminal('room-cap', doc, { maxBufferChars: 200 });

    // Emit far more than the cap; the Y.Text must never exceed it.
    await term.runCommand('printf "%s" "$(head -c 5000 /dev/zero | tr "\\0" "x")"');
    await waitForOutput(doc, 'x');

    expect(getTerminalText(doc).length).toBeLessThanOrEqual(200);
    term.dispose();
  });
});

describe('createTerminalRunner (TerminalRunner contract)', () => {
  it('lazily creates one terminal per room and runs the command there', async () => {
    forceBackendForTests('child-process');
    const docs = new Map<string, Y.Doc>();
    const runner = createTerminalRunner({
      resolveDoc(roomId) {
        let d = docs.get(roomId);
        if (!d) {
          d = new Y.Doc();
          docs.set(roomId, d);
        }
        return d;
      },
    });

    // No terminal until first use.
    expect(runner.getTerminal('room-A')).toBeUndefined();

    await runner.runCommand('room-A', 'echo ice-ok');
    const doc = docs.get('room-A')!;
    const text = await waitForOutput(doc, 'ice-ok');
    expect(text).toContain('ice-ok');

    // Created and cached.
    expect(runner.getTerminal('room-A')).toBeDefined();

    await runner.disposeAll();
  });

  it('returns the SAME terminal instance across concurrent creates for a room', async () => {
    forceBackendForTests('child-process');
    const doc = new Y.Doc();
    const runner = createTerminalRunner({ resolveDoc: () => doc });

    const [a, b] = await Promise.all([
      runner.getOrCreateTerminal('room-race'),
      runner.getOrCreateTerminal('room-race'),
    ]);
    expect(a).not.toBeNull();
    expect(a).toBe(b);

    await runner.disposeAll();
  });

  it('no-ops (does not throw) when the room doc is unavailable', async () => {
    const runner = createTerminalRunner({ resolveDoc: () => null });
    await expect(runner.runCommand('ghost-room', 'echo nope')).resolves.toBeUndefined();
    expect(runner.getTerminal('ghost-room')).toBeUndefined();
  });

  it('isolates output between rooms', async () => {
    forceBackendForTests('child-process');
    const docs = new Map<string, Y.Doc>();
    const runner = createTerminalRunner({
      resolveDoc(roomId) {
        const d = docs.get(roomId) ?? new Y.Doc();
        docs.set(roomId, d);
        return d;
      },
    });

    await runner.runCommand('room-1', 'echo only-in-one');
    await runner.runCommand('room-2', 'echo only-in-two');

    await waitForOutput(docs.get('room-1')!, 'only-in-one');
    await waitForOutput(docs.get('room-2')!, 'only-in-two');

    expect(termText(docs.get('room-1')!)).toContain('only-in-one');
    expect(termText(docs.get('room-1')!)).not.toContain('only-in-two');
    expect(termText(docs.get('room-2')!)).toContain('only-in-two');

    await runner.disposeAll();
  });
});

describe('robustness', () => {
  it('write() never throws even with a bogus shell override (falls back to a real shell)', () => {
    // An explicit but non-existent shell override must not break the terminal:
    // resolveShell falls through to real candidates (/bin/bash, /bin/sh, …).
    forceBackendForTests('child-process');
    const doc = new Y.Doc();
    const term = createRoomTerminal('room-bad-shell', doc, {
      shell: '/nonexistent/definitely-not-a-shell',
    });

    expect(() => term.write('echo hi\n')).not.toThrow();
    term.dispose();
  });

  it('exposes which backend the environment selected (diagnostic)', () => {
    resetBackendSelectionForTests();
    const kind = selectBackendKind();
    expect(['node-pty', 'child-process']).toContain(kind);
  });

  it('dispose() is idempotent', () => {
    forceBackendForTests('child-process');
    const doc = new Y.Doc();
    const term = createRoomTerminal('room-dispose', doc);
    term.write('echo hi\n');
    expect(() => {
      term.dispose();
      term.dispose();
    }).not.toThrow();
  });
});
