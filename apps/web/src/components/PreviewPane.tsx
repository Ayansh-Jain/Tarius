/**
 * PreviewPane — a shared live preview of the room's running dev server (ICE
 * v1.0 Slice C).
 *
 * The squad runs their app on some port (e.g. a Vite dev server inside the
 * room's workspace); this pane points an <iframe> at that URL so everyone sees
 * the running app next to the code. Deliberately simple for v1.0: no server
 * proxy, just an iframe + a URL bar + refresh, with a friendly empty state.
 *
 * "Shared" with no backend: the preview URL is coordinated through the room's
 * Yjs `meta` map (key `previewUrl`), written under a `system` origin via
 * `transactWithOrigin` (we never mutate room state outside a tagged txn). So
 * when one teammate points the preview at `localhost:5173`, everyone's pane
 * follows — same as the rest of the room state. We also mirror the last URL to
 * localStorage as a per-room default for the first paint before sync lands.
 *
 * Caveats surfaced in the UI: an app that sends `X-Frame-Options: DENY` /
 * a restrictive CSP can't be framed; we can't detect that cross-origin, so we
 * offer an "open in a new tab" escape hatch alongside the frame.
 *
 * Self-contained: props are `{ roomId, connection }`, matching the other panels.
 */
import { Monitor } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getMeta, transactWithOrigin } from '@ice/shared';
import type { RoomConnection } from '../lib/connection.js';

interface PreviewPaneProps {
  roomId: string;
  connection: RoomConnection;
}

/** Key under the room's Yjs meta map where the shared preview URL lives. */
const META_PREVIEW_URL = 'previewUrl';

function storageKey(roomId: string): string {
  return `ice.preview.url.${roomId}`;
}

/**
 * Normalize user input into a loadable URL, or null if it can't be one.
 * Bare `localhost:3000` / `127.0.0.1:5173` get an `http://` scheme; anything
 * without a scheme and not host-like is rejected so we don't frame garbage.
 */
function normalizeUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  let candidate = raw;
  if (!/^https?:\/\//i.test(candidate)) {
    // Accept host[:port][/path] and localhost shorthands.
    if (/^(localhost|\d{1,3}(\.\d{1,3}){3}|[\w.-]+)(:\d+)?(\/.*)?$/i.test(candidate)) {
      candidate = `http://${candidate}`;
    } else {
      return null;
    }
  }
  try {
    const u = new URL(candidate);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** Read the shared preview URL from the doc, falling back to localStorage. */
function readInitialUrl(connection: RoomConnection, roomId: string): string {
  const fromDoc = getMeta(connection.doc).get(META_PREVIEW_URL);
  if (typeof fromDoc === 'string' && fromDoc) return fromDoc;
  try {
    return localStorage.getItem(storageKey(roomId)) ?? '';
  } catch {
    return '';
  }
}

export function PreviewPane({ roomId, connection }: PreviewPaneProps): React.ReactElement {
  // The committed URL the iframe is actually showing (shared via the doc).
  const [url, setUrl] = useState<string>(() => readInitialUrl(connection, roomId));
  // The editable text in the URL bar (may differ from `url` while typing).
  const [draft, setDraft] = useState<string>(() => readInitialUrl(connection, roomId));
  const [invalid, setInvalid] = useState(false);
  // Bumping this remounts the iframe → a hard refresh of the preview.
  const [reloadKey, setReloadKey] = useState(0);

  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  // ── Subscribe to the shared URL in the room's meta map ──────────────────
  useEffect(() => {
    const meta = getMeta(connection.doc);
    const sync = (): void => {
      const next = meta.get(META_PREVIEW_URL);
      if (typeof next === 'string') {
        setUrl((prev) => (prev === next ? prev : next));
        // Only overwrite the draft when the user isn't mid-edit (draft === url).
        setDraft((prevDraft) => {
          // If the draft already matches the previous shared value, follow along.
          return prevDraft === url || prevDraft === '' ? next : prevDraft;
        });
      }
    };
    meta.observe(sync);
    sync();
    return () => meta.unobserve(sync);
    // `url` intentionally excluded: we read it inside but re-subscribing on every
    // url change would thrash; the observer closure reads the latest via setState.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection]);

  // Persist a per-room default for the next first paint.
  useEffect(() => {
    try {
      if (url) localStorage.setItem(storageKey(roomId), url);
    } catch {
      // private-mode browsers may reject writes; non-fatal.
    }
  }, [roomId, url]);

  /** Publish a new shared preview URL into the doc (system-origin txn). */
  const publishUrl = useCallback(
    (next: string) => {
      setUrl(next);
      transactWithOrigin(connection.doc, { kind: 'system' }, () => {
        getMeta(connection.doc).set(META_PREVIEW_URL, next);
      });
    },
    [connection],
  );

  const handleGo = useCallback(() => {
    const normalized = normalizeUrl(draft);
    if (!normalized) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setDraft(normalized);
    if (normalized === url) {
      // Same target: just force a refresh.
      setReloadKey((k) => k + 1);
    } else {
      publishUrl(normalized);
    }
  }, [draft, publishUrl, url]);

  const handleRefresh = useCallback(() => {
    setReloadKey((k) => k + 1);
  }, []);

  const handleClear = useCallback(() => {
    setDraft('');
    setInvalid(false);
    publishUrl('');
  }, [publishUrl]);

  const openInTab = useCallback(() => {
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  }, [url]);

  const hasUrl = url.length > 0;
  const displayHost = useMemo(() => {
    if (!url) return '';
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  }, [url]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ── URL bar ──────────────────────────────────────────────────────── */}
      <form
        className="flex shrink-0 items-center gap-1.5 border-b border-slate-800/80 px-2 py-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          handleGo();
        }}
      >
        <button
          type="button"
          onClick={handleRefresh}
          disabled={!hasUrl}
          title="Refresh preview"
          aria-label="Refresh preview"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <span className="text-[13px] leading-none">⟳</span>
        </button>

        <div className="relative min-w-0 flex-1">
          <input
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              if (invalid) setInvalid(false);
            }}
            placeholder="localhost:5173"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className={`w-full rounded-md border bg-slate-900 px-2.5 py-1 font-mono text-[12px] text-slate-100 outline-none placeholder:text-slate-600 ${
              invalid
                ? 'border-rose-500/60 focus:border-rose-400'
                : 'border-slate-700 focus:border-indigo-400'
            }`}
            aria-label="Preview URL"
            aria-invalid={invalid}
          />
          {draft && (
            <button
              type="button"
              onClick={handleClear}
              title="Clear"
              aria-label="Clear preview URL"
              className="absolute right-1 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-200"
            >
              <span className="text-[12px] leading-none">×</span>
            </button>
          )}
        </div>

        <button
          type="submit"
          className="shrink-0 rounded-md bg-indigo-500 px-2.5 py-1 text-[12px] font-medium text-white transition-colors hover:bg-indigo-400 active:bg-indigo-600"
        >
          Go
        </button>
        <button
          type="button"
          onClick={openInTab}
          disabled={!hasUrl}
          title="Open in a new tab"
          aria-label="Open preview in a new tab"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <span className="text-[12px] leading-none">↗</span>
        </button>
      </form>

      {invalid && (
        <p className="shrink-0 bg-rose-500/10 px-3 py-1 text-[11px] text-rose-300">
          That doesn’t look like a URL. Try something like <code>localhost:5173</code>.
        </p>
      )}

      {/* ── Frame / empty state ──────────────────────────────────────────── */}
      <div className="relative min-h-0 flex-1 bg-slate-950">
        {hasUrl ? (
          <iframe
            key={`${url}#${reloadKey}`}
            ref={iframeRef}
            src={url}
            title={`Preview of ${displayHost}`}
            className="h-full w-full border-0 bg-white"
            // Let the previewed app run, but keep it from reaching back into the
            // host page. allow-same-origin + allow-scripts is the usual combo a
            // dev server needs; we omit allow-top-navigation so it can't hijack us.
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-slate-800 text-slate-400">
              <Monitor size={22} aria-hidden />
            </div>
            <div className="space-y-1">
              <p className="text-[13px] font-medium text-slate-200">Live preview</p>
              <p className="mx-auto max-w-xs text-[11px] leading-relaxed text-slate-500">
                Point this at your running dev server — type a URL like{' '}
                <code className="rounded bg-slate-800 px-1 font-mono text-slate-300">
                  localhost:5173
                </code>{' '}
                above. Everyone in the room sees the same preview.
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-1.5">
              {['localhost:5173', 'localhost:3000', 'localhost:8080'].map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => {
                    const normalized = normalizeUrl(suggestion);
                    if (normalized) {
                      setDraft(normalized);
                      publishUrl(normalized);
                    }
                  }}
                  className="rounded-full border border-slate-700/80 bg-slate-800/40 px-2.5 py-1 font-mono text-[11px] text-slate-400 transition-colors hover:border-indigo-400/50 hover:text-slate-100"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
