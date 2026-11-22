/**
 * Human chat panel — the v1.0 "code with friends, out loud" text surface.
 *
 * Distinct from the v0.5 AgentsPanel (that's the AI transcript): this is the
 * people-to-people chat, group + DM, backed by getChannels(doc) via lib/chat.ts.
 * Two columns inside the rail:
 *   - left  : channel list — group channels (incl. the default '# general') and
 *             DMs, plus a "+ DM" affordance that opens a 1:1 with a present peer.
 *   - right : the open channel's message list (author name/color from presence,
 *             code + file-range embeds rendered inline) and a composer. The
 *             composer supports an attached code snippet so you can paste a chunk
 *             of code as a first-class embed.
 *
 * Authoring goes THROUGH the doc (postMessage → transactWithOrigin) so every
 * line is attributable + multiplayer; we don't optimistically echo — the shared
 * array replays our own message back to us, same as remote peers see it.
 *
 * Self-contained: takes { connection, me } and reads peers off the room
 * awareness, so it can drop into the rail next to the other panels.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Channel, ChatEmbed, ChatMessage, Participant } from '@ice/shared';
import type { PresencePeer, RoomConnection } from '../lib/connection.js';
import { composeMessage, openOrCreateDm, postMessage } from '../lib/chat.js';
import { useChannelsState } from '../lib/useChannels.js';
import { initials, readableOn } from '../lib/color.js';

interface ChatPanelProps {
  connection: RoomConnection;
  /** The local participant (author of messages sent from this panel). */
  me: Participant;
}

// ── presence helper (author name/color) ───────────────────────────────────────

/** Subscribe to the room's awareness peers so we can label message authors. */
function usePeers(connection: RoomConnection): PresencePeer[] {
  const [peers, setPeers] = useState<PresencePeer[]>(() => connection.peers());
  useEffect(() => connection.onPeersChange(setPeers), [connection]);
  return peers;
}

/** Resolve a stable, readable identity for an author id (falls back gracefully). */
function authorIdentity(
  authorId: string,
  me: Participant,
  byId: Map<string, Participant>,
): Participant {
  if (authorId === me.id) return me;
  const known = byId.get(authorId);
  if (known) return known;
  // Unknown / departed author: a deterministic placeholder so the bubble still
  // has a name + a (muted) color instead of a blank.
  return { id: authorId, name: 'Someone', color: '#64748b', kind: 'human' };
}

// ── small presentational bits ─────────────────────────────────────────────────

function Avatar({ participant, size = 6 }: { participant: Participant; size?: number }): React.ReactElement {
  const px = `${size * 4}px`;
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full text-[10px] font-semibold"
      style={{ height: px, width: px, backgroundColor: participant.color, color: readableOn(participant.color) }}
      title={participant.name}
    >
      {initials(participant.name)}
    </span>
  );
}

/** Channel label: '# name' for groups, '@ peer' / member list for DMs. */
function channelLabel(channel: Channel, me: Participant, byId: Map<string, Participant>): string {
  if (channel.kind === 'group') return `# ${channel.name}`;
  const others = (channel.members ?? []).filter((id) => id !== me.id);
  if (others.length === 0) return '@ you';
  const names = others.map((id) => byId.get(id)?.name ?? channel.name ?? 'Someone');
  return `@ ${names.join(', ')}`;
}

/** Render a code embed (snippet) or a file-range reference. */
function EmbedView({ embed }: { embed: ChatEmbed }): React.ReactElement {
  if (embed.type === 'code') {
    return (
      <div className="mt-1.5 overflow-hidden rounded-md border border-slate-700/60 bg-slate-950/70">
        {embed.language && (
          <div className="border-b border-slate-800/80 px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-slate-500">
            {embed.language}
          </div>
        )}
        <pre className="max-h-56 overflow-auto px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-slate-200">
          <code>{embed.code}</code>
        </pre>
      </div>
    );
  }
  // fileRange
  const sameLine = embed.from === embed.to;
  return (
    <a
      className="mt-1.5 inline-flex items-center gap-1.5 rounded-md border border-sky-500/30 bg-sky-500/5 px-2 py-1 font-mono text-[10px] text-sky-300 hover:bg-sky-500/10"
      title={`${embed.path} lines ${embed.from}–${embed.to}`}
      href={`#${encodeURIComponent(embed.path)}:${embed.from}-${embed.to}`}
    >
      <span aria-hidden>↳</span>
      <span className="truncate">{embed.path}</span>
      <span className="text-sky-400/70">{sameLine ? `:${embed.from}` : `:${embed.from}-${embed.to}`}</span>
    </a>
  );
}

