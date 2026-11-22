/**
 * v0.1 demo verification (headless proxy for the two-window live-cursor demo).
 *
 *   node apps/web/scripts/sync-check.mjs <room> write   # two clients; A edits, B must see it
 *   node apps/web/scripts/sync-check.mjs <room> read    # one client; room must still contain the marker (durability)
 *
 * Uses the same Yjs doc schema as @ice/shared (files: Y.Map<path, Y.Text>) but
 * inlined so this stays a plain .mjs (no TS loader). Connects to the running
 * @ice/server at ws://127.0.0.1:8080/sync. Exit 0 = PASS, 1 = FAIL.
 */
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';

const ROOM = process.argv[2] || 'verify-room';
const MODE = process.argv[3] || 'write';
const URL = process.env.ICE_SYNC_URL || 'ws://127.0.0.1:8080/sync';
const MARKER = 'ICE v0.1 sync OK';
const WS = globalThis.WebSocket;

if (!WS) {
  console.error('FAIL: no global WebSocket in this Node runtime');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fileText(doc) {
  const files = doc.getMap('files'); // YDOC_KEYS.files
  let t = files.get('main.ts');
  if (!t) {
    t = new Y.Text();
    files.set('main.ts', t);
  }
  return t;
}

function makeProvider(name, doc) {
  return new HocuspocusProvider({ url: URL, name, document: doc, WebSocketPolyfill: WS });
}

function waitSynced(provider, ms = 8000) {
  return new Promise((resolve, reject) => {
    if (provider.synced) return resolve();
    const to = setTimeout(() => reject(new Error('sync timeout')), ms);
    provider.on('synced', () => {
      clearTimeout(to);
      resolve();
    });
  });
}

try {
  if (MODE === 'write') {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const pA = makeProvider(ROOM, docA);
    const pB = makeProvider(ROOM, docB);
    await Promise.all([waitSynced(pA), waitSynced(pB)]);

    const msg = `${MARKER} @ ${new Date().toISOString()}`;
    fileText(docA).insert(0, msg + '\n');

    let ok = false;
    for (let i = 0; i < 100; i++) {
      if (fileText(docB).toString().includes(MARKER)) {
        ok = true;
        break;
      }
      await sleep(100);
    }
    await sleep(700); // let the server debounce-persist to SQLite
    pA.destroy();
    pB.destroy();
    console.log(ok ? `PASS write: A's edit reached B → "${msg}"` : 'FAIL write: edit did not propagate A→B');
    process.exit(ok ? 0 : 1);
  } else {
    const doc = new Y.Doc();
    const p = makeProvider(ROOM, doc);
    await waitSynced(p);
    await sleep(700);
    const content = fileText(doc).toString();
    const ok = content.includes(MARKER);
    p.destroy();
    console.log(
      ok
        ? 'PASS read: room state persisted across server restart (marker found)'
        : `FAIL read: marker missing after restart; content="${content.slice(0, 80)}"`,
    );
    process.exit(ok ? 0 : 1);
  }
} catch (err) {
  console.error('FAIL:', err?.message || err);
  process.exit(1);
}
