/**
 * React bindings over the agent surface in the room Y.Doc (v0.5).
 *
 * Per ADR-004, agents are first-class participants whose live state and chat
 * flow through the doc — so the web reads them straight from `getAgents(doc)`
 * (agent presence + run status + pending tool call) and `getAgentChat(doc)`
 * (the prompt/reply transcript), exactly like the file tree reads from `tree`.
 *
 * We `observeDeep` both containers so a status flip or a nested pending-tool-call
 * write re-renders the panel no matter how the server slice nests its values
 * (we stay decoupled from that layout — see lib/agentTypes.ts).
 */
import { useEffect, useState } from 'react';
import type { AgentChatMessage } from '@ice/shared';
import { getAgentChat, getAgents } from '@ice/shared';
import type { RoomConnection } from './connection.js';
import { readAgents, readChat, type AgentView } from './agentTypes.js';

/** Live list of agents in the room (presence, status, pending approval). */
export function useAgents(connection: RoomConnection): AgentView[] {
  const [agents, setAgents] = useState<AgentView[]>(() =>
    readAgents(getAgents(connection.doc).toJSON() as Record<string, unknown>),
  );

  useEffect(() => {
    const map = getAgents(connection.doc);
    const refresh = (): void =>
      setAgents(readAgents(map.toJSON() as Record<string, unknown>));
    // Deep observe: per-agent state lives nested, so a shallow observe would
    // miss status/pending-call updates.
    map.observeDeep(refresh);
    refresh();
    return () => map.unobserveDeep(refresh);
  }, [connection]);

  return agents;
}

/** Live agent chat transcript (human prompts + agent replies), oldest-first. */
export function useAgentChat(connection: RoomConnection): AgentChatMessage[] {
  const [messages, setMessages] = useState<AgentChatMessage[]>(() =>
    readChat(getAgentChat(connection.doc).toJSON() as unknown[]),
  );

  useEffect(() => {
    const arr = getAgentChat(connection.doc);
    const refresh = (): void => setMessages(readChat(arr.toJSON() as unknown[]));
    arr.observeDeep(refresh);
    refresh();
    return () => arr.unobserveDeep(refresh);
  }, [connection]);

  return messages;
}
