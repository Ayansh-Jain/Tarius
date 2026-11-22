/**
 * Community extension surface — internal contracts (v2.0 Slice C).
 *
 * ICE ships with a built-in MCP palette (apps/server/src/mcp) and a built-in
 * agent backend registry (apps/server/src/agent). Both are configured by the
 * *operator* of a deployment. This module adds the THIRD leg the "forkable
 * forever" promise needs: a way for the *community* to publish reusable
 * extensions — an MCP server bundle, or an agent backend definition — that an
 * operator can drop into a directory and have ICE discover, without forking the
 * codebase or editing core.
 *
 * An extension is JUST a manifest: a small, declarative JSON descriptor. It does
 * not run code at load time, it does not register handlers, it does not touch
 * the Yjs doc. The loader's only job is to FIND manifests and VALIDATE their
 * shape so two higher layers can consume them:
 *
 *   - kind 'mcp'   → the operator-facing MCP palette can offer the server's spec
 *                    to `loadMcpServerSpecs` / the `McpRegistry` (Slice C v1.5).
 *   - kind 'agent' → the agent registry can offer the backend as a spawnable
 *                    teammate alongside the built-ins (claude-code/codex/…).
 *
 * Trust model (see docs/THREAT_MODEL.md): a community extension is just config
 * the operator chose to install. Installing one that launches an MCP/agent
 * process is exactly as privileged as the operator typing that command into
 * `ICE_MCP_SERVERS` themselves. The loader therefore validates SHAPE, never
 * trust — it is the operator's job to vet what they install, and the per-agent
 * {@link AgentPolicy} + approval gate still bound everything an agent can do.
 *
 * The seams that keep this decoupled:
 *   - {@link ExtensionManifest} — how a publisher describes ONE extension (JSON).
 *   - {@link LoadedExtension}    — a validated manifest plus where it came from.
 *   - {@link ExtensionLoader}    — the narrow list surface the palette/registry
 *                                  consume (they import THIS, not the FS code).
 *
 * Everything is optional + robust: no configured dir → empty list, ICE runs
 * unchanged; one malformed manifest → skipped with a warning, the rest load.
 */

/**
 * What an extension plugs into. Mirrors the two community-extensible surfaces:
 *   - `mcp`   — a workspace MCP server (a toolbox surfaced in the MCP palette).
 *   - `agent` — an agent backend (a spawnable teammate in the agent registry).
 */
export type ExtensionKind = 'mcp' | 'agent';

/**
 * The spec for a kind:'mcp' extension. Deliberately the SAME stdio shape an
 * operator already writes into `ICE_MCP_SERVERS` (apps/server/src/mcp/config.ts)
 * so a loaded MCP extension can be handed straight to that subsystem without a
 * second schema. Only stdio is expressible declaratively (an in-memory transport
 * can't be serialised), which is the same constraint the MCP config has.
 */
export interface McpExtensionSpec {
  /** Executable to spawn (e.g. 'npx', '/usr/local/bin/my-mcp'). */
  command: string;
  /** Arguments passed to the executable. */
  args?: string[];
  /** Extra env for the child; merged over the parent process env at launch. */
  env?: Record<string, string>;
  /** Working directory for the child process. */
  cwd?: string;
  /** Per-connect / per-call timeout (ms). Optional; the registry has a default. */
  timeoutMs?: number;
}

/**
 * The spec for a kind:'agent' extension. Names an ACP-compatible backend the
 * agent registry can offer as a teammate. `backend` is the family the host knows
 * how to drive (matches the built-in {@link AgentBackendKind} union in
 * @ice/shared); `model` is an optional default hint. BYO-key stays the operator's
 * job — a manifest never carries secrets.
 */
export interface AgentExtensionSpec {
  /** ACP backend family the agent host drives ('claude-code'|'codex'|'gemini'|'mock'). */
  backend: string;
  /** Optional default model hint handed to the backend. */
  model?: string;
  /** Optional default system prompt / persona for the spawned agent. */
  systemPrompt?: string;
}

/**
 * A community extension manifest — the on-disk JSON a publisher ships. One file,
 * one extension. The `kind` discriminates which `spec` shape applies.
 *
 * Example (an MCP search server, `search-mcp.json`):
 *   {
 *     "id": "acme.search",
 *     "kind": "mcp",
 *     "name": "Acme Search",
 *     "description": "Web + docs search tools for the squad.",
 *     "version": "1.2.0",
 *     "homepage": "https://github.com/acme/search-mcp",
 *     "spec": { "command": "npx", "args": ["-y", "@acme/search-mcp"] }
 *   }
 *
 * Example (an agent backend, `reviewer-agent.json`):
 *   {
 *     "id": "acme.reviewer",
 *     "kind": "agent",
 *     "name": "Acme Reviewer",
 *     "spec": { "backend": "claude-code", "model": "sonnet" }
 *   }
 */
export interface ExtensionManifest {
  /**
   * Stable, globally-unique handle, recommended `<publisher>.<name>` (reverse-DNS
   * style). Used to dedupe and to namespace the extension wherever it surfaces.
   */
  id: string;
  /** Which surface this extension plugs into. */
  kind: ExtensionKind;
  /** Human-facing display name (shown in the palette / registry). */
  name: string;
  /** One-line description of what it adds. Optional. */
  description?: string;
  /** Publisher's version string (informational; not used for resolution). */
  version?: string;
  /** Link to source / docs so an operator can vet it before installing. */
  homepage?: string;
  /** The kind-specific payload. Validated against {@link kind}. */
  spec: McpExtensionSpec | AgentExtensionSpec;
}

/** An MCP extension after validation (its `spec` narrowed). */
export interface LoadedMcpExtension extends ExtensionManifest {
  kind: 'mcp';
  spec: McpExtensionSpec;
}

/** An agent extension after validation (its `spec` narrowed). */
export interface LoadedAgentExtension extends ExtensionManifest {
  kind: 'agent';
  spec: AgentExtensionSpec;
}

/**
 * A validated manifest plus provenance: the absolute path it was read from. The
 * palette/registry consume {@link manifest}; `sourcePath` is for diagnostics and
 * for an "installed extensions" admin view.
 */
export interface LoadedExtension {
  /** The validated manifest (its `spec` is narrowed to match `kind`). */
  manifest: LoadedMcpExtension | LoadedAgentExtension;
  /** Absolute path of the manifest file this was loaded from. */
  sourcePath: string;
}

/**
 * The narrow surface the MCP palette and agent registry consume — injected by
 * the driver, so neither subsystem imports the filesystem loader directly. CI
 * and tests can supply a fixed list with zero disk access.
 *
 *   list()            — every loaded extension (both kinds).
 *   listByKind(kind)  — just the MCP, or just the agent, extensions.
 *   get(id)           — one extension by id, or undefined.
 */
export interface ExtensionLoader {
  /** All loaded extensions, in a stable order (by id). */
  list(): LoadedExtension[];
  /** Loaded extensions of one kind only. */
  listByKind(kind: 'mcp'): LoadedExtension[];
  listByKind(kind: 'agent'): LoadedExtension[];
  listByKind(kind: ExtensionKind): LoadedExtension[];
  /** A single loaded extension by its id, or undefined if not present. */
  get(id: string): LoadedExtension | undefined;
}

/**
 * A no-op loader: zero extensions. The driver injects this when `ICE_EXTENSIONS`
 * is unset so the palette/registry can always depend on a loader being present
 * (never `undefined`).
 */
export const EMPTY_EXTENSION_LOADER: ExtensionLoader = {
  list: () => [],
  listByKind: () => [],
  get: () => undefined,
};
