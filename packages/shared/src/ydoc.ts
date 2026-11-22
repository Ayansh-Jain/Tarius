/**
 * ICE Yjs document schema.
 *
 * One room/workspace ↔ one Yjs document. These are the well-known top-level
 * shared types every client and the server agree on. Keeping them here (and
 * only here) is how the CRDT layer stays a single source of truth.
 *
 * See docs/ARCHITECTURE.md → "Yjs document model" and ADR-000 (the three-
 * sources-of-truth law).
 */
import * as Y from 'yjs';
import type { EditOrigin } from './protocol.js';

/** Well-known keys on the room Y.Doc. Do not invent new top-level keys ad hoc. */
export const YDOC_KEYS = {
  /** Open file buffers: path -> Y.Text. The editable source of truth. */
  files: 'files',
  /** File-tree structure & metadata (v0.3). */
  tree: 'tree',
  /** Room metadata (name, settings). */
  meta: 'meta',
  /** Chat messages (v1.0). */
  chat: 'chat',
  /** Connected agents and their live state (v0.5). */
  agents: 'agents',
  /** Agent chat transcript — prompts + replies (v0.5). */
  agentChat: 'agentChat',
  /** Human comms channels — group + DM (v1.0). channelId -> Y.Map{meta, messages:Y.Array}. */
  channels: 'channels',
  /** Orchestration tasks + subtasks for the agent squad (v1.5). */
  tasks: 'tasks',
  /** Audit trail of room actions — human + agent (v2.0). */
  audit: 'audit',
} as const;

export function getFiles(doc: Y.Doc): Y.Map<Y.Text> {
  return doc.getMap<Y.Text>(YDOC_KEYS.files);
}

/** Get (or lazily create) the Y.Text buffer for a file path. */
export function getFileText(doc: Y.Doc, path: string): Y.Text {
  const files = getFiles(doc);
  const existing = files.get(path);
  if (existing) return existing;
  const text = new Y.Text();
  files.set(path, text);
  return text;
}

export function getTree(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap(YDOC_KEYS.tree);
}

export function getMeta(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap(YDOC_KEYS.meta);
}

export function getChat(doc: Y.Doc): Y.Array<unknown> {
  return doc.getArray(YDOC_KEYS.chat);
}

export function getAgents(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap(YDOC_KEYS.agents);
}

export function getAgentChat(doc: Y.Doc): Y.Array<unknown> {
  return doc.getArray(YDOC_KEYS.agentChat);
}

export function getChannels(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap(YDOC_KEYS.channels);
}

export function getTasks(doc: Y.Doc): Y.Array<unknown> {
  return doc.getArray(YDOC_KEYS.tasks);
}

export function getAudit(doc: Y.Doc): Y.Array<unknown> {
  return doc.getArray(YDOC_KEYS.audit);
}

/**
 * Apply a mutation tagged with its origin. Humans, agents, and the system all
 * go through here so every change is attributable and per-origin undoable.
 * NEVER mutate room state outside an origin-tagged transaction.
 */
export function transactWithOrigin(doc: Y.Doc, origin: EditOrigin, fn: () => void): void {
  doc.transact(fn, origin);
}
