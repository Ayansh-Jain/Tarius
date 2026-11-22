/**
 * Shared terminal module — public API (v0.5, Slice B).
 *
 * A per-room SHARED terminal everyone (and the agent) sees. One shell per room
 * (spawned lazily), its I/O mirrored into the room's Yjs doc
 * (`doc.getText('terminal')`) so every xterm shows the same bytes.
 *
 * What the driver wires (see this slice's wiringInstructions):
 *   1. Build the runner once with a doc resolver:
 *        const terminals = createTerminalRunner({
 *          async resolveDoc(roomId) {
 *            const conn = await getHocuspocus().openDirectConnection(roomId);
 *            // keep `conn` to disconnect in release(); return conn.document
 *          },
 *        });
 *   2. Inject `terminals` (a TerminalRunner) into `startAgentForRoom(...)` so the
 *      agent's terminal tool runs through the shared channel.
 *   3. (Optional) a human route, e.g. POST /api/rooms/:roomId/terminal/run
 *      { command } → terminals.runCommand(roomId, command); and a WS/route that
 *      forwards raw keystrokes to terminals.getTerminal(roomId)?.write(data).
 *   4. On shutdown: await terminals.disposeAll().
 *
 * For a room whose live Y.Doc you ALREADY hold, skip the runner and call
 * `createRoomTerminal(roomId, doc)` directly.
 */

export {
  TERMINAL_TEXT_KEY,
  type RoomTerminal,
  type TerminalRunner,
  type TerminalBackend,
  type TerminalOptions,
} from './types.js';

export { createRoomTerminal } from './room-terminal.js';

export {
  createTerminalRunner,
  type TerminalRunnerDeps,
  type TerminalRunnerHandle,
} from './runner.js';

// Yjs sink helpers — for a route that wants to read/clear the shared buffer.
export { getTerminalText, clearTerminalOutput } from './ydoc-sink.js';

// Backend introspection / test seams (which implementation is live, force one).
export {
  selectBackendKind,
  forceBackendForTests,
  resetBackendSelectionForTests,
  type BackendKind,
} from './backend.js';