function timeLabel(ts: number): string {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

/** One message row: avatar + author + time, body, then any embeds. */
function MessageRow({
  message,
  author,
  isMe,
}: {
  message: ChatMessage;
  author: Participant;
  isMe: boolean;
}): React.ReactElement {
  return (
    <div className="flex gap-2">
      <Avatar participant={author} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-[12px] font-medium" style={{ color: author.color }}>
            {author.name}
            {isMe && <span className="ml-1 text-[9px] font-normal text-slate-500">you</span>}
          </span>
          <span className="shrink-0 text-[10px] text-slate-600">{timeLabel(message.createdAt)}</span>
        </div>
        {message.body && (
          <p className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-slate-200">
            {message.body}
          </p>
        )}
        {message.embeds?.map((embed, i) => <EmbedView key={i} embed={embed} />)}
      </div>
    </div>
  );
}

// ── panel ─────────────────────────────────────────────────────────────────────

export function ChatPanel({ connection, me }: ChatPanelProps): React.ReactElement {
  const peers = usePeers(connection);
  const { channels, selectedId, setSelectedId, selected, messages } = useChannelsState(connection, me);

  const [draft, setDraft] = useState('');
  const [codeDraft, setCodeDraft] = useState('');
  const [showCode, setShowCode] = useState(false);

  // Map participant id -> Participant from current presence (for author labels).
  const peersById = useMemo(() => {
    const m = new Map<string, Participant>();
    for (const p of peers) m.set(p.participant.id, p.participant);
    m.set(me.id, me);
    return m;
  }, [peers, me]);

  // Peers we can DM: present humans other than ourselves we don't already have
  // an open DM with.
  const dmCandidates = useMemo(() => {
    const existingDmMembers = new Set(
      channels
        .filter((c) => c.kind === 'dm')
        .flatMap((c) => (c.members ?? []).filter((id) => id !== me.id)),
    );
    return peers
      .map((p) => p.participant)
      .filter((p) => p.id !== me.id && p.kind === 'human' && !existingDmMembers.has(p.id));
  }, [peers, channels, me.id]);

  const [dmOpen, setDmOpen] = useState(false);

  const groupChannels = useMemo(() => channels.filter((c) => c.kind === 'group'), [channels]);
  const dmChannels = useMemo(() => channels.filter((c) => c.kind === 'dm'), [channels]);

  // Auto-scroll to the newest message when the conversation or channel changes.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, selectedId]);

  const startDm = useCallback(
    (peerId: string) => {
      const channel = openOrCreateDm(connection.doc, { kind: 'human', participantId: me.id }, [me.id, peerId]);
      setSelectedId(channel.id);
      setDmOpen(false);
    },
    [connection.doc, me.id, setSelectedId],
  );

  const send = useCallback(() => {
    const body = draft.trim();
    const code = codeDraft.trim();
    if (!selectedId || (!body && !code)) return;
    const embeds: ChatEmbed[] | undefined = code
      ? [{ type: 'code', code: codeDraft.replace(/\s+$/, '') }]
      : undefined;
    const message = composeMessage({ authorId: me.id, body, embeds });
    postMessage(connection.doc, { kind: 'human', participantId: me.id }, selectedId, message);
    setDraft('');
    setCodeDraft('');
    setShowCode(false);
  }, [draft, codeDraft, selectedId, me.id, connection.doc]);

  const canSend = Boolean(selectedId) && (draft.trim().length > 0 || codeDraft.trim().length > 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1">
        {/* ── Channel list ───────────────────────────────────────────────── */}
        <aside className="flex w-36 shrink-0 flex-col border-r border-slate-800/80">
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-2 py-3">
            <div>
              <h3 className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                Channels
              </h3>
              <ul className="space-y-0.5">
                {groupChannels.map((c) => (
                  <ChannelRow
                    key={c.id}
                    label={channelLabel(c, me, peersById)}
                    active={c.id === selectedId}
                    onClick={() => setSelectedId(c.id)}
                  />
                ))}
              </ul>
            </div>

            <div>
              <div className="flex items-center justify-between px-1 pb-1">
                <h3 className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  Direct
                </h3>
                <button
                  type="button"
                  onClick={() => setDmOpen((v) => !v)}
                  title="Start a direct message"
                  className="text-[12px] leading-none text-slate-500 hover:text-slate-200"
                >
                  ＋
                </button>
              </div>

              {dmOpen && (
                <div className="mb-1 rounded-md border border-slate-700/70 bg-slate-900/80 p-1">
                  {dmCandidates.length === 0 ? (
                    <p className="px-1 py-1 text-[10px] text-slate-500">No one else is here yet.</p>
                  ) : (
                    <ul className="space-y-0.5">
                      {dmCandidates.map((p) => (
                        <li key={p.id}>
                          <button
                            type="button"
                            onClick={() => startDm(p.id)}
                            className="flex w-full items-center gap-1.5 rounded px-1 py-1 text-left text-[11px] text-slate-200 hover:bg-slate-800"
                          >
                            <Avatar participant={p} size={4} />
                            <span className="truncate">{p.name}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              <ul className="space-y-0.5">
                {dmChannels.length === 0 && !dmOpen && (
                  <li className="px-1 py-0.5 text-[10px] text-slate-600">No DMs yet</li>
                )}
                {dmChannels.map((c) => (
                  <ChannelRow
                    key={c.id}
                    label={channelLabel(c, me, peersById)}
                    active={c.id === selectedId}
                    onClick={() => setSelectedId(c.id)}
                  />
                ))}
              </ul>
            </div>
          </div>
        </aside>

        {/* ── Conversation ───────────────────────────────────────────────── */}
        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="shrink-0 border-b border-slate-800/80 px-3 py-2">
            <p className="truncate text-[12px] font-semibold text-slate-100">
              {selected ? channelLabel(selected, me, peersById) : 'Chat'}
            </p>
            {selected?.kind === 'group' && (
              <p className="text-[10px] text-slate-500">{peers.length} here</p>
            )}
          </header>

          <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
            {messages.length === 0 ? (
              <p className="px-1 py-4 text-[11px] leading-relaxed text-slate-500">
                {selected?.kind === 'dm'
                  ? 'This is the start of your direct message.'
                  : 'No messages yet. Say something — your team sees it live.'}
              </p>
            ) : (
              messages.map((m) => (
                <MessageRow
                  key={m.id}
                  message={m}
                  author={authorIdentity(m.authorId, me, peersById)}
                  isMe={m.authorId === me.id}
                />
              ))
            )}
          </div>

          {/* ── Composer ─────────────────────────────────────────────────── */}
          <form
            className="shrink-0 border-t border-slate-800/80 p-2"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            {showCode && (
              <div className="mb-2 overflow-hidden rounded-md border border-slate-700/70 bg-slate-950/70">
                <div className="flex items-center justify-between border-b border-slate-800/80 px-2 py-1">
                  <span className="font-mono text-[9px] uppercase tracking-wider text-slate-500">
                    Code snippet
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setShowCode(false);
                      setCodeDraft('');
                    }}
                    className="text-[11px] leading-none text-slate-500 hover:text-slate-200"
                    title="Remove snippet"
                  >
                    ✕
                  </button>
                </div>
                <textarea
                  value={codeDraft}
                  onChange={(e) => setCodeDraft(e.target.value)}
                  rows={3}
                  placeholder="Paste code to attach…"
                  className="block max-h-40 w-full resize-none bg-transparent px-2.5 py-1.5 font-mono text-[11px] text-slate-200 outline-none placeholder:text-slate-600"
                />
              </div>
            )}

            <div className="flex items-end gap-2">
              <button
                type="button"
                onClick={() => setShowCode((v) => !v)}
                title="Attach a code snippet"
                className={`inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-md border text-[13px] transition-colors ${
                  showCode
                    ? 'border-sky-500/50 bg-sky-500/10 text-sky-300'
                    : 'border-slate-700 bg-slate-900 text-slate-400 hover:text-slate-200'
                }`}
              >
                {'</>'}
              </button>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                rows={1}
                placeholder={selected ? `Message ${channelLabel(selected, me, peersById)}` : 'Select a channel…'}
                disabled={!selectedId}
                className="max-h-28 min-h-[34px] flex-1 resize-none rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-[12px] text-slate-100 outline-none placeholder:text-slate-600 focus:border-sky-400 disabled:cursor-not-allowed disabled:opacity-60"
              />
              <button
                type="submit"
                disabled={!canSend}
                className="inline-flex h-[34px] shrink-0 items-center justify-center rounded-md bg-sky-500 px-3 text-[12px] font-medium text-white transition-colors hover:bg-sky-400 active:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Send
              </button>
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}

/** A single selectable row in the channel list. */
function ChannelRow({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}): React.ReactElement {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={`block w-full truncate rounded px-2 py-1 text-left text-[12px] transition-colors ${
          active ? 'bg-sky-500/15 text-sky-200' : 'text-slate-300 hover:bg-slate-800/60'
        }`}
        title={label}
      >
        {label}
      </button>
    </li>
  );
}
