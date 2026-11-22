/**
 * MCP tool registry (v1.5 Slice C) — the workspace tool palette.
 *
 * Connects to workspace-scoped MCP servers and surfaces their tools to the squad
 * of agents as one flat, namespaced palette. It is deliberately small and
 * un-opinionated about policy: it CONNECTS, LISTS, and CALLS. The agent host
 * decides which agent may use a tool ({@link AgentPolicy}) and whether a call
 * needs human approval — those gates live above this layer (Slice A / Slice D).
 *
 * Robustness is a feature, not a footnote:
 *   - Optional: with no servers configured the registry is empty and the whole
 *     system still works (the host gets {@link EMPTY_MCP_PROVIDER}'s behaviour).
 *   - Isolated: `connect` NEVER throws. A server that won't spawn, hangs the
 *     handshake, or dies mid-session is recorded as a failed/closed connection
 *     and simply contributes no tools — one bad server can't break the room.
 *   - Namespaced: every tool is exposed as `<server>/<tool>` so two servers can't
 *     collide and a tool's origin is always legible to humans and agents.
 *
 * Implements {@link McpToolProvider}, the narrow interface the agent host
 * consumes by injection. The driver builds ONE registry at boot, connects the
 * configured servers, and hands the registry to the host (see wiringInstructions).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  DEFAULT_MCP_TIMEOUT_MS,
  type McpCallResult,
  type McpServerSpec,
  type McpToolProvider,
  type ResolvedMcpTool,
} from './types.js';

/** Separator between server name and tool name in the namespaced id. */
export const TOOL_NAMESPACE_SEP = '/';

/** Connection lifecycle state for one server. */
export type McpConnectionStatus = 'connected' | 'failed' | 'closed';

/** Outcome of a {@link McpRegistry.connect} attempt (never thrown — returned). */
export interface McpConnectResult {
  name: string;
  status: McpConnectionStatus;
  /** Number of tools discovered (0 unless connected). */
  toolCount: number;
  /** Failure reason when status !== 'connected'. */
  error?: string;
}

/** What the registry tracks per connected server. */
interface Connection {
  spec: McpServerSpec;
  client: Client;
  transport: Transport;
  status: McpConnectionStatus;
  /** Namespaced tools this server contributes. */
  tools: ResolvedMcpTool[];
}

/** Minimal logger seam (matches config's). */
export interface RegistryLogger {
  warn(message: string): void;
}

const consoleLogger: RegistryLogger = {
  // eslint-disable-next-line no-console
  warn: (m) => console.warn(m),
};

/**
 * The MCP tool palette. One instance per server process (workspace-scoped). Build
 * it, `connect` each configured server (failures are isolated), then inject it
 * into the agent host as an {@link McpToolProvider}.
 */
export class McpRegistry implements McpToolProvider {
  /** Connected servers keyed by spec.name. */
  private readonly connections = new Map<string, Connection>();

  constructor(
    private readonly clientInfo: { name: string; version: string } = {
      name: 'ice-mcp-registry',
      version: '1.5.0',
    },
    private readonly logger: RegistryLogger = consoleLogger,
  ) {}

