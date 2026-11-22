/**
 * File-tree model for ICE v0.3 — the CRDT-backed multi-file surface.
 *
 * ADR-000 reminder: the Yjs doc is the single source of truth for open files.
 * Two top-level shared types cooperate (see @ice/shared `ydoc.ts`):
 *
 *   - `tree`  (getTree)  : path -> {@link FileNode}. The AUTHORITATIVE list of
 *                          what files/dirs exist in the room. Everyone reads it
 *                          to render the sidebar; we mutate it in transactions
 *                          so all participants converge.
 *   - `files` (getFiles) : path -> Y.Text. The editable buffers. A buffer is
 *                          created lazily the first time a file is opened/edited
 *                          (getFileText). The tree, not this map, is the source
 *                          of "which files exist" — an unopened file has a tree
 *                          entry but no Y.Text yet.
 *
 * Every mutation here flows through `transactWithOrigin` so the change is
 * attributable (and per-origin undoable) exactly like editor edits. We NEVER
 * mutate room state outside an origin-tagged transaction.
 *
 * This module is deliberately framework-free (no React, no DOM) so the tree
 * logic is unit-testable headlessly against a bare Y.Doc.
 */
import * as Y from 'yjs';
import type { EditOrigin, FileNode, FileNodeKind } from '@ice/shared';
import { getFiles, getTree, transactWithOrigin } from '@ice/shared';

/** The single file every room opens by default, so the v0.1 demo still works. */
export const DEFAULT_FILE = 'main.ts';

/** A short seed so a brand-new room shows something instead of a blank page. */
export const DEFAULT_FILE_SEED = `// Welcome to ICE — edit this together, live.
// Open this same /r/<room> URL in another browser to see remote cursors.

export function greet(name: string): string {
  return \`hello, \${name}!\`;
}

console.log(greet('world'));
`;

// ── Path helpers ────────────────────────────────────────────────────────────

/**
 * Normalize a user-entered path into a stable tree key: forward slashes, no
 * leading/trailing slash, no empty or '.'/'..' segments. Returns null when the
 * input can't be a legal file path (so callers can reject it in the UI).
 */
export function normalizePath(raw: string): string | null {
  const segments = raw
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (segments.length === 0) return null;
  for (const seg of segments) {
    if (seg === '.' || seg === '..') return null;
  }
  return segments.join('/');
}

