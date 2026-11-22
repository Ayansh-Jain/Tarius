/**
 * MCP server configuration parsing (v1.5 Slice C).
 *
 * Operators describe workspace MCP servers in ONE env var, `ICE_MCP_SERVERS`,
 * holding a JSON array of stdio specs. Everything here is defensive: a malformed
 * var, a missing field, or a bogus entry is dropped with a warning rather than
 * crashing the server — "robust + optional" is the whole point of the slice. If
 * the var is unset/empty the result is `[]` and the registry stays empty.
 *
 * Example (a search server + a GitHub server):
 *
 *   ICE_MCP_SERVERS='[
 *     { "name": "search", "command": "npx", "args": ["-y", "@org/search-mcp"] },
 *     { "name": "github", "command": "github-mcp", "env": { "GITHUB_TOKEN": "..." } }
 *   ]'
 *
 * Each entry is a stdio server (the only kind expressible as JSON — an in-memory
 * transport can't be serialised). Shape per entry:
 *   { name: string, command: string, args?: string[],
 *     env?: Record<string,string>, cwd?: string, timeoutMs?: number }
 */
import type { McpServerSpec } from './types.js';

/** Env var holding the JSON array of MCP server specs. */
export const MCP_SERVERS_ENV = 'ICE_MCP_SERVERS';

/** Minimal logger seam so callers (and tests) can capture warnings. */
export interface ConfigLogger {
  warn(message: string): void;
}

const consoleLogger: ConfigLogger = {
  // eslint-disable-next-line no-console
  warn: (m) => console.warn(m),
};

/**
 * Parse {@link MCP_SERVERS_ENV} into validated {@link McpServerSpec}s. Never
 * throws: a parse error returns `[]`; individual bad entries are skipped. Entry
 * names are deduped (first wins) so a typo'd duplicate can't shadow a good one.
 */
export function loadMcpServerSpecs(
  env: NodeJS.ProcessEnv = process.env,
  logger: ConfigLogger = consoleLogger,
): McpServerSpec[] {
  const raw = env[MCP_SERVERS_ENV]?.trim();
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn(
      `[ice:mcp] ${MCP_SERVERS_ENV} is not valid JSON — ignoring it. ` +
        `(${String((err as Error)?.message ?? err)})`,
    );
    return [];
  }

  if (!Array.isArray(parsed)) {
    logger.warn(
      `[ice:mcp] ${MCP_SERVERS_ENV} must be a JSON array of server specs — ignoring it.`,
    );
    return [];
  }

  const specs: McpServerSpec[] = [];
  const seen = new Set<string>();
  parsed.forEach((entry, i) => {
    const spec = parseEntry(entry, i, logger);
    if (!spec) return;
    if (seen.has(spec.name)) {
      logger.warn(
        `[ice:mcp] duplicate MCP server name '${spec.name}' at index ${i} — keeping the first.`,
      );
      return;
    }
    seen.add(spec.name);
    specs.push(spec);
  });
  return specs;
}

/** Validate one array entry into a stdio {@link McpServerSpec}, or null+warn. */
function parseEntry(
  entry: unknown,
  index: number,
  logger: ConfigLogger,
): McpServerSpec | null {
  if (typeof entry !== 'object' || entry === null) {
    logger.warn(`[ice:mcp] server spec at index ${index} is not an object — skipping.`);
    return null;
  }
  const obj = entry as Record<string, unknown>;

  const name = typeof obj.name === 'string' ? obj.name.trim() : '';
  if (!name) {
    logger.warn(`[ice:mcp] server spec at index ${index} is missing 'name' — skipping.`);
    return null;
  }

  const command = typeof obj.command === 'string' ? obj.command.trim() : '';
  if (!command) {
    logger.warn(
      `[ice:mcp] server '${name}' (index ${index}) is missing 'command' — skipping. ` +
        `Only stdio servers are configurable via ${MCP_SERVERS_ENV}.`,
    );
    return null;
  }

  const args = toStringArray(obj.args);
  const env = toStringRecord(obj.env);
  const cwd = typeof obj.cwd === 'string' && obj.cwd.trim() ? obj.cwd : undefined;
  const timeoutMs =
    typeof obj.timeoutMs === 'number' && Number.isFinite(obj.timeoutMs) && obj.timeoutMs > 0
      ? obj.timeoutMs
      : undefined;

  return {
    name,
    transport: { type: 'stdio', command, args, env, cwd },
    timeoutMs,
  };
}

/** Coerce to a string[] of non-empty strings; non-arrays / bad items → []. */
function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

/** Coerce to a Record<string,string>; drop non-string values. */
function toStringRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}
