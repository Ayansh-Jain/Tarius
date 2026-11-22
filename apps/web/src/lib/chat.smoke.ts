/**
 * Headless smoke for the v1.0 human-chat model (lib/chat.ts) — the pure, load-
 * bearing logic the ChatPanel is built on. No DOM, no framework beyond Node's
 * `node:test`; it proves multiplayer behaviour against bare Y.Docs with no
 * server (there is none in CI):
 *
 *   1. ensureDefaultChannel is idempotent — calling it many times (even on two
 *      docs that then sync) converges on ONE 'general' channel.
 *   2. THE headline: a message posted into a channel on doc A appears in the
 *      SAME channel on doc B once the two docs exchange updates. (group + DM)
 *   3. openOrCreateDm derives a stable, order-independent id, so both sides land
 *      on the same DM regardless of who opens it first.
 *   4. Embeds (code snippet + file/line range) survive the round-trip intact.
 *   5. Every mutation is attributable: a post is carried by a {kind:'human'}
 *      Yjs transaction (the signal behind per-author attribution).
 *
 * Run:  node apps/web/src/lib/run-chat-smoke.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import type { ChatEmbed, EditOrigin } from '@ice/shared';
import { getChannels } from '@ice/shared';
import {
  DEFAULT_CHANNEL_ID,
  composeMessage,
  createChannel,
  dmChannelId,
  ensureDefaultChannel,
  listChannels,
  listMessages,
  openOrCreateDm,
  postMessage,
} from './chat.ts';

const ALICE: EditOrigin = { kind: 'human', participantId: 'p_alice' };
const BOB: EditOrigin = { kind: 'human', participantId: 'p_bob' };

/** Bidirectionally sync two docs (apply each one's full state to the other). */
function sync(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
}

test('ensureDefaultChannel is idempotent and converges across docs', () => {
  const a = new Y.Doc();
  const b = new Y.Doc();

  // Both clients seed 'general' independently (as every room mount does)…
  ensureDefaultChannel(a, ALICE);
  ensureDefaultChannel(a, ALICE); // repeat on the same doc → no-op
  ensureDefaultChannel(b, BOB);

  sync(a, b);

  // …and after sync there is exactly ONE 'general' on each side.
  for (const doc of [a, b]) {
    const channels = listChannels(doc);
    const generals = channels.filter((c) => c.id === DEFAULT_CHANNEL_ID);
    assert.equal(generals.length, 1, 'exactly one general channel');
    assert.equal(generals[0]!.kind, 'group');
    assert.equal(generals[0]!.name, 'general');
  }
});

test('a message posted in a channel on doc A appears in the same channel on doc B', () => {
  const a = new Y.Doc();
  const b = new Y.Doc();
  ensureDefaultChannel(a, ALICE);
  sync(a, b); // B now knows about 'general'

  // Alice posts in 'general' on A.
  const sent = postMessage(
    a,
    ALICE,
    DEFAULT_CHANNEL_ID,
    composeMessage({ authorId: 'p_alice', body: 'hello team' }),
  );

  // Before sync, B hasn't seen it.
  assert.equal(listMessages(b, DEFAULT_CHANNEL_ID).length, 0, 'not visible pre-sync');

  sync(a, b);

  // After sync, B sees the identical message in the SAME channel.
  const onB = listMessages(b, DEFAULT_CHANNEL_ID);
  assert.equal(onB.length, 1, 'message replicated to B');
  assert.equal(onB[0]!.id, sent.id);
  assert.equal(onB[0]!.authorId, 'p_alice');
  assert.equal(onB[0]!.body, 'hello team');

  // And a reply from B flows back to A in the same channel (full duplex).
  postMessage(b, BOB, DEFAULT_CHANNEL_ID, composeMessage({ authorId: 'p_bob', body: 'hi alice' }));
  sync(a, b);
  const onA = listMessages(a, DEFAULT_CHANNEL_ID);
  assert.deepEqual(onA.map((m) => m.body), ['hello team', 'hi alice'], 'ordered, both visible on A');
});

