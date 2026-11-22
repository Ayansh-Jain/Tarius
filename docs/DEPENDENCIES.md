# ICE — Key Dependencies & Risks

The load-bearing third-party pieces ICE stands on, and what we're watching. See [DECISIONS.md](DECISIONS.md) for why each was chosen.

## ⚠️ Load-bearing risk: `y-codemirror.next`

- **What:** the Yjs ↔ CodeMirror 6 binding (`yCollab`, remote cursor rendering). It's how the editor becomes multiplayer — the heart of v0.1.
- **Risk:** the package has been **stale** (last release ~2 years ago) and historically shipped an unstamped license field. A core, unmaintained dependency on the most correctness-critical surface is a real liability (PM-council risk #5).
- **Mitigation / plan:**
  - **Pin it** (currently `0.3.5`) — never float.
  - **Vendor it** into the repo (e.g. `packages/vendor/y-codemirror`) so we control the source and can patch without waiting upstream.
  - Be ready to **co-maintain or fork** it as a first-class dependency.
  - Cover the binding behavior with our own tests so an upstream change (or our fork) can't silently regress live editing.
- **Status:** pinned. Vendoring tracked as a v0.1/v0.2 hardening task.

## Core stack

| Dependency | Role | License | Notes |
|---|---|---|---|
| **yjs** | CRDT — single source of truth for open files | MIT | The one CRDT engine (no Automerge; ADR-003) |
| **y-protocols** | awareness (presence/cursors) | MIT | Pairs with yjs |
| **@hocuspocus/server**, **@hocuspocus/extension-sqlite** | Yjs sync server + durable room persistence | MIT | v4.x; SQLite-backed durability |
| **@hocuspocus/provider** | client sync + auto-reconnect | MIT | Reconnection-without-data-loss for free |
| **codemirror** (+ `@codemirror/*`) | editor surface | MIT | CodeMirror 6; not a VS Code fork (ADR-002) |
| **y-codemirror.next** | Yjs↔CM6 binding | MIT (pinned) | See risk above |
| **react**, **react-dom** | web UI | MIT | React 19 |
| **vite**, **@vitejs/plugin-react** | web build/dev | MIT | |
| **tailwindcss** | styling | MIT | v3 |
| **hono**, **@hono/node-server** | server REST API | MIT | Lightweight |
| **jose** | JWT signing (sessions, room/invite tokens) | MIT | |
| **better-sqlite3** | SQLite (via Hocuspocus extension) | MIT | Native; prebuilt binaries |
| `node:sqlite` | metadata DB | (Node core) | Built into Node 22 — no native compile |

## Planned (later releases)

- **LiveKit** (Apache-2.0) — voice rooms (v1.0).
- **isomorphic-git** + **node git-http-backend** (MIT) — bundled git server (v0.3).
- **node-pty** + **xterm.js** (MIT) — shared terminal (v0.5).
- **ACP** / **MCP** clients — agent integration (v0.5+).

## Policy

- Prefer **permissive (MIT/Apache)** deps; avoid pulling copyleft into the distributed product (keeps ICE's own Apache-2.0 clean).
- Pin anything load-bearing; vendor anything load-bearing **and** unmaintained.
- Reuse mature OSS over rebuilding (git forge → Forgejo at v2; CRDT → Yjs; voice → LiveKit).
