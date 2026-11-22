/**
 * Snapshot ("try it safely") tests (v1.5 Slice B).
 *
 * These exercise the real git layer, so — exactly like the convergence suite —
 * each test runs against its OWN temp ICE_GIT_ROOT. `repos.ts` resolves
 * REPOS_DIR from process.env.ICE_GIT_ROOT at import time, so we set the env var,
 * `vi.resetModules()`, then dynamic-import a FRESH module graph (snapshot +
 * convergence share the same freshly-evaluated repos binding) per test.
 *
 * Asserts the lifecycle end-to-end:
 *   • createAgentSnapshot makes a REAL branch off the room's HEAD,
 *   • work committed on the snapshot branch does NOT touch the room's main,
 *   • mergeSnapshot brings the snapshot's commit back onto main (fast-forward),
 *   • a true 3-way merge works when main has diverged,
 *   • discardSnapshot drops the branch, leaving main untouched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { getFileText } from '@ice/shared';

type SnapshotModule = typeof import('./index.js');
type ConvergenceModule = typeof import('../convergence/index.js');

let gitRoot: string;

/** Fresh temp repo root + freshly-evaluated modules bound to it. */
async function freshModules(): Promise<{ snap: SnapshotModule; conv: ConvergenceModule }> {
  vi.resetModules();
  // Import convergence FIRST so both modules resolve the same fresh repos.ts
  // instance (snapshot.ts imports from ../convergence, which imports ../repos).
  const conv = await import('../convergence/index.js');
  const snap = await import('./index.js');
  return { snap, conv };
}

beforeEach(async () => {
  gitRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ice-snapshot-'));
  process.env.ICE_GIT_ROOT = gitRoot;
});

afterEach(async () => {
  delete process.env.ICE_GIT_ROOT;
  if (gitRoot) await fs.rm(gitRoot, { recursive: true, force: true });
});

/** Seed a doc's files map with {path: content}. */
function seedDoc(doc: Y.Doc, files: Record<string, string>): void {
  doc.transact(() => {
    for (const [p, content] of Object.entries(files)) {
      const text = getFileText(doc, p);
      if (text.length > 0) text.delete(0, text.length);
      text.insert(0, content);
    }
  });
}

describe('createAgentSnapshot', () => {
  it('creates a REAL branch off the room HEAD and tracks it as open', async () => {
    const { snap, conv } = await freshModules();
    const roomId = 'room-snap-create';

    const doc = new Y.Doc();
    seedDoc(doc, { 'a.ts': 'export const a = 1;\n' });

    const s = await snap.createAgentSnapshot(roomId, doc, 'agent-x', { id: 'snap1' });

    expect(s.status).toBe('open');
    expect(s.agentId).toBe('agent-x');
    expect(s.branch).toBe('snapshots/agent-x/snap1');
    expect(s.baseCommit).toMatch(/^[0-9a-f]{40}$/);

    // The branch really exists in the bare repo and points at the base commit.
    const branches = await conv.listBranches(roomId);
    const names = branches.map((b) => b.name);
    expect(names).toContain('main');
    expect(names).toContain('snapshots/agent-x/snap1');
    const snapBranch = branches.find((b) => b.name === 'snapshots/agent-x/snap1');
    expect(snapBranch?.head).toBe(s.baseCommit);
  });

  it('is retrievable from the shared store after creation', async () => {
    const { snap } = await freshModules();
    const doc = new Y.Doc();
    seedDoc(doc, { 'a.ts': 'a\n' });
    const s = await snap.createAgentSnapshot('room-store', doc, 'agent-x', { id: 'snapS' });
    expect(snap.snapshotStore.get('snapS')?.id).toBe(s.id);
    expect(snap.snapshotStore.roomFor('snapS')).toBe('room-store');
    expect(snap.snapshotStore.list('room-store', 'agent-x').map((x) => x.id)).toEqual(['snapS']);
  });
});

