# ICE — Architecture

> Ratified stack (see [DECISIONS.md](DECISIONS.md)). This is the system every release builds against.

## System shape

```
┌──────────────────────────── apps/web (React 19 + Vite + Tailwind, SPA) ────────────────────────┐
│  CodeMirror 6 editor        Agent panel (chat,        Comms (chat/DM,      File tree / git UI    │
│  + y-codemirror.next        approval gate)            voice)                                     │
│  awareness: cursors/presence  ACP event stream         LiveKit client                            │
└──────────┬───────────────────────┬────────────────────────┬───────────────────────┬─────────────┘
           │ Yjs sync (ws)         │ agent events (ws)        │ WebRTC (LiveKit)      │ git smart-HTTP
┌──────────┴───────────────────────┴────────────────────────┴───────────────────────┴─────────────┐
│                                  apps/server (Node 22, TypeScript)                                │
│  Hocuspocus sync+persistence   ACP host (out-of-proc       LiveKit token        git-http-backend  │
│  (Yjs docs, awareness,         agents → Yjs writes,        service              + isomorphic-git   │
│   auth hook, durable rooms)    approval gate, MCP)                              (bare repos)       │
│  ───────────────────────────────────────────────────────────────────────────────────────────────│
│  ⭐ CRDT↔FS↔git convergence module (the owned seam)   Auth/sessions   SQLite (libSQL) persistence  │
│  node-pty shared terminal                                                                          │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
       docker compose: [ web ] [ server ] [ livekit ]  — one command, secrets auto-generated
```

## The three-sources-of-truth law (read this twice)

The single most important constraint in the system. There are three representations of "the code":

1. **Yjs document tree** — the live, in-memory CRDT. **THE source of truth for open files.**
2. **Server filesystem** — bare/working-tree files that terminals, builds, and the git server operate on.
3. **Git** — committed history.

Rules (enforced from v0.3, before any agent lands at v0.5):

- Edits — human **and** agent — flow **into the Yjs doc first**.
- **Agents never touch the raw filesystem**; they write **through** the Yjs doc (via the ACP↔Yjs adapter). Every agent edit is an **origin-tagged** Yjs transaction → attributable, undoable.
- The filesystem is **projected from** the Yjs doc by the convergence module on an explicit **flush** (e.g., before a build or commit), under a **lock**.
- Git commits are taken from the flushed working tree. Commit authorship carries the originating identity (human or which agent).

This module (`apps/server/src/convergence/`) is owned, small, and the most heavily tested code in the repo.

## Module boundaries

- **`packages/shared`** — the protocol/domain vocabulary shared by web + server: workspace/room model, file-tree node shapes, Yjs doc schema (which subdocs/maps exist), presence/awareness fields, agent event + approval types, chat message types, ACP/MCP shapes. No runtime deps beyond types + small pure helpers.
- **`apps/web`** — UI only. Talks to the server over: Yjs websocket (editing/presence/chat), ACP event websocket (agent stream + approvals), LiveKit (voice), git smart-HTTP. Holds no authority — the server is authoritative.
- **`apps/server`** — authoritative. Hosts Hocuspocus (Yjs sync+persistence+auth hook), the ACP agent host, the convergence module, the git-http server, the LiveKit token service, the shared terminal (node-pty), auth/sessions, and SQLite persistence.

## Yjs document model (v0 sketch — ratified per release)

One **room/workspace** ↔ one top-level Yjs document (or a Hocuspocus document per room), containing:

- `files: Y.Map<path, Y.Text>` — open file contents (the editable buffers).
- `tree: Y.Map` — the file-tree structure (create/rename/delete), metadata.
- `presence` — via the **awareness** protocol (not the doc): cursor, selection, name, color, kind=`human|agent`, agentId.
- `chat: Y.Array` — messages (channels/DMs as keyed arrays or subdocs).
- `agents: Y.Map<agentId, state>` — connected agents, current activity, pending approvals.

CodeMirror binds to a `Y.Text` via `y-codemirror.next`. Agent writes target the same `Y.Text` with a distinct transaction `origin` so the UI can render attribution and offer per-origin undo.

## Protocols (adopt, don't reinvent)

- **Yjs** — CRDT state + sync. **`y-protocols` awareness** — presence/cursors.
- **ACP (Agent Client Protocol)** — editor↔agent. ICE is an ACP **client** hosting external agent processes (Claude Code / Codex / Gemini), BYO-key.
- **MCP** — agent↔tools (workspace-scoped tools at v1.5).
- **Git smart-HTTP** — clone/push/pull. **LiveKit/WebRTC** — voice.

## The ACP↔Yjs adapter (first-class boundary, v0.5)

Off-the-shelf ACP agents assume raw filesystem access. The adapter is the seam that redirects agent file ops into Yjs transactions:

- Agent "read file" → served from the Yjs `Y.Text` (or flushed FS for binary).
- Agent "write/edit file" → applied as an origin-tagged Yjs transaction (shows live, attributable, undoable).
- Agent "run command" → routed to the shared `node-pty` terminal after a flush; output streamed to all participants.
- Destructive/large actions → gated behind the **approval gate** (approve/interrupt) before they land.
- Escape hatch (v1.5): an opt-in snapshot/branch mode for agents that genuinely need isolated FS access, merged back into the room.

## Deployment

Single `docker-compose.yml`: `web`, `server`, `livekit`. Secrets auto-generated on first boot; zero required env file; telemetry off by default; air-gappable. SQLite by default (a volume); Postgres opt-in for teams (v1.0). Optional Helm chart only at v2.

## Build/runtime conventions

- TypeScript end-to-end; ESM; Node 22; React 19.
- pnpm workspaces + Turborepo; `packages/shared` is the dependency root.
- Server is the authority; the client is replaceable. Keep the protocol in `packages/shared` so alternate clients (or a future TUI) stay possible.
