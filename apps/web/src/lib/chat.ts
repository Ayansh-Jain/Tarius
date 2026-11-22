/**
 * Human chat model for ICE v1.0 — group + DM channels, Yjs-backed.
 *
 * This is the HUMAN comms surface (distinct from the v0.5 *agent* chat, which
 * lives in `getAgentChat(doc)`). Per the v1.0 vocabulary it rides the room's
 * `channels` shared type so chat is durable + multiplayer like everything else:
 *
 *   getChannels(doc)  : Y.Map  channelId -> Y.Map {
 *                          meta:     Channel              (frozen @ice/shared type)
 *                          messages: Y.Array<ChatMessage> (frozen @ice/shared type)
 *                        }
 *
 * Storing `meta` as a plain JSON object (not a nested Y.Map) and `messages` as a
 * Y.Array of plain ChatMessage objects keeps the schema dead-simple while still
 * converging: two peers that create the *same* channel id (e.g. the default
 * 'general', or a DM whose id is derived from its members) land on one entry,
 * and message appends from every peer interleave by Lamport order inside the
 * shared array. A message is never mutated after insert, so a shallow read of
 * the array is always coherent.
 *
 * Every mutation flows through `transactWithOrigin` with a {kind:'human'} origin
 * so each post is attributable + per-origin undoable, exactly like editor and
 * file-tree edits (ADR-000/004 — never mutate room state outside an origin-
 * tagged transaction).
 *
 * Deliberately framework-free (no React, no DOM) so the logic is unit-testable
 * headlessly against a bare Y.Doc — see chat.smoke.ts.
 */
import * as Y from 'yjs';
import type { Channel, ChatEmbed, ChatMessage, EditOrigin, ParticipantId } from '@ice/shared';
import { getChannels, transactWithOrigin } from '@ice/shared';

/** The id of the always-present group channel every room opens with. */
export const DEFAULT_CHANNEL_ID = 'general';
/** Display name for {@link DEFAULT_CHANNEL_ID}. */
export const DEFAULT_CHANNEL_NAME = 'general';

/** Keys used inside a per-channel Y.Map. Kept local; this module owns the layout. */
const CHANNEL_META = 'meta';
const CHANNEL_MESSAGES = 'messages';

/** The per-channel container shape stored in `getChannels(doc)`. */
type ChannelEntry = Y.Map<unknown>;

// ── id helpers ────────────────────────────────────────────────────────────────

/**
 * Deterministic DM channel id from its members, so that whichever side opens the
 * DM first, both converge on the SAME channel (order-independent, dedup'd). The
 * id is stable for a given set of participants — opening it again is idempotent.
 */
export function dmChannelId(members: ParticipantId[]): string {
  const unique = [...new Set(members.map((m) => m.trim()).filter(Boolean))].sort();
  return `dm:${unique.join('|')}`;
}

