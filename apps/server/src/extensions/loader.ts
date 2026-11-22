/**
 * Community extension loader (v2.0 Slice C).
 *
 * Discovers community extension manifests (see {@link ExtensionManifest}) from
 * one or more locations named by the `ICE_EXTENSIONS` env var, validates their
 * shape, and exposes them as a small {@link ExtensionLoader} the MCP palette and
 * agent registry can consume.
 *
 * `ICE_EXTENSIONS` is a {@link path.delimiter}-separated list (`:` on POSIX,
 * `;` on Windows) of entries; each entry is either:
 *   - a DIRECTORY  → every `*.json` file directly inside it is a manifest, or
 *   - a FILE       → that single `*.json` file is a manifest.
 *
 * Example:
 *   ICE_EXTENSIONS=/etc/ice/extensions:/opt/ice/extra/reviewer.json
 *
 * Everything is defensive and optional — this is the whole point of the slice:
 *   - var unset/empty                 → loader is empty, ICE runs unchanged.
 *   - a path that doesn't exist        → warned + skipped.
 *   - a file that isn't valid JSON     → warned + skipped.
 *   - a manifest missing a field, with
 *     a bad `kind`, or a `spec` that
 *     doesn't match its `kind`         → warned + skipped.
 *   - two manifests with the same `id` → first wins (by sorted path), warned.
 * A single bad manifest never prevents the good ones from loading, and the
 * loader NEVER throws.
 *
 * Loading is a one-shot snapshot at construction time (matching how the operator
 * configures MCP servers once at boot). Call {@link loadExtensions} again to
 * re-scan.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { delimiter as PATH_DELIMITER, join, resolve } from 'node:path';
import type {
  AgentExtensionSpec,
  ExtensionKind,
  ExtensionLoader,
  ExtensionManifest,
  LoadedAgentExtension,
  LoadedExtension,
  LoadedMcpExtension,
  McpExtensionSpec,
} from './types.js';

/** Env var naming where community extension manifests live. */
export const EXTENSIONS_ENV = 'ICE_EXTENSIONS';

/** Minimal logger seam so callers (and tests) can capture warnings. */
export interface ExtensionLogger {
  warn(message: string): void;
}

const consoleLogger: ExtensionLogger = {
  // eslint-disable-next-line no-console
  warn: (m) => console.warn(m),
};

/** The two kinds we accept, for validation messages + membership checks. */
const KINDS: readonly ExtensionKind[] = ['mcp', 'agent'];

/**
 * Build an {@link ExtensionLoader} by scanning {@link EXTENSIONS_ENV}. Never
 * throws; returns an empty loader when nothing is configured or everything is
 * malformed. The returned loader holds an immutable snapshot.
 */
export function loadExtensions(
  env: NodeJS.ProcessEnv = process.env,
  logger: ExtensionLogger = consoleLogger,
): ExtensionLoader {
  const loaded = scan(env, logger);
  return makeLoader(loaded);
}

/** Wrap an already-resolved list as an {@link ExtensionLoader} (tests/driver). */
export function makeExtensionLoader(loaded: LoadedExtension[]): ExtensionLoader {
  // Defensive copy + stable order so callers can't mutate our snapshot.
  return makeLoader([...loaded].sort(byId));
}

/** Scan the configured paths into a deduped, sorted list of loaded extensions. */
function scan(env: NodeJS.ProcessEnv, logger: ExtensionLogger): LoadedExtension[] {
  const raw = env[EXTENSIONS_ENV]?.trim();
  if (!raw) return [];

  const entries = raw
    .split(PATH_DELIMITER)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  // Collect candidate manifest files (absolute paths), in a stable order.
  const files = new Set<string>();
  for (const entry of entries) {
    const abs = resolve(entry);
    let st;
    try {
      st = statSync(abs);
    } catch {
      logger.warn(`[ice:ext] ${EXTENSIONS_ENV} path does not exist — skipping: ${abs}`);
      continue;
    }
    if (st.isDirectory()) {
      for (const f of listJsonFiles(abs, logger)) files.add(f);
    } else if (st.isFile()) {
      if (isJson(abs)) files.add(abs);
      else logger.warn(`[ice:ext] not a .json manifest — skipping: ${abs}`);
    }
  }

  const sortedFiles = [...files].sort();
  const out: LoadedExtension[] = [];
  const seen = new Set<string>();
  for (const file of sortedFiles) {
    const manifest = readManifest(file, logger);
    if (!manifest) continue;
    if (seen.has(manifest.id)) {
      logger.warn(
        `[ice:ext] duplicate extension id '${manifest.id}' in ${file} — keeping the first.`,
      );
      continue;
    }
    seen.add(manifest.id);
    out.push({ manifest, sourcePath: file });
  }
  return out.sort(byId);
}

/** List `*.json` files directly inside a directory (non-recursive). */
function listJsonFiles(dir: string, logger: ExtensionLogger): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    logger.warn(
      `[ice:ext] could not read extensions directory ${dir} — skipping. ` +
        `(${String((err as Error)?.message ?? err)})`,
    );
    return [];
  }
  const files: string[] = [];
  for (const name of names) {
    if (!isJson(name)) continue;
    const full = join(dir, name);
    try {
      if (statSync(full).isFile()) files.push(full);
    } catch {
      // Raced/removed between readdir and stat — ignore.
    }
  }
  return files;
}

