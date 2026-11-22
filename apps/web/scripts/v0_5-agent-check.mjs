/**
 * v0.5 "Your first AI teammate" e2e verification (mock agent — no API key).
 *
 *   node apps/web/scripts/v0_5-agent-check.mjs    (requires @ice/server running)
 *
 * Proves the AGENT LAW end to end through the live Yjs doc:
 *   - an agent edit appears in the shared doc (it acted THROUGH the doc)
 *   - the agent chat transcript streams back
 *   - a destructive tool call is GATED (status 'awaiting-approval', not applied)
 *   - REJECT preserves the file; APPROVE applies the delete
 *   - the shared terminal shows the agent's command output (soft check)
 * (Per-origin attribution + undo are covered by the 45 server unit tests.)
 */
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';

const API = process.env.ICE_API || 'http://127.0.0.1:8080';
const WS = process.env.ICE_WS || 'ws://127.0.0.1:8080/sync';
const WSCtor = globalThis.WebSocket;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}
function soft(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'soft'}: ${name}${extra ? ` — ${extra}` : ''}`);
}

// Read a field from either a Y.Map or a plain object.
function field(obj, key) {
  if (!obj) return undefined;
  return typeof obj.get === 'function' ? obj.get(key) : obj[key];
}
function fileText(doc, path) {
  const f = doc.getMap('files');
  let t = f.get(path);
  if (!t) {
    t = new Y.Text();
    f.set(path, t);
  }
  return t;
}
function firstAgent(doc) {
  const agents = doc.getMap('agents');
  for (const [id, entry] of agents.entries()) return { id, entry };
  return { id: null, entry: null };
}
function agentStatus(doc) {
  const { entry } = firstAgent(doc);
  return field(field(entry, 'state'), 'status');
}
function pendingCallId(doc) {
  const { entry } = firstAgent(doc);
  const pending = field(entry, 'pendingCall');
  return field(pending, 'id');
}
async function post(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

try {
  const { room } = await (
    await fetch(`${API}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'agent-check' }),
    })
  ).json();
  const roomId = room.id;
  check('create room', !!roomId, roomId);

  const doc = new Y.Doc();
  const p = new HocuspocusProvider({ url: WS, name: roomId, document: doc, WebSocketPolyfill: WSCtor });
  await new Promise((res) => (p.synced ? res() : p.on('synced', res)));
  // Seed the file the mock will try to (destructively) delete.
  fileText(doc, 'scratch.tmp').insert(0, 'temp\n');
  await sleep(400);

  // Add a mock agent + send a prompt.
  const started = await post(`/api/rooms/${roomId}/agent`, { kind: 'mock' });
  check('add mock agent', started.status === 201 && !!started.json.agent, JSON.stringify(started.json.agent || started.json));
  await post(`/api/rooms/${roomId}/agent/message`, { text: 'add a helper and tidy up' });
  await sleep(1500);

  // Agent acted THROUGH the doc.
  check('agent edit landed in shared doc', fileText(doc, 'src/generated.ts').toString().includes('mockHelper1'), fileText(doc, 'src/generated.ts').toString().slice(0, 40));
  const chat = doc.getArray('agentChat').toArray();
  const agentSaid = chat.some((m) => field(m, 'role') === 'agent' && String(field(m, 'text') || '').length > 0);
  check('agent chat reply present', agentSaid, `${chat.length} msg(s)`);

  // Destructive call is GATED.
  check('destructive call awaiting approval', agentStatus(doc) === 'awaiting-approval', String(agentStatus(doc)));
  const callId1 = pendingCallId(doc);
  check('pending tool call exposed for approval', !!callId1, String(callId1));
  check('gated delete NOT applied yet', doc.getMap('files').has('scratch.tmp'));
  soft('shared terminal shows command output', doc.getText('terminal').toString().includes('hello from the mock agent'), doc.getText('terminal').toString().slice(0, 30).replace(/\n/g, ' '));

  // REJECT preserves the file.
  await post(`/api/rooms/${roomId}/agent/approve`, { callId: callId1, decision: 'reject' });
  await sleep(900);
  check('after REJECT: file preserved', doc.getMap('files').has('scratch.tmp'));
  check('after REJECT: gate cleared', agentStatus(doc) !== 'awaiting-approval', String(agentStatus(doc)));

  // APPROVE applies the delete (turn 2).
  await post(`/api/rooms/${roomId}/agent/message`, { text: 'okay, clean it up' });
  await sleep(1500);
  const callId2 = pendingCallId(doc);
  check('turn 2 re-gates the destructive call', agentStatus(doc) === 'awaiting-approval' && !!callId2, String(callId2));
  await post(`/api/rooms/${roomId}/agent/approve`, { callId: callId2, decision: 'approve' });
  await sleep(900);
  check('after APPROVE: file deleted by agent', !doc.getMap('files').has('scratch.tmp'));

  p.destroy();
  console.log(failures === 0 ? '\n✅ ALL v0.5 AGENT CHECKS PASSED' : `\n❌ ${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
} catch (err) {
  console.error('FATAL:', err?.message || err);
  process.exit(1);
}