test('openOrCreateDm derives a stable id; both sides converge on one DM', () => {
  const a = new Y.Doc();
  const b = new Y.Doc();

  // id is order-independent.
  assert.equal(dmChannelId(['p_alice', 'p_bob']), dmChannelId(['p_bob', 'p_alice']));

  // Alice opens the DM from her side; Bob (independently) from his — opposite order.
  const dmA = openOrCreateDm(a, ALICE, ['p_alice', 'p_bob']);
  const dmB = openOrCreateDm(b, BOB, ['p_bob', 'p_alice']);
  assert.equal(dmA.id, dmB.id, 'same DM id regardless of who opens it / member order');
  assert.equal(dmA.kind, 'dm');

  // Alice posts in the DM; it reaches Bob's same DM after sync.
  postMessage(a, ALICE, dmA.id, composeMessage({ authorId: 'p_alice', body: 'just us' }));
  sync(a, b);

  const dms = listChannels(b).filter((c) => c.kind === 'dm');
  assert.equal(dms.length, 1, 'a single merged DM channel');
  const msgs = listMessages(b, dmA.id);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0]!.body, 'just us');
});

test('embeds (code + file range) survive the round-trip', () => {
  const a = new Y.Doc();
  const b = new Y.Doc();
  ensureDefaultChannel(a, ALICE);

  const embeds: ChatEmbed[] = [
    { type: 'code', language: 'ts', code: 'export const x = 1;\n' },
    { type: 'fileRange', path: 'src/app.ts', from: 10, to: 14 },
  ];
  postMessage(
    a,
    ALICE,
    DEFAULT_CHANNEL_ID,
    composeMessage({ authorId: 'p_alice', body: 'see this', embeds }),
  );
  sync(a, b);

  const [msg] = listMessages(b, DEFAULT_CHANNEL_ID);
  assert.ok(msg, 'message present on B');
  assert.equal(msg!.embeds?.length, 2);
  const code = msg!.embeds![0]!;
  const range = msg!.embeds![1]!;
  assert.equal(code.type, 'code');
  if (code.type === 'code') {
    assert.equal(code.language, 'ts');
    assert.equal(code.code, 'export const x = 1;\n');
  }
  assert.equal(range.type, 'fileRange');
  if (range.type === 'fileRange') {
    assert.equal(range.path, 'src/app.ts');
    assert.equal(range.from, 10);
    assert.equal(range.to, 14);
  }
});

test('createChannel returns the existing channel and never clobbers messages', () => {
  const doc = new Y.Doc();
  const made = createChannel(doc, ALICE, { id: 'team', kind: 'group', name: 'team', createdAt: 1 });
  assert.equal(made.name, 'team');
  postMessage(doc, ALICE, 'team', composeMessage({ authorId: 'p_alice', body: 'first' }));

  // Re-creating the same id is a no-op that preserves the existing meta + messages.
  const again = createChannel(doc, BOB, { id: 'team', kind: 'group', name: 'RENAMED', createdAt: 999 });
  assert.equal(again.name, 'team', 'first-written meta wins; no clobber');
  assert.equal(listMessages(doc, 'team').length, 1, 'messages preserved');
});

test('a post is carried by a human-origin transaction (attributable)', () => {
  const doc = new Y.Doc();
  ensureDefaultChannel(doc, ALICE);

  let sawHumanPost: string | null = null;
  let sawNonHumanPost = false;
  const channels = getChannels(doc) as Y.Map<unknown>;
  const handler = (_events: Y.YEvent<Y.AbstractType<unknown>>[], txn: Y.Transaction): void => {
    const origin = txn.origin as { kind?: string; participantId?: string } | null;
    if (origin && typeof origin === 'object' && origin.kind === 'human') {
      sawHumanPost = origin.participantId ?? null;
    } else if (origin && typeof origin === 'object' && origin.kind === 'agent') {
      sawNonHumanPost = true;
    }
  };
  channels.observeDeep(handler);
  postMessage(doc, ALICE, DEFAULT_CHANNEL_ID, composeMessage({ authorId: 'p_alice', body: 'attributable' }));
  channels.unobserveDeep(handler);

  assert.equal(sawHumanPost, 'p_alice', 'post attributed to the human author');
  assert.equal(sawNonHumanPost, false, 'never misattributed to an agent');
});
