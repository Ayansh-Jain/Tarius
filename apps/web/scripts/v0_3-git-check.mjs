/**
 * v0.3 "Git comes home" end-to-end verification.
 *
 *   node apps/web/scripts/v0_3-git-check.mjs
 *
 * Requires a running @ice/server (REST :8080, git :8081). Proves:
 *   1. create room → edit the live doc → POST /commit returns a real hash
 *   2. /branches + /commits endpoints report the commit
 *   3. `git clone` of the room repo contains the committed files (doc → git)
 *   4. an UNCOMMITTED edit survives a reconnect — git HEAD never clobbers live
 *      state, and nothing is duplicated (the ADR-000 no-data-loss guarantee)
 */
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const exec = promisify(execFile);
const API = process.env.ICE_API || 'http://127.0.0.1:8080';
const WS = process.env.ICE_WS || 'ws://127.0.0.1:8080/sync';
const GIT = process.env.ICE_GIT || 'http://127.0.0.1:8081/git';
const WSCtor = globalThis.WebSocket;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
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
function provider(room, doc) {
  return new HocuspocusProvider({ url: WS, name: room, document: doc, WebSocketPolyfill: WSCtor });
}
function synced(p, ms = 8000) {
  return new Promise((res, rej) => {
    if (p.synced) return res();
    const to = setTimeout(() => rej(new Error('sync timeout')), ms);
    p.on('synced', () => {
      clearTimeout(to);
      res();
    });
  });
}

try {
  // 1. create room + edit the live doc
  const { room } = await (
    await fetch(`${API}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'git-check' }),
    })
  ).json();
  check('create room', !!room?.id, room?.id);
  const roomId = room.id;

  const doc = new Y.Doc();
  const p = provider(roomId, doc);
  await synced(p);
  fileText(doc, 'main.ts').insert(0, `export const x = 42; // @ ${new Date().toISOString()}\n`);
  fileText(doc, 'lib/util.ts').insert(0, 'export const y = 1;\n');
  await sleep(600);

  // 2. commit via API
  const commit = await (
    await fetch(`${API}/api/rooms/${roomId}/commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'v0.3 e2e commit' }),
    })
  ).json();
  check('commit returns hash', typeof commit?.hash === 'string' && commit.hash.length > 0, JSON.stringify(commit));

  // 3. branches + commits endpoints
  const br = await (await fetch(`${API}/api/rooms/${roomId}/branches`)).json();
  check('branches endpoint', Array.isArray(br.branches) && br.branches.length >= 1, JSON.stringify(br.branches));
  const cm = await (await fetch(`${API}/api/rooms/${roomId}/commits`)).json();
  check('commits endpoint', Array.isArray(cm.commits) && cm.commits.length >= 1, cm.commits?.[0]?.message);

  // 4. git clone (doc → git round-trip from a plain git client)
  const dir = mkdtempSync(join(tmpdir(), 'ice-clone-'));
  try {
    await exec('git', ['clone', '-q', `${GIT}/${roomId}.git`, dir]);
    const main = existsSync(join(dir, 'main.ts')) ? readFileSync(join(dir, 'main.ts'), 'utf8') : '';
    check('git clone has main.ts content', main.includes('export const x = 42'), main.slice(0, 40));
    check('git clone has nested lib/util.ts', existsSync(join(dir, 'lib', 'util.ts')));
  } catch (e) {
    check('git clone', false, e.message);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // 5. NO DATA LOSS: an uncommitted edit must survive a reconnect, un-duplicated
  fileText(doc, 'main.ts').insert(0, '// uncommitted edit\n');
  await sleep(500);
  p.destroy();
  await sleep(400);
  const doc2 = new Y.Doc();
  const p2 = provider(roomId, doc2);
  await synced(p2);
  await sleep(600);
  const reloaded = fileText(doc2, 'main.ts').toString();
  check('uncommitted edit survives reconnect (git did NOT overwrite live state)', reloaded.includes('// uncommitted edit'), reloaded.slice(0, 30));
  check('content not duplicated by git seed', (reloaded.match(/export const x = 42/g) || []).length === 1);
  p2.destroy();

  console.log(failures === 0 ? '\n✅ ALL v0.3 CHECKS PASSED' : `\n❌ ${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
} catch (err) {
  console.error('FATAL:', err?.message || err);
  process.exit(1);
}
