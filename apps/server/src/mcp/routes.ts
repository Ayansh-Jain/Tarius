/**
 * MCP tool palette — HTTP surface (v1.5 Slice C).
 *
 * A tiny, self-contained Hono sub-app the driver mounts onto the main API. It
 * exposes the workspace tool palette read-only so the web client (and humans
 * debugging a room) can see which MCP tools the squad has available:
 *
 *   GET /api/rooms/:roomId/mcp/tools  → { tools: McpTool[], servers: [...] }
 *
 * MCP servers are workspace-scoped (one palette per server process), so today
 * the palette is the same for every room; `:roomId` is kept in the path so the
 * surface can become per-room later without a breaking change. The route is read
 * only — calling a tool always goes through an agent + the policy/approval gate,
 * never a raw HTTP endpoint.
 *
 * Decoupled by injection: the factory takes a {@link McpToolProvider} (the
 * registry, or {@link EMPTY_MCP_PROVIDER}) plus an optional connection lister, so
 * it never imports the registry's construction or the MCP SDK. The driver builds
 * the registry at boot and passes it in (see wiringInstructions).
 */
import { Hono } from 'hono';
import type { McpConnectionStatus } from './registry.js';
import type { McpToolProvider } from './types.js';

/** Optional introspection: list server connection statuses for the palette UI. */
export interface McpConnectionLister {
  listConnections(): { name: string; status: McpConnectionStatus; toolCount: number }[];
}

export interface McpRoutesDeps {
  /** The injected tool palette (registry or empty provider). */
  provider: McpToolProvider;
  /**
   * Optional connection introspection. When the provider is an {@link McpRegistry}
   * it already implements this, so the driver can pass the same object for both.
   */
  connections?: McpConnectionLister;
}

/**
 * Build the MCP routes sub-app. Mount it on the main API with
 * `app.route('/', makeMcpRoutes({ provider, connections }))` — the paths are
 * absolute (`/api/...`) so the mount prefix is just '/'.
 */
export function makeMcpRoutes(deps: McpRoutesDeps): Hono {
  const app = new Hono();

  app.get('/api/rooms/:roomId/mcp/tools', (c) => {
    // The palette is workspace-scoped; :roomId is accepted (and reserved for a
    // future per-room palette) but does not currently filter the result.
    const tools = deps.provider.listTools();
    const servers = deps.connections?.listConnections() ?? [];
    return c.json({ tools, servers });
  });

  return app;
}
