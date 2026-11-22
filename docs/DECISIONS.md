# ICE — Decision Log (ADRs)

> Authoritative product + technical decisions, ratified by the `ice-pm-council` (6 PM personas → Head-of-Product synthesis) on 2026-05-31. Do not relitigate without a new council. New ADRs are appended as the build proceeds.

## Product one-liner

**ICE is the open-source Google Docs for code:** one self-hostable live workspace where your whole squad — humans and AI agents — edits the same repo in real time, talks over voice and chat, and ships from a git server that runs in the same `docker compose up`.

## Pillars

1. **Shared live workspace** — humans **and** agents edit ONE live CRDT document tree (not isolated worktrees). _The differentiator and the reason ICE exists._
2. **AI agents in the room** — chat with one agent (then several) that act as first-class participants editing the same buffers via ACP, with visible attribution, an approval gate, and one-click rollback.
3. **Human comms in-app** — workspace-scoped voice rooms, group chat, DMs. Never need Discord open next to ICE.
4. **Own your stack** — one self-hostable server with its own bundled git server, one command to run, permissively licensed, forkable forever.

---

## The architectural law (ADR-000, load-bearing)

> **Three sources of truth must converge: the Yjs CRDT (live buffer), the server filesystem (what terminals/builds/agents run against), and git (what gets committed). Under concurrent human+agent edits these can silently diverge, lose edits, or corrupt commits. "A collaborative IDE that loses your code" is fatal.**

The law, enforced from day one:

1. **Yjs is the SINGLE source of truth for open files.**
2. **Agents MUST write THROUGH the Yjs doc**, never the raw filesystem.
3. **Git commits are projected FROM the doc** with explicit flush + lock semantics around builds/commits.
4. This seam is **ONE owned, heavily-tested module**, landed at **v0.3 before any agent touches the workspace** (v0.5).

Every other decision serves this law.

---

## Technical ADRs

| # | Decision | Rationale / guardrail |
|---|---|---|
| **001** | **Shared live workspace**, not per-agent isolation | The whole thesis. We deliberately cede the crowded worktree-isolation lane (Claude Squad/Sculptor/Conductor/ccswarm); we borrow only their *safety ergonomics* (checkpoints, attributed commits, rollback) as an opt-in escape hatch at v1.5. |
| **002** | **Editor = CodeMirror 6 + `y-codemirror.next`** | NOT a VS Code fork, NOT Monaco/Theia, NO "pro IDE shell." Web-native, light, first-class Yjs binding. Ships the collaborative wow ~10× faster and dodges MS marketplace/extension-enforcement risk. |
| **003** | **CRDT = Yjs (MIT)** + `y-protocols` awareness; **Hocuspocus** sync+persistence server | ONE CRDT backend. No Automerge, no pluggable-CRDT abstraction. `y-sweet` is named only as the documented v2 scale-out swap, not a maintained second backend. |
| **004** | **Agents via ACP as a client**, out-of-process, **writing through the Yjs doc** | Host Claude Code / Codex CLI / Gemini CLI via a registry, BYO-key, model-agnostic. Every agent edit = an origin-tagged, attributable, undoable Yjs transaction. **MCP** for agent↔tools. Multi-agent router (Kilo-style architect/coder/debugger) at v1.5. No bundled model. No bespoke protocol. No A2A before v2. |
| **005** | **Voice = LiveKit** (Apache-2.0 SFU) sidecar | Voice rooms + talking indicators only. **No video, no screen share** (the shared editor already shows the code). No hand-rolled WebRTC. |
| **006** | **Chat + presence reuse the Yjs/Hocuspocus layer** | Text channels + DMs persisted as Yjs docs; presence via the awareness protocol. No separate chat datastore at launch. |
| **007** | **Git server = `isomorphic-git` + `node git-http-backend`** smart-HTTP over bare repos | v0.3: clone/push/pull with token/SSH-key auth. v2: OPTIONAL Forgejo for teams wanting a full forge. **Never build our own forge** (issues/PRs/CI/wikis). |
| **008** | **DB = SQLite by default**, Postgres opt-in | Zero-config protects the single-binary self-host promise. Stores workspace metadata + Hocuspocus-persisted docs. Postgres is opt-in for teams. |
| **009** | **Auth = email/password + signed invite links** (no mandatory account); OIDC at v1.0; SSH keys/tokens for git | Room access enforced in the Hocuspocus auth hook. **No SSO/SAML/RBAC matrices in core.** |
| **010** | **Deploy = single `docker-compose.yml`** (web + server + LiveKit), secrets auto-generated, zero required env | Works on localhost, air-gappable, telemetry off by default. **No Kubernetes/Helm as the primary path** (optional Helm chart at v2 only). |
| **011** | **License = Apache-2.0**, single, across the whole repo; DCO, no CLA | Reject the AGPL/GPL/Apache tri-split — copyleft contradicts "forkable forever." Foundation + trademark commitment formalized post-v1, not a launch blocker. |
| **012** | **Stack = TypeScript everywhere** — React 19 + Vite + Tailwind (web), Node 22 (server), pnpm + Turborepo | One toolchain for contributors and the autonomous agent team. |

