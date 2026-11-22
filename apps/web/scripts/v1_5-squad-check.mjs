/**
 * v1.5 "A squad of agents" e2e (mock agents — no API key).
 *
 *   node apps/web/scripts/v1_5-squad-check.mjs   (requires @ice/server running)
 *
 * Proves the moat through the live doc + routes:
 *   - POST /orchestrate spawns a SQUAD: >= 2 distinct agents on the same room
 *   - the orchestration task + subtasks appear in getTasks(doc)
 *   - the squad co-edits the shared doc (files appear)
 *   - opt-in snapshot round-trip: create → merge → listed as merged
 * (Distinct per-agent origins + conflict-free concurrent edits are covered by
 *  the orchestrator's unit tests; this proves the route → squad path e2e.)
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
const field = (o, k) => (!o ? undefined : typeof o.get === 'function' ? o.get(k) : o[k]);
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
      body: JSON.stringify({ name: 'squad-check' }),
    })
  ).json();
  const roomId = room.id;
  check('create room', !!roomId, roomId);

  const doc = new Y.Doc();
  const p = new HocuspocusProvider({ url: WS, name: roomId, document: doc, WebSocketPolyfill: WSCtor });
  await new Promise((res) => (p.synced ? res() : p.on('synced', res)));

  // Assign a task to the squad.
  const orch = await post(`/api/rooms/${roomId}/orchestrate`, {
    prompt: 'Build a small feature: add a helper module, wire it up, and add a test.',
  });
  check('orchestrate accepted', orch.status === 200 || orch.status === 201, JSON.stringify(orch.json));
  await sleep(3500); // let the orchestrator plan + spawn + run the squad

  const agents = doc.getMap('agents');
  const agentIds = [...agents.keys()];
  check('squad has >= 2 distinct agents', agentIds.length >= 2, `${agentIds.length} agents`);

  const tasks = doc.getArray('tasks').toArray();
  const task = tasks[0];
  const subtasks = field(task, 'subtasks'); // a Y.Array of Y.Maps (or plain array)
  const subCount = subtasks && typeof subtasks.length === 'number' ? subtasks.length : 0;
  check('orchestration task with subtasks in doc', tasks.length >= 1 && subCount >= 1, `${tasks.length} task(s), ${subCount} subtask(s)`);

  const fileCount = doc.getMap('files').size;
  check('squad co-edited the shared doc (files present)', fileCount >= 1, `${fileCount} file(s)`);

  // Opt-in snapshot round-trip for one agent.
  const agentId = agentIds[0];
  if (agentId) {
    const snap = await post(`/api/rooms/${roomId}/snapshots`, { agentId, message: 'try it safely' });
    const snapId = field(snap.json.snapshot, 'id');
    check('snapshot created', !!snapId, JSON.stringify(snap.json.snapshot || snap.json));
    if (snapId) {
      const merged = await post(`/api/rooms/${roomId}/snapshots/${snapId}/merge`, {});
      check('snapshot merge ok', merged.status === 200 && merged.json.ok === true, JSON.stringify(merged.json));
      const list = await (await fetch(`${API}/api/rooms/${roomId}/snapshots`)).json();
      const found = (list.snapshots || []).find((s) => field(s, 'id') === snapId);
      check('snapshot listed as merged', !!found && field(found, 'status') === 'merged', JSON.stringify(found));
    }
  }

  // MCP palette endpoint responds (empty without configured servers).
  const mcp = await (await fetch(`${API}/api/rooms/${roomId}/mcp/tools`)).json();
  check('mcp tools endpoint responds', Array.isArray(mcp.tools), `${(mcp.tools || []).length} tool(s)`);

  p.destroy();
  console.log(failures === 0 ? '\n✅ ALL v1.5 SQUAD CHECKS PASSED' : `\n❌ ${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
} catch (err) {
  console.error('FATAL:', err?.message || err);
  process.exit(1);
}
