/**
 * React bindings over the CRDT file tree (see lib/tree.ts).
 *
 * `useFileTree` subscribes to the room's Yjs `tree` map and re-renders the
 * caller whenever any participant creates/renames/deletes a file. It also seeds
 * a fresh room with the default file on mount (idempotent + race-safe), so the
 * v0.1 single-file demo keeps working with zero ceremony.
 */
import { useEffect, useState } from 'react';
import type { FileNode } from '@ice/shared';
import { getTree } from '@ice/shared';
import type { RoomConnection } from './connection.js';
import { ensureSeeded, listNodes } from './tree.js';

export function useFileTree(connection: RoomConnection): FileNode[] {
  const [nodes, setNodes] = useState<FileNode[]>(() => listNodes(connection.doc));

  useEffect(() => {
    const doc = connection.doc;
    // Seed the default file the first time anyone lands in a fresh room.
    ensureSeeded(doc);

    const tree = getTree(doc);
    const refresh = (): void => setNodes(listNodes(doc));
    // `observe` fires on direct key add/delete; that's all the tree map needs
    // since node values are plain objects we replace wholesale, never mutate.
    tree.observe(refresh);
    // Sync once after (possibly) seeding / late connection.
    refresh();

    return () => tree.unobserve(refresh);
  }, [connection]);

  return nodes;
}
