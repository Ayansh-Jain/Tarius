/**
 * Agents panel — the v0.5 "AI teammate" surface (right rail tab).
 *
 * Three stacked sections:
 *   1. Roster + "Add AI teammate" — POST /api/rooms/:id/agent { kind:'mock' };
 *      the live list is read from getAgents(doc) (name, color, run status), so
 *      a spawned agent appears here over the realtime channel, not from the POST.
 *   2. Approval gate — when an agent is 'awaiting-approval' with a pending tool
 *      call, render Approve / Reject(interrupt) → POST /agent/approve.
 *   3. Chat — the transcript from getAgentChat(doc) (user vs agent bubbles) plus
 *      a prompt box → POST /agent/message. We don't optimistically echo; the doc
 *      is the source of truth and replays both the prompt and the reply.
 *
 * Every server call degrades gracefully (these routes are wired post-merge): a
 * 404/unreachable shows a quiet "not ready" note instead of throwing, so the
 * room — and this panel — never break in isolation.
 */
import { Bot } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentChatMessage, AgentToolCall } from '@ice/shared';
import { addAgent, decideApproval, sendAgentMessage } from '../lib/api.js';
import type { RoomConnection } from '../lib/connection.js';
import { useAgentChat, useAgents } from '../lib/useAgents.js';
import type { AgentView } from '../lib/agentTypes.js';
import { RUN_STATUS_META } from '../lib/agentTypes.js';
import { initials, readableOn } from '../lib/color.js';

interface AgentsPanelProps {
  roomId: string;
  connection: RoomConnection;
}

type Notice = { kind: 'ok' | 'err' | 'info'; text: string } | null;

/** Compact agent avatar that matches the presence chip / editor attribution. */
function AgentAvatar({ agent }: { agent: AgentView }): React.ReactElement {
  return (
    <span
      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold"
      style={{ backgroundColor: agent.state.color, color: readableOn(agent.state.color) }}
      title={agent.state.displayName}
    >
      {initials(agent.state.displayName) || <Bot size={12} aria-hidden />}
    </span>
  );
}

function StatusChip({ status }: { status: AgentView['state']['status'] }): React.ReactElement {
  const meta = RUN_STATUS_META[status];
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] ${meta.text}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
      {meta.label}
    </span>
  );
}

/** Best-effort one-line preview of a tool call's args for the approval card. */
function describeArgs(args: unknown): string {
  if (args == null) return '';
  if (typeof args === 'string') return args;
  try {
    const json = JSON.stringify(args);
    return json.length > 140 ? `${json.slice(0, 137)}…` : json;
  } catch {
    return String(args);
  }
}

/** The Approve / Reject gate shown when an agent is blocked on a tool call. */
function ApprovalCard({
  agent,
  call,
  roomId,
  onNotice,
}: {
  agent: AgentView;
  call: AgentToolCall;
  roomId: string;
  onNotice: (n: Notice) => void;
}): React.ReactElement {
  const [busy, setBusy] = useState<null | 'approve' | 'reject'>(null);

  const decide = useCallback(
    async (decision: 'approve' | 'reject') => {
      setBusy(decision);
      onNotice(null);
      try {
        const res = await decideApproval(roomId, call.id, decision, agent.state.agentId);
        if (res.ok) {
          onNotice({
            kind: 'info',
            text: decision === 'approve' ? 'Approved — applying…' : 'Rejected — interrupted.',
          });
        } else if (res.notReady) {
          onNotice({ kind: 'err', text: 'Agent server isn’t available yet.' });
        } else {
          onNotice({ kind: 'err', text: res.message });
        }
      } finally {
        setBusy(null);
      }
    },
    [agent.state.agentId, call.id, onNotice, roomId],
  );

  return (
    <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2.5">
      <div className="flex items-center gap-2">
        <AgentAvatar agent={agent} />
        <div className="min-w-0">
          <p className="truncate text-[12px] font-medium text-slate-100">
            {agent.state.displayName} wants to run a tool
          </p>
          <p className="truncate font-mono text-[11px] text-amber-300" title={call.tool}>
            {call.tool}
          </p>
        </div>
      </div>
      {describeArgs(call.args) && (
        <pre className="mt-1.5 max-h-20 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-950/60 px-2 py-1 font-mono text-[10px] leading-relaxed text-slate-400">
          {describeArgs(call.args)}
        </pre>
      )}
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={() => void decide('approve')}
          disabled={busy !== null}
          className="inline-flex flex-1 items-center justify-center rounded-md bg-emerald-500 px-2 py-1 text-[11px] font-medium text-white transition-colors hover:bg-emerald-400 active:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy === 'approve' ? 'Approving…' : 'Approve'}
        </button>
        <button
          type="button"
          onClick={() => void decide('reject')}
          disabled={busy !== null}
          className="inline-flex flex-1 items-center justify-center rounded-md border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-[11px] font-medium text-rose-200 transition-colors hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-60"
          title="Reject and interrupt the tool call"
        >
          {busy === 'reject' ? 'Rejecting…' : 'Reject'}
        </button>
      </div>
    </div>
  );
}

