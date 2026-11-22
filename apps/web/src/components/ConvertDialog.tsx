/**
 * Convert the open file into another language (C++, Python, Java, JavaScript).
 *
 * The result is a private preview until the user saves it as a new file in the
 * room (so teammates only see it if you choose). Source files are never
 * modified, which also makes converting "back" a second, separate conversion.
 */
import { ArrowRight, Check, Copy, FilePlus2, Loader2, RefreshCw, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { EditOrigin } from '@ice/shared';
import { getFileText } from '@ice/shared';
import type { RoomConnection } from '../lib/connection.js';
import {
  LANGS,
  convertCode,
  detectLang,
  extFor,
  fetchApiStatus,
  langLabel,
  type ApiStatus,
  type LangId,
} from '../lib/convert.js';
import { importEntries } from '../lib/importFiles.js';
import { basename, dirname, nodeExists } from '../lib/tree.js';

interface ConvertDialogProps {
  connection: RoomConnection;
  path: string;
  origin: EditOrigin;
  onClose: () => void;
  onOpenFile: (path: string) => void;
}

function uniqueConvertedPath(connection: RoomConnection, path: string, to: LangId): string {
  const dir = dirname(path);
  const base = basename(path).replace(/\.[^.]+$/, '');
  const prefix = dir ? `${dir}/` : '';
  let candidate = `${prefix}${base}.${extFor(to)}`;
  let n = 2;
  while (nodeExists(connection.doc, candidate)) {
    candidate = `${prefix}${base}-converted${n > 2 ? `-${n}` : ''}.${extFor(to)}`;
    n++;
  }
  return candidate;
}

export function ConvertDialog({
  connection,
  path,
  origin,
  onClose,
  onOpenFile,
}: ConvertDialogProps): React.ReactElement {
  const detected = detectLang(path);
  const [from, setFrom] = useState<LangId>(detected ?? 'javascript');
  const [to, setTo] = useState<LangId>(() => (detected === 'python' ? 'javascript' : 'python'));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [savedAs, setSavedAs] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const source = useMemo(() => getFileText(connection.doc, path).toString(), [connection, path]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function reset(): void {
    setResult(null);
    setError(null);
    setSavedAs(null);
  }

  async function run(): Promise<void> {
    reset();
    if (from === to) {
      setError('Pick a different target language.');
      return;
    }
    if (!source.trim()) {
      setError('This file is empty.');
      return;
    }
    setBusy(true);
    try {
      setResult(await convertCode(source, from, to));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'We could not convert this file right now.');
    } finally {
      setBusy(false);
    }
  }

  async function copy(): Promise<void> {
    if (result === null) return;
    try {
      await navigator.clipboard.writeText(result);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Could not copy to the clipboard.');
    }
  }

  function save(): void {
    if (result === null) return;
    const target = uniqueConvertedPath(connection, path, to);
    const summary = importEntries(connection.doc, [{ path: target, content: result }], origin, false);
    if (summary.added === 1) {
      setSavedAs(target);
      onOpenFile(target);
    }
  }

  const select =
    'rounded-control border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-ember-500 focus:outline-none focus:ring-1 focus:ring-ember-500/60';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Convert file to another language"
        className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-card border border-slate-700 bg-slate-900 shadow-pop"
      >
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3">
          <div className="min-w-0">
            <h2 className="font-display text-base font-semibold text-slate-100">Convert code</h2>
            <p className="truncate font-label text-[11px] text-slate-500">{path}</p>
          </div>
          <button
            ref={closeRef}
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="rounded p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex flex-wrap items-end gap-3 border-b border-slate-800 px-5 py-4">
          <label className="flex flex-col gap-1 text-[11px] text-slate-400">
            From
            <select
              className={select}
              value={from}
              onChange={(e) => {
                setFrom(e.target.value as LangId);
                reset();
              }}
            >
              {LANGS.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
          <ArrowRight size={16} className="mb-3 text-slate-500" aria-hidden />
          <label className="flex flex-col gap-1 text-[11px] text-slate-400">
            To
            <select
              className={select}
              value={to}
              onChange={(e) => {
                setTo(e.target.value as LangId);
                reset();
              }}
            >
              {LANGS.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="btn-primary" disabled={busy} onClick={() => void run()}>
            {busy ? <Loader2 size={15} className="animate-spin" aria-hidden /> : null}
            {busy ? 'Converting…' : 'Convert'}
          </button>
          {detected === null && (
            <p className="basis-full text-[11px] text-slate-500">
              We could not tell this file's language from its name, so please check the "From" language.
            </p>
          )}
        </div>

        <div className="min-h-[12rem] flex-1 overflow-auto bg-slate-950 px-5 py-4">
          {error && (
            <p role="alert" className="rounded-control bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
              {error}
            </p>
          )}
          {!error && result === null && !busy && (
            <p className="text-sm text-slate-500">
              Choose a language and press Convert. Your original file stays unchanged, and you decide whether to
              save the result into the room.
            </p>
          )}
          {busy && <p className="text-sm text-slate-400">Converting {basename(path)}…</p>}
          {result !== null && (
            <pre className="whitespace-pre-wrap break-words font-mono text-[12.5px] leading-relaxed text-slate-100">
              {result}
            </pre>
          )}
        </div>

        {result !== null && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800 px-5 py-3">
            <span className="text-[11px] text-slate-500">
              {langLabel(from)} → {langLabel(to)}
              {savedAs && <span className="ml-2 text-emerald-400">Saved as {savedAs}</span>}
            </span>
            <div className="flex gap-2">
              <button type="button" className="btn-secondary !px-3 !py-1.5 !text-xs" onClick={() => void copy()}>
                {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
                {copied ? 'Copied' : 'Copy'}
              </button>
              <button type="button" className="btn-secondary !px-3 !py-1.5 !text-xs" onClick={() => void run()} disabled={busy}>
                <RefreshCw size={13} aria-hidden /> Redo
              </button>
              <button type="button" className="btn-primary !px-3 !py-1.5 !text-xs" onClick={save} disabled={savedAs !== null}>
                <FilePlus2 size={13} aria-hidden /> Save as new file
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Small always-visible indicator for the conversion backup's health. */
export function ApiStatusChip(): React.ReactElement {
  const [status, setStatus] = useState<ApiStatus>('checking');
  const [rechecking, setRechecking] = useState(false);

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      const s = await fetchApiStatus();
      if (!alive) return;
      setStatus(s);
      // Startup probe may still be running; poll quickly until it settles.
      timer = window.setTimeout(() => void poll(), s === 'checking' ? 1500 : 60_000);
    };
    void poll();
    return () => {
      alive = false;
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  async function recheck(): Promise<void> {
    setRechecking(true);
    setStatus('checking');
    setStatus(await fetchApiStatus(true));
    setRechecking(false);
  }

  const meta: Record<ApiStatus, { label: string; dot: string; title: string }> = {
    working: { label: 'API ready', dot: 'bg-emerald-400', title: 'Backup conversion API is working. Click to re-test.' },
    checking: { label: 'API checking…', dot: 'bg-amber-400 animate-pulse', title: 'Testing the backup conversion API…' },
    unavailable: { label: 'API down', dot: 'bg-rose-400', title: 'Backup conversion API is not responding. Click to re-test.' },
    not_configured: { label: 'API not set', dot: 'bg-slate-500', title: 'No backup API key configured. Click to re-test.' },
  };
  const m = meta[status];
  return (
    <button
      type="button"
      onClick={() => void recheck()}
      disabled={rechecking}
      title={m.title}
      aria-label={m.title}
      className="inline-flex items-center gap-1.5 rounded-full border border-slate-800 px-2.5 py-1 font-label text-[10px] text-slate-400 transition-colors hover:border-slate-700 hover:bg-slate-800"
    >
      <span className={`h-1.5 w-1.5 rounded-full ${m.dot}`} />
      {m.label}
    </button>
  );
}
