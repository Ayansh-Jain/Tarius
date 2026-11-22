/**
 * Presence: compact avatar stack of who's in the room.
 *
 * Humans come from Yjs awareness (color matches their remote caret); agents come
 * from the doc's agent map and show a live status pip. Hover or focus an avatar
 * for name + status.
 */
import { Bot } from 'lucide-react';
import type { PresencePeer } from '../lib/connection.js';
import { initials, readableOn } from '../lib/color.js';
import type { AgentView } from '../lib/agentTypes.js';
import { RUN_STATUS_META } from '../lib/agentTypes.js';

interface PresenceProps {
  peers: PresencePeer[];
  /** Agents present in the room (rendered alongside the human peers). */
  agents?: AgentView[];
}

const TIP =
  'pointer-events-none absolute left-1/2 top-full z-30 mt-2 -translate-x-1/2 whitespace-nowrap rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-[11px] font-medium text-slate-100 opacity-0 shadow-pop transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100';

export function Presence({ peers, agents = [] }: PresenceProps): React.ReactElement {
  const total = peers.length + agents.length;
  return (
    <div className="flex items-center gap-2" aria-label={`${total} in this room`}>
      <ul className="flex items-center -space-x-1.5">
        {peers.map((peer) => (
          <li
            key={peer.clientId}
            tabIndex={0}
            className="group relative inline-flex h-7 w-7 animate-pop-in items-center justify-center rounded-full ring-2 ring-slate-900 transition-transform hover:z-10 hover:-translate-y-px"
            style={{ backgroundColor: peer.participant.color, color: readableOn(peer.participant.color) }}
          >
            <span className="text-[10px] font-semibold leading-none">
              {initials(peer.participant.name)}
            </span>
            <span className={TIP}>
              {peer.participant.name}
              {peer.isSelf ? ' (you)' : ''} · online
            </span>
          </li>
        ))}
        {agents.map((agent) => {
          const meta = RUN_STATUS_META[agent.state.status];
          return (
            <li
              key={`agent-${agent.state.agentId}`}
              tabIndex={0}
              className="group relative inline-flex h-7 w-7 animate-pop-in items-center justify-center rounded-full ring-2 ring-slate-900 transition-transform hover:z-10 hover:-translate-y-px"
              style={{ backgroundColor: agent.state.color, color: readableOn(agent.state.color) }}
            >
              <Bot size={14} aria-hidden />
              <span
                className={`absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ring-2 ring-slate-900 ${meta.dot}`}
              />
              <span className={TIP}>
                {agent.state.displayName} · AI · {meta.label}
              </span>
            </li>
          );
        })}
      </ul>
      <span className="hidden text-xs tabular-nums text-slate-500 xl:inline">{total}</span>
    </div>
  );
}
