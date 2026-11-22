/**
 * Room workspace materialisation.
 *
 * Room files live ONLY in the shared Yjs doc (`files` map: path -> Y.Text), so a
 * shell spawned in the server's cwd can't see them — `python main.py` or
 * `node index.js` fail with "can't open file". Before a terminal command runs we
 * write the room's files to a real per-room directory and use it as the shell's
 * cwd. The doc stays the source of truth; the directory is a disposable mirror
 * (tool output such as node_modules / venvs persists there between commands).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type * as Y from 'yjs';

/** Root dir for all room workspaces (override with ICE_WORKSPACE_ROOT). */
export function workspaceRoot(): string {
  return path.resolve(process.env.ICE_WORKSPACE_ROOT ?? path.join(process.cwd(), 'data', 'workspaces'));
}

/** Per-room workspace directory; the room id is reduced to a safe folder name. */
export function roomWorkspaceDir(roomId: string): string {
  const safe = roomId.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_') || '_';
  return path.join(workspaceRoot(), safe);
}

/**
 * Write every file in the room doc into `dir`. Skips paths that would escape
 * `dir` and files whose on-disk content already matches. Returns the number of
 * files written. Never throws for an individual bad file.
 */
export function materializeRoomFiles(doc: Y.Doc, dir: string): number {
  mkdirSync(dir, { recursive: true });
  const files = doc.getMap<Y.Text>('files');
  const root = path.resolve(dir);
  let written = 0;
  files.forEach((text, rel) => {
    try {
      const clean = rel.replace(/^[\\/]+/, '');
      if (!clean) return;
      const target = path.resolve(root, clean);
      if (target !== root && !target.startsWith(root + path.sep)) return; // path traversal
      const content = text.toString();
      try {
        if (readFileSync(target, 'utf8') === content) return;
      } catch {
        /* not there yet */
      }
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content, 'utf8');
      written++;
    } catch {
      /* skip unwritable file */
    }
  });
  return written;
}