/** One chat bubble: human prompt (right) vs agent reply (left, with avatar). */
function ChatBubble({
  message,
  agentFor,
}: {
  message: AgentChatMessage;
  agentFor: (id: string) => AgentView | undefined;
}): React.ReactElement {
  const isUser = message.role === 'user';
  const agent = !isUser ? agentFor(message.agentId) : undefined;
  return (
    <div className={`flex gap-2 ${isUser ? 'justify-end' : 'justify-start'}`}>
      {!isUser &&
        (agent ? (
          <AgentAvatar agent={agent} />
        ) : (
          <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-violet-500/80 text-slate-950">
            <Bot size={13} aria-hidden />
          </span>
        ))}
      <div
        className={`max-w-[82%] rounded-lg px-2.5 py-1.5 text-[12px] leading-relaxed ${
          isUser
            ? 'bg-indigo-500/90 text-white'
            : 'bg-slate-800 text-slate-100 ring-1 ring-slate-700/60'
        }`}
      >
        <p className="whitespace-pre-wrap break-words">{message.text}</p>
      </div>
    </div>
  );
}

export function AgentsPanel({ roomId, connection }: AgentsPanelProps): React.ReactElement {
  const agents = useAgents(connection);
  const chat = useAgentChat(connection);

  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const agentById = useMemo(() => {
    const map = new Map<string, AgentView>();
    for (const a of agents) map.set(a.state.agentId, a);
    return map;
  }, [agents]);

  const pendingApprovals = useMemo(
    () => agents.filter((a) => a.pendingCall !== null),
    [agents],
  );

  // Auto-scroll the transcript to the newest message.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.length, pendingApprovals.length]);

  const handleAdd = useCallback(async () => {
    setAdding(true);
    setNotice(null);
    try {
      const res = await addAgent(roomId);
      if (res.ok) {
        setNotice({ kind: 'ok', text: `${res.agent.displayName} joined the room.` });
      } else if (res.notReady) {
        setNotice({
          kind: 'err',
          text: 'The agent server isn’t wired up yet — try again once it’s available.',
        });
      } else {
        setNotice({ kind: 'err', text: res.message });
      }
    } finally {
      setAdding(false);
    }
  }, [roomId]);

  const handleSend = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setNotice(null);
    // Address the sole agent when there's exactly one; otherwise let the server
    // route (it may broadcast or pick the active agent).
    const targetId = agents.length === 1 ? agents[0]!.state.agentId : undefined;
    try {
      const res = await sendAgentMessage(roomId, text, targetId);
      if (res.ok) {
        setDraft(''); // the doc transcript will echo the prompt back
      } else if (res.notReady) {
        setNotice({ kind: 'err', text: 'The agent server isn’t available yet.' });
      } else {
        setNotice({ kind: 'err', text: res.message });
      }
    } finally {
      setSending(false);
    }
  }, [agents, draft, roomId, sending]);

  const hasAgents = agents.length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ── Header + roster ─────────────────────────────────────────────── */}
      <div className="shrink-0 space-y-2 px-3 pb-2 pt-3">
        <div className="flex items-center justify-between">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            AI Teammates
          </h2>
          <span className="text-[10px] text-slate-500">{agents.length}</span>
        </div>

        <button
          type="button"
          onClick={() => void handleAdd()}
          disabled={adding}
          className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-violet-500 px-3 py-1.5 text-xs font-medium text-white shadow-sm transition-colors hover:bg-violet-400 active:bg-violet-600 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <span aria-hidden>＋</span>
          {adding ? 'Adding…' : 'Add AI teammate'}
        </button>

        {hasAgents && (
          <ul className="space-y-1">
            {agents.map((a) => (
              <li
                key={a.state.agentId}
                className="flex items-center gap-2 rounded-md bg-slate-800/40 px-2 py-1.5"
              >
                <AgentAvatar agent={a} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12px] text-slate-100">{a.state.displayName}</p>
                  <p className="truncate text-[10px] text-slate-500">{a.state.kind}</p>
                </div>
                <StatusChip status={a.state.status} />
              </li>
            ))}
          </ul>
        )}

        {notice && (
          <p
            className={`rounded px-2 py-1 text-[11px] ${
              notice.kind === 'ok'
                ? 'bg-emerald-500/10 text-emerald-300'
                : notice.kind === 'info'
                  ? 'bg-sky-500/10 text-sky-300'
                  : 'bg-rose-500/10 text-rose-300'
            }`}
          >
            {notice.text}
          </p>
        )}
      </div>

      {/* ── Pending approvals (gate) ────────────────────────────────────── */}
      {pendingApprovals.length > 0 && (
        <div className="shrink-0 space-y-2 border-t border-slate-800/80 px-3 py-2">
          <h3 className="text-[10px] font-semibold uppercase tracking-wider text-amber-400/80">
            Needs your approval
          </h3>
          {pendingApprovals.map((a) => (
            <ApprovalCard
              key={`${a.state.agentId}-${a.pendingCall!.id}`}
              agent={a}
              call={a.pendingCall!}
              roomId={roomId}
              onNotice={setNotice}
            />
          ))}
        </div>
      )}

      {/* ── Chat transcript ─────────────────────────────────────────────── */}
      <div className="flex min-h-0 flex-1 flex-col border-t border-slate-800/80">
        <h3 className="shrink-0 px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          Chat
        </h3>
        <div ref={scrollRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-2">
          {chat.length === 0 ? (
            <p className="px-1 py-3 text-[11px] leading-relaxed text-slate-500">
              {hasAgents
                ? 'Say hi to your AI teammate below — ask it to make an edit.'
                : 'Add an AI teammate, then chat with it here. It edits the repo with you, live.'}
            </p>
          ) : (
            chat.map((m) => (
              <ChatBubble key={m.id} message={m} agentFor={(id) => agentById.get(id)} />
            ))
          )}
        </div>

        {/* ── Prompt box ────────────────────────────────────────────────── */}
        <form
          className="shrink-0 border-t border-slate-800/80 p-2"
          onSubmit={(e) => {
            e.preventDefault();
            void handleSend();
          }}
        >
          <div className="flex items-end gap-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends; Shift+Enter inserts a newline.
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void handleSend();
                }
              }}
              rows={1}
              placeholder={hasAgents ? 'Message your AI teammate…' : 'Add a teammate to start…'}
              disabled={!hasAgents || sending}
              className="max-h-28 min-h-[34px] flex-1 resize-none rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-[12px] text-slate-100 outline-none placeholder:text-slate-600 focus:border-violet-400 disabled:cursor-not-allowed disabled:opacity-60"
            />
            <button
              type="submit"
              disabled={!hasAgents || sending || draft.trim().length === 0}
              className="inline-flex h-[34px] shrink-0 items-center justify-center rounded-md bg-violet-500 px-3 text-[12px] font-medium text-white transition-colors hover:bg-violet-400 active:bg-violet-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {sending ? '…' : 'Send'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