---

## Explicitly OUT (the anti-bloat charter)

Cut hard, with reasons. Do **not** build these without a new council:

- ❌ **Forking VS Code / full IDE + extension marketplace** — biggest bloat trap; MS licensing risk; buries the differentiator.
- ❌ **Per-agent worktree/container isolation as a core feature** — the opposite architecture; commoditized (Vibe Kanban died there). Only an opt-in snapshot escape hatch at v1.5.
- ❌ **A full git forge** (issues/PR-as-product/CI/runners/registry/wikis) — that's Forgejo's job; optional integration at v2.
- ❌ **Our own model / inference stack / model gateway** — bottomless cost, lock-in. ACP + BYO-key instead.
- ❌ **Video + screen share** — redundant with shared editor; balloons bandwidth.
- ❌ **Mobile native + desktop (Electron/Tauri) apps at launch** — web-first; "send a friend a link."
- ❌ **Enterprise SSO/SAML, RBAC, audit-everything, multi-tenant SaaS, billing** — premature for squads of 2–8.
- ❌ **Automerge / pluggable-CRDT abstraction** — two engines on the correctness-critical layer for zero benefit.
- ❌ **K8s/Terraform/Helm as primary deploy** — violates one-command-up.
- ❌ **Built-in CI/CD** — served by Actions/Woodpecker; push out.
- ❌ **Plugin marketplace at launch** — empty marketplace = liability; MCP covers extensibility.
- ❌ **Kanban / issue tracker / PM boards / wikis** — Vibe Kanban's death is the signal.
- ❌ **A2A protocol early** — emerging/unproven; shared doc + router coordinates agents more cheaply.
- ❌ **Local-first P2P (no authoritative server)** — fights Pillar 4; breaks server-side agents/terminals/builds.
- ❌ **Mandatory accounts / cloud control plane / telemetry-on** — anti-self-host.

---

## Top risks (carry into every release)

1. **Three-sources-of-truth convergence** (see architectural law) — mitigated by ADR-000.
2. **Multi-agent-in-shared-buffer trust & safety** — the differentiator and the failure mode are the same feature. Ship the trust layer (attribution, approval gate, checkpoint/rollback) at v0.5/v1.0 and prove the single-agent loop is loved before scaling agent count at v1.5.
3. **"Agents write through the CRDT, not the FS" vs off-the-shelf ACP agents** that assume raw FS access — treat the ACP↔Yjs adapter as a first-class, heavily-tested boundary; snapshot escape hatch for agents needing real FS.
4. **Contributor drought** before network effects — permissive Apache-2.0, ruthless protocol reuse (ACP/MCP), an independently-demoable wow at v0.1, legible governance.
5. **`y-codemirror.next` dependency rot** (stale, unstamped license) — vendor, pin, license-stamp from v0.1; be ready to co-maintain/fork.
6. **Scope creep** — the VISION "What ICE is NOT" charter is binding; new ideas get flagged for the next council, not built.
