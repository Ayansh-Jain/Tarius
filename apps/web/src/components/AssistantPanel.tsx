/**
 * AI Assistant panel — ask Gemini to fix code in the file you are viewing, or in
 * any file you reference with "@".
 *
 * Flow: your prompt + the open file + every @-referenced file are sent to the
 * server (retrieval), Gemini returns the corrected full file, and we diff it
 * against the current text so you see exactly which lines and words changed
 * before you decide to apply it.
 */
import { Check, Copy, FileCode2, Loader2, Send, Sparkles, Undo2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EditOrigin } from '@ice/shared';
import { getFileText } from '@ice/shared';
import type { RoomConnection } from '../lib/connection.js';
import { activeMention, askAssistant, mentionedPaths, rankFiles, type AssistResponse } from '../lib/assist.js';
import { diffLines, minimalReplace } from '../lib/diff.js';
import { DiffView } from './DiffView.js';
import { basename, listFilePaths } from '../lib/tree.js';

interface AssistantPanelProps {
  roomId: string;
  connection: RoomConnection;
  /** File currently open in the editor. */
  activePath: string;
  origin: EditOrigin;
}

interface Turn {
  id: number;
  prompt: string;
  status: 'loading' | 'done' | 'error';
  error?: string;
  result?: AssistResponse;
  /** Target file text when the request was sent (what the diff is against). */
  original?: string;
  /** Set once applied: the text we wrote, so Undo knows it is still safe. */
  applied?: { before: string; after: string };
}

/** Match line endings / trailing newline of the original so the diff shows real changes only. */
function normalise(original: string, code: string): { oldText: string; newText: string; crlf: boolean } {
  const crlf = original.includes('\r\n');
  const oldText = original.replace(/\r\n/g, '\n');
  let newText = code.replace(/\r\n/g, '\n');
  if (!oldText.endsWith('\n')) newText = newText.replace(/\n+$/, '');
  else if (!newText.endsWith('\n')) newText += '\n';
  return { oldText, newText, crlf };
}

function replaceWhole(connection: RoomConnection, path: string, next: string, origin: EditOrigin): void {
  const yt = getFileText(connection.doc, path);
  const cur = yt.toString();
  const { index, remove, insert } = minimalReplace(cur, next);
  if (remove === 0 && insert === '') return;
  connection.doc.transact(() => {
    if (remove > 0) yt.delete(index, remove);
    if (insert) yt.insert(index, insert);
  }, origin);
}

