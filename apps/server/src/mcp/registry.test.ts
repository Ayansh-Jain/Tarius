/**
 * MCP tool registry tests (v1.5 Slice C) — the workspace tool palette.
 *
 * Proves the registry against a REAL (in-process) MCP server wired over the SDK's
 * InMemoryTransport — no network, no child process, deterministic in CI:
 *   - connect() discovers the server's tools and namespaces them <server>/<tool>.
 *   - listTools() flattens every connected server's tools.
 *   - callTool() round-trips arguments to the server and returns its result.
 *   - a tool that reports isError surfaces that flag (and isn't thrown).
 *   - unknown tools / down servers fail fast without hanging.
 *   - a server whose transport never connects is isolated (failed, no tools),
 *     and a second healthy server still works.
 *   - the EMPTY_MCP_PROVIDER + config parser behave (optional/robust).
 *
 * The server is built with the LOW-LEVEL Server + the SDK's own request schemas,
 * so the test needs no Zod of its own (zod is not a direct @ice/server dep).
 */
import { describe, it, expect } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { McpRegistry } from './registry.js';
import { loadMcpServerSpecs, MCP_SERVERS_ENV } from './config.js';
import { EMPTY_MCP_PROVIDER, type McpServerSpec } from './types.js';

/**
 * Build a trivial in-process MCP server exposing:
 *   - `echo`   → returns its `text` argument (happy path).
 *   - `boom`   → returns a tool-level error (isError: true).
 * Returns the client-side transport to hand to the registry.
 */
async function startMockServer(): Promise<Transport> {
  const server = new Server(
    { name: 'mock-mcp', version: '0.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'echo',
        description: 'Echo back the provided text.',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
      },
      {
        name: 'boom',
        description: 'Always returns a tool-level error.',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    if (name === 'echo') {
      const text = (args as { text?: unknown } | undefined)?.text;
      return { content: [{ type: 'text', text: `echo:${String(text ?? '')}` }] };
    }
    if (name === 'boom') {
      return { content: [{ type: 'text', text: 'kaboom' }], isError: true };
    }
    // Unknown tool on the server side → surface as a tool error.
    return { content: [{ type: 'text', text: `no such tool ${name}` }], isError: true };
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return clientTransport;
}

/** A spec that wraps an already-linked in-memory transport. */
function inMemorySpec(name: string, transport: Transport): McpServerSpec {
  return { name, transport: { type: 'inMemory', transport } };
}

/** Silent logger so the test output stays clean. */
const QUIET = { warn: () => {} };

describe('McpRegistry', () => {
  it('connects, lists namespaced tools, and calls one', async () => {
    const transport = await startMockServer();
    const registry = new McpRegistry(undefined, QUIET);

    const result = await registry.connect(inMemorySpec('demo', transport));
    expect(result.status).toBe('connected');
    expect(result.toolCount).toBe(2);

    const tools = registry.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['demo/boom', 'demo/echo']);

    // Namespacing carries the origin server + preserves the input schema.
    const echo = tools.find((t) => t.name === 'demo/echo');
    expect(echo?.server).toBe('demo');
    expect(echo?.description).toBe('Echo back the provided text.');
    expect(echo?.inputSchema).toMatchObject({ type: 'object' });

    expect(registry.hasTool('demo/echo')).toBe(true);
    expect(registry.hasTool('demo/missing')).toBe(false);

    const call = await registry.callTool('demo/echo', { text: 'hello' });
    expect(call.isError).toBe(false);
    expect(call.content).toEqual([{ type: 'text', text: 'echo:hello' }]);

    await registry.disconnectAll();
  });

  it('surfaces a tool-level error via isError rather than throwing', async () => {
    const transport = await startMockServer();
    const registry = new McpRegistry(undefined, QUIET);
    await registry.connect(inMemorySpec('demo', transport));

    const call = await registry.callTool('demo/boom', {});
    expect(call.isError).toBe(true);
    expect(call.content).toEqual([{ type: 'text', text: 'kaboom' }]);

    await registry.disconnectAll();
  });

  it('throws for an unknown tool and a bad tool name (no hang)', async () => {
    const transport = await startMockServer();
    const registry = new McpRegistry(undefined, QUIET);
    await registry.connect(inMemorySpec('demo', transport));

    await expect(registry.callTool('demo/nope', {})).rejects.toThrow(/unknown MCP tool/);
    await expect(registry.callTool('demo:echo', {})).rejects.toThrow(/invalid MCP tool name/);
    await expect(registry.callTool('ghost/echo', {})).rejects.toThrow(/not connected/);

    await registry.disconnectAll();
  });

  it('namespaces two servers independently and flattens the palette', async () => {
    const t1 = await startMockServer();
    const t2 = await startMockServer();
    const registry = new McpRegistry(undefined, QUIET);

    await registry.connect(inMemorySpec('alpha', t1));
    await registry.connect(inMemorySpec('beta', t2));

    const names = registry.listTools().map((t) => t.name).sort();
    expect(names).toEqual(['alpha/boom', 'alpha/echo', 'beta/boom', 'beta/echo']);

    // Calls route to the correct server's client.
    const a = await registry.callTool('alpha/echo', { text: 'A' });
    const b = await registry.callTool('beta/echo', { text: 'B' });
    expect(a.content).toEqual([{ type: 'text', text: 'echo:A' }]);
    expect(b.content).toEqual([{ type: 'text', text: 'echo:B' }]);

    await registry.disconnectAll();
  });

  it('isolates a failing server: one bad connect does not break the rest', async () => {
    const good = await startMockServer();
    const registry = new McpRegistry(undefined, QUIET);

    // A spec whose inMemory transport is invalid (not a real Transport) fails the
    // connect — and must NOT throw or poison the registry.
    const bad: McpServerSpec = {
      name: 'broken',
      transport: { type: 'inMemory', transport: { not: 'a transport' } },
    };

    const results = await registry.connectAll([bad, inMemorySpec('good', good)]);
    expect(results[0]?.status).toBe('failed');
    expect(results[0]?.error).toBeTruthy();
    expect(results[1]?.status).toBe('connected');

    // Only the healthy server contributes tools.
    expect(registry.listTools().map((t) => t.name).sort()).toEqual([
      'good/boom',
      'good/echo',
    ]);
    expect(registry.listConnections()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'good', status: 'connected', toolCount: 2 }),
      ]),
    );

    await registry.disconnectAll();
  });

  it('reconnecting a name replaces the previous connection', async () => {
    const first = await startMockServer();
    const second = await startMockServer();
    const registry = new McpRegistry(undefined, QUIET);

    await registry.connect(inMemorySpec('x', first));
    expect(registry.listTools()).toHaveLength(2);

    // Same name again → old one torn down, new one in place (still 2 tools, one x).
    await registry.connect(inMemorySpec('x', second));
    expect(registry.listConnections().filter((c) => c.name === 'x')).toHaveLength(1);
    expect(registry.listTools()).toHaveLength(2);

    await registry.disconnectAll();
  });
});

