/**
 * Voice huddle panel — ICE v1.0 "Code with friends, out loud" (Slice A).
 *
 * A drop-in, self-contained voice control for a room. Audio only — Join/Leave,
 * push-to-talk, per-user (personal) mute, and live talking indicators. NO video,
 * NO screen share by product decision: the editor is the shared surface; voice
 * is just the "out loud" layer on top.
 *
 * It owns a {@link VoiceController} (which wraps livekit-client) keyed by
 * roomId+identity and subscribes to its immutable snapshots. Media never touches
 * ICE's server — the only server call is POSTing for a LiveKit token; if that
 * 503s (LIVEKIT_* env unset) we render a friendly setup hint rather than an
 * error.
 *
 * Props are intentionally minimal and match the other room panels' contract:
 *   - roomId    the workspace/room id (== the LiveKit room name)
 *   - identity  this user's stable participant id (token identity)
 *   - name      optional display name shown to other members
 */
import { AlertTriangle, Headphones, Mic, MicOff, PlugZap } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  getVoiceController,
  type VoiceMember,
  type VoiceSnapshot,
} from '../lib/voice.js';

interface VoicePanelProps {
  roomId: string;
  /** Stable per-user identity for the voice room (e.g. the participant id). */
  identity: string;
  /** Display name shown to other huddle members (falls back to identity). */
  name?: string;
}

/** The key that acts as push-to-talk while held. */
const PTT_KEY = ' '; // Space

