# ICE — Integrated Collaborative Environment

> The open-source collaborative IDE where you and your friends — human **and** AI — code together in one shared, live workspace.

ICE is a self-hostable collaborative coding environment built around four pillars:

1. **🤖 Chat with AI agents** — talk to a coding agent (or several) that can read, write, and run code _inside the shared workspace_, not in an isolated sandbox.
2. **🎙️ Talk to your team** — voice rooms, group chat, and DMs, built in. No second app.
3. **👥 Code together, live** — real-time collaborative editing (CRDT-backed) with presence, shared cursors, and shared terminals.
4. **🪐 Own your stack** — one self-hostable server that ships with its **own git server**. Your code, your infra, forever.

**The thesis:** most "multi-agent coding" tools _isolate_ agents in separate git worktrees and make humans merge afterward. ICE does the opposite — humans and agents share **one live workspace**, the way Figma made design multiplayer. See [docs/VISION.md](docs/VISION.md).

---

## Status — v2.0, roadmap complete ✅

All six releases are shipped, tagged, and verified end-to-end:

| Release | Theme | What it added |
|---|---|---|
| **v0.1** | Two friends, one live file | CodeMirror 6 + Yjs live multiplayer editing, named cursors, durable rooms (SQLite), auth + invite links, one-command self-host |
| **v0.3** | Git comes home | Bundled smart-HTTP **git server** (`git clone` your room) + the **CRDT↔git convergence seam** (commits projected from the doc), file tree + source control |
| **v0.5** | Your first AI teammate | An AI agent via the **ACP↔Yjs adapter** — edits *through* the doc (attributable, undoable), an **approval gate**, and a **shared terminal** |
| **v1.0** | Code with friends, out loud | **LiveKit voice** + group/DM **chat** + in-UI git + one-click **agent rollback** + preview + hardening (OIDC/Postgres/roles, self-host docs) |
| **v1.5** | A squad of agents | **Orchestrator** routing subtasks to specialist roles, **multiple agents co-editing** concurrently, per-agent **policies**, **MCP** palette, opt-in **snapshots** |
| **v2.0** | Scale out and integrate | Redis **horizontal scale-out**, **audit log**, optional **Forgejo** + **Helm** chart, governance + RFC + threat model, community extension surface |

**Verification:** ~198 server tests + per-release e2e checks (`apps/web/scripts/*-check.mjs`), `pnpm typecheck`/`build` clean, `docker compose config` valid.
Decisions: [docs/DECISIONS.md](docs/DECISIONS.md) · Roadmap: [docs/ROADMAP.md](docs/ROADMAP.md) · Per-release specs: [plans/releases/](plans/releases/) · Resuming work? [docs/AGENT_HANDOFF.md](docs/AGENT_HANDOFF.md) · Live log: [PROGRESS.md](PROGRESS.md).

> Some capabilities need a real external service to exercise at runtime (a LiveKit SFU for audio, an IdP for OIDC, Postgres, a Redis cluster, a real ACP agent binary + key). These are wired + unit-tested and **bring-your-own** at deploy time; CI verification uses a built-in mock agent and the single-node defaults.

## Repository layout

```
apps/
  web/            # Browser client (editor, chat, voice, agent panel)
  server/         # Realtime + API + AI agent host + git server
packages/
  shared/         # Shared types & protocol definitions
docs/             # Vision, competition, architecture, roadmap, decisions, handoff
plans/releases/   # One spec per release (v0.1 … v2.0)
PROGRESS.md       # Running build log (updated every tick)
```

## Quickstart (self-host)

> Target experience (not yet wired up): `docker compose up` → open `http://localhost:3000` → create a room → invite friends and agents.

## License

**Apache-2.0** — one permissive license across the whole repo, with DCO (no CLA). Forkable forever, self-host forever. See [LICENSE](LICENSE), [CONTRIBUTING.md](CONTRIBUTING.md), and [GOVERNANCE.md](GOVERNANCE.md).
