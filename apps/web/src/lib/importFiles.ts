/**
 * Import existing files/folders from the user's machine into the room.
 *
 * Browser-only reading (file picker, folder picker, drag-and-drop) produces a
 * list of {path, content}; `importEntries` then writes them into the shared
 * Yjs tree in one origin-tagged transaction so every participant sees them.
 */
import * as Y from 'yjs';
import type { EditOrigin, FileNode } from '@ice/shared';
import { getFiles, getTree, transactWithOrigin } from '@ice/shared';
import { ancestorDirs, normalizePath } from './tree.js';

export const MAX_FILES = 500;
export const MAX_FILE_BYTES = 1_000_000;
export const MAX_TOTAL_BYTES = 8_000_000;

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', '.next', '.turbo', '.cache',
  '__pycache__', '.venv', 'venv', '.idea', '.vscode', 'target', 'coverage', '.gradle',
]);
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db']);
const BINARY_EXT =
  /\.(png|jpe?g|gif|bmp|ico|webp|avif|svgz|pdf|zip|gz|tgz|rar|7z|tar|jar|war|class|exe|dll|so|dylib|o|obj|a|lib|bin|dat|db|sqlite3?|woff2?|ttf|otf|eot|mp[34]|wav|ogg|mov|avi|webm|pyc|pyo|iso|dmg|psd)$/i;

export interface ImportEntry {
  path: string;
  content: string;
}

export interface ReadResult {
  entries: ImportEntry[];
  skipped: number;
}

function shouldSkipPath(path: string): boolean {
  const parts = path.split('/');
  if (parts.slice(0, -1).some((p) => SKIP_DIRS.has(p))) return true;
  const name = parts[parts.length - 1] ?? '';
  return SKIP_FILES.has(name) || BINARY_EXT.test(name);
}

async function readOne(file: File, path: string, acc: ReadResult, state: { total: number }): Promise<void> {
  const norm = normalizePath(path);
  if (!norm || shouldSkipPath(norm) || file.size > MAX_FILE_BYTES) {
    acc.skipped++;
    return;
  }
  if (acc.entries.length >= MAX_FILES || state.total + file.size > MAX_TOTAL_BYTES) {
    acc.skipped++;
    return;
  }
  const content = await file.text();
  if (content.includes(String.fromCharCode(0))) {
    acc.skipped++;
    return;
  }
  state.total += file.size;
  acc.entries.push({ path: norm, content });
}

/** From an <input type=file> (single files, or a directory via webkitdirectory). */
export async function readFileList(files: FileList): Promise<ReadResult> {
  const acc: ReadResult = { entries: [], skipped: 0 };
  const state = { total: 0 };
  for (const f of Array.from(files)) {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath;
    await readOne(f, rel && rel.length > 0 ? rel : f.name, acc, state);
  }
  return acc;
}

interface FsEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (ok: (f: File) => void, err: (e: unknown) => void) => void;
  createReader?: () => { readEntries: (ok: (e: FsEntry[]) => void, err: (e: unknown) => void) => void };
}

async function walk(entry: FsEntry, prefix: string, acc: ReadResult, state: { total: number }): Promise<void> {
  const here = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile && entry.file) {
    const file = await new Promise<File>((ok, err) => entry.file!(ok, err));
    await readOne(file, here, acc, state);
  } else if (entry.isDirectory && entry.createReader) {
    if (SKIP_DIRS.has(entry.name)) {
      acc.skipped++;
      return;
    }
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise<FsEntry[]>((ok, err) => reader.readEntries(ok, err));
      if (batch.length === 0) break;
      for (const child of batch) await walk(child, here, acc, state);
    }
  }
}

/** From a drag-and-drop event (supports dropping whole folders). */
export async function readDataTransfer(dt: DataTransfer): Promise<ReadResult> {
  const acc: ReadResult = { entries: [], skipped: 0 };
  const state = { total: 0 };
  const roots: FsEntry[] = [];
  for (const item of Array.from(dt.items)) {
    const e = (item as DataTransferItem & { webkitGetAsEntry?: () => FsEntry | null }).webkitGetAsEntry?.();
    if (e) roots.push(e);
  }
  for (const r of roots) await walk(r, '', acc, state);
  return acc;
}

export interface ImportSummary {
  added: number;
  replaced: number;
  skippedExisting: number;
  firstPath: string | null;
}

/** Which of these entries would collide with files already in the room? */
export function findConflicts(doc: Y.Doc, entries: ImportEntry[]): string[] {
  const tree = getTree(doc);
  return entries.filter((e) => tree.has(e.path)).map((e) => e.path);
}

export function importEntries(
  doc: Y.Doc,
  entries: ImportEntry[],
  origin: EditOrigin,
  overwrite: boolean,
): ImportSummary {
  const summary: ImportSummary = { added: 0, replaced: 0, skippedExisting: 0, firstPath: null };
  transactWithOrigin(doc, origin, () => {
    const tree = getTree(doc);
    const files = getFiles(doc);
    for (const { path, content } of entries) {
      const exists = tree.has(path);
      if (exists && !overwrite) {
        summary.skippedExisting++;
        continue;
      }
      for (const dir of ancestorDirs(path)) {
        if (!tree.has(dir)) tree.set(dir, { path: dir, kind: 'dir' } satisfies FileNode);
      }
      tree.set(path, { path, kind: 'file' } satisfies FileNode);
      const text = new Y.Text();
      if (content.length > 0) text.insert(0, content);
      files.set(path, text);
      if (exists) summary.replaced++;
      else summary.added++;
      if (!summary.firstPath) summary.firstPath = path;
    }
  });
  return summary;
}
