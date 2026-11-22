/**
 * Headless smoke for the CRDT file-tree model (lib/tree.ts).
 *
 * No DOM, no test framework — just Node's built-in `node:test` runner exercising
 * the pure model the sidebar + editor are built on. This proves the load-bearing
 * behaviours without booting a browser:
 *
 *   1. A fresh room seeds exactly `main.ts` (so the v0.1 demo still opens).
 *   2. Seeding is idempotent + convergent across two docs syncing.
 *   3. create / rename / delete mutate the shared tree and buffers correctly.
 *   4. "Switching files rebinds the editor": resolveSelection + getFileText hand
 *      back the right Y.Text for the selected path, and renaming carries content
 *      (and the editor would rebind to the new buffer).
 *
 * Run:  node --experimental-strip-types apps/web/src/lib/tree.smoke.ts
 * (from the web package dir, or with an absolute path).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import type { EditOrigin } from '@ice/shared';
import { getFileText, getTree } from '@ice/shared';
import {
  DEFAULT_FILE,
  createFile,
  deleteFile,
  ensureSeeded,
  listFilePaths,
  listNodes,
  normalizePath,
  renameFile,
  resolveSelection,
} from './tree.ts';

const HUMAN: EditOrigin = { kind: 'human', participantId: 'p_test' };

test('a fresh room seeds exactly main.ts with the welcome buffer', () => {
  const doc = new Y.Doc();
  ensureSeeded(doc);
  assert.deepEqual(listFilePaths(doc), [DEFAULT_FILE]);
  const text = getFileText(doc, DEFAULT_FILE).toString();
  assert.ok(text.includes('Welcome to ICE'), 'seed content present');
});

test('ensureSeeded is idempotent (second call is a no-op)', () => {
  const doc = new Y.Doc();
  ensureSeeded(doc);
  const before = getFileText(doc, DEFAULT_FILE).toString();
  ensureSeeded(doc);
  assert.deepEqual(listFilePaths(doc), [DEFAULT_FILE]);
  assert.equal(getFileText(doc, DEFAULT_FILE).toString(), before);
});

test('two docs racing the seed converge to a single main.ts after sync', () => {
  const a = new Y.Doc();
  const b = new Y.Doc();
  // Both seed independently (the real race: two clients into a fresh room).
  ensureSeeded(a);
  ensureSeeded(b);
  // Exchange updates both ways, as Hocuspocus would.
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
  assert.deepEqual(listFilePaths(a), [DEFAULT_FILE]);
  assert.deepEqual(listFilePaths(b), [DEFAULT_FILE]);
});

test('createFile adds a file (and parent dirs) visible in the tree', () => {
  const doc = new Y.Doc();
  ensureSeeded(doc);
  const res = createFile(doc, 'src/util/math.ts', HUMAN);
  assert.equal(res.ok, true);
  assert.equal(res.path, 'src/util/math.ts');

  const paths = listNodes(doc).map((n) => `${n.kind}:${n.path}`);
  assert.ok(paths.includes('dir:src'), 'created parent dir src');
  assert.ok(paths.includes('dir:src/util'), 'created parent dir src/util');
  assert.ok(paths.includes('file:src/util/math.ts'), 'created the file');

  // Duplicate create is rejected, not silently duplicated.
  const dup = createFile(doc, 'src/util/math.ts', HUMAN);
  assert.equal(dup.ok, false);
});

test('createFile rejects invalid paths', () => {
  const doc = new Y.Doc();
  ensureSeeded(doc);
  assert.equal(createFile(doc, '   ', HUMAN).ok, false);
  assert.equal(createFile(doc, '..', HUMAN).ok, false);
  assert.equal(normalizePath('a/../b'), null);
  assert.equal(normalizePath('  foo//bar/ '), 'foo/bar');
});

test('switching files: resolveSelection + getFileText return the selected buffer', () => {
  const doc = new Y.Doc();
  ensureSeeded(doc);
  createFile(doc, 'notes.ts', HUMAN);
  // Put distinct content in each buffer so we can tell which one we bound.
  getFileText(doc, DEFAULT_FILE); // already seeded
  doc.transact(() => getFileText(doc, 'notes.ts').insert(0, 'NOTES_BODY'));

  // Selecting an existing file resolves to itself; the editor binds its Y.Text.
  assert.equal(resolveSelection(doc, 'notes.ts'), 'notes.ts');
  assert.equal(getFileText(doc, 'notes.ts').toString(), 'NOTES_BODY');

  // Selecting back to main.ts rebinds to the seed buffer (the v0.1 file).
  assert.equal(resolveSelection(doc, DEFAULT_FILE), DEFAULT_FILE);
  assert.ok(getFileText(doc, DEFAULT_FILE).toString().includes('greet'));

  // A bogus selection falls back to main.ts (never an empty/created buffer).
  assert.equal(resolveSelection(doc, 'does/not/exist.ts'), DEFAULT_FILE);
});

test('renameFile moves the tree node AND carries the buffer content', () => {
  const doc = new Y.Doc();
  ensureSeeded(doc);
  createFile(doc, 'old.ts', HUMAN);
  doc.transact(() => getFileText(doc, 'old.ts').insert(0, 'KEEP_ME'));

  const res = renameFile(doc, 'old.ts', 'lib/new.ts', HUMAN);
  assert.equal(res.ok, true);
  assert.equal(res.path, 'lib/new.ts');

  const files = listFilePaths(doc);
  assert.ok(!files.includes('old.ts'), 'old path gone');
  assert.ok(files.includes('lib/new.ts'), 'new path present');
  // Content (and thus the buffer the editor rebinds to) survived the move.
  assert.equal(getFileText(doc, 'lib/new.ts').toString(), 'KEEP_ME');
});

test('deleteFile drops the file and reports the next selection', () => {
  const doc = new Y.Doc();
  ensureSeeded(doc); // main.ts
  createFile(doc, 'a.ts', HUMAN);
  createFile(doc, 'b.ts', HUMAN);

  // Files sort as: a.ts, b.ts, main.ts. Deleting a.ts → next is b.ts.
  const { nextSelection } = deleteFile(doc, 'a.ts', HUMAN);
  assert.ok(!listFilePaths(doc).includes('a.ts'), 'a.ts removed');
  assert.equal(nextSelection, 'b.ts');

  // The deleted file's buffer is dropped too (no resurrection).
  assert.equal(getTree(doc).has('a.ts'), false);
});

test('deleting the last file yields a null next selection', () => {
  const doc = new Y.Doc();
  createFile(doc, 'only.ts', HUMAN);
  const { nextSelection } = deleteFile(doc, 'only.ts', HUMAN);
  assert.equal(nextSelection, null);
  assert.deepEqual(listFilePaths(doc), []);
  // With no files, resolveSelection reports null (empty room).
  assert.equal(resolveSelection(doc, 'only.ts'), null);
});