describe('EMPTY_MCP_PROVIDER', () => {
  it('offers no tools and rejects calls', () => {
    expect(EMPTY_MCP_PROVIDER.listTools()).toEqual([]);
    expect(EMPTY_MCP_PROVIDER.hasTool('anything')).toBe(false);
    expect(() => EMPTY_MCP_PROVIDER.callTool('x/y')).toThrow(/no MCP servers configured/);
  });
});

describe('loadMcpServerSpecs', () => {
  it('returns [] when the env var is unset or empty', () => {
    expect(loadMcpServerSpecs({}, QUIET)).toEqual([]);
    expect(loadMcpServerSpecs({ [MCP_SERVERS_ENV]: '   ' }, QUIET)).toEqual([]);
  });

  it('returns [] (not throw) on malformed JSON or a non-array', () => {
    expect(loadMcpServerSpecs({ [MCP_SERVERS_ENV]: '{not json' }, QUIET)).toEqual([]);
    expect(loadMcpServerSpecs({ [MCP_SERVERS_ENV]: '{"name":"x"}' }, QUIET)).toEqual([]);
  });

  it('parses valid stdio specs and skips bad entries', () => {
    const env = {
      [MCP_SERVERS_ENV]: JSON.stringify([
        { name: 'search', command: 'npx', args: ['-y', '@org/search'] },
        { name: 'nocmd' }, // missing command → skipped
        { command: 'x' }, // missing name → skipped
        { name: 'gh', command: 'gh-mcp', env: { TOKEN: 't' }, cwd: '/tmp', timeoutMs: 5000 },
      ]),
    };
    const specs = loadMcpServerSpecs(env, QUIET);
    expect(specs.map((s) => s.name)).toEqual(['search', 'gh']);

    const search = specs[0];
    expect(search?.transport).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@org/search'],
      env: undefined,
      cwd: undefined,
    });

    const gh = specs[1];
    expect(gh?.timeoutMs).toBe(5000);
    expect(gh?.transport).toMatchObject({
      type: 'stdio',
      command: 'gh-mcp',
      env: { TOKEN: 't' },
      cwd: '/tmp',
    });
  });

  it('drops duplicate names, keeping the first', () => {
    const env = {
      [MCP_SERVERS_ENV]: JSON.stringify([
        { name: 'dup', command: 'first' },
        { name: 'dup', command: 'second' },
      ]),
    };
    const specs = loadMcpServerSpecs(env, QUIET);
    expect(specs).toHaveLength(1);
    expect(specs[0]?.transport).toMatchObject({ command: 'first' });
  });
});