export function VoicePanel({ roomId, identity, name }: VoicePanelProps): React.ReactElement {
  // One controller per room+identity; survives re-renders, rebuilt on change.
  const controller = useMemo(
    () => getVoiceController(roomId, identity, name?.trim() || identity),
    [roomId, identity, name],
  );

  const [snap, setSnap] = useState<VoiceSnapshot>(() => controller.current);

  useEffect(() => {
    // Only unsubscribe: the call itself outlives this panel (tab switches).
    return controller.onChange(setSnap);
  }, [controller]);

  const connected = snap.state === 'connected';
  const busy = snap.state === 'connecting';

  // ── Push-to-talk: hold Space (when connected + PTT on) to transmit. ─────────
  // We ignore auto-repeat and skip when the user is typing in an input/editor.
  const heldRef = useRef(false);
  useEffect(() => {
    if (!connected || !snap.pushToTalk) {
      heldRef.current = false;
      return;
    }
    const isEditable = (el: EventTarget | null): boolean => {
      const node = el as HTMLElement | null;
      if (!node) return false;
      const tag = node.tagName;
      return (
        node.isContentEditable ||
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT'
      );
    };
    const down = (e: KeyboardEvent): void => {
      if (e.key !== PTT_KEY || e.repeat) return;
      if (isEditable(e.target)) return;
      e.preventDefault();
      if (heldRef.current) return;
      heldRef.current = true;
      void controller.setTransmitting(true);
    };
    const up = (e: KeyboardEvent): void => {
      if (e.key !== PTT_KEY) return;
      if (!heldRef.current) return;
      e.preventDefault();
      heldRef.current = false;
      void controller.setTransmitting(false);
    };
    // Releasing focus while holding shouldn't leave the mic stuck open.
    const blur = (): void => {
      if (heldRef.current) {
        heldRef.current = false;
        void controller.setTransmitting(false);
      }
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, [controller, connected, snap.pushToTalk]);

  return (
    <section className="flex h-full w-full flex-col bg-slate-950 text-slate-200">
      <header className="flex items-center justify-between border-b border-slate-800 px-3 py-2">
        <div className="flex items-center gap-2">
          <Mic size={15} className="text-slate-400" aria-hidden />
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
            Voice
          </h2>
          {connected && (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-300">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              live · {snap.members.length}
            </span>
          )}
        </div>
        <JoinLeaveButton
          state={snap.state}
          busy={busy}
          onJoin={() => void controller.join()}
          onLeave={() => void controller.leave()}
        />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {snap.state === 'unconfigured' ? (
          <UnconfiguredHint />
        ) : snap.state === 'idle' ? (
          <IdleHint />
        ) : snap.state === 'error' ? (
          <ErrorHint message={snap.error} onRetry={() => void controller.join()} />
        ) : (
          <MemberList
            members={snap.members}
            onToggleMuteForMe={(id, muted) => controller.setMemberMutedForMe(id, muted)}
          />
        )}
        {snap.audioBlocked && connected && (
          <button
            type="button"
            onClick={() => void controller.enableAudio()}
            className="mb-2 w-full rounded-md bg-amber-500/20 px-2 py-1.5 text-xs font-semibold text-amber-300 hover:bg-amber-500/30"
          >
            Click to enable sound
          </button>
        )}
        {snap.error && snap.state === 'connected' && (
          <p className="mt-2 text-[11px] text-amber-400">{snap.error}</p>
        )}
      </div>

      {connected && (
        <footer className="border-t border-slate-800 px-3 py-2">
          <MicControls
            snap={snap}
            onTogglePtt={(on) => void controller.setPushToTalk(on)}
            onToggleMic={(on) => void controller.setTransmitting(on)}
            onPttDown={() => void controller.setTransmitting(true)}
            onPttUp={() => void controller.setTransmitting(false)}
          />
        </footer>
      )}
    </section>
  );
}

// ── Header button ─────────────────────────────────────────────────────────────

function JoinLeaveButton({
  state,
  busy,
  onJoin,
  onLeave,
}: {
  state: VoiceSnapshot['state'];
  busy: boolean;
  onJoin: () => void;
  onLeave: () => void;
}): React.ReactElement {
  if (state === 'connected') {
    return (
      <button
        type="button"
        onClick={onLeave}
        className="rounded-md bg-rose-600/90 px-2.5 py-1 text-xs font-semibold text-white transition-colors hover:bg-rose-600"
      >
        Leave
      </button>
    );
  }
  const disabled = busy || state === 'unconfigured';
  return (
    <button
      type="button"
      onClick={onJoin}
      disabled={disabled}
      className="rounded-md bg-emerald-600/90 px-2.5 py-1 text-xs font-semibold text-white transition-colors hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {busy ? 'Joining…' : 'Join voice'}
    </button>
  );
}

// ── Member list ───────────────────────────────────────────────────────────────

function MemberList({
  members,
  onToggleMuteForMe,
}: {
  members: VoiceMember[];
  onToggleMuteForMe: (identity: string, muted: boolean) => void;
}): React.ReactElement {
  if (members.length === 0) {
    return <p className="text-xs text-slate-500">Connecting to the huddle…</p>;
  }
  return (
    <ul className="flex flex-col gap-1">
      {members.map((m) => (
        <MemberRow key={m.identity} member={m} onToggleMuteForMe={onToggleMuteForMe} />
      ))}
    </ul>
  );
}

function MemberRow({
  member,
  onToggleMuteForMe,
}: {
  member: VoiceMember;
  onToggleMuteForMe: (identity: string, muted: boolean) => void;
}): React.ReactElement {
  const { speaking, micMuted, mutedForMe, isLocal } = member;
  // The "speaking" ring only shows when the member is actually audible.
  const showSpeaking = speaking && !micMuted && !mutedForMe;

  return (
    <li className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-slate-900/60">
      {/* Talking indicator: a pulsing ring around the avatar when speaking. */}
      <span
        className={`relative inline-flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-semibold text-slate-100 ring-2 transition-colors ${
          showSpeaking ? 'bg-emerald-500/25 ring-emerald-400' : 'bg-slate-700 ring-slate-700'
        }`}
        title={showSpeaking ? 'Speaking' : undefined}
      >
        {initials(member.name)}
        {showSpeaking && (
          <span className="absolute inset-0 -z-0 animate-ping rounded-full bg-emerald-400/40" />
        )}
      </span>

      <span className="min-w-0 flex-1 truncate text-xs">
        {member.name}
        {isLocal && <span className="ml-1 text-slate-500">(you)</span>}
      </span>

      {/* Source-mute glyph: this member muted their own mic. */}
      {micMuted && (
        <span
          aria-hidden
          title={isLocal ? 'Your mic is off' : `${member.name} is muted`}
          className="text-slate-500"
        >
          <MicOff size={12} aria-hidden />
        </span>
      )}

      {/* Personal mute toggle (only for remote members). */}
      {!isLocal && (
        <button
          type="button"
          onClick={() => onToggleMuteForMe(member.identity, !mutedForMe)}
          aria-pressed={mutedForMe}
          title={mutedForMe ? `Unmute ${member.name} for me` : `Mute ${member.name} for me`}
          className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
            mutedForMe
              ? 'bg-rose-500/20 text-rose-300 hover:bg-rose-500/30'
              : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-slate-200'
          }`}
        >
          {mutedForMe ? 'Muted' : 'Mute'}
        </button>
      )}
    </li>
  );
}

// ── Mic controls (footer) ─────────────────────────────────────────────────────

function MicControls({
  snap,
  onTogglePtt,
  onToggleMic,
  onPttDown,
  onPttUp,
}: {
  snap: VoiceSnapshot;
  onTogglePtt: (on: boolean) => void;
  onToggleMic: (on: boolean) => void;
  onPttDown: () => void;
  onPttUp: () => void;
}): React.ReactElement {
  const { pushToTalk, transmitting } = snap;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        {/* Open-mic toggle (hidden while in push-to-talk mode). */}
        {!pushToTalk ? (
          <button
            type="button"
            onClick={() => onToggleMic(!transmitting)}
            aria-pressed={transmitting}
            className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
              transmitting
                ? 'bg-emerald-600/90 text-white hover:bg-emerald-600'
                : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
            }`}
          >
            {transmitting ? <Mic size={13} aria-hidden /> : <MicOff size={13} aria-hidden />}
            {transmitting ? 'Mic on' : 'Mic off'}
          </button>
        ) : (
          // Push-to-talk: press-and-hold (or hold Space) to transmit.
          <button
            type="button"
            onPointerDown={(e) => {
              e.preventDefault();
              onPttDown();
            }}
            onPointerUp={onPttUp}
            onPointerLeave={() => {
              if (transmitting) onPttUp();
            }}
            className={`inline-flex select-none items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
              transmitting
                ? 'bg-emerald-500 text-white ring-2 ring-emerald-300'
                : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
            }`}
            title="Hold to talk (or hold Space)"
          >
            <Mic size={13} aria-hidden />
            {transmitting ? 'Talking…' : 'Hold to talk'}
          </button>
        )}

        {/* Push-to-talk mode switch. */}
        <label className="inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-slate-400">
          <input
            type="checkbox"
            checked={pushToTalk}
            onChange={(e) => onTogglePtt(e.target.checked)}
            className="h-3 w-3 accent-emerald-500"
          />
          Push-to-talk
        </label>
      </div>

      {pushToTalk && (
        <p className="text-[10px] text-slate-500">
          Hold <kbd className="rounded bg-slate-800 px-1 text-slate-300">Space</kbd> or the
          button to talk.
        </p>
      )}
    </div>
  );
}