/** A reasonably-unique message id without pulling in a uuid dependency. */
export function newMessageId(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return `m_${cryptoObj.randomUUID()}`;
  }
  return `m_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

// ── low-level accessors ───────────────────────────────────────────────────────

/** True when `value` looks like a usable per-channel Y.Map container. */
function isChannelEntry(value: unknown): value is ChannelEntry {
  return value instanceof Y.Map;
}

/** Read the (plain JSON) Channel meta off a channel entry, if present + valid. */
function readMeta(entry: ChannelEntry): Channel | null {
  const raw = entry.get(CHANNEL_META);
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.id !== 'string') return null;
  const kind = m.kind === 'dm' ? 'dm' : 'group';
  return {
    id: m.id,
    kind,
    name: typeof m.name === 'string' ? m.name : m.id,
    members: Array.isArray(m.members) ? (m.members.filter((x) => typeof x === 'string') as string[]) : undefined,
    createdAt: typeof m.createdAt === 'number' ? m.createdAt : 0,
  };
}

/** Get the Y.Array<ChatMessage> for a channel entry (created lazily if absent). */
function messagesOf(entry: ChannelEntry): Y.Array<ChatMessage> {
  let arr = entry.get(CHANNEL_MESSAGES) as Y.Array<ChatMessage> | undefined;
  if (!(arr instanceof Y.Array)) {
    arr = new Y.Array<ChatMessage>();
    entry.set(CHANNEL_MESSAGES, arr);
  }
  return arr;
}

// ── creation ──────────────────────────────────────────────────────────────────

/**
 * Create (or return the existing) channel with `meta.id`. Idempotent and race-
 * safe: if two peers create the same id concurrently, Yjs merges to a single
 * entry and the first-written meta wins; we never clobber an existing meta or
 * messages array. Returns the resolved Channel meta.
 *
 * All work happens inside one origin-tagged transaction so the channel's
 * appearance is attributable to whoever created it.
 */
export function createChannel(doc: Y.Doc, origin: EditOrigin, meta: Channel): Channel {
  const channels = getChannels(doc) as Y.Map<unknown>;
  let resolved = meta;
  transactWithOrigin(doc, origin, () => {
    const existing = channels.get(meta.id);
    if (isChannelEntry(existing)) {
      const existingMeta = readMeta(existing);
      // Ensure a messages array exists even on a pre-seeded/partial entry.
      messagesOf(existing);
      if (existingMeta) {
        resolved = existingMeta;
        return;
      }
      existing.set(CHANNEL_META, { ...meta });
      return;
    }
    const entry = new Y.Map<unknown>();
    entry.set(CHANNEL_META, { ...meta });
    entry.set(CHANNEL_MESSAGES, new Y.Array<ChatMessage>());
    channels.set(meta.id, entry);
  });
  return resolved;
}

/**
 * Ensure the default 'general' group channel exists. Idempotent — safe to call
 * on every room mount from every client; the first caller seeds it and the rest
 * no-op (converging on the one shared 'general').
 */
export function ensureDefaultChannel(doc: Y.Doc, origin: EditOrigin): Channel {
  return createChannel(doc, origin, {
    id: DEFAULT_CHANNEL_ID,
    kind: 'group',
    name: DEFAULT_CHANNEL_NAME,
    createdAt: Date.now(),
  });
}

/**
 * Open (or create) a direct-message channel between `members`. The id is derived
 * from the member set (see {@link dmChannelId}) so both participants resolve to
 * the same DM no matter who opens it first. `name` defaults to the joined member
 * ids; callers with a roster typically relabel DMs by peer name in the UI.
 */
export function openOrCreateDm(doc: Y.Doc, origin: EditOrigin, members: ParticipantId[]): Channel {
  const unique = [...new Set(members.map((m) => m.trim()).filter(Boolean))].sort();
  const id = dmChannelId(unique);
  return createChannel(doc, origin, {
    id,
    kind: 'dm',
    name: unique.join(', '),
    members: unique,
    createdAt: Date.now(),
  });
}

// ── reads ─────────────────────────────────────────────────────────────────────

/**
 * Snapshot every channel's meta, sorted deterministically: the default 'general'
 * first, then group channels, then DMs, each group by createdAt then id. Stable
 * order keeps the channel list from jumping as peers join.
 */
export function listChannels(doc: Y.Doc): Channel[] {
  const channels = getChannels(doc) as Y.Map<unknown>;
  const out: Channel[] = [];
  channels.forEach((value) => {
    if (!isChannelEntry(value)) return;
    const meta = readMeta(value);
    if (meta) out.push(meta);
  });
  out.sort((a, b) => {
    if (a.id === DEFAULT_CHANNEL_ID) return b.id === DEFAULT_CHANNEL_ID ? 0 : -1;
    if (b.id === DEFAULT_CHANNEL_ID) return 1;
    if (a.kind !== b.kind) return a.kind === 'group' ? -1 : 1;
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.id.localeCompare(b.id);
  });
  return out;
}

/** Resolve a single channel's meta by id, or null if it doesn't exist (yet). */
export function getChannelMeta(doc: Y.Doc, channelId: string): Channel | null {
  const entry = (getChannels(doc) as Y.Map<unknown>).get(channelId);
  return isChannelEntry(entry) ? readMeta(entry) : null;
}

/**
 * List a channel's messages oldest-first. Returns a plain-object copy of each
 * ChatMessage (safe to hand to React). An unknown channel yields []. Malformed
 * rows (missing id/body) are skipped so a half-written entry can't crash render.
 */
export function listMessages(doc: Y.Doc, channelId: string): ChatMessage[] {
  const entry = (getChannels(doc) as Y.Map<unknown>).get(channelId);
  if (!isChannelEntry(entry)) return [];
  const arr = entry.get(CHANNEL_MESSAGES);
  if (!(arr instanceof Y.Array)) return [];
  const out: ChatMessage[] = [];
  for (const raw of arr.toArray() as unknown[]) {
    const msg = normalizeMessage(raw);
    if (msg) out.push(msg);
  }
  return out;
}

// ── writes ────────────────────────────────────────────────────────────────────

/**
 * Append a message to a channel. The channel is created lazily if it doesn't
 * exist yet (so a DM's first message also opens the DM). Runs in one origin-
 * tagged transaction → attributable + multiplayer. Returns the stored message.
 *
 * The caller supplies a full {@link ChatMessage} (so ids/timestamps are theirs
 * to control for optimistic flows); {@link composeMessage} is a convenience for
 * building one. Embeds (code snippets + file/line ranges) ride along untouched.
 */
export function postMessage(
  doc: Y.Doc,
  origin: EditOrigin,
  channelId: string,
  message: ChatMessage,
): ChatMessage {
  const channels = getChannels(doc) as Y.Map<unknown>;
  const stored = sanitizeOutgoing(message);
  transactWithOrigin(doc, origin, () => {
    let entry = channels.get(channelId);
    if (!isChannelEntry(entry)) {
      entry = new Y.Map<unknown>();
      (entry as ChannelEntry).set(CHANNEL_META, {
        id: channelId,
        kind: channelId.startsWith('dm:') ? 'dm' : 'group',
        name: channelId,
        createdAt: Date.now(),
      } satisfies Channel);
      (entry as ChannelEntry).set(CHANNEL_MESSAGES, new Y.Array<ChatMessage>());
      channels.set(channelId, entry);
    }
    messagesOf(entry as ChannelEntry).push([stored]);
  });
  return stored;
}

/** Build a well-formed {@link ChatMessage} from an author + body (+ optional embeds/thread). */
export function composeMessage(input: {
  authorId: ParticipantId;
  body: string;
  embeds?: ChatEmbed[];
  threadId?: string;
}): ChatMessage {
  const msg: ChatMessage = {
    id: newMessageId(),
    authorId: input.authorId,
    body: input.body,
    createdAt: Date.now(),
  };
  if (input.threadId) msg.threadId = input.threadId;
  if (input.embeds && input.embeds.length > 0) msg.embeds = input.embeds.map(cloneEmbed);
  return msg;
}

// ── normalization (defensive read/write) ──────────────────────────────────────

function cloneEmbed(embed: ChatEmbed): ChatEmbed {
  return embed.type === 'code'
    ? { type: 'code', language: embed.language, code: embed.code }
    : { type: 'fileRange', path: embed.path, from: embed.from, to: embed.to };
}

/** Keep only the embeds we understand, with their fields coerced to the contract. */
function normalizeEmbeds(raw: unknown): ChatEmbed[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ChatEmbed[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const e = item as Record<string, unknown>;
    if (e.type === 'code' && typeof e.code === 'string') {
      out.push({ type: 'code', language: typeof e.language === 'string' ? e.language : undefined, code: e.code });
    } else if (
      e.type === 'fileRange' &&
      typeof e.path === 'string' &&
      typeof e.from === 'number' &&
      typeof e.to === 'number'
    ) {
      out.push({ type: 'fileRange', path: e.path, from: e.from, to: e.to });
    }
  }
  return out.length > 0 ? out : undefined;
}

/** Coerce an unknown stored value into a ChatMessage, or null if unusable. */
function normalizeMessage(raw: unknown): ChatMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.id !== 'string') return null;
  if (typeof m.authorId !== 'string') return null;
  if (typeof m.body !== 'string') return null;
  const msg: ChatMessage = {
    id: m.id,
    authorId: m.authorId,
    body: m.body,
    createdAt: typeof m.createdAt === 'number' ? m.createdAt : 0,
  };
  if (typeof m.threadId === 'string') msg.threadId = m.threadId;
  const embeds = normalizeEmbeds(m.embeds);
  if (embeds) msg.embeds = embeds;
  return msg;
}

/** Produce a clean, plain-object copy of an outgoing message for storage. */
function sanitizeOutgoing(message: ChatMessage): ChatMessage {
  const out: ChatMessage = {
    id: typeof message.id === 'string' && message.id ? message.id : newMessageId(),
    authorId: message.authorId,
    body: message.body,
    createdAt: typeof message.createdAt === 'number' ? message.createdAt : Date.now(),
  };
  if (message.threadId) out.threadId = message.threadId;
  if (message.embeds && message.embeds.length > 0) out.embeds = message.embeds.map(cloneEmbed);
  return out;
}
