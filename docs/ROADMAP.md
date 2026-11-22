# ICE — Roadmap (v0.1 → v2.0)

> Ratified by the PM council (2026-05-31). Each release is **independently demoable**; dependencies flow forward. Detailed per-release specs live in [`plans/releases/`](../plans/releases/). Build in order.

> **✅ All six releases below are SHIPPED + tagged (`v0.1`…`v2.0`).** → **Next arc: [v3 Roadmap — "Trust the squad"](ROADMAP_V3.md)** (v2.1 → v2.2 → v2.3 → v3.0; *planned, not built*). v3 closes the documented debt and deepens the multi-agent moat without bloat — prove the workspace survives real agents overnight without losing code.

**Ordering principle:** prove durable shared editing → own the source (git) → land the seam (CRDT↔git) before any agent → one trustworthy agent → the lovable human core (voice/chat) → many agents → scale & govern.

| Version | Theme | What's demoable |
|---|---|---|
| **v0.1** | Two friends, one live file | Open a link → see your friend's named cursor moving in the same file, durably, on a one-command self-host |
| **v0.3** | Git comes home | `git clone/push/pull` to a server that ships in the box; multi-file project tree; the owned CRDT↔git seam |
| **v0.5** | Your first AI teammate | Watch ONE agent type *into the same buffer you're in*, with attribution, an approval gate, and a shared terminal |
| **v1.0** | Code with friends, out loud | The lovable core complete: voice + chat beside live code, in-UI git, rollback, preview, hardened self-host |
| **v1.5** | A squad of agents | Multiple agents co-editing one tree with a router (architect/coder/debugger), permissions, human-vs-agent blame |
| **v2.0** | Scale out & integrate | Horizontal sync scale-out, optional Forgejo, community MCP surface, formal governance |

---

## v0.1 — Two friends, one live file
**Goals:** the 10-second wow (link → two cursors in one file); durable shared editing on one-command self-host; the server-side workspace substrate every later pillar stands on.
**Features:** server-side workspace on a real filesystem · CodeMirror 6 + `y-codemirror.next` shared editing with multiplayer cursors/selections/presence · Hocuspocus sync server with durable rooms (SQLite) surviving restart · share-a-room-by-link invite links + basic email/password (no mandatory account) · reconnection without lost edits · `docker compose up` (web + server), zero config, secrets auto-generated · Apache-2.0 + DCO, no CLA.

## v0.3 — Git comes home
**Goals:** make Pillar 4 literally true (clone/push/pull to a git server in the box, no external forge); establish the **CRDT↔git boundary as a single owned module**; give the workspace a real multi-file shape.
**Features:** bundled smart-HTTP git server (`isomorphic-git` + `node git-http-backend`) over bare repos · SSH keys / tokens for git auth · per-room repos with a synced file tree (create/rename/delete) · live doc↔working-tree sync with explicit flush-to-disk + commit semantics (the owned module) · branches + commit history in-app · hardened compose self-host.

## v0.5 — Your first AI teammate
**Goals:** land Pillar 1 single-agent (agent types into the same buffer, as a participant with its own cursor); solve correctness for ONE writer-agent before any concurrency; ship the trust layer.
**Features:** ACP client connecting ONE agent (Claude Code/Codex/Gemini), BYO-key, out-of-process · agent as a named participant, every edit an origin-tagged Yjs transaction (distinct, attributable, one-click undo) · agent chat panel docked to the editor, referencing files/lines · live tool-call / proposed-diff stream with approve / interrupt before destructive actions · shared server-side terminal (`node-pty` + `xterm.js`) + built-in read/write/run tools · per-workspace branch with agent edits attributed in commits.

## v1.0 — Code with friends, out loud
**Goals:** complete Pillar 2 (voice + chat co-located with live code); reach "a squad can live in it"; make agent contributions trustworthy for daily use.
**Features:** LiveKit voice rooms scoped to workspace (push-to-talk, per-user mute, talking indicators; no video) · group + DM text chat (threaded, Yjs-backed) with code-snippet and file/line embeds · in-UI git (branch/stage/diff/commit/push) with agent commit attribution · checkpoint / one-click rollback of an agent's changes + branch-aware diff review + in-app merge gate · shared dev-server preview pane · OIDC / BYO-IdP + optional Postgres + per-workspace roles · hardened self-host (single compose, one-page docs, backup/restore).

## v1.5 — A squad of agents
**Goals:** deliver "multiple agents working together" (the moat) only now that the single-agent loop is loved; treat one→many as a concurrency/permissions problem on the existing origin-tagged foundation, not a rewrite; keep agents legible.
**Features:** multiple ACP agents co-editing concurrently with distinct identities/colors + per-agent attribution · orchestrator routing subtasks to specialist roles (architect/coder/debugger, Kilo-style) working IN the shared workspace (watch & interrupt) · per-agent permission policies (allow/deny per tool, per path) + propose-then-apply for large refactors · MCP tool palette (workspace-scoped) · diff/blame distinguishing human vs each agent · opt-in agent branch/snapshot "try it safely" mode that merges back into the room.

## v2.0 — Scale out and integrate
**Goals:** hold up under bigger teams and longer-lived workspaces (the hard CRDT-fanout problem, correctly deferred to here); integrate with the ecosystem without rebuilding it; codify "forkable forever."
**Features:** horizontal scale-out of the sync layer (multi-node Hocuspocus / y-sweet swap) · optional Forgejo integration · optional Helm chart (never the default) · community MCP/agent extension surface + audit log of agent actions · foundation formed (trademark + copyright transferred), public RFC process, security/threat-model docs · evaluate A2A now that shared-workspace coordination is proven.
