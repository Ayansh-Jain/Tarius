/**
 * Headless smoke for the v0.5 agent web model (the pure, load-bearing logic the
 * Agents panel / presence / editor-indicator are built on). No DOM, no test
 * framework beyond Node's `node:test` — this proves behaviour without a browser
 * and without a real server or ACP backend (there is none in CI):
 *
 *   1. readAgents normalizes BOTH plausible server layouts (flat AgentState, and
 *      { state, pendingCall }) into the frozen shape, and surfaces a pending
 *      tool call for the approval gate. Garbage entries are skipped, not thrown.
 *   2. readChat tolerates partial/garbage rows and keeps valid ones in order.
 *   3. Agent edits made THROUGH the doc with an {kind:'agent'} origin are
 *      attributable: a real Yjs transaction tagged that way is detectable on the
 *      files map (the signal behind the "AI teammate is editing" indicator),
 *      while a human-origin edit is NOT misattributed to the agent.
 *
 * Run:  node apps/web/src/lib/run-agents-smoke.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import type { EditOrigin } from '@ice/shared';
import { getFileText, getFiles, transactWithOrigin } from '@ice/shared';
import { readAgents, readChat } from './agentTypes.ts';

const AGENT_ID = 'agent_mock_1';
const AGENT: EditOrigin = { kind: 'agent', agentId: AGENT_ID };
const HUMAN: EditOrigin = { kind: 'human', participantId: 'p_human' };

test('readAgents normalizes a flat AgentState map (with merged pending call)', () => {
  const snapshot = {
    [AGENT_ID]: {
      agentId: AGENT_ID,
      kind: 'mock',
      displayName: 'Mockingbird',
      color: '#8b5cf6',
      status: 'awaiting-approval',
      // pending call merged alongside the state (one valid server layout):
      pendingCall: {
        id: 'call_1',
        agentId: AGENT_ID,
        tool: 'write_file',
        args: { path: 'src/x.ts' },
        requiresApproval: true,
        status: 'proposed',
      },
    },
  };
  const views = readAgents(snapshot);
  assert.equal(views.length, 1);
  const v = views[0]!;
  assert.equal(v.state.agentId, AGENT_ID);
  assert.equal(v.state.displayName, 'Mockingbird');
  assert.equal(v.state.color, '#8b5cf6');
  assert.equal(v.state.status, 'awaiting-approval');
  assert.ok(v.pendingCall, 'pending tool call surfaced for the approval gate');
  assert.equal(v.pendingCall!.id, 'call_1');
  assert.equal(v.pendingCall!.tool, 'write_file');
});

test('readAgents normalizes the nested { state, pendingCall } layout too', () => {
  const snapshot = {
    [AGENT_ID]: {
      state: {
        agentId: AGENT_ID,
        kind: 'claude-code',
        displayName: 'Claude',
        color: '#22d3ee',
        status: 'editing',
      },
      // no pending call → no approval gate
    },
  };
  const views = readAgents(snapshot);
  assert.equal(views.length, 1);
  assert.equal(views[0]!.state.kind, 'claude-code');
  assert.equal(views[0]!.state.status, 'editing');
  assert.equal(views[0]!.pendingCall, null);
});

test('readAgents skips malformed entries and defaults unknown status to idle', () => {
  const snapshot = {
    good: { agentId: 'good', displayName: 'Good', status: 'not-a-real-status' },
    bad1: null,
    bad2: 42,
    bad3: { displayName: 'no id here' }, // falls back to the key as id
  };
  const views = readAgents(snapshot as Record<string, unknown>);
  // 'good' (id from field) + 'bad3' (id from key) are usable; null/number are not.
  const ids = views.map((v) => v.state.agentId).sort();
  assert.deepEqual(ids, ['bad3', 'good']);
  const good = views.find((v) => v.state.agentId === 'good')!;
  assert.equal(good.state.status, 'idle', 'unknown status coerced to idle');
});

test('readChat keeps valid rows in order and drops garbage', () => {
  const items = [
    { id: 'm1', agentId: AGENT_ID, role: 'user', text: 'add a hello fn', createdAt: 1 },
    null,
    { id: 'm2', agentId: AGENT_ID, role: 'agent', text: 'on it', createdAt: 2 },
    { id: 'm3', text: '' }, // empty text is still a valid (empty) message
    { role: 'agent' }, // no id/text → dropped
    'nope',
  ];
  const msgs = readChat(items as unknown[]);
  assert.deepEqual(
    msgs.map((m) => m.id),
    ['m1', 'm2', 'm3'],
  );
  assert.equal(msgs[0]!.role, 'user');
  assert.equal(msgs[1]!.role, 'agent');
});

test('agent edits flow THROUGH the doc with an agent origin (attributable)', () => {
  const doc = new Y.Doc();
  const files = getFiles(doc);

  let sawAgentEditPath: string | null = null;
  let sawHumanMisattributed = false;

  const handler = (events: Y.YEvent<Y.AbstractType<unknown>>[], txn: Y.Transaction): void => {
    const origin = txn.origin as { kind?: string; agentId?: string } | null;
    const isAgent =
      origin !== null && typeof origin === 'object' && origin.kind === 'agent';
    for (const ev of events) {
      // derive the touched file path (key on the files map, or first path seg)
      let path: string | null = null;
      if (ev.target === files && ev.keys && ev.keys.size > 0) {
        path = [...ev.keys.keys()][0] ?? null;
      } else if (ev.path.length > 0 && typeof ev.path[0] === 'string') {
        path = ev.path[0] as string;
      }
      if (isAgent) sawAgentEditPath = path ?? sawAgentEditPath;
      else if (origin && origin.kind !== 'human') sawHumanMisattributed = true;
    }
  };
  files.observeDeep(handler);

  // The agent creates + writes a file, the law's way: origin-tagged transaction.
  transactWithOrigin(doc, AGENT, () => {
    getFileText(doc, 'src/agent.ts').insert(0, 'export const hi = () => "hi";\n');
  });

  // A human edit must NOT be attributed to the agent indicator.
  transactWithOrigin(doc, HUMAN, () => {
    getFileText(doc, 'src/agent.ts').insert(0, '// human note\n');
  });

  files.unobserveDeep(handler);

  assert.equal(sawAgentEditPath, 'src/agent.ts', 'agent edit detected on the right path');
  assert.equal(sawHumanMisattributed, false, 'human edit never misread as agent');
  // And the content is real (agents act through the doc, not the filesystem).
  assert.ok(getFileText(doc, 'src/agent.ts').toString().includes('export const hi'));
});