describe('snapshot isolation + merge-back', () => {
  it('work on the snapshot branch does NOT touch main until merge', async () => {
    const { snap, conv } = await freshModules();
    const roomId = 'room-snap-iso';

    const doc = new Y.Doc();
    seedDoc(doc, { 'a.ts': 'base\n' });
    const s = await snap.createAgentSnapshot(roomId, doc, 'agent-x', { id: 'snap1' });

    const mainBefore = await conv.listCommits(roomId, { ref: 'main', limit: 10 });

    // Agent "tries it safely": add a new file on the snapshot branch only.
    const snapCommit = await snap.commitSnapshotFiles('snap1', [
      { path: 'a.ts', content: 'base\n' },
      { path: 'feature.ts', content: 'export const feature = true;\n' },
    ]);
    expect(snapCommit).toMatch(/^[0-9a-f]{40}$/);

    // main is unchanged; the snapshot branch advanced.
    const mainAfter = await conv.listCommits(roomId, { ref: 'main', limit: 10 });
    expect(mainAfter.map((c) => c.hash)).toEqual(mainBefore.map((c) => c.hash));

    const branches = await conv.listBranches(roomId);
    const snapHead = branches.find((b) => b.name === s.branch)?.head;
    const mainHead = branches.find((b) => b.name === 'main')?.head;
    expect(snapHead).toBe(snapCommit);
    expect(snapHead).not.toBe(mainHead);

    // Loading the room doc still reflects ONLY main (no feature.ts yet).
    const liveDoc = new Y.Doc();
    await conv.loadRoomFromGit(roomId, liveDoc);
    expect(getFileText(liveDoc, 'feature.ts').toString()).toBe('');
    expect(getFileText(liveDoc, 'a.ts').toString()).toBe('base\n');
  });

  it('mergeSnapshot fast-forwards main and brings the snapshot commit back', async () => {
    const { snap, conv } = await freshModules();
    const roomId = 'room-snap-merge';

    const doc = new Y.Doc();
    seedDoc(doc, { 'a.ts': 'base\n' });
    await snap.createAgentSnapshot(roomId, doc, 'agent-x', { id: 'snap1' });

    const snapCommit = await snap.commitSnapshotFiles('snap1', [
      { path: 'a.ts', content: 'base\n' },
      { path: 'feature.ts', content: 'export const feature = 42;\n' },
    ]);

    const result = await snap.mergeSnapshot('snap1');
    expect(result.fastForward).toBe(true);
    expect(result.mergedCommit).toBe(snapCommit);
    expect(result.snapshot.status).toBe('merged');

    // main now points at the snapshot's commit.
    const branches = await conv.listBranches(roomId);
    expect(branches.find((b) => b.name === 'main')?.head).toBe(snapCommit);

    // A fresh room doc hydrated from git now sees the agent's merged work.
    const liveDoc = new Y.Doc();
    await conv.loadRoomFromGit(roomId, liveDoc);
    expect(getFileText(liveDoc, 'feature.ts').toString()).toBe('export const feature = 42;\n');

    // Store reflects merged; re-merging a non-open snapshot is rejected.
    expect(snap.snapshotStore.get('snap1')?.status).toBe('merged');
    await expect(snap.mergeSnapshot('snap1')).rejects.toThrow(/not open/);
  });

  it('merges back even when main diverged (true 3-way merge commit)', async () => {
    const { snap, conv } = await freshModules();
    const roomId = 'room-snap-3way';

    const doc = new Y.Doc();
    seedDoc(doc, { 'a.ts': 'base\n' });
    await snap.createAgentSnapshot(roomId, doc, 'agent-x', { id: 'snap1' });

    // Snapshot adds feature.ts on its branch.
    await snap.commitSnapshotFiles('snap1', [
      { path: 'a.ts', content: 'base\n' },
      { path: 'feature.ts', content: 'snap feature\n' },
    ]);

    // Meanwhile the live room advances main with a DISJOINT file (no conflict).
    seedDoc(doc, { 'a.ts': 'base\n', 'human.ts': 'human work\n' });
    await conv.flushAndCommit(roomId, doc, { message: 'human change on main' });

    const result = await snap.mergeSnapshot('snap1');
    expect(result.fastForward).toBe(false); // diverged → real merge commit
    expect(result.mergedCommit).toMatch(/^[0-9a-f]{40}$/);

    // The merged room has BOTH the human's and the agent's files.
    const liveDoc = new Y.Doc();
    await conv.loadRoomFromGit(roomId, liveDoc);
    expect(getFileText(liveDoc, 'feature.ts').toString()).toBe('snap feature\n');
    expect(getFileText(liveDoc, 'human.ts').toString()).toBe('human work\n');
    expect(getFileText(liveDoc, 'a.ts').toString()).toBe('base\n');
  });
});

describe('discardSnapshot', () => {
  it('drops the snapshot branch and leaves main untouched', async () => {
    const { snap, conv } = await freshModules();
    const roomId = 'room-snap-discard';

    const doc = new Y.Doc();
    seedDoc(doc, { 'a.ts': 'base\n' });
    const s = await snap.createAgentSnapshot(roomId, doc, 'agent-x', { id: 'snap1' });
    await snap.commitSnapshotFiles('snap1', [
      { path: 'a.ts', content: 'base\n' },
      { path: 'throwaway.ts', content: 'oops\n' },
    ]);

    const mainBefore = (await conv.listBranches(roomId)).find((b) => b.name === 'main')?.head;

    const discarded = await snap.discardSnapshot('snap1');
    expect(discarded.status).toBe('discarded');

    const branches = await conv.listBranches(roomId);
    expect(branches.map((b) => b.name)).not.toContain(s.branch);
    expect(branches.find((b) => b.name === 'main')?.head).toBe(mainBefore);

    // The experiment never reached the room.
    const liveDoc = new Y.Doc();
    await conv.loadRoomFromGit(roomId, liveDoc);
    expect(getFileText(liveDoc, 'throwaway.ts').toString()).toBe('');

    // Merging a discarded snapshot is rejected.
    await expect(snap.mergeSnapshot('snap1')).rejects.toThrow(/not open/);
  });

  it('throws for an unknown snapshot id', async () => {
    const { snap } = await freshModules();
    await expect(snap.discardSnapshot('does-not-exist')).rejects.toThrow(/unknown snapshot/);
    await expect(snap.mergeSnapshot('does-not-exist')).rejects.toThrow(/unknown snapshot/);
  });
});
