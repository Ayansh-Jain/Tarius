/**
 * MCP tool palette — public API (v1.5 Slice C).
 *
 * Workspace-scoped MCP (Model Context Protocol) servers, surfaced to the squad of
 * agents as one namespaced tool palette. The driver wires this at boot:
 *
 *   1. const specs = loadMcpServerSpecs();              // from ICE_MCP_SERVERS
 *   2. const registry = new McpRegistry();
 *      await registry.connectAll(specs);                // failures isolated
 *   3. inject `registry` into the agent host as an McpToolProvider
 *      (or EMPTY_MCP_PROVIDER when there are no servers — the host always gets
 *      a provider, never undefined).
 *   4. app.route('/', makeMcpRoutes({ provider: registry, connections: registry }))
 *
 * Everything is optional + robust: no configured servers → empty palette, system
 * works unchanged; one bad server → isolated failure, the rest keep working.
 *
 * The agent host depends ONLY on {@link McpToolProvider} (injected), never on the
 * registry or the MCP SDK — keeping the host free of any MCP dependency.
 */

// ── The registry (concrete McpToolProvider) ──────────────────────────────────
export { McpRegistry, TOOL_NAMESPACE_SEP } from './registry.js';
export type {
  McpConnectResult,
  McpConnectionStatus,
  RegistryLogger,
} from './registry.js';

// ── Config (env → specs) ──────────────────────────────────────────────────────
export { loadMcpServerSpecs, MCP_SERVERS_ENV } from './config.js';
export type { ConfigLogger } from './config.js';

// ── Routes (GET /api/rooms/:id/mcp/tools) ─────────────────────────────────────
export { makeMcpRoutes } from './routes.js';
export type { McpRoutesDeps, McpConnectionLister } from './routes.js';

// ── Contracts (injected into the agent host; shared with the driver/tests) ────
export {
  EMPTY_MCP_PROVIDER,
  DEFAULT_MCP_TIMEOUT_MS,
} from './types.js';
export type {
  McpToolProvider,
  McpServerSpec,
  McpTransportSpec,
  McpCallResult,
  ResolvedMcpTool,
} from './types.js';
