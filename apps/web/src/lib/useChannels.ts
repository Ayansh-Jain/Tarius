/**
 * React bindings over the human-chat surface in the room Y.Doc (v1.0).
 *
 * Mirrors the file-tree / agent hooks: the doc is the source of truth and we
 * subscribe to it, never holding chat state anywhere else. Two hooks:
 *
 *   - useChannels(connection, me?) : the live channel list. On mount it seeds the
 *     default 'general' group channel (idempotent + race-safe) so a fresh room
 *     always has somewhere to talk, then re-renders whenever any peer adds a
 *     channel. `me` (when provided) attributes that seed to the local human.
 *   - useChannelMessages(connection, channelId) : the live, oldest-first message
 *     list for one channel. Switches cleanly when `channelId` changes.
 *
 * We `observe` the channels map shallowly (entries are added/removed wholesale —
 * a new channel is a new key) and `observeDeep` a channel's message array so a
 * push from any peer re-renders the open conversation.
 */
import { useEffect, useMemo, useState } from 'react';
import * as Y from 'yjs';
import type { Channel, ChatMessage, EditOrigin, Participant } from '@ice/shared';
import { getChannels } from '@ice/shared';
import type { RoomConnection } from './connection.js';
import { ensureDefaultChannel, listChannels, listMessages } from './chat.js';

/** Origin to tag the default-channel seed with (the local human, if known). */
function seedOrigin(me?: Participant): EditOrigin {
  return me ? { kind: 'human', participantId: me.id } : { kind: 'system' };
}

/**
 * Live list of chat channels (group + DM) in the room, seeding 'general' once.
 * Pass `me` so the seed is attributed to the local participant.
 */
export function useChannels(connection: RoomConnection, me?: Participant): Channel[] {
  const [channels, setChannels] = useState<Channel[]>(() => listChannels(connection.doc));

  useEffect(() => {
    const doc = connection.doc;
    // Seed the default 'general' channel the first time anyone lands here.
    ensureDefaultChannel(doc, seedOrigin(me));

    const map = getChannels(doc) as Y.Map<unknown>;
    const refresh = (): void => setChannels(listChannels(doc));
    // A channel is a new key on the map; shallow observe catches add/remove.
    map.observe(refresh);
    refresh();
    return () => map.unobserve(refresh);
    // Re-seed/re-subscribe if the connection (room) changes; `me.id` only affects
    // attribution of the seed, so it's safe to omit from deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection]);

  return channels;
}

/** Live oldest-first messages for `channelId` (empty until the channel exists). */
export function useChannelMessages(connection: RoomConnection, channelId: string | null): ChatMessage[] {
  const [messages, setMessages] = useState<ChatMessage[]>(() =>
    channelId ? listMessages(connection.doc, channelId) : [],
  );

  useEffect(() => {
    if (!channelId) {
      setMessages([]);
      return;
    }
    const doc = connection.doc;
    const map = getChannels(doc) as Y.Map<unknown>;
    const refresh = (): void => setMessages(listMessages(doc, channelId));
    // Deep observe so a message push (nested in the channel's Y.Array) — and a
    // late-arriving channel entry — both re-render the open conversation.
    map.observeDeep(refresh);
    refresh();
    return () => map.unobserveDeep(refresh);
  }, [connection, channelId]);

  return messages;
}

/** Bundle: channels + a selected channel id + that channel's messages. */
export interface ChannelsState {
  channels: Channel[];
  selectedId: string | null;
  setSelectedId: (id: string) => void;
  selected: Channel | null;
  messages: ChatMessage[];
}

/**
 * Convenience hook for the panel: tracks the channel list, a selected channel
 * (defaulting to 'general'/the first available), and that channel's messages.
 * Keeps the selection valid as channels appear/disappear.
 */
export function useChannelsState(connection: RoomConnection, me?: Participant): ChannelsState {
  const channels = useChannels(connection, me);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Keep a valid selection: prefer the explicit pick, else the first channel.
  const effectiveId = useMemo(() => {
    if (selectedId && channels.some((c) => c.id === selectedId)) return selectedId;
    return channels[0]?.id ?? null;
  }, [selectedId, channels]);

  const selected = useMemo(
    () => channels.find((c) => c.id === effectiveId) ?? null,
    [channels, effectiveId],
  );

  const messages = useChannelMessages(connection, effectiveId);

  return { channels, selectedId: effectiveId, setSelectedId, selected, messages };
}
