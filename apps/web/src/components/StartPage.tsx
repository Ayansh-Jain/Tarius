/**
 * Create / Join room page (route '/start').
 *
 * Uses the existing flows unchanged: createRoom() from lib/api, identity from
 * lib/identity, and plain navigation to /r/:id for joining.
 */
import { useId, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Copy, DoorOpen, Plus, RefreshCw } from 'lucide-react';
import { createRoom } from '../lib/api.js';
import { COLOR_PALETTE, suggestName, type StoredIdentity } from '../lib/identity.js';
import { getRecentRooms, parseRoomInput, rememberRoom } from '../lib/rooms.js';
import { Logo } from './ui.js';

interface StartPageProps {
  initial: StoredIdentity | null;
  onIdentity: (value: { name: string; color: string }) => void;
  onNavigate: (path: string) => void;
}

const SUGGESTIONS = ['midnight-build', 'side-project', 'ship-it', 'debug-club'];

interface Created {
  id: string;
  name: string;
}

export function StartPage({ initial, onIdentity, onNavigate }: StartPageProps): React.ReactElement {
  const nameId = useId();
  const roomNameId = useId();
  const joinId = useId();

  const [name, setName] = useState(initial?.name ?? '');
  const [color, setColor] = useState<string>(initial?.color ?? COLOR_PALETTE[0]);
  const [roomName, setRoomName] = useState('');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [copied, setCopied] = useState<'link' | 'code' | null>(null);

  const [joinValue, setJoinValue] = useState('');
  const [joinError, setJoinError] = useState<string | null>(null);
  const joinRef = useRef<HTMLInputElement | null>(null);
  const recent = useRef(getRecentRooms()).current;

  const identityValue = (): { name: string; color: string } => ({
    name: name.trim() || suggestName(),
    color,
  });

  async function handleCreate(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setCreateError(null);
    setCreating(true);
    try {
      const id = identityValue();
      onIdentity(id);
      const finalName = roomName.trim() || `${id.name}'s room`;
      const room = await createRoom(finalName);
      rememberRoom(room.id, finalName);
      setCreated({ id: room.id, name: finalName });
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Could not create the room. Try again.');
    } finally {
      setCreating(false);
    }
  }

  function handleJoin(e: React.FormEvent): void {
    e.preventDefault();
    const id = parseRoomInput(joinValue);
    if (!id) {
      setJoinError(
        joinValue.trim()
          ? 'That doesn’t look like a room code or invite link.'
          : 'Enter a room code or paste an invite link.',
      );
      joinRef.current?.focus();
      return;
    }
    setJoinError(null);
    rememberRoom(id);
    onNavigate(`/r/${encodeURIComponent(id)}`);
  }

  async function copy(kind: 'link' | 'code'): Promise<void> {
    if (!created) return;
    const text = kind === 'link' ? `${window.location.origin}/r/${created.id}` : created.id;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      window.prompt('Copy this:', text);
    }
    setCopied(kind);
    window.setTimeout(() => setCopied(null), 1600);
  }

  return (
    <div className="glow-ember min-h-screen bg-slate-950 text-slate-100">
      <div className="bg-dots pointer-events-none fixed inset-0 [mask-image:linear-gradient(to_bottom,black,transparent_60%)]" />
      <header className="relative mx-auto flex h-16 max-w-5xl items-center justify-between px-5">
        <a
          href="/"
          onClick={(e) => {
            e.preventDefault();
            onNavigate('/');
          }}
          aria-label="ICE home"
        >
          <Logo />
        </a>
        <button
          type="button"
          onClick={() => onNavigate('/')}
          className="inline-flex items-center gap-1.5 text-sm text-slate-400 transition-colors hover:text-slate-100"
        >
          <ArrowLeft size={14} aria-hidden /> Home
        </button>
      </header>

      <main className="page-enter relative mx-auto max-w-5xl px-5 pb-20 pt-10">
        <h1 className="font-display text-4xl font-semibold tracking-[-0.03em] sm:text-5xl">
          Start <span className="text-ember-500">something</span> together.
        </h1>
        <p className="mt-3 text-slate-400">
          Create your own workspace or jump into an existing session.
        </p>

        <div className="mt-12 grid gap-5 md:grid-cols-[1.15fr_1fr]">
          {/* ── Create ─────────────────────────────────────────────── */}
          <section
            aria-labelledby="create-h"
            className="rounded-card border border-slate-800 bg-slate-900 p-6 sm:p-7"
          >
            {created ? (
              <div className="animate-pop-in">
                <span className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-full bg-ember-900 text-ember-500">
                  <Check size={20} aria-hidden />
                </span>
                <h2 id="create-h" className="font-display text-2xl font-semibold tracking-tight">
                  {created.name} is ready.
                </h2>
                <p className="mt-1.5 text-sm text-slate-400">
                  Share the link or code, then step inside.
                </p>

                <dl className="mt-6 space-y-3">
                  <div className="rounded-control border border-slate-800 bg-slate-950 px-3.5 py-3">
                    <dt className="eyebrow mb-1">Room code</dt>
                    <dd className="flex items-center justify-between gap-3">
                      <code className="truncate font-mono text-sm text-slate-100">{created.id}</code>
                      <button
                        type="button"
                        onClick={() => void copy('code')}
                        aria-label="Copy room code"
                        className="text-slate-400 transition-colors hover:text-slate-100"
                      >
                        {copied === 'code' ? <Check size={16} /> : <Copy size={16} />}
                      </button>
                    </dd>
                  </div>
                </dl>

                <div className="mt-5 flex flex-wrap gap-3">
                  <button type="button" className="btn-secondary" onClick={() => void copy('link')}>
                    {copied === 'link' ? <Check size={16} aria-hidden /> : <Copy size={16} aria-hidden />}
                    {copied === 'link' ? 'Link copied' : 'Copy Invite Link'}
                  </button>
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={() => onNavigate(`/r/${encodeURIComponent(created.id)}`)}
                  >
                    Enter Workspace
                    <ArrowRight size={16} aria-hidden />
                  </button>
                </div>
              </div>
            ) : (
              <form onSubmit={(e) => void handleCreate(e)} noValidate>
                <h2 id="create-h" className="font-display text-2xl font-semibold tracking-tight">
                  Create a Room
                </h2>
                <p className="mt-1.5 text-sm text-slate-400">A fresh workspace, ready in seconds.</p>

                <label htmlFor={roomNameId} className="mb-1.5 mt-6 block text-xs font-medium text-slate-300">
                  Room name
                </label>
                <input
                  id={roomNameId}
                  className="input-field"
                  value={roomName}
                  onChange={(e) => setRoomName(e.target.value)}
                  placeholder="midnight-build"
                  maxLength={48}
                  autoComplete="off"
                />
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setRoomName(s)}
                      className="rounded-full border border-slate-800 px-2.5 py-1 font-label text-[11px] text-slate-400 transition-colors hover:border-slate-700 hover:text-slate-100"
                    >
                      {s}
                    </button>
                  ))}
                </div>

                <label htmlFor={nameId} className="mb-1.5 mt-6 block text-xs font-medium text-slate-300">
                  Your display name
                </label>
                <div className="flex gap-2">
                  <input
                    id={nameId}
                    className="input-field"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={suggestName()}
                    maxLength={32}
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    onClick={() => setName(suggestName())}
                    aria-label="Suggest a name"
                    className="btn-secondary !px-3"
                  >
                    <RefreshCw size={15} aria-hidden />
                  </button>
                </div>

                <p className="mb-2 mt-5 text-xs font-medium text-slate-300">Your color</p>
                <div className="flex flex-wrap gap-2" role="group" aria-label="Your color">
                  {COLOR_PALETTE.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setColor(c)}
                      aria-label={`Pick color ${c}`}
                      aria-pressed={c === color}
                      className={`h-7 w-7 rounded-full ring-offset-2 ring-offset-slate-900 transition-transform hover:scale-110 ${
                        c === color ? 'ring-2 ring-slate-100' : ''
                      }`}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </div>

                {createError && (
                  <p role="alert" className="mt-4 text-sm text-rose-400">
                    {createError}
                  </p>
                )}

                <button type="submit" disabled={creating} className="btn-primary mt-7 w-full">
                  <Plus size={16} aria-hidden />
                  {creating ? 'Creating…' : 'Create Workspace'}
                </button>
              </form>
            )}
          </section>

          {/* ── Join ───────────────────────────────────────────────── */}
          <section
            id="join"
            aria-labelledby="join-h"
            className="h-fit rounded-card border border-slate-800 bg-slate-900 p-6 sm:p-7"
          >
            <form onSubmit={handleJoin} noValidate>
              <h2 id="join-h" className="font-display text-2xl font-semibold tracking-tight">
                Join a Room
              </h2>
              <p className="mt-1.5 text-sm text-slate-400">Paste a room code or invite link.</p>

              <label htmlFor={joinId} className="mb-1.5 mt-6 block text-xs font-medium text-slate-300">
                Room code or link
              </label>
              <input
                id={joinId}
                ref={joinRef}
                className={`input-field ${joinError ? '!border-rose-400' : ''}`}
                value={joinValue}
                onChange={(e) => {
                  setJoinValue(e.target.value);
                  if (joinError) setJoinError(null);
                }}
                placeholder="room code or http://…/r/…"
                aria-invalid={joinError ? true : undefined}
                aria-describedby={joinError ? `${joinId}-err` : undefined}
                autoComplete="off"
              />
              {joinError && (
                <p id={`${joinId}-err`} role="alert" className="mt-2 text-sm text-rose-400">
                  {joinError}
                </p>
              )}

              <button type="submit" className="btn-secondary mt-5 w-full">
                <DoorOpen size={16} aria-hidden />
                Join Room
              </button>
            </form>

            {recent.length > 0 && (
              <div className="mt-8 border-t border-slate-800 pt-5">
                <p className="eyebrow mb-3">Recent rooms</p>
                <ul className="space-y-1">
                  {recent.map((r) => (
                    <li key={r.id}>
                      <button
                        type="button"
                        onClick={() => onNavigate(`/r/${encodeURIComponent(r.id)}`)}
                        className="flex w-full items-center justify-between gap-3 rounded-control px-3 py-2 text-left transition-colors hover:bg-slate-800"
                      >
                        <span className="truncate text-sm text-slate-200">{r.name ?? r.id}</span>
                        <ArrowRight size={14} className="shrink-0 text-slate-500" aria-hidden />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
