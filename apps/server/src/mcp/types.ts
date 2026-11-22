/**
 * MCP tool palette — internal contracts (v1.5 Slice C).
 *
 * Workspace-scoped MCP (Model Context Protocol) servers let operators plug
 * external toolboxes — a GitHub server, a database server, a search server — into
 * a room, and surface their tools to the squad of agents. Every such tool stays
 * behind the SAME guard rails as a native tool: the per-agent {@link AgentPolicy}
 * decides whether the agent may call it, and destructive calls still pass the
 * human approval gate. The registry here is JUST the connection + tool surface;
 * it never decides policy and never touches the Yjs doc.
 *
 * These are the seams that keep this module decoupled:
 *   - {@link McpServerSpec}     — how an operator describes one server (env/JSON).
 *   - {@link McpToolProvider}   — the narrow read/call surface the agent host
 *                                 consumes (the host imports THIS, not the SDK).
 *   - {@link McpCallResult}     — the SDK result, normalised to a plain object.
 *
 * The agent host receives an {@link McpToolProvider} by injection (the driver
 * builds the concrete {@link McpRegistry} at boot and hands it in). That keeps
 * the host free of any MCP/SDK dependency and lets CI run with an empty provider.
 */
import type { McpTool } from '@ice/shared';

/**
 * Transport for an MCP server. Two shapes ICE supports out of the box:
 *
 *   - `stdio`: spawn a child process and speak MCP over its stdin/stdout. This is
 *     how the vast majority of community MCP servers ship (`npx`-style binaries).
 *   - `inMemory`: an already-constructed in-process transport. Used by tests and
 *     by callers that embed a server in the same process; never produced by env
 *     config (you can't serialise a live transport into JSON).
 */
export type McpTransportSpec =
  | {
      type: 'stdio';
      /** Executable to spawn (e.g. 'npx', '/usr/local/bin/my-mcp'). */
      command: string;
      /** Arguments passed to the executable. */
      args?: string[];
      /** Extra env for the child; merged over the parent process env. */
      env?: Record<string, string>;
      /** Working directory for the child process. */
      cwd?: string;
    }
  | {
      type: 'inMemory';
      /**
       * A live client-side transport already linked to a server. Opaque here to
       * avoid importing the SDK transport type into the shared surface; the
       * registry passes it straight to `Client.connect`.
       */
      transport: unknown;
    };

/**
 * How an operator describes ONE MCP server. The `name` namespaces every tool the
 * server exposes (a tool `search` on server `web` is surfaced as `web/search`) so
 * two servers can't collide and a tool's origin is always legible.
 */
export interface McpServerSpec {
  /** Stable, unique handle for this server within the workspace. */
  name: string;
  /** How to reach it. */
  transport: McpTransportSpec;
  /**
   * Per-connect timeout (ms) for the initialize handshake and each tool call.
   * Defaults to {@link DEFAULT_MCP_TIMEOUT_MS}. A slow/hung server must not wedge
   * the room — the connect attempt is bounded and isolated.
   */
  timeoutMs?: number;
}

/** Default handshake / call timeout. Generous enough for a cold `npx` spawn. */
export const DEFAULT_MCP_TIMEOUT_MS = 30_000;

/**
 * A tool surfaced to agents, with its originating server attached. Extends the
 * shared {@link McpTool} (name/description/inputSchema/server) — `name` is the
 * namespaced id (`<server>/<tool>`) so it round-trips through callTool unchanged.
 */
export interface ResolvedMcpTool extends McpTool {
  /** Always set here (the shared type leaves it optional). */
  server: string;
}

/**
 * Normalised result of an MCP tool call. The SDK returns a rich, schema-heavy
 * union; the agent host only needs: did it error, the content blocks, and any
 * structured payload. We keep `content` as-is (the SDK's content block array)
 * and pass through `structuredContent` so callers can use either.
 */
export interface McpCallResult {
  /** True when the server reported a tool-level error (isError). */
  isError: boolean;
  /** The MCP content blocks (text/image/resource/…), verbatim from the server. */
  content: unknown[];
  /** Structured payload if the tool declared an output schema. */
  structuredContent?: Record<string, unknown>;
}

/**
 * The narrow surface the agent host (Slice A) consumes — injected by the driver.
 *
 * THE host imports this interface, never the registry or the MCP SDK, so the
 * agent host has zero MCP dependency and CI runs fine with an empty provider
 * (e.g. {@link EMPTY_MCP_PROVIDER}). A real provider is the {@link McpRegistry}.
 *
 *   listTools()        — every connected server's tools, namespaced + deduped.
 *   hasTool(name)      — cheap membership check for the policy/offer layer.
 *   callTool(name,args)— invoke `<server>/<tool>`; routes to the right client.
 *
 * `callTool` performs NO policy/approval — that is the host's job. It only fails
 * if the tool is unknown or its server is down, and surfaces tool-level errors
 * via {@link McpCallResult.isError} rather than throwing.
 */
export interface McpToolProvider {
  /** All tools across all connected servers (namespaced `<server>/<tool>`). */
  listTools(): ResolvedMcpTool[];
  /** Whether a namespaced tool name is currently offered. */
  hasTool(name: string): boolean;
  /** Call a namespaced tool. Throws only for unknown tool / transport failure. */
  callTool(name: string, args?: Record<string, unknown>): Promise<McpCallResult>;
}

/**
 * A no-op provider: zero tools, every call rejects as "unknown tool". The driver
 * injects this when no MCP servers are configured so the agent host can always
 * depend on a provider being present (never `undefined`).
 */
export const EMPTY_MCP_PROVIDER: McpToolProvider = {
  listTools: () => [],
  hasTool: () => false,
  callTool: (name) => {
    throw new Error(`unknown MCP tool '${name}' (no MCP servers configured)`);
  },
};
