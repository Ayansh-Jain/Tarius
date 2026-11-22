/**
 * Terminal pane — a read-only view of the room's shared terminal channel (v0.5).
 *
 * The server streams a pty's output into the Yjs `Y.Text` at `doc.getText('terminal')`
 * (a CRDT append log). We mount an xterm.js terminal and mirror that text into it:
 * on mount we replay the whole buffer, then on every change we write only the
 * newly-appended tail (tracking how much we've already rendered). If the shared
 * text is ever truncated/reset, we clear and replay from scratch.
 *
 * Read-only is the v0.5 contract: humans watch the agent's commands/output here;
 * driving the pty (stdin) is a later release. We therefore don't wire onData.
 *
 * The channel key 'terminal' is a direct Y.Text (not in YDOC_KEYS) by design —
 * it's a transient output stream, not part of the persisted file/agent model.
 */
import { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { RoomConnection } from '../lib/connection.js';

/** Well-known shared-terminal channel name (matches the server's pty writer). */
export const TERMINAL_TEXT_KEY = 'terminal';

/** xterm theme tuned to sit flush inside the dark room chrome. */
const xtermTheme = {
  background: '#101010',
  foreground: '#F5F3EF',
  cursor: '#FF7139',
  selectionBackground: 'rgba(255,113,57,0.25)',
  black: '#141414',
  red: '#E47B74',
  green: '#79C9A4',
  yellow: '#E6B56C',
  blue: '#8DB4E8',
  magenta: '#B1A4DD',
  cyan: '#8DD0C8',
  white: '#E2DFDA',
  brightBlack: '#747474',
};

interface TerminalPaneProps {
  connection: RoomConnection;
  roomId: string;
}

export function TerminalPane({ connection, roomId }: TerminalPaneProps): React.ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      convertEol: true, // pty newlines are \n; render them as CRLF
      cursorBlink: false,
      disableStdin: true, // read-only view (v0.5)
      fontSize: 12,
      fontFamily: '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace',
      theme: xtermTheme,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);

    // Fit to the container now and whenever it resizes.
    const doFit = (): void => {
      try {
        fit.fit();
      } catch {
        // fit can throw if the element is detached/zero-sized; ignore.
      }
    };
    doFit();
    const ro = new ResizeObserver(doFit);
    ro.observe(host);

    const ytext: Y.Text = connection.doc.getText(TERMINAL_TEXT_KEY);

    // How many characters we've already pushed into xterm. The shared text is
    // an append log, so normally we just write the tail beyond this offset.
    let rendered = 0;

    const replayAll = (): void => {
      const full = ytext.toString();
      term.clear();
      term.reset();
      if (full.length > 0) term.write(full);
      rendered = full.length;
    };

    // Initial paint of whatever's already in the buffer.
    replayAll();

    const onChange = (): void => {
      const full = ytext.toString();
      if (full.length < rendered) {
        // Truncated/reset upstream — safest to replay the whole buffer.
        replayAll();
        return;
      }
      if (full.length > rendered) {
        term.write(full.slice(rendered));
        rendered = full.length;
      }
    };
    ytext.observe(onChange);

    return () => {
      ytext.unobserve(onChange);
      ro.disconnect();
      term.dispose();
    };
  }, [connection]);

  const [cmd, setCmd] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const history = useRef<string[]>([]);
  const histIdx = useRef(-1);

  const submit = async (): Promise<void> => {
    const command = cmd.trim();
    if (!command) return;
    history.current.unshift(command);
    histIdx.current = -1;
    setCmd('');
    setErr(null);
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/terminal/run`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setErr(body.error ?? `${res.status} ${res.statusText}`);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void submit();
    } else if (e.key === 'ArrowUp' && history.current.length > 0) {
      e.preventDefault();
      histIdx.current = Math.min(histIdx.current + 1, history.current.length - 1);
      setCmd(history.current[histIdx.current] ?? '');
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      histIdx.current = Math.max(histIdx.current - 1, -1);
      setCmd(histIdx.current === -1 ? '' : (history.current[histIdx.current] ?? ''));
    }
  };

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-[#101010] px-3 py-2">
      {/* xterm sizes itself to this host; the FitAddon keeps cols/rows in sync. */}
      <div ref={hostRef} className="min-h-0 w-full flex-1" />
      {err && <p className="px-1 text-[11px] text-rose-400">{err}</p>}
      <div className="flex shrink-0 items-center gap-2 border-t border-slate-800 pt-1.5">
        <span className="font-mono text-xs text-ember-500">$</span>
        <input
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Run a command in the shared terminal…"
          spellCheck={false}
          autoComplete="off"
          aria-label="Terminal command"
          className="min-w-0 flex-1 bg-transparent font-mono text-xs text-slate-100 outline-none placeholder:text-slate-500"
        />
      </div>
    </div>
  );
}