/** The display name (last path segment) for a node. */
export function basename(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

/** The parent directory path of `path`, or '' for a root-level entry. */
export function dirname(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

/** All ancestor directory paths of `path`, outermost first (excludes `path`). */
export function ancestorDirs(path: string): string[] {
  const parts = path.split('/');
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    out.push(parts.slice(0, i).join('/'));
  }
  return out;
}

// ── Reading the tree ─────────────────────────────────────────────────────────

/**
 * Snapshot the tree as a sorted {@link FileNode} list (dirs before files within
 * a directory, then alphabetical) — ready for the sidebar to render. Entries
 * are validated defensively so a malformed peer write can't crash the UI.
 */
export function listNodes(doc: Y.Doc): FileNode[] {
  const tree = getTree(doc);
  const nodes: FileNode[] = [];
  tree.forEach((value, key) => {
    const node = coerceNode(key, value);
    if (node) nodes.push(node);
  });
  nodes.sort(compareNodes);
  return nodes;
}

/** Validate/normalize a raw tree value into a {@link FileNode}. */
function coerceNode(path: string, value: unknown): FileNode | null {
  if (typeof path !== 'string' || path.length === 0) return null;
  const kind = (value as { kind?: unknown } | null)?.kind;
  if (kind !== 'file' && kind !== 'dir') return null;
  return { path, kind };
}

/** Sort: shallower paths first by segment, dirs before files, then by name. */
function compareNodes(a: FileNode, b: FileNode): number {
  const as = a.path.split('/');
  const bs = b.path.split('/');
  const n = Math.min(as.length, bs.length);
  for (let i = 0; i < n; i++) {
    const ai = as[i]!;
    const bi = bs[i]!;
    // When at the final segment of one path, a dir component outranks a leaf.
    const aIsDirHere = i < as.length - 1 || a.kind === 'dir';
    const bIsDirHere = i < bs.length - 1 || b.kind === 'dir';
    if (aIsDirHere !== bIsDirHere) return aIsDirHere ? -1 : 1;
    const cmp = ai.localeCompare(bi);
    if (cmp !== 0) return cmp;
  }
  return as.length - bs.length;
}

/** Just the file paths (kind === 'file'), sorted — handy for selection logic. */
export function listFilePaths(doc: Y.Doc): string[] {
  return listNodes(doc)
    .filter((n) => n.kind === 'file')
    .map((n) => n.path);
}

/** Does a node exist at this exact path? */
export function nodeExists(doc: Y.Doc, path: string): boolean {
  return getTree(doc).has(path);
}

// ── Mutations (always origin-tagged transactions) ─────────────────────────────

/** Ensure every ancestor directory of `path` has a 'dir' node in the tree. */
function ensureParentDirs(tree: Y.Map<unknown>, path: string): void {
  for (const dir of ancestorDirs(path)) {
    if (!tree.has(dir)) {
      const node: FileNode = { path: dir, kind: 'dir' };
      tree.set(dir, node);
    }
  }
}

/**
 * Seed a fresh room: if the tree has no files yet, create {@link DEFAULT_FILE}
 * with the welcome buffer. Idempotent and race-safe (re-checks inside the
 * transaction), so every client can call it on mount and only the first wins.
 * Uses a 'system' origin — this is structural setup, not a human edit.
 */
export function ensureSeeded(doc: Y.Doc): void {
  const origin: EditOrigin = { kind: 'system' };
  transactWithOrigin(doc, origin, () => {
    const tree = getTree(doc);
    // Re-check inside the txn so two clients racing the first mount converge.
    const hasAnyFile = anyFile(tree);
    if (hasAnyFile) return;
    tree.set(DEFAULT_FILE, { path: DEFAULT_FILE, kind: 'file' } satisfies FileNode);
    const files = getFiles(doc);
    let text = files.get(DEFAULT_FILE);
    if (!text) {
      text = new Y.Text();
      files.set(DEFAULT_FILE, text);
    }
    if (text.length === 0) text.insert(0, DEFAULT_FILE_SEED);
  });
}

function anyFile(tree: Y.Map<unknown>): boolean {
  let found = false;
  tree.forEach((value) => {
    if (!found && (value as { kind?: unknown } | null)?.kind === 'file') found = true;
  });
  return found;
}

export interface CreateResult {
  ok: boolean;
  /** Normalized path on success; reason on failure. */
  path?: string;
  error?: string;
}

/**
 * Create a new empty file (and any missing parent dirs) in the shared tree.
 * The Y.Text buffer is created eagerly so the file is immediately editable.
 */
export function createFile(doc: Y.Doc, rawPath: string, origin: EditOrigin): CreateResult {
  const path = normalizePath(rawPath);
  if (!path) return { ok: false, error: 'Enter a valid file name.' };
  if (nodeExists(doc, path)) return { ok: false, error: `"${path}" already exists.` };

  transactWithOrigin(doc, origin, () => {
    const tree = getTree(doc);
    ensureParentDirs(tree, path);
    tree.set(path, { path, kind: 'file' } satisfies FileNode);
    const files = getFiles(doc);
    if (!files.get(path)) files.set(path, new Y.Text());
  });
  return { ok: true, path };
}

/**
 * Rename/move a file. Moves the tree node AND the Y.Text buffer (preserving
 * content + edit history) to the new key, creating parent dirs as needed.
 * Only files are renamable here (dir rename is out of scope for this slice).
 */
export function renameFile(
  doc: Y.Doc,
  fromPath: string,
  rawToPath: string,
  origin: EditOrigin,
): CreateResult {
  const to = normalizePath(rawToPath);
  if (!to) return { ok: false, error: 'Enter a valid file name.' };
  if (to === fromPath) return { ok: true, path: fromPath };

  const tree = getTree(doc);
  const existing = coerceNode(fromPath, tree.get(fromPath));
  if (!existing || existing.kind !== 'file') {
    return { ok: false, error: 'Can only rename a file.' };
  }
  if (tree.has(to)) return { ok: false, error: `"${to}" already exists.` };

  transactWithOrigin(doc, origin, () => {
    ensureParentDirs(tree, to);
    tree.delete(fromPath);
    tree.set(to, { path: to, kind: 'file' } satisfies FileNode);

    // Move the buffer content to the new key. Y.Text instances can't be shared
    // across two keys, so we copy the string into a fresh Y.Text at `to`.
    const files = getFiles(doc);
    const old = files.get(fromPath);
    const content = old ? old.toString() : '';
    files.delete(fromPath);
    const next = new Y.Text();
    if (content.length > 0) next.insert(0, content);
    files.set(to, next);
  });
  return { ok: true, path: to };
}

/**
 * Delete a file from the tree and drop its buffer. Returns the path that
 * callers should select next (a sibling/remaining file), or null if the room
 * is now empty.
 */
export function deleteFile(doc: Y.Doc, path: string, origin: EditOrigin): { nextSelection: string | null } {
  const tree = getTree(doc);
  const node = coerceNode(path, tree.get(path));
  if (!node || node.kind !== 'file') {
    // Nothing to delete; pick any remaining file for selection.
    return { nextSelection: firstFilePath(doc) };
  }

  // Compute the next selection BEFORE mutating (from the current ordering).
  const files = listFilePaths(doc);
  const idx = files.indexOf(path);
  const remaining = files.filter((p) => p !== path);
  let nextSelection: string | null = null;
  if (remaining.length > 0) {
    // Prefer the next file after the deleted one; else the previous.
    nextSelection = remaining[Math.min(idx, remaining.length - 1)] ?? remaining[0]!;
  }

  transactWithOrigin(doc, origin, () => {
    tree.delete(path);
    getFiles(doc).delete(path);
  });
  return { nextSelection };
}

/** First file path in sorted order, or null when the room has no files. */
export function firstFilePath(doc: Y.Doc): string | null {
  const files = listFilePaths(doc);
  return files[0] ?? null;
}

/**
 * Resolve which file the editor should bind to, given a desired selection.
 * Falls back to {@link DEFAULT_FILE} if present, else the first file, else null
 * (empty room). This keeps the editor pointed at a real buffer at all times.
 */
export function resolveSelection(doc: Y.Doc, desired: string | null): string | null {
  if (desired && nodeExists(doc, desired)) {
    const node = coerceNode(desired, getTree(doc).get(desired));
    if (node?.kind === 'file') return desired;
  }
  if (nodeExists(doc, DEFAULT_FILE)) return DEFAULT_FILE;
  return firstFilePath(doc);
}

/** Icon hint for a file path, used by the sidebar. Pure string → emoji. */
export function fileGlyph(path: string, kind: FileNodeKind): string {
  if (kind === 'dir') return '📁';
  const name = basename(path).toLowerCase();
  if (name.endsWith('.ts') || name.endsWith('.tsx')) return '🟦';
  if (name.endsWith('.js') || name.endsWith('.jsx') || name.endsWith('.mjs')) return '🟨';
  if (name.endsWith('.json')) return '🟧';
  if (name.endsWith('.md')) return '📝';
  if (name.endsWith('.css')) return '🎨';
  if (name.endsWith('.html')) return '🌐';
  return '📄';
}
