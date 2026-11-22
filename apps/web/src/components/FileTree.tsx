/**
 * File-tree sidebar — the multi-file surface backed by the room's CRDT tree.
 *
 * Lists every file/dir from the shared `tree` map (so all participants see the
 * same set live), lets you open a file (which re-binds the editor), and
 * create / rename / delete files. Every mutation flows through lib/tree.ts in
 * an origin-tagged transaction, so changes propagate to every peer instantly.
 *
 * Directories render as non-selectable group headers with their children
 * nested under them; files are the selectable leaves.
 */
import { ChevronDown, ChevronRight, FileCode2, Folder, FolderOpen, FolderUp, Pencil, Trash2, Upload } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FileNode } from '@ice/shared';
import type { EditOrigin } from '@ice/shared';
import type { RoomConnection } from '../lib/connection.js';
import {
  ancestorDirs,
  basename,
  createFile,
  deleteFile,
  dirname,
  renameFile,
} from '../lib/tree.js';
import {
  findConflicts,
  importEntries,
  readDataTransfer,
  readFileList,
  type ReadResult,
} from '../lib/importFiles.js';

interface FileTreeProps {
  connection: RoomConnection;
  /** The live, sorted tree nodes (owned by the parent's useFileTree). */
  nodes: FileNode[];
  /** Currently bound file path (highlighted). */
  selected: string | null;
  /** Open a file in the editor. */
  onSelect: (path: string) => void;
  /** Attribution origin for tree mutations (the local human). */
  origin: EditOrigin;
}

/** Depth (number of '/' separators) for indentation. */
function depthOf(path: string): number {
  let d = 0;
  for (const ch of path) if (ch === '/') d++;
  return d;
}