/** Read + parse + validate one manifest file. Null (with a warning) on any fault. */
function readManifest(
  file: string,
  logger: ExtensionLogger,
): LoadedMcpExtension | LoadedAgentExtension | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    logger.warn(
      `[ice:ext] could not read manifest ${file} — skipping. ` +
        `(${String((err as Error)?.message ?? err)})`,
    );
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    logger.warn(
      `[ice:ext] manifest ${file} is not valid JSON — skipping. ` +
        `(${String((err as Error)?.message ?? err)})`,
    );
    return null;
  }

  return validateManifest(parsed, file, logger);
}

/**
 * Validate an arbitrary parsed value into a narrowed extension, or null+warn.
 * Exported for unit tests that want to validate without touching the disk.
 */
export function validateManifest(
  value: unknown,
  source: string,
  logger: ExtensionLogger,
): LoadedMcpExtension | LoadedAgentExtension | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    logger.warn(`[ice:ext] manifest ${source} is not a JSON object — skipping.`);
    return null;
  }
  const obj = value as Record<string, unknown>;

  const id = str(obj.id);
  if (!id) {
    logger.warn(`[ice:ext] manifest ${source} is missing a string 'id' — skipping.`);
    return null;
  }

  const kind = str(obj.kind);
  if (!kind || !KINDS.includes(kind as ExtensionKind)) {
    logger.warn(
      `[ice:ext] manifest '${id}' (${source}) has invalid 'kind' ` +
        `(${kind ? `'${kind}'` : 'missing'}) — must be ${KINDS.map((k) => `'${k}'`).join(' or ')}. Skipping.`,
    );
    return null;
  }

  const name = str(obj.name);
  if (!name) {
    logger.warn(`[ice:ext] extension '${id}' (${source}) is missing a string 'name' — skipping.`);
    return null;
  }

  if (typeof obj.spec !== 'object' || obj.spec === null || Array.isArray(obj.spec)) {
    logger.warn(`[ice:ext] extension '${id}' (${source}) is missing an object 'spec' — skipping.`);
    return null;
  }
  const specObj = obj.spec as Record<string, unknown>;

  const base: Pick<ExtensionManifest, 'id' | 'name' | 'description' | 'version' | 'homepage'> = {
    id,
    name,
    description: str(obj.description) || undefined,
    version: str(obj.version) || undefined,
    homepage: str(obj.homepage) || undefined,
  };

  if (kind === 'mcp') {
    const spec = validateMcpSpec(specObj, id, source, logger);
    if (!spec) return null;
    return { ...base, kind: 'mcp', spec };
  }

  const agentSpec = validateAgentSpec(specObj, id, source, logger);
  if (!agentSpec) return null;
  return { ...base, kind: 'agent', spec: agentSpec };
}

/** Validate the `spec` of a kind:'mcp' manifest. */
function validateMcpSpec(
  obj: Record<string, unknown>,
  id: string,
  source: string,
  logger: ExtensionLogger,
): McpExtensionSpec | null {
  const command = str(obj.command);
  if (!command) {
    logger.warn(
      `[ice:ext] mcp extension '${id}' (${source}) spec is missing 'command' — skipping. ` +
        `Only stdio MCP servers are expressible in a manifest.`,
    );
    return null;
  }
  const args = strArray(obj.args);
  const envRec = strRecord(obj.env);
  const cwd = str(obj.cwd) || undefined;
  const timeoutMs = positiveNumber(obj.timeoutMs);
  return {
    command,
    ...(args.length ? { args } : {}),
    ...(envRec ? { env: envRec } : {}),
    ...(cwd ? { cwd } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

/** Validate the `spec` of a kind:'agent' manifest. */
function validateAgentSpec(
  obj: Record<string, unknown>,
  id: string,
  source: string,
  logger: ExtensionLogger,
): AgentExtensionSpec | null {
  const backend = str(obj.backend);
  if (!backend) {
    logger.warn(
      `[ice:ext] agent extension '${id}' (${source}) spec is missing 'backend' — skipping.`,
    );
    return null;
  }
  const model = str(obj.model) || undefined;
  const systemPrompt = str(obj.systemPrompt) || undefined;
  return {
    backend,
    ...(model ? { model } : {}),
    ...(systemPrompt ? { systemPrompt } : {}),
  };
}

/** Assemble the {@link ExtensionLoader} surface over a fixed list. */
function makeLoader(loaded: LoadedExtension[]): ExtensionLoader {
  const byKind = (kind: ExtensionKind): LoadedExtension[] =>
    loaded.filter((e) => e.manifest.kind === kind);
  return {
    list: () => [...loaded],
    listByKind: ((kind: ExtensionKind) => byKind(kind)) as ExtensionLoader['listByKind'],
    get: (id: string) => loaded.find((e) => e.manifest.id === id),
  };
}

// ── tiny coercion helpers (mirror apps/server/src/mcp/config.ts) ───────────────

/** A trimmed non-empty string, or ''. */
function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** A string[] of non-empty strings; non-arrays / bad items dropped. */
function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

/** A Record<string,string> dropping non-string values; undefined when empty. */
function strRecord(v: unknown): Record<string, string> | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string') out[k] = val;
  }
  return Object.keys(out).length ? out : undefined;
}

/** A finite positive number, or undefined. */
function positiveNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

/** Stable order by id (so listings are deterministic). */
function byId(a: LoadedExtension, b: LoadedExtension): number {
  return a.manifest.id < b.manifest.id ? -1 : a.manifest.id > b.manifest.id ? 1 : 0;
}

/** True for a path whose name ends in `.json` (case-insensitive). */
function isJson(path: string): boolean {
  return path.toLowerCase().endsWith('.json');
}
