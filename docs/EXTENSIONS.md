# Community Extensions

> ICE has two built-in extension points: the **MCP tool palette** (toolboxes for agents) and the **agent backend registry** (which kinds of agent you can spawn). Both are normally configured by the operator. **Community extensions** let *anyone* package one of these as a small, shareable manifest that an operator can drop in — so the palette and the registry can grow without forking ICE. This is the "forkable forever" promise extended to *additive* contribution: extend without forking.
>
> A community extension is **declarative**: one JSON file describing *what* to plug in. It runs no code at load time. The [loader](../apps/server/src/extensions/) discovers and validates manifests; the MCP/agent subsystems consume them.
>
> Implemented in [`apps/server/src/extensions`](../apps/server/src/extensions). Optional and off by default: with nothing configured, ICE behaves exactly as before.

---

## 1. The model in 30 seconds

- A **publisher** writes a manifest (`my-extension.json`) and shares it (a gist, a repo, an npm package's `dist/`).
- An **operator** puts that file in a directory and points `ICE_EXTENSIONS` at it.
- At boot, ICE's loader reads, validates, and lists every manifest. MCP extensions appear in the tool palette; agent extensions appear as spawnable teammates.

```
ICE_EXTENSIONS=/etc/ice/extensions          # a directory of *.json manifests
ICE_EXTENSIONS=/etc/ice/extensions:/opt/x.json   # dirs and/or single files, ":"-joined
```

(Use your platform's path separator — `:` on Linux/macOS, `;` on Windows.)

---

## 2. The manifest format

`ExtensionManifest` ([types](../apps/server/src/extensions/types.ts)) — one file, one extension:

| Field | Required | Type | Notes |
|---|---|---|---|
| `id` | ✅ | string | Globally-unique handle. Use reverse-DNS style `<publisher>.<name>` (e.g. `acme.search`). Used to dedupe + namespace. |
| `kind` | ✅ | `"mcp"` \| `"agent"` | Which surface this plugs into. |
| `name` | ✅ | string | Human-facing display name. |
| `spec` | ✅ | object | Kind-specific payload (below). |
| `description` | — | string | One-liner shown in the palette/registry. |
| `version` | — | string | Informational (not used for resolution). |
| `homepage` | — | string | Link to source/docs so an operator can **vet it before installing**. |

### `kind: "mcp"` — a workspace MCP server

`spec` is the **same stdio shape** an operator writes into `ICE_MCP_SERVERS` (so a loaded MCP extension hands straight to the existing [MCP subsystem](../apps/server/src/mcp)):

| `spec` field | Required | Type | Notes |
|---|---|---|---|
| `command` | ✅ | string | Executable to spawn (`npx`, an absolute path, …). |
| `args` | — | string[] | Arguments. |
| `env` | — | object<string,string> | Extra env, merged over the parent at launch. **Don't bake secrets in** — operators set those. |
| `cwd` | — | string | Working directory for the child. |
| `timeoutMs` | — | number (>0) | Handshake/call timeout; the registry has a sane default. |

Only **stdio** servers are expressible (you can't serialise a live in-memory transport) — the same constraint `ICE_MCP_SERVERS` has.

```json
{
  "id": "acme.search",
  "kind": "mcp",
  "name": "Acme Search",
  "description": "Web + docs search tools for the squad.",
  "version": "1.2.0",
  "homepage": "https://github.com/acme/search-mcp",
  "spec": { "command": "npx", "args": ["-y", "@acme/search-mcp"] }
}
```

### `kind: "agent"` — an agent backend

`spec` names an ACP-compatible backend the agent host can drive:

| `spec` field | Required | Type | Notes |
|---|---|---|---|
| `backend` | ✅ | string | ACP backend family (`claude-code`, `codex`, `gemini`, `mock`). |
| `model` | — | string | Default model hint. |
| `systemPrompt` | — | string | Default persona/system prompt for the spawned agent. |

BYO-key stays the operator's job — **a manifest never carries provider keys.**

```json
{
  "id": "acme.reviewer",
  "kind": "agent",
  "name": "Acme Reviewer",
  "description": "A reviewer-tuned agent persona.",
  "spec": { "backend": "claude-code", "model": "sonnet", "systemPrompt": "You are a meticulous code reviewer." }
}
```

---

## 3. Publishing an extension

1. **Write the manifest** (above). Pick a stable, namespaced `id` and set `homepage` to where your source lives, so operators can audit it.
2. **Make the underlying thing installable.** For `mcp`, ensure `command`/`args` resolve on a typical host (publishing your server to npm and using `npx -y @you/server` is the friendliest path). For `agent`, document any provider key the operator must set.
3. **Share the file.** A repo, a release asset, or an npm package that ships the JSON. There is no central registry in v2.0 — distribution is "share a file," by design (no gatekeeper, nothing to fork around).
4. **Version with `version`** and note breaking changes in your `homepage` README.

### Good-citizen guidelines

- **Least privilege.** Request only the tools/commands you need; don't shell out to broad interpreters if a focused binary will do.
- **No secrets in the manifest.** Read them from `env` the *operator* sets, not literals you ship.
- **Be honest in `description`/`homepage`.** Operators decide to trust you based on these.
- **Pin or document your runtime** (`npx -y @you/server@1.2.0`) so behaviour is reproducible.

---

## 4. Installing an extension (operator)

1. **Vet the source first.** Installing an extension is a *privileged act* — see [Trust & safety](#5-trust--safety). Read the `homepage`, check what `command` it runs and what tools it exposes.
2. **Place the manifest.** Drop `my-extension.json` into a directory, e.g. `/etc/ice/extensions/`.
3. **Point ICE at it:**
   ```bash
   ICE_EXTENSIONS=/etc/ice/extensions
   # or mix directories and single files:
   ICE_EXTENSIONS=/etc/ice/extensions:/opt/ice/reviewer-agent.json
   ```
   In Docker, mount the directory and set the env var in `docker-compose.yml`.
4. **Set any required secrets** (provider keys, MCP server tokens) via your secret store — **not** in the manifest.
5. **Restart ICE.** The loader scans on boot. MCP extensions join the palette; agent extensions become spawnable. Check server logs for `[ice:ext]` warnings (a skipped manifest tells you what was wrong).

### How discovery works (so there are no surprises)

- Each `ICE_EXTENSIONS` entry is either a **directory** (every `*.json` **directly inside** it is a manifest — non-recursive) or a **single `.json` file**.
- Manifests are loaded in a **stable order (sorted by `id`)**.
- A **malformed** manifest (bad JSON, missing `id`/`name`/`spec`, an unknown `kind`, or a `spec` that doesn't match its `kind`) is **skipped with a warning** — it never blocks the valid ones, and the loader never crashes the server.
- **Duplicate `id`s:** the first (by sorted file path) wins; the rest are skipped with a warning.
- `ICE_EXTENSIONS` **unset/empty** ⇒ no extensions, ICE runs exactly as before.

---

## 5. Trust & safety

**Installing a community extension is exactly as privileged as the operator typing that command into the config themselves.** A `kind:"mcp"` extension causes ICE to *launch the `command` you put in `ICE_EXTENSIONS`*; a `kind:"agent"` extension adds a spawnable backend. The loader validates **shape, not trustworthiness** — it confirms the manifest is well-formed, it does **not** vouch for what the referenced code does.

Therefore (see [THREAT_MODEL.md §4.3](THREAT_MODEL.md)):

- **Only install extensions you've vetted**, from sources you trust. Treat a manifest like a line you're adding to your own startup script.
- **The safety rails still apply.** Tools an MCP extension exposes remain behind the per-agent [`AgentPolicy`](../packages/shared/src/orchestration.ts) (allow/deny tools + write paths) and the **human approval gate** for destructive calls — installing a tool does not grant any agent the right to use it unsupervised.
- **Sandbox the agent host** regardless (containerise, drop privileges, limit egress) — an extension's `command` runs with the agent host's privileges.
- **No secrets in manifests.** Provide keys via operator-controlled `env`/secret store.

In short: community extensions make ICE *extensible without forking*, while keeping the operator firmly in the trust seat.

---

## 6. For developers: consuming the loader

The loader is a small, injectable surface ([`apps/server/src/extensions`](../apps/server/src/extensions)). The driver wires it at boot:

```ts
import { loadExtensions } from './extensions/index.js';

const extensions = loadExtensions();              // reads ICE_EXTENSIONS; empty if unset

// Surface MCP extensions in the palette (→ McpServerSpec[]):
const extraMcp = extensions.listByKind('mcp').map((e) => ({
  name: e.manifest.id,
  transport: { type: 'stdio' as const, ...e.manifest.spec },
  timeoutMs: e.manifest.spec.timeoutMs,
}));
// await registry.connectAll([...loadMcpServerSpecs(), ...extraMcp]);

// Offer agent extensions alongside the built-ins:
const teammates = extensions.listByKind('agent'); // each .manifest.spec.backend / .model
```

`ExtensionLoader` exposes `list()`, `listByKind('mcp'|'agent')`, and `get(id)`. When `ICE_EXTENSIONS` is unset the loader is empty; inject `EMPTY_EXTENSION_LOADER` where a non-null loader is required. See the [tests](../apps/server/src/extensions/loader.test.ts) for the full behaviour contract.

---

### See also

- [GOVERNANCE.md](../GOVERNANCE.md) — "forkable forever"; the extensions area of responsibility.
- [THREAT_MODEL.md](THREAT_MODEL.md) — the privilege of installing extensions (§4.3, §6).
- [`apps/server/src/mcp`](../apps/server/src/mcp) — the MCP subsystem MCP extensions feed.
- [A2A_EVALUATION.md](A2A_EVALUATION.md) — why ICE invests in MCP/tool integration over agent-federation protocols.
