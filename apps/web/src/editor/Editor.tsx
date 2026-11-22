/**
 * The collaborative code editor: CodeMirror 6 bound to a Yjs Y.Text.
 *
 * Per the architectural law, the Yjs doc is the source of truth for open files.
 * We bind CodeMirror to `getFileText(doc, path)` — where `path` is the file the
 * sidebar has selected — via y-codemirror.next's `yCollab`, which wires the
 * text sync, a per-origin undo manager, and remote carets/selections (drawn
 * from the awareness `user` field set in connection.ts). Editing flows through
 * Yjs — never around it.
 *
 * v0.3 makes the binding multi-file: when `path` changes we tear down the old
 * EditorView + UndoManager (disposing the old yCollab cleanly) and rebind to
 * the newly selected file's Y.Text. The default selection is still 'main.ts'
 * so the v0.1 single-file demo keeps working untouched.
 */
import { useEffect, useRef } from 'react';
import * as Y from 'yjs';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { yCollab } from 'y-codemirror.next';
import type { Extension } from '@codemirror/state';
import { getFileText } from '@ice/shared';
import type { RoomConnection } from '../lib/connection.js';
import { DEFAULT_FILE, DEFAULT_FILE_SEED, basename } from '../lib/tree.js';

// Re-export so existing imports of `DEFAULT_FILE` from the editor keep working.
export { DEFAULT_FILE };

/** Syntax colors: restrained, warm-neutral, readable on charcoal. */
const iceHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: '#B1A4DD' },
  { tag: [t.string, t.special(t.string), t.regexp], color: '#E6C98F' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName))], color: '#8DB4E8' },
  { tag: [t.variableName, t.propertyName, t.name], color: '#F5F3EF' },
  { tag: [t.typeName, t.className, t.namespace], color: '#8DD0C8' },
  { tag: [t.number, t.bool, t.null, t.atom], color: '#F2B48C' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: '#7C8A7A', fontStyle: 'italic' },
  { tag: [t.operator, t.punctuation, t.bracket], color: '#A7A5A2' },
  { tag: t.invalid, color: '#E47B74' },
]);

/** Editor surface theme: charcoal, subtle active line, crisp gutter. */
const iceTheme = EditorView.theme(
  {
    '&': { height: '100%', fontSize: '13.5px', backgroundColor: '#141414', color: '#F5F3EF' },
    '.cm-scroller': {
      fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      lineHeight: '1.7',
    },
    '.cm-content': { caretColor: '#FF7139', padding: '10px 0' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#FF7139' },
    '&.cm-focused': { outline: 'none' },
    '.cm-gutters': {
      backgroundColor: '#141414',
      color: '#5A5957',
      border: 'none',
      fontVariantNumeric: 'tabular-nums',
    },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 14px 0 18px' },
    '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.035)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: '#A7A5A2' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
      backgroundColor: 'rgba(255,113,57,0.22)',
    },
  },
  { dark: true },
);

/**
 * Pick a language extension from the file extension. We ship the JS/TS grammar
 * (the only @codemirror/lang-* package in the web deps); plain `.js` files turn
 * TS parsing off, everything else gets TS — a forgiving default for an IDE.
 */
function languageFor(path: string): Extension {
  const name = basename(path).toLowerCase();
  const plainJs = name.endsWith('.js') || name.endsWith('.jsx') || name.endsWith('.mjs');
  return javascript({ typescript: !plainJs });
}

interface EditorProps {
  connection: RoomConnection;
  /** Path of the currently selected file to bind. Defaults to {@link DEFAULT_FILE}. */
  path?: string;
}

export function Editor({ connection, path = DEFAULT_FILE }: EditorProps): React.ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const ytext = getFileText(connection.doc, path);

    // Per-origin undo manager: only undoes *this* client's edits, leaving
    // remote (and later, agent) edits intact. yCollab tracks it.
    const undoManager = new Y.UndoManager(ytext);

    const awareness = connection.provider.awareness;

    const state = EditorState.create({
      doc: ytext.toString(),
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        languageFor(path),
        iceTheme,
        syntaxHighlighting(iceHighlight),
        EditorView.lineWrapping,
        // yCollab binds text + awareness cursors + undo. awareness may be null
        // only if explicitly disabled; we always provide one.
        yCollab(ytext, awareness, { undoManager }),
      ],
    });

    const view = new EditorView({ state, parent: host });

    // Seed only the default file's empty buffer (first client into a fresh
    // room). Other files start empty by design. Guard on length so we never
    // stomp existing collaborative content, and re-check inside the txn to
    // avoid a race with a peer's seed.
    if (path === DEFAULT_FILE && ytext.length === 0) {
      connection.doc.transact(() => {
        if (ytext.length === 0) ytext.insert(0, DEFAULT_FILE_SEED);
      });
    }

    view.focus();

    return () => {
      // Tearing down the view disposes the yCollab plugin (and its awareness +
      // relative-position listeners); destroying the undo manager releases its
      // observers on the old Y.Text. Both must happen before we rebind.
      view.destroy();
      undoManager.destroy();
    };
    // Re-bind whenever the room connection OR the selected file changes.
  }, [connection, path]);

  return <div ref={hostRef} className="h-full w-full overflow-hidden" />;
}