export function FileTree({
  connection,
  nodes,
  selected,
  onSelect,
  origin,
}: FileTreeProps): React.ReactElement {
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [importing, setImporting] = useState(false);
  const folderInput = useRef<HTMLInputElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);

  const fileCount = useMemo(() => nodes.filter((n) => n.kind === 'file').length, [nodes]);

  // Folders start collapsed; click one to reveal what is directly inside it.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  function toggleDir(path: string): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  }
  // Opening/creating a file somewhere deep reveals it by expanding only its parents.
  const skipReveal = useRef<string | null>(null); // set by imports so they stay collapsed
  useEffect(() => {
    const skip = skipReveal.current;
    skipReveal.current = null;
    if (!selected || skip === selected) return;
    const parents = ancestorDirs(selected);
    if (parents.length === 0) return;
    setExpanded((prev) => (parents.every((d) => prev.has(d)) ? prev : new Set([...prev, ...parents])));
  }, [selected]);
  // A node is shown only when every folder above it is expanded.
  const visibleNodes = useMemo(
    () => nodes.filter((n) => ancestorDirs(n.path).every((d) => expanded.has(d))),
    [nodes, expanded],
  );

  function applyImport(read: ReadResult): void {
    setError(null);
    setNotice(null);
    if (read.entries.length === 0) {
      setError(
        read.skipped > 0
          ? 'Nothing importable found (binary, very large, or build/dependency files are skipped).'
          : 'No files found to import.',
      );
      return;
    }
    let overwrite = false;
    const conflicts = findConflicts(connection.doc, read.entries);
    if (conflicts.length > 0) {
      overwrite = window.confirm(
        conflicts.length +
          ' file(s) already exist in this room (e.g. "' +
          conflicts[0] +
          '").\n\nOK = replace them with your imported versions\nCancel = keep the existing ones and import only new files',
      );
    }
    const sum = importEntries(connection.doc, read.entries, origin, overwrite);
    const n = sum.added + sum.replaced;
    const parts = ['Imported ' + n + (n === 1 ? ' file' : ' files')];
    if (sum.replaced) parts.push(sum.replaced + ' replaced');
    if (sum.skippedExisting) parts.push(sum.skippedExisting + ' kept as-is');
    if (read.skipped) parts.push(read.skipped + ' skipped');
    setNotice(parts.join(' \u00b7 '));
    if (sum.firstPath) {
      skipReveal.current = sum.firstPath;
      onSelect(sum.firstPath);
    }
  }

  async function handlePicked(files: FileList | null): Promise<void> {
    if (!files || files.length === 0) return;
    setImporting(true);
    try {
      applyImport(await readFileList(files));
    } catch {
      setError('Could not read those files.');
    } finally {
      setImporting(false);
    }
  }

  async function handleDrop(e: React.DragEvent): Promise<void> {
    e.preventDefault();
    setDragging(false);
    setImporting(true);
    try {
      applyImport(await readDataTransfer(e.dataTransfer));
    } catch {
      setError('Could not read the dropped items.');
    } finally {
      setImporting(false);
    }
  }

  function handleNew(): void {
    setError(null);
    const dir = selected ? dirname(selected) : '';
    const suggestion = dir ? `${dir}/` : '';
    const raw = window.prompt('New file path:', suggestion);
    if (raw === null) return; // cancelled
    const res = createFile(connection.doc, raw, origin);
    if (!res.ok) {
      setError(res.error ?? 'Could not create file.');
      return;
    }
    if (res.path) onSelect(res.path);
  }

  function handleRenameSubmit(fromPath: string, rawTo: string): void {
    setError(null);
    const res = renameFile(connection.doc, fromPath, rawTo, origin);
    if (!res.ok) {
      setError(res.error ?? 'Could not rename file.');
      return;
    }
    setRenaming(null);
    if (res.path) onSelect(res.path);
  }

  function handleDelete(path: string): void {
    setError(null);
    const ok = window.confirm(`Delete "${path}"? This removes it for everyone in the room.`);
    if (!ok) return;
    const { nextSelection } = deleteFile(connection.doc, path, origin);
    if (nextSelection) onSelect(nextSelection);
  }

  return (
    <div
      className={`relative flex h-full min-h-0 flex-col ${dragging ? 'bg-ember-900/40' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => void handleDrop(e)}
    >
      <input
        ref={folderInput}
        type="file"
        className="hidden"
        multiple
        {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
        onChange={(e) => {
          void handlePicked(e.target.files);
          e.target.value = '';
        }}
      />
      <input
        ref={filesInput}
        type="file"
        className="hidden"
        multiple
        onChange={(e) => {
          void handlePicked(e.target.files);
          e.target.value = '';
        }}
      />
      <div className="flex items-center justify-between px-3 pb-1 pt-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          Files
        </h2>
        <div className="flex items-center gap-0.5">
        <button
          type="button"
          onClick={() => folderInput.current?.click()}
          title="Import a folder from your computer"
          aria-label="Import folder"
          disabled={importing}
          className="flex h-6 w-6 items-center justify-center rounded text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-100 disabled:opacity-50"
        >
          <FolderUp size={14} aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => filesInput.current?.click()}
          title="Import files from your computer"
          aria-label="Import files"
          disabled={importing}
          className="flex h-6 w-6 items-center justify-center rounded text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-100 disabled:opacity-50"
        >
          <Upload size={14} aria-hidden />
        </button>
        <button
          type="button"
          onClick={handleNew}
          title="New file"
          className="flex h-6 w-6 items-center justify-center rounded text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-100"
        >
          <span className="text-base leading-none">＋</span>
        </button>
        </div>
      </div>

      {notice && (
        <p className="mx-3 mb-1 rounded bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-300">{notice}</p>
      )}
      {importing && <p className="mx-3 mb-1 text-[11px] text-slate-400">Importing...</p>}

      {error && (
        <p className="mx-3 mb-1 rounded bg-rose-500/10 px-2 py-1 text-[11px] text-rose-300">
          {error}
        </p>
      )}

      <ul className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {nodes.length === 0 && (
          <li className="px-2 py-4 text-center text-[11px] text-slate-500">No files yet. Drop a folder here to import it.</li>
        )}
        {visibleNodes.map((node) =>
          node.kind === 'dir' ? (
            <DirRow
              key={node.path}
              node={node}
              open={expanded.has(node.path)}
              onToggle={() => toggleDir(node.path)}
            />
          ) : renaming === node.path ? (
            <RenameRow
              key={node.path}
              node={node}
              onSubmit={(to) => handleRenameSubmit(node.path, to)}
              onCancel={() => setRenaming(null)}
            />
          ) : (
            <FileRow
              key={node.path}
              node={node}
              selected={node.path === selected}
              onOpen={() => onSelect(node.path)}
              onRename={() => {
                setError(null);
                setRenaming(node.path);
              }}
              onDelete={() => handleDelete(node.path)}
            />
          ),
        )}
      </ul>

      <div className="border-t border-slate-800/80 px-3 py-2 text-[11px] text-slate-500">
        {fileCount} {fileCount === 1 ? 'file' : 'files'}
      </div>
    </div>
  );
}

// ── Rows ──────────────────────────────────────────────────────────────────────

function DirRow({
  node,
  open,
  onToggle,
}: {
  node: FileNode;
  open: boolean;
  onToggle: () => void;
}): React.ReactElement {
  return (
    <li style={{ paddingLeft: `${depthOf(node.path) * 0.75}rem` }}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        title={node.path}
        className="flex w-full select-none items-center gap-1.5 truncate rounded px-2 py-1 text-left text-[13px] text-slate-300 transition-colors hover:bg-slate-800/70 hover:text-slate-100"
      >
        {open ? (
          <ChevronDown size={13} className="shrink-0 text-slate-500" aria-hidden />
        ) : (
          <ChevronRight size={13} className="shrink-0 text-slate-500" aria-hidden />
        )}
        {open ? (
          <FolderOpen size={14} className="shrink-0 text-amber-400/80" aria-hidden />
        ) : (
          <Folder size={14} className="shrink-0 text-amber-400/80" aria-hidden />
        )}
        <span className="truncate">{basename(node.path)}</span>
      </button>
    </li>
  );
}

interface FileRowProps {
  node: FileNode;
  selected: boolean;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
}

function FileRow({ node, selected, onOpen, onRename, onDelete }: FileRowProps): React.ReactElement {
  return (
    <li
      className="group/file relative"
      style={{ paddingLeft: `${depthOf(node.path) * 0.75}rem` }}
    >
      <button
        type="button"
        onClick={onOpen}
        title={node.path}
        className={`flex w-full items-center gap-1.5 truncate rounded px-2 py-1 text-left text-[13px] transition-colors ${
          selected
            ? 'bg-indigo-500/20 text-indigo-100'
            : 'text-slate-300 hover:bg-slate-800/70 hover:text-slate-100'
        }`}
      >
        <FileCode2 size={14} className="shrink-0 text-slate-400" aria-hidden />
        <span className="truncate">{basename(node.path)}</span>
      </button>
      <div className="absolute right-1 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 group-hover/file:flex">
        <button
          type="button"
          onClick={onRename}
          title="Rename"
          aria-label="Rename file"
          className="flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:bg-slate-700 hover:text-slate-100"
        >
          <Pencil size={12} aria-hidden />
        </button>
        <button
          type="button"
          onClick={onDelete}
          title="Delete"
          aria-label="Delete file"
          className="flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:bg-rose-600/80 hover:text-white"
        >
          <Trash2 size={12} aria-hidden />
        </button>
      </div>
    </li>
  );
}

interface RenameRowProps {
  node: FileNode;
  onSubmit: (to: string) => void;
  onCancel: () => void;
}

function RenameRow({ node, onSubmit, onCancel }: RenameRowProps): React.ReactElement {
  const [value, setValue] = useState(node.path);
  return (
    <li style={{ paddingLeft: `${depthOf(node.path) * 0.75}rem` }} className="px-1 py-0.5">
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSubmit(value);
          else if (e.key === 'Escape') onCancel();
        }}
        onBlur={onCancel}
        className="w-full rounded border border-indigo-500/60 bg-slate-900 px-2 py-1 text-[13px] text-slate-100 outline-none focus:border-indigo-400"
      />
    </li>
  );
}
