/**
 * Identity gate.
 *
 *  - mode 'join': someone opened an invite link (/r/:id) without an identity yet.
 *  - mode 'edit': in-room modal to change display name + color.
 *
 * Name + color persist to localStorage (see lib/identity).
 */
import { useId, useState } from 'react';
import { Check, RefreshCw } from 'lucide-react';
import { COLOR_PALETTE, suggestName, type StoredIdentity } from '../lib/identity.js';
import { Logo } from './ui.js';

export type LandingMode = 'join' | 'edit';

interface LandingProps {
  mode: LandingMode;
  initial?: StoredIdentity | null;
  /** Room being joined when mode === 'join' (shown for context). */
  joiningRoomId?: string;
  busy?: boolean;
  onSubmit: (value: { name: string; color: string }) => void;
  /** Only present in 'edit' mode (modal dismiss). */
  onCancel?: () => void;
}

export function Landing({
  mode,
  initial,
  joiningRoomId,
  busy = false,
  onSubmit,
  onCancel,
}: LandingProps): React.ReactElement {
  const nameFieldId = useId();
  const [name, setName] = useState(initial?.name ?? '');
  const [color, setColor] = useState<string>(initial?.color ?? COLOR_PALETTE[0]);

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault();
    onSubmit({ name: name.trim() || suggestName(), color });
  }

  const card = (
    <form
      onSubmit={handleSubmit}
      aria-label={mode === 'edit' ? 'Edit your identity' : 'Join room'}
      className="animate-pop-in w-full max-w-md rounded-card border border-slate-800 bg-slate-900 p-7 shadow-pop"
    >
      <Logo />
      <h1 className="mt-6 font-display text-2xl font-semibold tracking-tight">
        {mode === 'edit' ? 'Your identity' : 'Join the session'}
      </h1>
      <p className="mt-1.5 text-sm text-slate-400">
        {mode === 'edit'
          ? 'Update how you appear to the room.'
          : 'Pick how you’ll appear, then jump in.'}
      </p>
      {mode === 'join' && joiningRoomId && (
        <p className="mt-3 inline-flex items-center gap-2 rounded-control bg-slate-800 px-2.5 py-1.5 text-xs text-slate-300">
          Room <span className="font-mono text-slate-100">{joiningRoomId}</span>
        </p>
      )}

      <label htmlFor={nameFieldId} className="mb-1.5 mt-6 block text-xs font-medium text-slate-300">
        Display name
      </label>
      <div className="flex gap-2">
        <input
          id={nameFieldId}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={suggestName()}
          maxLength={32}
          autoFocus
          autoComplete="off"
          className="input-field"
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
        {COLOR_PALETTE.map((c) => {
          const selected = c === color;
          return (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              aria-label={`Pick color ${c}`}
              aria-pressed={selected}
              className={`relative flex h-8 w-8 items-center justify-center rounded-full ring-offset-2 ring-offset-slate-900 transition-transform hover:scale-110 ${
                selected ? 'ring-2 ring-slate-100' : ''
              }`}
              style={{ backgroundColor: c }}
            >
              {selected && <Check size={14} className="text-slate-950" aria-hidden />}
            </button>
          );
        })}
      </div>

      <div className="mt-7 flex items-center gap-3">
        {mode === 'edit' && onCancel && (
          <button type="button" onClick={onCancel} className="btn-secondary">
            Cancel
          </button>
        )}
        <button type="submit" disabled={busy} className="btn-primary flex-1">
          {busy ? 'Working…' : mode === 'edit' ? 'Save' : 'Join room'}
        </button>
      </div>

      {mode === 'join' && (
        <p className="mt-4 text-center text-[11px] text-slate-500">
          No account needed. Your name &amp; color are saved on this device.
        </p>
      )}
    </form>
  );

  if (mode === 'edit') {
    return (
      <div
        role="dialog"
        aria-modal="true"
        className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 p-4 backdrop-blur-sm"
      >
        {card}
      </div>
    );
  }
  return <div className="flex min-h-screen items-center justify-center bg-slate-950 p-4">{card}</div>;
}