  /**
   * Connect to one MCP server and cache its tool list. NEVER throws: any failure
   * (bad transport, handshake timeout, list-tools error) is captured and returned
   * as a `failed` result so the caller can keep going. Re-connecting the same
   * name first disconnects the previous connection.
   */
  async connect(spec: McpServerSpec): Promise<McpConnectResult> {
    // Replacing an existing connection: tear the old one down cleanly first.
    if (this.connections.has(spec.name)) {
      await this.disconnect(spec.name);
    }

    const timeoutMs = spec.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;

    let transport: Transport;
    try {
      transport = this.buildTransport(spec);
    } catch (err) {
      const error = describe(err);
      this.logger.warn(`[ice:mcp] server '${spec.name}' transport setup failed: ${error}`);
      return { name: spec.name, status: 'failed', toolCount: 0, error };
    }

    const client = new Client(this.clientInfo, { capabilities: {} });

    // A dead/hung server must not wedge boot. The SDK's connect already does the
    // initialize handshake; we bound it AND the subsequent listTools with our own
    // timeout so neither can hang forever.
    try {
      await client.connect(transport, { timeout: timeoutMs });
    } catch (err) {
      const error = describe(err);
      this.logger.warn(`[ice:mcp] server '${spec.name}' failed to connect: ${error}`);
      // The transport may be half-open; close it best-effort so we don't leak a
      // child process or socket.
      await safeClose(client, transport);
      return { name: spec.name, status: 'failed', toolCount: 0, error };
    }

    let tools: ResolvedMcpTool[];
    try {
      tools = await this.fetchTools(client, spec, timeoutMs);
    } catch (err) {
      const error = describe(err);
      this.logger.warn(`[ice:mcp] server '${spec.name}' listTools failed: ${error}`);
      await safeClose(client, transport);
      return { name: spec.name, status: 'failed', toolCount: 0, error };
    }

    const connection: Connection = {
      spec,
      client,
      transport,
      status: 'connected',
      tools,
    };
    // If the transport drops later, mark the connection closed so its tools stop
    // being offered and callTool fails fast instead of hanging.
    transport.onclose = () => {
      const c = this.connections.get(spec.name);
      if (c && c.status === 'connected') {
        c.status = 'closed';
        c.tools = [];
      }
    };
    this.connections.set(spec.name, connection);

    return { name: spec.name, status: 'connected', toolCount: tools.length };
  }

  /**
   * Connect many servers, isolating each (one failure never aborts the rest).
   * Returns a result per spec, in order. Convenience for the driver's boot path.
   */
  async connectAll(specs: McpServerSpec[]): Promise<McpConnectResult[]> {
    const results: McpConnectResult[] = [];
    for (const spec of specs) {
      // Sequential keeps log output legible and avoids a thundering herd of
      // child-process spawns; the per-connect timeout bounds total time.
      results.push(await this.connect(spec));
    }
    return results;
  }

  /** Every connected server's tools, namespaced + flattened. */
  listTools(): ResolvedMcpTool[] {
    const out: ResolvedMcpTool[] = [];
    for (const conn of this.connections.values()) {
      if (conn.status === 'connected') out.push(...conn.tools);
    }
    return out;
  }

  /** Whether a namespaced tool (`<server>/<tool>`) is currently offered. */
  hasTool(name: string): boolean {
    const ref = this.parseToolName(name);
    if (!ref) return false;
    const conn = this.connections.get(ref.server);
    if (!conn || conn.status !== 'connected') return false;
    return conn.tools.some((t) => t.name === name);
  }

