/**
 * The collaborative room experience — the lazy route boundary.
 *
 * Everything that touches the heavy editor/CRDT stack — CodeMirror 6, Yjs, the
 * Hocuspocus transport, the live file tree, and the Source Control panel — is
 * reachable only through this module. App.tsx pulls it in via React.lazy, so
 * the landing route ('/') never downloads those (hundreds of KB of) vendor
 * chunks; they load on demand the first time someone enters a room.
 */
import { useEffect, useMemo, useState } from 'react';
import type { EditOrigin, Participant } from '@ice/shared';
import { toParticipant, type StoredIdentity } from '../lib/identity.js';
import { useRoomConnection } from '../lib/connection.js';
import { Landing } from '../components/Landing.js';
import { TopBar } from '../components/TopBar.js';
import { FileTree } from '../components/FileTree.js';
import { SourceControl } from '../components/SourceControl.js';
import { useFileTree } from '../lib/useTree.js';
import { resolveSelection } from '../lib/tree.js';
import { Editor, DEFAULT_FILE } from '../editor/Editor.js';

interface RoomProps {
  roomId: string;
  identity: StoredIdentity;
  onChangeIdentity: (value: { name: string; color: string }) => StoredIdentity;
}

export function Room({ roomId, identity, onChangeIdentity }: RoomProps): React.ReactElement {
  const participant: Participant = useMemo(() => toParticipant(identity), [identity]);
  const { connection, status, peers } = useRoomConnection(roomId, participant);
  const [editingIdentity, setEditingIdentity] = useState(false);

  // Live CRDT file tree (seeds the default file on mount). Owned here so the
  // sidebar render list and the editor's selection reconciliation share one
  // subscription and never disagree.
  const nodes = useFileTree(connection);

  // The file the user picked. Defaults to the v0.1 file so the demo opens to
  // content. We bind the editor to a *resolved* path (below) so a deleted or
  // not-yet-existent selection can never make the editor recreate a buffer.
  const [selected, setSelected] = useState<string>(DEFAULT_FILE);
  const boundPath = useMemo(
    () => resolveSelection(connection.doc, selected) ?? DEFAULT_FILE,
    // `nodes` is the live tree signal — recompute whenever it changes.
    [connection, selected, nodes],
  );

  // Collapsible Source Control panel (tree left, editor center, SCM right).
  const [scmOpen, setScmOpen] = useState(true);

  // The local human's attribution origin for all tree mutations.
  const origin: EditOrigin = useMemo(
    () => ({ kind: 'human', participantId: participant.id }),
    [participant.id],
  );

  // A fresh connection (room/identity change) resets to the default file.
  useEffect(() => {
    setSelected(DEFAULT_FILE);
  }, [connection]);

  // If the chosen file vanished (e.g. a peer deleted it), follow the resolved
  // fallback so the highlight and the editor stay in sync.
  useEffect(() => {
    if (selected !== boundPath) setSelected(boundPath);
  }, [boundPath, selected]);

  const roomName = useMemo(() => `Room ${roomId}`, [roomId]);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-slate-950 text-slate-100">
      <TopBar
        roomName={roomName}
        roomId={roomId}
        status={status}
        peers={peers}
        me={participant}
        onEditIdentity={() => setEditingIdentity(true)}
      />

      <div className="flex min-h-0 flex-1">
        {/* File tree (left) */}
        <aside className="hidden w-56 shrink-0 flex-col border-r border-slate-800/80 bg-slate-900/40 sm:flex">
          <FileTree
            connection={connection}
            nodes={nodes}
            selected={boundPath}
            onSelect={setSelected}
            origin={origin}
          />
        </aside>

        {/* Editor (center) */}
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-8 shrink-0 items-center justify-between border-b border-slate-800/80 bg-slate-900/30 px-3">
            <span className="truncate font-mono text-[11px] text-slate-400" title={boundPath}>
              {boundPath}
            </span>
            <button
              type="button"
              onClick={() => setScmOpen((v) => !v)}
              className="rounded px-2 py-0.5 text-[11px] text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-100"
              title={scmOpen ? 'Hide Source Control' : 'Show Source Control'}
            >
              {scmOpen ? 'Hide SCM ›' : '‹ Source Control'}
            </button>
          </div>
          <div className="min-h-0 flex-1">
            <Editor connection={connection} path={boundPath} />
          </div>
        </main>

        {/* Source Control (right, collapsible) */}
        {scmOpen && (
          <aside className="hidden w-64 shrink-0 flex-col border-l border-slate-800/80 bg-slate-900/40 md:flex">
            <SourceControl roomId={roomId} />
          </aside>
        )}
      </div>

      {editingIdentity && (
        <Landing
          mode="edit"
          initial={identity}
          onSubmit={(value) => {
            onChangeIdentity(value);
            setEditingIdentity(false);
          }}
          onCancel={() => setEditingIdentity(false)}
        />
      )}
    </div>
  );
}
