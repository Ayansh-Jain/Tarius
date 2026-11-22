# ICE — Competitive Research (2026)

Distilled from a deep, source-verified landscape sweep. Two facts were adversarially fact-checked against primary repos (✓verified); the rest is from current 2026 sources + primary GitHub repos. **This space turns over monthly — re-verify before betting on any single project.**

## The big split: isolation vs. shared

> "Coordination between agents is either manual (most tools) or limited to task-graph scheduling within one repo." Most multi-agent coding tools use **git-worktree isolation** with **manual merge** — agents never see each other's work. — Augment Code, 2026

- **Isolation orchestrators** = many agents, separately (worktrees/containers, separate branches).
- **Shared real-time workspaces** = agents on a team, together (one CRDT workspace). **← ICE lives here.**

## What to STEAL (and from whom)

| Feature | Steal from | Why |
|---|---|---|
| Real-time multiplayer editing (CRDT, shared cursors) | **Zed**, Yjs ecosystem | The collaboration core; proven pattern |
| Humans + multiple agents in ONE editor | **Zed** (via ACP), GitHub Next **Ace** | The exact differentiator we want |
| Talk-to-your-agent UX, plan→act loop | **Cline / Aider** | Loved agent interaction model |
| Subtask routing to specialist "modes" | **Kilo Code** (Orchestrator: architect/coder/debugger) | Multi-agent coordination that users like |
| Agent that reads/writes/runs in the repo | **OpenHands**, Aider | Agents must _act_, not just suggest |
| MCP tool extensibility | **Goose**, Continue | Standard, batteries-included tool access |
| One-command self-host | code-server, Coder | Trivial onboarding |
| Built-in source hosting | Gitea/Forgejo | "Its own git server" pillar |
| Voice/group audio | **LiveKit** (Apache-2.0 SFU) | Best OSS realtime audio |
| Shared chat/threads/files in real time | **OpenAgents** (Apache-2.0) | Closest OSS shared-workspace analogue |

## What to AVOID (bloat / traps)

- **Forking VS Code** — Microsoft enforced licensing in 2025; C/C++ & other MS extensions stopped working in Cursor/forks; VSIX downloads restricted. Use a web-native editor (CodeMirror/Monaco) or Theia instead.
- **Copyleft foundations if you want permissive** — Zed (GPL/AGPL) and Coder (AGPL) are great to use but constrain building a permissive product on them.
- **"Open source" that isn't** — Multica (modified Apache, source-available), Agent Kanban (Elastic License). Read the LICENSE.
- **Enterprise sprawl** — RBAC matrices, SSO, audit, K8s control planes. Not for a squad.
- **Worktree-isolation-only** — solves the wrong problem for a _shared_ space (still useful as an execution primitive for risky agent actions).

## Building blocks (the recommended OSS stack)

| Layer | Pick | License |
|---|---|---|
| CRDT / multiplayer state | **Yjs** (+ `y-codemirror.next` / `y-monaco`) | MIT ✓verified |
| Persistence/scaling for Yjs | Hocuspocus or y-sweet | MIT |
| Editor surface | **CodeMirror 6** (web-native) or Monaco | MIT |
| Full IDE base (if needed) | OpenVSCode Server (MIT ✓verified) or Theia (EPL+MIT) | permissive |
| Voice / group audio | **LiveKit** (self-hostable SFU) | Apache-2.0 |
| Agent ↔ editor protocol | **ACP** (Agent Client Protocol, from Zed) | open |
| Agent ↔ tools protocol | **MCP** | open |
| Git server | **Gitea/Forgejo** or `isomorphic-git` smart-HTTP | MIT / MIT |
| AI agent framework to learn from | OpenHands (MIT), Aider (Apache) | permissive |

## Key projects, one-line each

**Editors/IDEs:** Code-OSS (MIT; branded VS Code + Copilot/Live Share are proprietary) · VSCodium (MIT) · Theia (EPL+MIT, vendor-neutral, ships Theia AI) · **Zed** (GPL/AGPL — multiplayer + in-editor agents, closest analogue) · Lapce (Apache) · Neovim (Apache).

**Agentic tools:** OpenHands (MIT, autonomous SWE, SDK→1000s agents) · Aider (Apache, terminal pair-programmer) · Goose (Apache, MCP, → Linux Foundation) · Cline/Roo/Kilo (Apache; Kilo has Orchestrator modes) · Continue (Apache, open-core) · Void (Apache, paused 2025) · Trae (proprietary).

**Self-host infra:** code-server (MIT) · OpenVSCode Server (MIT ✓) · Coder (AGPL open-core) · Eclipse Che (EPL, K8s) · Gitpod (pivoted; killed Classic 2025) · DevPod (MPL).

**Collaboration layer:** Yjs (MIT ✓) · Automerge (MIT) · Hocuspocus/y-sweet (MIT) · Open Collaboration Tools (TypeFox, OSS) · Liveblocks (proprietary SaaS) · VS Code Live Share (proprietary, maintenance mode).

**Multi-agent (isolation):** Claude Squad (AGPL) · Composio AO (MIT) · Sculptor (containers, beta) · Emdash (Apache) · MS Conductor (MIT) · Crystal→Nimbalyst · ccswarm (MIT) · Vibe Kanban (Apache, discontinued).

**Multi-agent (shared — our category):** **Zed** · **OpenAgents** (Apache-2.0, self-hostable shared workspace) · **Ace** (GitHub Next, prototype, not OSS) · Multica (source-available) · AgentHub/OpenSwarm (early).

## Takeaway for ICE

No mature, permissively-licensed, genuinely-OSS "shared team space for agentic coders" exists yet. The path is to **compose**: Yjs (multiplayer) + CodeMirror/Monaco (editor) + LiveKit (voice) + Gitea/isomorphic-git (source) + an ACP/MCP agent host — and to nail the **coordination layer** (presence, intent/locking, turn-taking for multiple agents in shared context), which is the genuine open gap and the moat.