  /**
   * Call a namespaced tool. Routes to the owning server's client. Throws only for
   * an unknown tool or a down server (programmer/operator error); a tool-level
   * failure from the server is surfaced via {@link McpCallResult.isError} (false
   * is for the caller to decide what to do with), not thrown.
   */
  async callTool(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<McpCallResult> {
    const ref = this.parseToolName(name);
    if (!ref) {
      throw new Error(`invalid MCP tool name '${name}' (expected '<server>/<tool>')`);
    }
    const conn = this.connections.get(ref.server);
    if (!conn || conn.status !== 'connected') {
      throw new Error(
        `MCP server '${ref.server}' is not connected (tool '${name}' unavailable)`,
      );
    }
    if (!conn.tools.some((t) => t.name === name)) {
      throw new Error(`unknown MCP tool '${name}' on server '${ref.server}'`);
    }

    const timeoutMs = conn.spec.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
    const result = await conn.client.callTool(
      { name: ref.tool, arguments: args },
      undefined,
      { timeout: timeoutMs },
    );

    return normaliseCallResult(result);
  }

  /** Names of every server, with its current status (introspection / routes). */
  listConnections(): { name: string; status: McpConnectionStatus; toolCount: number }[] {
    return [...this.connections.values()].map((c) => ({
      name: c.spec.name,
      status: c.status,
      toolCount: c.status === 'connected' ? c.tools.length : 0,
    }));
  }

  /** Disconnect one server (close the client + transport). Idempotent. */
  async disconnect(name: string): Promise<void> {
    const conn = this.connections.get(name);
    if (!conn) return;
    this.connections.delete(name);
    conn.status = 'closed';
    await safeClose(conn.client, conn.transport);
  }

  /** Disconnect every server (graceful shutdown). */
  async disconnectAll(): Promise<void> {
    const all = [...this.connections.keys()];
    await Promise.all(all.map((name) => this.disconnect(name)));
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /** Build the SDK transport for a spec. Throws on an unusable inMemory spec. */
  private buildTransport(spec: McpServerSpec): Transport {
    const t = spec.transport;
    if (t.type === 'inMemory') {
      const transport = t.transport;
      if (!isTransport(transport)) {
        throw new Error("inMemory spec.transport is not a valid MCP transport");
      }
      return transport;
    }
    // stdio: spawn the child. Merge the parent env so PATH etc. survive, then
    // overlay the spec's extra env. getDefaultEnvironment() (the SDK default) is
    // intentionally restrictive; passing env explicitly keeps user servers usable.
    const childEnv: Record<string, string> = {
      ...filterEnv(process.env),
      ...(t.env ?? {}),
    };
    return new StdioClientTransport({
      command: t.command,
      args: t.args ?? [],
      env: childEnv,
      cwd: t.cwd,
      // Pipe stderr so a crashing child's output is captured, not dumped to ours.
      stderr: 'pipe',
    });
  }

  /** List a server's tools and namespace them; bounded by `timeoutMs`. */
  private async fetchTools(
    client: Client,
    spec: McpServerSpec,
    timeoutMs: number,
  ): Promise<ResolvedMcpTool[]> {
    const res = await client.listTools(undefined, { timeout: timeoutMs });
    return res.tools.map((tool) => ({
      name: `${spec.name}${TOOL_NAMESPACE_SEP}${tool.name}`,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema,
      server: spec.name,
    }));
  }

  /** Split a namespaced tool id into its server + bare tool name. */
  private parseToolName(name: string): { server: string; tool: string } | null {
    const idx = name.indexOf(TOOL_NAMESPACE_SEP);
    if (idx <= 0 || idx >= name.length - 1) return null;
    return { server: name.slice(0, idx), tool: name.slice(idx + 1) };
  }
}

/** Normalise the SDK's rich result union into our flat {@link McpCallResult}. */
function normaliseCallResult(result: unknown): McpCallResult {
  const r = (result ?? {}) as Record<string, unknown>;
  const content = Array.isArray(r.content) ? (r.content as unknown[]) : [];
  const structuredContent =
    typeof r.structuredContent === 'object' && r.structuredContent !== null
      ? (r.structuredContent as Record<string, unknown>)
      : undefined;
  return {
    isError: r.isError === true,
    content,
    structuredContent,
  };
}

/** Close a client/transport without letting a teardown error escape. */
async function safeClose(client: Client, transport: Transport): Promise<void> {
  try {
    await client.close();
  } catch {
    /* ignore — best effort */
  }
  try {
    await transport.close();
  } catch {
    /* ignore — best effort */
  }
}

/** Drop undefined-valued env entries so StdioServerParameters typechecks. */
function filterEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/** Structural check that an unknown value is usable as an MCP Transport. */
function isTransport(value: unknown): value is Transport {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { start?: unknown }).start === 'function' &&
    typeof (value as { send?: unknown }).send === 'function' &&
    typeof (value as { close?: unknown }).close === 'function'
  );
}

/** Best-effort error message extraction. */
function describe(err: unknown): string {
  return String((err as Error)?.message ?? err);
}