export function AssistantPanel({ roomId, connection, activePath, origin }: AssistantPanelProps): React.ReactElement {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<{ start: number; items: string[]; index: number } | null>(null);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const nextId = useRef(1);

  const allPaths = useCallback(() => listFilePaths(connection.doc), [connection]);

  const refs = useMemo(() => mentionedPaths(draft, allPaths()), [draft, allPaths]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  useEffect(() => () => abortRef.current?.abort(), []);

  function updateMenu(text: string, caret: number): void {
    const m = activeMention(text, caret);
    if (!m) return setMenu(null);
    const items = rankFiles(allPaths(), m.query);
    setMenu(items.length ? { start: m.start, items, index: 0 } : null);
  }

  function pick(path: string): void {
    const ta = taRef.current;
    if (!ta || !menu) return;
    const caret = ta.selectionStart;
    const next = `${draft.slice(0, menu.start)}@${path} ${draft.slice(caret)}`;
    const pos = menu.start + path.length + 2;
    setDraft(next);
    setMenu(null);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(pos, pos);
    });
  }

  async function send(): Promise<void> {
    const prompt = draft.trim();
    if (!prompt || busy) return;
    const id = nextId.current++;
    // The file we expect to be fixed: first @reference, else the open file.
    const target = mentionedPaths(prompt, allPaths()).found[0] ?? activePath;
    const original = getFileText(connection.doc, target).toString();
    setTurns((t) => [...t, { id, prompt, status: 'loading' }]);
    setDraft('');
    setMenu(null);
    setBusy(true);
    const ctl = new AbortController();
    abortRef.current = ctl;
    try {
      const result = await askAssistant(roomId, prompt, activePath, ctl.signal);
      // Diff against the exact file the server fixed (it can differ from our guess).
      const base = result.path === target ? original : getFileText(connection.doc, result.path).toString();
      setTurns((t) => t.map((x) => (x.id === id ? { ...x, status: 'done', result, original: base } : x)));
    } catch (e) {
      if ((e as { name?: string }).name === 'AbortError') {
        setTurns((t) => t.filter((x) => x.id !== id));
      } else {
        const msg = e instanceof Error ? e.message : 'Something went wrong.';
        setTurns((t) => t.map((x) => (x.id === id ? { ...x, status: 'error', error: msg } : x)));
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  function apply(turn: Turn): void {
    if (!turn.result || turn.original === undefined) return;
    const path = turn.result.path;
    const current = getFileText(connection.doc, path).toString();
    if (current !== turn.original && !window.confirm(`${basename(path)} changed since you asked. Replace it with the AI's version anyway?`)) {
      return;
    }
    const { newText, crlf } = normalise(current, turn.result.code);
    const after = crlf ? newText.replace(/\n/g, '\r\n') : newText;
    replaceWhole(connection, path, after, origin);
    setTurns((t) => t.map((x) => (x.id === turn.id ? { ...x, applied: { before: current, after } } : x)));
  }

  function undo(turn: Turn): void {
    if (!turn.result || !turn.applied) return;
    const path = turn.result.path;
    if (getFileText(connection.doc, path).toString() !== turn.applied.after) return;
    replaceWhole(connection, path, turn.applied.before, origin);
    setTurns((t) => t.map((x) => (x.id === turn.id ? { ...x, applied: undefined } : x)));
  }

  async function copy(turn: Turn): Promise<void> {
    if (!turn.result) return;
    try {
      await navigator.clipboard.writeText(turn.result.code);
      setCopiedId(turn.id);
      window.setTimeout(() => setCopiedId(null), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-slate-800/80 px-3 py-2">
        <p className="flex items-center gap-1.5 text-[11px] text-slate-400">
          <FileCode2 size={12} aria-hidden className="text-violet-400" />
          <span>Viewing</span>
          <span className="truncate font-medium text-slate-200" title={activePath}>
            {activePath}
          </span>
        </p>
        <p className="mt-1 text-[10px] leading-relaxed text-slate-500">
          Your open file is sent with every request. Type <span className="text-violet-300">@</span> to add other files.
          Changes stay minimal unless you ask to optimise.
        </p>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {turns.length === 0 && (
          <div className="rounded-md border border-dashed border-slate-700 px-3 py-4 text-[11px] leading-relaxed text-slate-500">
            <p className="mb-1 flex items-center gap-1.5 text-slate-300">
              <Sparkles size={13} className="text-violet-400" aria-hidden /> Try
            </p>
            <ul className="list-disc space-y-1 pl-4">
              <li>“fix the compile errors”</li>
              <li>“why does <span className="text-violet-300">@l.cpp</span> print the wrong sum?”</li>
              <li>“make <span className="text-violet-300">@l.py</span> faster — optimise it”</li>
            </ul>
          </div>
        )}
        {turns.map((turn) => (
          <TurnView
            key={turn.id}
            turn={turn}
            copied={copiedId === turn.id}
            onApply={() => apply(turn)}
            onUndo={() => undo(turn)}
            onCopy={() => void copy(turn)}
            onDiscard={() => setTurns((t) => t.filter((x) => x.id !== turn.id))}
            currentText={turn.result ? getFileText(connection.doc, turn.result.path).toString() : ''}
          />
        ))}
      </div>

      <form
        className="relative shrink-0 border-t border-slate-800/80 p-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        {menu && (
          <ul
            role="listbox"
            aria-label="Files"
            className="absolute inset-x-2 bottom-full z-10 mb-1 max-h-48 overflow-y-auto rounded-md border border-slate-700 bg-slate-900 py-1 shadow-pop"
          >
            {menu.items.map((p, i) => (
              <li key={p} role="option" aria-selected={i === menu.index}>
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(p);
                  }}
                  className={`flex w-full items-center gap-2 px-2.5 py-1 text-left text-[12px] ${
                    i === menu.index ? 'bg-violet-500/20 text-slate-50' : 'text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  <FileCode2 size={12} aria-hidden className="shrink-0 text-slate-500" />
                  <span className="truncate">{p}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {(refs.found.length > 0 || refs.missing.length > 0) && (
          <div className="mb-1.5 flex flex-wrap gap-1">
            {refs.found.map((p) => (
              <span key={p} className="rounded-full bg-violet-500/15 px-2 py-0.5 text-[10px] text-violet-200">
                @{p}
              </span>
            ))}
            {refs.missing.map((p) => (
              <span key={p} className="rounded-full bg-rose-500/15 px-2 py-0.5 text-[10px] text-rose-300" title="No such file">
                @{p} ?
              </span>
            ))}
          </div>
        )}

        <div className="flex items-end gap-2">
          <textarea
            ref={taRef}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              updateMenu(e.target.value, e.target.selectionStart);
            }}
            onClick={(e) => updateMenu(draft, e.currentTarget.selectionStart)}
            onBlur={() => setMenu(null)}
            onKeyDown={(e) => {
              if (menu) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  const d = e.key === 'ArrowDown' ? 1 : -1;
                  setMenu({ ...menu, index: (menu.index + d + menu.items.length) % menu.items.length });
                  return;
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault();
                  pick(menu.items[menu.index]!);
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setMenu(null);
                  return;
                }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={2}
            placeholder="Describe the problem… use @file to reference a file"
            className="max-h-32 min-h-[48px] flex-1 resize-none rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-[12px] text-slate-100 outline-none placeholder:text-slate-600 focus:border-violet-400"
          />
          {busy ? (
            <button
              type="button"
              onClick={() => abortRef.current?.abort()}
              aria-label="Cancel"
              className="inline-flex h-[34px] shrink-0 items-center justify-center rounded-md bg-slate-700 px-3 text-[12px] font-medium text-white hover:bg-slate-600"
            >
              <X size={14} aria-hidden />
            </button>
          ) : (
            <button
              type="submit"
              disabled={draft.trim().length === 0}
              aria-label="Send"
              className="inline-flex h-[34px] shrink-0 items-center justify-center rounded-md bg-violet-500 px-3 text-[12px] font-medium text-white transition-colors hover:bg-violet-400 active:bg-violet-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Send size={14} aria-hidden />
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

// ── Turn rendering ────────────────────────────────────────────────────────────

function TurnView({
  turn,
  copied,
  currentText,
  onApply,
  onUndo,
  onCopy,
  onDiscard,
}: {
  turn: Turn;
  copied: boolean;
  currentText: string;
  onApply: () => void;
  onUndo: () => void;
  onCopy: () => void;
  onDiscard: () => void;
}): React.ReactElement {
  const diff = useMemo(() => {
    if (!turn.result || turn.original === undefined) return null;
    // Once applied, keep showing the change that was made.
    const base = turn.applied ? turn.applied.before : turn.original;
    const { oldText, newText } = normalise(base, turn.result.code);
    return diffLines(oldText, newText);
  }, [turn.result, turn.original, turn.applied]);

  return (
    <div className="space-y-2">
      <div className="ml-6 rounded-md bg-violet-500/15 px-2.5 py-1.5 text-[12px] text-slate-100">
        <p className="whitespace-pre-wrap break-words">{turn.prompt}</p>
      </div>

      {turn.status === 'loading' && (
        <p className="flex items-center gap-2 text-[11px] text-slate-400">
          <Loader2 size={13} className="animate-spin text-violet-400" aria-hidden /> Reading your code and thinking…
        </p>
      )}

      {turn.status === 'error' && (
        <p role="alert" className="rounded-md bg-rose-500/10 px-2.5 py-1.5 text-[12px] text-rose-300">
          {turn.error}
        </p>
      )}

      {turn.status === 'done' && turn.result && diff && (
        <div className="space-y-2">
          <div className="rounded-md bg-slate-800/50 px-2.5 py-1.5 text-[12px] leading-relaxed text-slate-200">
            <p className="whitespace-pre-wrap break-words">{turn.result.explanation}</p>
            <p className="mt-1 text-[10px] text-slate-500">
              Used: {turn.result.context.join(', ')}
              {turn.result.unresolved.length > 0 && (
                <span className="text-amber-400"> · not found: {turn.result.unresolved.map((u) => `@${u}`).join(', ')}</span>
              )}
            </p>
          </div>

          <div className="overflow-hidden rounded-md border border-slate-800 bg-slate-950">
            <div className="flex items-center justify-between border-b border-slate-800 px-2.5 py-1.5">
              <span className="truncate text-[11px] font-medium text-slate-300" title={turn.result.path}>
                {turn.result.path}
              </span>
              <span className="shrink-0 font-label text-[10px]">
                <span className="text-emerald-400">+{diff.added}</span>{' '}
                <span className="text-rose-400">−{diff.removed}</span>
              </span>
            </div>
            {diff.hunks === 0 ? (
              <p className="px-2.5 py-3 text-[11px] text-slate-500">No changes — the code already looks right.</p>
            ) : (
              <DiffView rows={diff.rows} />
            )}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {turn.applied ? (
              <>
                <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400">
                  <Check size={13} aria-hidden /> Applied to {basename(turn.result.path)}
                </span>
                <button
                  type="button"
                  onClick={onUndo}
                  disabled={currentText !== turn.applied.after}
                  title={currentText !== turn.applied.after ? 'The file changed after applying' : 'Restore the previous code'}
                  className="inline-flex items-center gap-1 rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Undo2 size={12} aria-hidden /> Undo
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={onApply}
                  disabled={diff.hunks === 0}
                  className="inline-flex items-center gap-1 rounded-md bg-violet-500 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-violet-400 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Check size={12} aria-hidden /> Apply changes
                </button>
                <button
                  type="button"
                  onClick={onCopy}
                  className="inline-flex items-center gap-1 rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800"
                >
                  {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
                  {copied ? 'Copied' : 'Copy code'}
                </button>
                <button
                  type="button"
                  onClick={onDiscard}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-slate-500 hover:bg-slate-800 hover:text-slate-200"
                >
                  Discard
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
