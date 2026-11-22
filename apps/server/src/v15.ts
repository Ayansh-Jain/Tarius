/**
 * v1.5 driver singletons — the per-process PolicyRegistry + McpRegistry shared by
 * api.ts (routes) and index.ts (boot connect / shutdown). Kept in one module so
 * both ends reference the same instances.
 */
import { PolicyRegistry } from './agent-policy/index.js';
import { McpRegistry } from './mcp/index.js';

/** Per-agent permission policies (per room). Routes set them; enforcement reads them. */
export const policies = new PolicyRegistry();

/** Workspace MCP tool palette. Connected at boot from ICE_MCP_SERVERS (empty if unset). */
export const mcpRegistry = new McpRegistry();
