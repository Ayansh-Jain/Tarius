/**
 * Voice huddle client — ICE v1.0 "Code with friends, out loud" (Slice A).
 *
 * Wraps `livekit-client` behind a tiny, framework-free controller so the React
 * panel never touches the SDK's event soup. Audio-only by design: we publish the
 * mic and subscribe to everyone else's; NO camera, NO screen share (the editor
 * IS the shared screen). Media goes peer↔SFU directly — ICE's server only mints
 * the join token (see apps/server/src/voice), so nothing here calls Yjs.
 *
 * The flow:
 *   1. POST /api/rooms/:roomId/voice/token  → { url, token, ... } | 503.
 *      A 503 means LiveKit isn't configured; we surface that as a friendly
 *      `state: 'unconfigured'` (the panel shows a "set LIVEKIT_* env" hint)
 *      instead of throwing.
 *   2. Room.connect(url, token), publish the mic.
 *   3. Mirror participants + speaking flags into a small immutable snapshot the
 *      UI subscribes to via {@link VoiceController.onChange}.
 *
 * Push-to-talk: when enabled, the mic is muted at rest and unmuted only while
 * the key is held ({@link VoiceController.setTransmitting}). Per-user mute uses
 * the remote participant's local volume (0 = muted *for me*), so muting someone
 * doesn't affect what others hear — it's a personal control.
 */
import {
  DisconnectReason,
  Room,
  RoomEvent,
  Track,
  type RemoteParticipant,
  type LocalParticipant,
  type Participant,
} from 'livekit-client';

/** Where the panel POSTs to mint a token; `:roomId` is substituted. */
function tokenUrl(roomId: string): string {
  return `/api/rooms/${encodeURIComponent(roomId)}/voice/token`;
}

/** Lifecycle of the huddle, as the UI sees it. */
export type VoiceState =
  | 'idle' // not connected; ready to join
  | 'connecting' // fetching token / establishing the SFU connection
  | 'connected' // live in the huddle
  | 'unconfigured' // server returned 503 → LIVEKIT_* env missing
  | 'error'; // anything else went wrong (mic denied, network, …)

/** A participant in the huddle, flattened for rendering. */
export interface VoiceMember {
  /** LiveKit identity (the ICE participant id we minted the token for). */
  identity: string;
  /** Display name (falls back to identity). */
  name: string;
  /** True for our own local participant. */
  isLocal: boolean;
  /** Actively speaking right now (LiveKit speaker detection). */
  speaking: boolean;
  /** This member's mic is muted at the source (they muted themselves). */
  micMuted: boolean;
  /**
   * We have locally muted this member (personal — others still hear them).
   * Always false for the local member.
   */
  mutedForMe: boolean;
}

/** Immutable snapshot the UI renders from. */
export interface VoiceSnapshot {
  state: VoiceState;
  /** Present when state === 'error' (or a non-fatal note). */
  error: string | null;
  /** Whether push-to-talk mode is on. */
  pushToTalk: boolean;
  /**
   * In push-to-talk: true while the talk key is held (mic live). With PTT off
   * this tracks the plain mic on/off toggle. Drives the "you're live" ring.
   */
  transmitting: boolean;
  /** All huddle members (local first), sorted stably by name. */
  members: VoiceMember[];
  /** Browser autoplay policy is blocking remote audio until a user gesture. */
  audioBlocked: boolean;
}

const INITIAL: VoiceSnapshot = {
  state: 'idle',
  error: null,
  pushToTalk: false,
  transmitting: false,
  members: [],
  audioBlocked: false,
};

/** Shape of the token endpoint's success body (mirrors VoiceTokenResponse). */
interface TokenOk {
  url: string;
  token: string;
  room: string;
  identity: string;
}

/**
 * Fetch a LiveKit join token for `roomId`/`identity`. Returns the token on
 * success, the string `'unconfigured'` when the server 503s (LiveKit env
 * missing), or throws for other failures.
 */
export async function fetchVoiceToken(
  roomId: string,
  identity: string,
  name: string,
): Promise<TokenOk | 'unconfigured'> {
  const res = await fetch(tokenUrl(roomId), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ identity, name }),
  });
  if (res.status === 503) return 'unconfigured';
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body: unknown = await res.json();
      if (body && typeof body === 'object' && 'error' in body) {
        message = String((body as { error: unknown }).error);
      }
    } catch {
      /* ignore non-JSON */
    }
    throw new Error(message);
  }
  return (await res.json()) as TokenOk;
}

/**
 * Owns one LiveKit {@link Room} for a single huddle. Construct per panel mount;
 * call {@link join} / {@link leave}. Subscribe with {@link onChange} to render.
 */
export class VoiceController {
  private readonly roomId: string;
  private readonly identity: string;
  private readonly displayName: string;

  private room: Room | null = null;
  private snapshot: VoiceSnapshot = INITIAL;
  private listeners = new Set<(s: VoiceSnapshot) => void>();

  /** identities we've muted locally (personal mute). */
  private readonly locallyMuted = new Set<string>();
  /** Guards against overlapping join/leave races. */
  private generation = 0;

