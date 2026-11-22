/**
 * Community extension surface — public API (v2.0 Slice C).
 *
 * A community-extensible layer over ICE's two built-in extension points:
 *   - the MCP tool palette (apps/server/src/mcp), and
 *   - the agent backend registry (apps/server/src/agent).
 *
 * A community extension is a declarative {@link ExtensionManifest} (one JSON
 * file). The operator drops manifests into a directory (or names files) via the
 * `ICE_EXTENSIONS` env var; {@link loadExtensions} discovers + validates them and
 * returns an {@link ExtensionLoader}. The driver wires this at boot:
 *
 *   1. const extensions = loadExtensions();           // from ICE_EXTENSIONS
 *   2. // surface MCP extensions in the palette:
 *      const extraMcp = extensions.listByKind('mcp').map((e) => ({
 *        name: e.manifest.id,
 *        transport: { type: 'stdio', ...e.manifest.spec },
 *        timeoutMs: e.manifest.spec.timeoutMs,
 *      }));                                            // → McpServerSpec[]
 *      await registry.connectAll([...loadMcpServerSpecs(), ...extraMcp]);
 *   3. // offer agent extensions in the registry alongside the built-ins:
 *      extensions.listByKind('agent') → spawnable teammates.
 *
 * Optional + robust by design: no `ICE_EXTENSIONS` → an empty loader, ICE runs
 * exactly as before; one malformed manifest → skipped with a warning, the rest
 * load. The loader validates SHAPE, never trust — installing an extension is the
 * operator's deliberate act (see docs/THREAT_MODEL.md and docs/EXTENSIONS.md).
 */

// ── The loader (env → validated extensions) ───────────────────────────────────
export {
  loadExtensions,
  makeExtensionLoader,
  validateManifest,
  EXTENSIONS_ENV,
} from './loader.js';
export type { ExtensionLogger } from './loader.js';

// ── Contracts (consumed by the MCP palette / agent registry / driver / tests) ─
export { EMPTY_EXTENSION_LOADER } from './types.js';
export type {
  ExtensionKind,
  ExtensionLoader,
  ExtensionManifest,
  McpExtensionSpec,
  AgentExtensionSpec,
  LoadedExtension,
  LoadedMcpExtension,
  LoadedAgentExtension,
} from './types.js';