// ── Empty / status states ─────────────────────────────────────────────────────

function IdleHint(): React.ReactElement {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 text-center text-slate-500">
      <Headphones size={22} aria-hidden />
      <p className="text-xs">Join the huddle to talk with everyone in the room.</p>
    </div>
  );
}

function UnconfiguredHint(): React.ReactElement {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
      <PlugZap size={22} className="text-slate-500" aria-hidden />
      <p className="text-xs font-medium text-slate-300">Voice isn’t set up yet</p>
      <p className="max-w-[14rem] text-[11px] leading-relaxed text-slate-500">
        Voice needs a LiveKit server. Set{' '}
        <code className="rounded bg-slate-800 px-1 text-slate-300">LIVEKIT_API_KEY</code>,{' '}
        <code className="rounded bg-slate-800 px-1 text-slate-300">LIVEKIT_API_SECRET</code>{' '}
        (and optionally{' '}
        <code className="rounded bg-slate-800 px-1 text-slate-300">LIVEKIT_URL</code>) on the
        server, then reload.
      </p>
    </div>
  );
}

function ErrorHint({
  message,
  onRetry,
}: {
  message: string | null;
  onRetry: () => void;
}): React.ReactElement {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
      <AlertTriangle size={22} className="text-amber-400" aria-hidden />
      <p className="text-xs font-medium text-rose-300">Couldn’t join voice</p>
      {message && (
        <p className="max-w-[15rem] text-[11px] leading-relaxed text-slate-500">{message}</p>
      )}
      <button
        type="button"
        onClick={onRetry}
        className="mt-1 rounded-md bg-slate-800 px-2.5 py-1 text-xs font-semibold text-slate-200 transition-colors hover:bg-slate-700"
      >
        Try again
      </button>
    </div>
  );
}

// ── Small util ────────────────────────────────────────────────────────────────

/** First letters of up to two words, uppercased (avatar fallback). */
function initials(nameStr: string): string {
  const parts = nameStr.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}