  constructor(roomId: string, identity: string, displayName: string) {
    this.roomId = roomId;
    this.identity = identity;
    this.displayName = displayName;
  }

  /** Current snapshot (for initial render). */
  get current(): VoiceSnapshot {
    return this.snapshot;
  }

  /** Subscribe to snapshot changes; emits the current value immediately. */
  onChange(fn: (s: VoiceSnapshot) => void): () => void {
    this.listeners.add(fn);
    fn(this.snapshot);
    return () => this.listeners.delete(fn);
  }

  private patch(next: Partial<VoiceSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...next };
    for (const fn of this.listeners) fn(this.snapshot);
  }

  /** Join the huddle: fetch a token, connect, publish the mic. */
  async join(): Promise<void> {
    if (this.snapshot.state === 'connecting' || this.snapshot.state === 'connected') {
      return;
    }
    const gen = ++this.generation;
    this.patch({ state: 'connecting', error: null });

    let token: TokenOk | 'unconfigured';
    try {
      token = await fetchVoiceToken(this.roomId, this.identity, this.displayName);
    } catch (err) {
      if (gen !== this.generation) return;
      this.patch({ state: 'error', error: errorMessage(err) });
      return;
    }
    if (gen !== this.generation) return; // superseded by a leave()

    if (token === 'unconfigured') {
      this.patch({ state: 'unconfigured', error: null });
      return;
    }

    const room = new Room({
      // Drop a member from the UI promptly when they go quiet/leave.
      stopLocalTrackOnUnpublish: true,
    });
    this.room = room;
    this.wireRoomEvents(room);

    try {
      await room.connect(token.url, token.token);
      if (gen !== this.generation) {
        // A leave() landed mid-connect; undo.
        await room.disconnect();
        return;
      }
      // Start live unless push-to-talk is on (then we stay muted until held).
      const startMuted = this.snapshot.pushToTalk;
      // Unlock playback while we're still close to the user's click.
      await room.startAudio().catch(() => undefined);
      this.patch({ audioBlocked: !room.canPlaybackAudio });
      this.patch({ state: 'connected', error: null, transmitting: false });
      this.refreshMembers();
      // A denied/missing mic must not kill the call: you can still listen.
      try {
        await room.localParticipant.setMicrophoneEnabled(!startMuted);
        this.patch({ transmitting: !startMuted });
      } catch (micErr) {
        this.patch({ error: errorMessage(micErr), transmitting: false });
      }
      this.refreshMembers();
    } catch (err) {
      if (gen !== this.generation) return;
      this.patch({ state: 'error', error: errorMessage(err) });
      await this.teardownRoom();
    }
  }

  /** Leave the huddle and release the mic. */
  async leave(): Promise<void> {
    this.generation++; // cancel any in-flight join
    await this.teardownRoom();
    this.locallyMuted.clear();
    this.patch({ state: 'idle', error: null, transmitting: false, members: [], audioBlocked: false });
  }

  /**
   * Toggle push-to-talk mode. Turning it ON mutes the mic until a key is held;
   * turning it OFF unmutes (you're live again, classic open-mic).
   */
  async setPushToTalk(enabled: boolean): Promise<void> {
    this.patch({ pushToTalk: enabled });
    const lp = this.room?.localParticipant;
    if (!lp || this.snapshot.state !== 'connected') return;
    // PTT on → go silent at rest; PTT off → go live.
    await this.applyMic(!enabled ? true : false);
  }

  /**
   * Set whether we're transmitting right now. In push-to-talk this is driven by
   * the talk key (down = true, up = false). With PTT off it's the mic toggle.
   */
  async setTransmitting(on: boolean): Promise<void> {
    if (this.snapshot.state !== 'connected') return;
    if (this.snapshot.transmitting === on) return;
    await this.applyMic(on);
  }

  /** Mute/unmute another member FOR ME (personal; others are unaffected). */
  setMemberMutedForMe(identity: string, muted: boolean): void {
    if (identity === this.identity) return; // can't personal-mute yourself
    if (muted) this.locallyMuted.add(identity);
    else this.locallyMuted.delete(identity);

    const p = this.room?.remoteParticipants.get(identity);
    if (p) {
      // Volume 0 = inaudible to me; 1 = normal. This is a *receive-side* control.
      p.setVolume(muted ? 0 : 1, Track.Source.Microphone);
    }
    this.refreshMembers();
  }

  /** Tear everything down (call on unmount). */
  destroy(): void {
    this.generation++;
    void this.teardownRoom();
    this.listeners.clear();
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async applyMic(on: boolean): Promise<void> {
    const lp = this.room?.localParticipant;
    if (!lp) return;
    try {
      await lp.setMicrophoneEnabled(on);
      this.patch({ transmitting: on });
    } catch (err) {
      // Most commonly: mic permission denied. Surface, don't crash the huddle.
      this.patch({ error: errorMessage(err) });
    }
  }

  /** Hidden host for the <audio> elements that actually play remote voices. */
  private audioHost(): HTMLElement {
    let el = document.getElementById('ice-voice-audio');
    if (!el) {
      el = document.createElement('div');
      el.id = 'ice-voice-audio';
      el.style.display = 'none';
      document.body.appendChild(el);
    }
    return el;
  }

  /** Try to unlock audio playback (must run inside a user gesture). */
  async enableAudio(): Promise<void> {
    try {
      await this.room?.startAudio();
    } catch {
      /* still blocked; the banner stays */
    }
    this.patch({ audioBlocked: this.room ? !this.room.canPlaybackAudio : false });
  }

  private wireRoomEvents(room: Room): void {
    const refresh = (): void => this.refreshMembers();

    // LiveKit does NOT play remote audio by itself: each subscribed audio track
    // must be attached to a media element, otherwise the call is silent.
    room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
      if (track.kind !== Track.Kind.Audio) return;
      const el = track.attach();
      el.setAttribute('data-voice-identity', participant.identity);
      this.audioHost().appendChild(el);
      if (this.locallyMuted.has(participant.identity)) {
        participant.setVolume(0, Track.Source.Microphone);
      }
      this.refreshMembers();
    });
    room.on(RoomEvent.TrackUnsubscribed, (track) => {
      if (track.kind !== Track.Kind.Audio) return;
      track.detach().forEach((el) => el.remove());
      this.refreshMembers();
    });
    room.on(RoomEvent.AudioPlaybackStatusChanged, () => {
      this.patch({ audioBlocked: !room.canPlaybackAudio });
    });

    room.on(RoomEvent.ParticipantConnected, refresh);
    room.on(RoomEvent.ParticipantDisconnected, refresh);
    room.on(RoomEvent.TrackMuted, refresh);
    room.on(RoomEvent.TrackUnmuted, refresh);
    room.on(RoomEvent.LocalTrackPublished, refresh);
    room.on(RoomEvent.ActiveSpeakersChanged, refresh);
    room.on(RoomEvent.ConnectionStateChanged, refresh);

    room.on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
      // Server/network closed the room: reflect it unless we're mid-rejoin.
      if (this.snapshot.state === 'connected') {
        const dup = reason === DisconnectReason.DUPLICATE_IDENTITY;
        this.patch({
          state: dup ? 'error' : 'idle',
          error: dup
            ? 'You joined voice from another tab or window, so this one was disconnected.'
            : reason === DisconnectReason.CLIENT_INITIATED
              ? null
              : 'Disconnected from voice. Join again to reconnect.',
          transmitting: false,
          members: [],
        });
      }
    });
    room.on(RoomEvent.MediaDevicesError, (e: Error) => {
      this.patch({ error: errorMessage(e) });
    });
  }

  private async teardownRoom(): Promise<void> {
    const room = this.room;
    this.room = null;
    if (!room) return;
    room.removeAllListeners();
    document
      .querySelectorAll('#ice-voice-audio audio')
      .forEach((el) => el.remove());
    try {
      await room.disconnect();
    } catch {
      /* already disconnected */
    }
  }

  /** Rebuild the members snapshot from the live room state. */
  private refreshMembers(): void {
    const room = this.room;
    if (!room) {
      this.patch({ members: [] });
      return;
    }
    const speakingIds = new Set(room.activeSpeakers.map((p) => p.identity));

    const toMember = (p: Participant, isLocal: boolean): VoiceMember => ({
      identity: p.identity,
      name: p.name?.trim() || p.identity,
      isLocal,
      speaking: p.isSpeaking || speakingIds.has(p.identity),
      micMuted: isMicMuted(p),
      mutedForMe: !isLocal && this.locallyMuted.has(p.identity),
    });

    const members: VoiceMember[] = [
      toMember(room.localParticipant as LocalParticipant, true),
      ...[...room.remoteParticipants.values()].map((p: RemoteParticipant) =>
        toMember(p, false),
      ),
    ];
    members.sort((a, b) => {
      if (a.isLocal !== b.isLocal) return a.isLocal ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    this.patch({ members });
  }
}

/** Whether a participant's microphone track is currently muted at the source. */
function isMicMuted(p: Participant): boolean {
  const pub = p.getTrackPublication(Track.Source.Microphone);
  // No mic published yet ⇒ treat as muted (nothing to hear).
  if (!pub) return true;
  return pub.isMuted;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    // Friendlier copy for the overwhelmingly common case.
    if (/permission|NotAllowed|denied/i.test(err.message)) {
      return 'Microphone access was blocked. Allow it in your browser to join voice.';
    }
    return err.message;
  }
  return String(err);
}

// ── Per-room singleton ───────────────────────────────────────────────────────
// The side panel unmounts whenever the user switches tabs or closes the rail.
// The call must survive that, so controllers live here, not in the component.
const registry = new Map<string, VoiceController>();

export function getVoiceController(
  roomId: string,
  identity: string,
  name: string,
): VoiceController {
  const key = `${roomId} ${identity}`;
  let c = registry.get(key);
  if (!c) {
    c = new VoiceController(roomId, identity, name);
    registry.set(key, c);
  }
  return c;
}

/** Leave and forget every controller (call when the user leaves the room). */
export function releaseVoiceControllers(): void {
  for (const c of registry.values()) c.destroy();
  registry.clear();
}
