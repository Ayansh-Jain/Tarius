/**
 * Terminal → Yjs sink (v0.5, Slice B).
 *
 * The ONE writer of the shared terminal Y.Text. Every byte the room shell emits
 * is appended here and trimmed to a scrollback cap. All mutations go through
 * `transactWithOrigin` with a `{kind:'system'}` origin — honouring ADR-000 (no
 * raw, untagged mutation of room state). The terminal stream is system output
 * (shared, not attributable to one author); a command *initiated* by an agent
 * is attributed where it's initiated (the agent runtime), while the streamed
 * bytes themselves are system-origin so a human "undo" never tries to rewind a
 * live shell.
 */
import * as Y from 'yjs';
import { transactWithOrigin } from '@ice/shared';
import { TERMINAL_TEXT_KEY } from './types.js';

/** Get (never lazily-`set`, Y.Text is created on first `getText`) the shared terminal buffer. */
export function getTerminalText(doc: Y.Doc): Y.Text {
  return doc.getText(TERMINAL_TEXT_KEY);
}

/**
 * Append `chunk` to the shared terminal, enforcing `maxBufferChars` by trimming
 * the oldest content. Runs in a single system-origin transaction so the trim +
 * append apply atomically and replicate as one update.
 *
 * Empty chunks are ignored. Trimming drops whole leading characters; we don't
 * try to preserve ANSI escape integrity across the cut (the renderer tolerates
 * a truncated prefix, and the cap is large relative to a single escape).
 */
export function appendTerminalOutput(
  doc: Y.Doc,
  chunk: string,
  maxBufferChars: number,
): void {
  if (chunk.length === 0) return;

  transactWithOrigin(doc, { kind: 'system' }, () => {
    const text = getTerminalText(doc);

    // If a single chunk is itself larger than the cap, keep only its tail.
    let toInsert = chunk;
    if (toInsert.length > maxBufferChars) {
      toInsert = toInsert.slice(toInsert.length - maxBufferChars);
    }

    text.insert(text.length, toInsert);

    // Trim from the front if we've exceeded the cap.
    const overflow = text.length - maxBufferChars;
    if (overflow > 0) {
      text.delete(0, overflow);
    }
  });
}

/**
 * Clear the shared terminal buffer (system-origin). Used on dispose so a
 * re-created room terminal doesn't show a previous session's tail, and
 * available to a "clear" control.
 */
export function clearTerminalOutput(doc: Y.Doc): void {
  transactWithOrigin(doc, { kind: 'system' }, () => {
    const text = getTerminalText(doc);
    if (text.length > 0) text.delete(0, text.length);
  });
}
