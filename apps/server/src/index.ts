/**
 * ICE server — entry point (v0.1, Slice A).
 *
 * One process, one port. The Hocuspocus realtime server owns a Node http.Server
 * with the WebSocket upgrade wired for `/sync`; we swap its default HTTP request
 * handler for the Hono REST app so the same port serves both the API and live
 * collaboration.
 *
 *   ws(s)://<host>/sync   → Hocuspocus (Yjs sync + awareness), document = roomId
 *   http(s)://<host>/api  → Hono REST (auth, rooms, invites, health)
 *
 * Durable state lives under apps/server/data: ice.sqlite (metadata) and
 * ydoc.sqlite (Yjs documents). A room survives a restart.
 */
import { getRequestListener } from '@hono/node-server';
import { createApiApp } from './api.js';
import { getDb } from './db.js';
import { createRealtimeServer } from './realtime.js';
import { DATA_DIR, HOST, IS_PRODUCTION, PORT, ensureDataDir } from './config.js';
import { startGitServer, stopGitServer } from './git/index.js';
import { configureAgentHost, getAgentHost } from './agent/index.js';
import { createTerminalRunner, type TerminalRunnerHandle } from './terminal/index.js';
import { setSharedTerminalRunner } from './terminal/shared.js';
import { checkApiStatus } from './convert/convert.js';
import { getRoomDoc, releaseRoomDoc, closeAllRoomDocs } from './room-doc.js';
import { loadMcpServerSpecs } from './mcp/index.js';
import { mcpRegistry } from './v15.js';
import { getScaleStatus } from './scale/index.js';
import { loadExtensions } from './extensions/index.js';

async function main(): Promise<void> {
  ensureDataDir();
  // Open + migrate the metadata DB eagerly so failures surface at boot.
  getDb();

  const api = createApiApp();
  const realtime = createRealtimeServer();

  // v0.5: a shared terminal (Slice B) injected into the agent host (Slice A),
  // both driven off the room's live Y.Doc. Agents act THROUGH the doc; the
  // terminal mirrors output into doc.getText('terminal') for every client.
  const terminals = createTerminalRunner({ resolveDoc: getRoomDoc, release: releaseRoomDoc });
  configureAgentHost({ terminal: terminals });
  setSharedTerminalRunner(terminals);

  // Probe the code-conversion backup key once at startup (non-blocking).
  void checkApiStatus().then(() => {});

  // v1.5: connect workspace MCP tool servers (no-op if ICE_MCP_SERVERS is unset).
  try {
    await mcpRegistry.connectAll(loadMcpServerSpecs(process.env));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[ice] MCP connect failed (continuing without MCP):', err);
  }

  // v2.0: community extension surface (empty unless ICE_EXTENSIONS is set).
  const communityExtensions = loadExtensions();

  // Hocuspocus created an http.Server whose only 'request' listener writes a
  // placeholder banner. Replace it with Hono so the REST API answers here.
  const httpServer = realtime.httpServer;
  const honoListener = getRequestListener(api.fetch);
  httpServer.removeAllListeners('request');
  httpServer.on('request', honoListener);

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(PORT, HOST, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  const gitServer = await startGitServer();

  // eslint-disable-next-line no-console
  console.log(
    `[ice] server listening on http://${HOST}:${PORT}\n` +
      `      REST   → http://${HOST}:${PORT}/api/health\n` +
      `      sync   → ws://${HOST}:${PORT}/sync (document = roomId)\n` +
      `      git    → http://${HOST}:${gitServer.port}/git/<roomId>.git\n` +
      `      scale  → ${getScaleStatus().summary}\n` +
      `      ext    → ${communityExtensions.list().length} community extension(s)\n` +
      `      data   → ${DATA_DIR}\n` +
      `      env    → ${IS_PRODUCTION ? 'production' : 'development (auth permissive)'}`,
  );

  setupGracefulShutdown(realtime, terminals);
}

function setupGracefulShutdown(
  realtime: ReturnType<typeof createRealtimeServer>,
  terminals: TerminalRunnerHandle,
): void {
  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    // eslint-disable-next-line no-console
    console.log(`[ice] received ${signal}, flushing documents and shutting down…`);
    // Safety net if a graceful close hangs on lingering sockets.
    const force = setTimeout(() => process.exit(0), 3000);
    force.unref();
    try {
      // Persist any debounced Yjs writes, then close the http.Server and unload
      // all documents (Server.destroy handles both).
      await getAgentHost().stopAll();
      await terminals.disposeAll();
      await mcpRegistry.disconnectAll();
      await closeAllRoomDocs();
      realtime.hocuspocus.flushPendingStores();
      await realtime.destroy();
      await stopGitServer();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[ice] error during realtime shutdown:', err);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[ice] fatal startup error:', err);
  process.exit(1);
});
