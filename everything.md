# EVERYTHING ABOUT THIS PROJECT — ICE (Integrated Collaborative Environment)

> One file that explains the whole project: the problem, the design, how it looks, how it works, every technology used, how to run it, and a checklist of what to put in your college major-project report.
>
> Everything below was derived from the actual source in this repository (`apps/`, `packages/`, `docs/`, `plans/`, `server.py`, `engine_v2.py`, `docker-compose.yml`, etc.).

---

## TABLE OF CONTENTS

1. [Project at a glance](#1-project-at-a-glance)
2. [Problem statement](#2-problem-statement-system-design)
3. [Objectives and scope](#3-objectives-and-scope)
4. [Features (all of them)](#4-features-all-of-them)
5. [System design / architecture](#5-system-design--architecture)
6. [How things look (UI)](#6-how-things-look-ui)
7. [How things work (flows)](#7-how-things-work-flows)
8. [Tech stack (every single piece)](#8-tech-stack-every-single-piece)
9. [Repository structure](#9-repository-structure)
10. [Data design](#10-data-design)
11. [API reference](#11-api-reference)
12. [Security design](#12-security-design)
13. [Deployment and scaling](#13-deployment-and-scaling)
14. [Testing and verification](#14-testing-and-verification)
15. [Release history and roadmap](#15-release-history-and-roadmap)
16. [How to run it](#16-how-to-run-it)
17. [Known limitations (be honest in the report)](#17-known-limitations-be-honest-in-the-report)
18. [WHAT TO ADD IN THE COLLEGE MAJOR PROJECT REPORT](#18-what-to-add-in-the-college-major-project-report)
19. [Viva questions and answers](#19-viva-questions-and-answers)
20. [Glossary](#20-glossary)

---

## 1. Project at a glance

| Item | Detail |
|---|---|
| **Name** | **ICE — Integrated Collaborative Environment** |
| **One-liner** | "The open-source Google Docs for code": one self-hostable live workspace where a squad of humans **and AI agents** edit the same repo in real time, talk over voice/chat, and ship from a git server that runs in the same `docker compose up`. |
| **Type** | Full-stack web application (monorepo), real-time collaborative IDE |
| **Languages** | TypeScript (almost everything), Python (code-conversion service), SQL, YAML, Nginx conf, shell |
| **License** | Apache-2.0 (with DCO, no CLA) |
| **Package manager / build** | pnpm 9.12 workspaces + Turborepo; Node >= 20 (Docker image uses Node 22) |
| **Target users** | A squad of 2–8 people (hackathon team, student project group, small startup, open-source crew) |
| **Status** | Releases v0.1 → v2.0 shipped; v2.1 → v3.0 planned ("Trust the squad") |
| **Bundled extra module** | **Altern** — a code-translation service (C++ ⇄ Java ⇄ Python ⇄ JavaScript) in Python/FastAPI plus a TypeScript bridge, used by the "Convert" dialog inside ICE |

### The four pillars

1. **AI agents in the room** — chat with one or several coding agents that act *inside* the shared workspace (not in an isolated sandbox).
2. **Human comms in-app** — voice rooms (LiveKit), group chat, DMs.
3. **Real-time collaborative coding** — CRDT (Yjs) editing, presence, named cursors, shared terminal.
4. **Own your stack** — a self-hostable server with its **own git server**; one command to run.

---

## 2. Problem statement (system design)

### 2.1 The problem

Modern AI coding tools split into two shapes:

- **Isolation:** each AI agent gets its own git worktree/container/branch. A human merges the results later. Agents never see each other or the humans' live edits, so there is no real collaboration and merge conflicts pile up.
- **Shared:** humans and multiple agents work in *one* live workspace (like Figma/Google Docs for design/text). This is the frontier, and it is mostly unbuilt in open source.

At the same time, a student/startup team today needs **four separate tools**: an editor (VS Code + Live Share), an AI assistant (Copilot/Claude/ChatGPT in another window), a chat/voice app (Discord/Slack), and a git host (GitHub). Context is fragmented, there is vendor lock-in, and the AI cannot see what teammates are typing *right now*.

### 2.2 The hard system-design problem

> **How do you let several humans and several AI agents edit the same codebase at the same moment — without ever losing code, without conflicts, with every change attributable and reversible — while also keeping a terminal, a build, and git history consistent with what is on screen?**

Concretely the design must solve:

| # | Sub-problem | Why it is hard |
|---|---|---|
| 1 | **Concurrent edit conflict resolution** | Two people (or a person and an agent) type in the same line at the same time. Last-write-wins loses work. |
| 2 | **Three sources of truth** | The live buffer (Yjs doc), the server filesystem (what terminals/builds see) and git history can silently diverge. "A collaborative IDE that loses your code" is the fatal failure. |
| 3 | **Making off-the-shelf AI agents collaborative** | Agents (Claude Code, Codex, Gemini CLI) assume raw filesystem access. They must be redirected to write *through* the shared document. |
| 4 | **Trust and safety of agents** | Agents can run commands and delete files. Need approval gates, per-agent policies, attribution, and one-click rollback. |
| 5 | **Presence and real-time awareness** | Everyone must see who is where (named, colored cursors; humans vs agents). |
| 6 | **Voice + chat without a second app** | Needs WebRTC infrastructure (SFU) and token-based room access. |
| 7 | **Own your stack** | Bundled git smart-HTTP server, SQLite by default (zero config), Docker one-command deploy, secrets auto-generated, air-gappable. |
| 8 | **Scale-out** | A second server replica without a shared bus silently diverges; need Redis pub/sub for rooms. |
| 9 | **Language migration inside the IDE** | Users want to convert a file between C++/Java/Python/JavaScript without leaving the workspace (Altern module). |

### 2.3 The design answer (summary)

- **Yjs CRDT** as the single source of truth for open files → conflict-free merging.
- **"Three-sources-of-truth law" (ADR-000):** edits go into the Yjs doc first; agents never touch the raw filesystem; the filesystem is *projected from* the doc on explicit flush under a per-room lock; git commits are taken from the flushed tree.
- **ACP↔Yjs adapter:** agent file reads/writes are intercepted and turned into origin-tagged Yjs transactions (so they are attributable and individually undoable); agent commands go to a shared terminal; destructive actions go through an **approval gate**.
- **Hocuspocus** for sync + persistence, **LiveKit** for voice, **isomorphic-git / node-git-server** for git, **Hono** for REST, **SQLite** by default, **Docker Compose** for deploy.

---

## 3. Objectives and scope

### Objectives
1. Build a browser-based collaborative code editor with live multi-user editing and presence.
2. Integrate AI coding agents as first-class, attributable, approvable participants.
3. Provide in-app voice, group chat and DMs.
4. Provide a built-in git server and in-UI git operations (commit, branches, history, rollback).
5. Make the whole system self-hostable with one command and secure by default.
6. Provide code-language conversion (Altern) as an additional productivity module.
7. Keep the system testable, documented and extensible (extension API, MCP tools, RFC process).

### In scope
Real-time editor, file tree, chat, voice, agent panel/orchestrator/squad, policies, snapshots, git, shared terminal, preview pane, audit log, auth (email/password, guest, invite links, OIDC), roles, Redis scale-out, Docker/Helm deploy, code conversion.

### Explicitly out of scope (the "anti-bloat charter")
VS Code fork / extension marketplace, own forge (issues/PRs/CI), own AI model, video/screen share, native mobile/desktop apps, enterprise SSO/SAML/RBAC matrices, billing/multi-tenant SaaS, Kanban/wiki, mandatory accounts or telemetry.

---

## 4. Features (all of them)

### 4.1 Real-time collaboration
- Live multi-user editing in **CodeMirror 6**, bound to **Yjs** with `y-codemirror.next`.
- Named, colored remote cursors and selections (awareness protocol); participants tagged `human` or `agent`.
- Durable rooms: a room survives a server restart (Yjs doc persisted to SQLite).
- File tree (create/rename/delete), multiple files per room, import files.
- Resizable panels, dark theme (`@codemirror/theme-one-dark`).

### 4.2 Auth, rooms, invites
- Register / login with email + password (salted **scrypt**), **guest** login, logout, `me`.
- Room creation; **signed invite links** (bearer tokens, optional expiry) — join without an account.
- Session = signed **JWT (HS256, jose)** in an `ice_session` cookie.
- **Roles per workspace:** `owner` and `member`.
- Optional **OIDC** (openid-client) login; optional **Postgres** instead of SQLite.

### 4.3 AI agents
- **Agent host** that runs agents out-of-process through **ACP** (Agent Client Protocol, `@zed-industries/agent-client-protocol`), bring-your-own-key (Claude Code / Codex / Gemini).
- **ACP↔Yjs adapter**: agent edits become origin-tagged Yjs transactions.
- **Approval gate**: destructive actions (e.g. delete file) wait for human **approve / reject**.
- **Mock agent backend** for deterministic tests and demos (no API key needed).
- **Agent chat transcript** stored in the Yjs doc.
- **Per-origin undo / "RollbackBar"**: revert one agent's changes without touching humans' edits.

### 4.4 Multi-agent "Squad" (v1.5)
- **Orchestrator** with a **planner** that splits a request into subtasks and routes them to specialist roles: `architect`, `coder`, `debugger`, `reviewer`.
- Multiple agents **co-edit concurrently** with distinct identities/colors.
- **Per-agent policies** (allowed tools, writable paths, require-approval rules) with an `enforce()` decision engine.
- **MCP tool palette** (`@modelcontextprotocol/sdk`) — workspace tools agents can call.
- **Snapshots** ("try it safely" branch) with merge / discard.
- **Blame view**: which human/agent wrote which lines.
- **Task document** (`tasks` in Yjs) tracking tasks and subtasks.

### 4.5 Communication
- **Voice rooms** via **LiveKit** (server mints JWT tokens; client uses `livekit-client`): mute, push-to-talk, talking indicators; no video by design.
- **Group chat + DMs** stored as Yjs `channels`.

### 4.6 Git (own your stack)
- Bundled **git smart-HTTP server** (`git clone` your room), bare repos per room.
- **Convergence module**: projects Yjs → filesystem → git commits with authorship (human or agent); loads room from git on first open.
- In-UI **Git panel**: commit, branches, commit log; **Source Control** view.
- Optional **Forgejo** compose override for a full forge.

### 4.7 Shared terminal and preview
- **Shared terminal** (node-pty with a child-process fallback) streamed into the doc and rendered with **xterm.js** for every participant.
- **Preview pane** / workspace preview for running web output.

### 4.8 Operations and governance
- **Audit log** (`GET /audit`): who/what did what (orchestrate, commit, snapshot-merge, agent actions).
- **Redis** horizontal scale-out (optional via `REDIS_URL`).
- **Extension surface** (manifest + loader) for community extensions.
- **Docker Compose** (web + server + livekit), **Helm chart**, **Nginx** edge, healthchecks, auto-generated session secret.
- Governance docs: `GOVERNANCE.md`, `SECURITY.md`, `docs/THREAT_MODEL.md`, RFC process, A2A evaluation (declined for now).

### 4.9 Altern — code conversion module
- Convert code between **C++, Java, Python, JavaScript** (the Python service also handles TypeScript).
- Pipeline: **local rule-based structural engine** (`engine_v2.py`) → syntax-checked with real toolchain → if it fails, **Gemini** backup (`GEMINI_CONVERT_API_KEY`).
- UI: `ConvertDialog` with an API-status chip (`working` / `unavailable` / `not_configured` / `checking`).
- Standalone FastAPI service (`server.py`) adds: `/translate`, `/execute` (run code with stdin), `/ws/execute` (interactive run over WebSocket), LRU cache, optional local DeepSeek-Coder/Ollama model path.

---

## 5. System design / architecture

### 5.1 High-level architecture

```
┌──────────────────────── apps/web  (React 19 + Vite + Tailwind SPA) ────────────────────────┐
│ CodeMirror 6 editor   Agents / Squad panel   Chat + Voice   Git panel   Terminal (xterm)     │
│ + y-codemirror.next   (approvals, blame)     (LiveKit)      Preview     Convert dialog       │
│ presence/cursors via Yjs awareness                                                           │
└──────┬───────────────────┬─────────────────────┬──────────────────┬──────────────┬──────────┘
       │ Yjs sync (WS /sync)│ REST /api/*         │ WebRTC           │ git smart-HTTP│
       │                    │                     │ (LiveKit)        │               │
┌──────┴────────────────────┴─────────────────────┴──────────────────┴──────────────┴──────────┐
│                        apps/server  (Node 22 + TypeScript, ONE port :8080)                    │
│  Hocuspocus (Yjs sync,      Hono REST API        Agent host (ACP) +     LiveKit token   git   │
│  awareness, persistence,    (auth, rooms,        ACP↔Yjs adapter +      service         server│
│  auth hook)                 invites, agents,     approval gate + MCP                          │
│                             git, convert, audit)                                              │
│  ─────────────────────────────────────────────────────────────────────────────────────────── │
│  ⭐ Convergence module (Yjs ⇄ filesystem ⇄ git, per-room lock)                                │
│  Orchestrator/Planner/Squad · Agent policy · Snapshots · Terminal (node-pty) · Roles · Audit  │
│  SQLite (ice.sqlite metadata + ydoc.sqlite Yjs docs)  |  optional Postgres  |  optional Redis │
└───────┬──────────────────────────────┬───────────────────────────────┬──────────────────────┘
        │ spawn python                 │ child processes (agents/MCP)  │ HTTPS
┌───────┴──────────────┐      ┌────────┴─────────────┐        ┌────────┴──────────────┐
│ convert_cli.py       │      │ external ACP agents  │        │ Gemini API (backup    │
│ engine_v2.py (rules) │      │ (Claude/Codex/Gemini)│        │ code conversion)      │
└──────────────────────┘      └──────────────────────┘        └───────────────────────┘

Docker Compose:   [ web (nginx :3000) ] ──► [ server (:8080, internal) ]   [ livekit :7880-7882 ]
```

### 5.2 The "Three Sources of Truth" law (the most important design rule)

```
 Human typing ─┐                               ┌──► Terminal / builds read files
               ├──► (1) YJS DOCUMENT  ──flush──┤        (2) SERVER FILESYSTEM
 Agent edits  ─┘   (live CRDT, THE truth)      │            │ commit under room lock
 (via adapter)                                  └────────────▼
                                                       (3) GIT history
```

1. Edits (human **and** agent) enter the **Yjs doc first**.
2. **Agents never write the raw filesystem.** They write through the adapter as **origin-tagged** transactions → attributable + undoable.
3. The filesystem is **projected from** the doc on an explicit **flush**, under a **per-room async FIFO mutex** (`convergence/lock.ts`).
4. Git commits are taken from the flushed tree; commit authorship carries the originating identity.

### 5.3 Module boundaries

| Module | Responsibility |
|---|---|
| `packages/shared` | The contract: types + Yjs schema + helpers shared by web and server (protocol, ydoc, agent, comms, git, orchestration, audit). |
| `apps/web` | UI only. Holds **no authority**; server is authoritative. |
| `apps/server` | Authoritative: sync, auth, REST, agents, git, terminal, voice tokens, audit, scale. |
| `apps/server/src/convert` | Bridge from Node to Python engine + Gemini fallback. |
| root `server.py` + `engine_v2.py` | Standalone Altern FastAPI translation/execution service and its rule engine. |

### 5.4 Yjs document model (one room = one Y.Doc)

| Key | Type | Content |
|---|---|---|
| `files` | `Y.Map<path, Y.Text>` | Editable file buffers (the truth for open files) |
| `tree` | `Y.Map` | File-tree structure and metadata |
| `meta` | `Y.Map` | Room metadata/settings |
| `chat` | `Y.Array` | Chat messages |
| `channels` | `Y.Map` | Group + DM channels (`{meta, messages}`) |
| `agents` | `Y.Map` | Connected agents + live state + pending approvals |
| `agentChat` | `Y.Array` | Agent prompt/reply transcript |
| `tasks` | `Y.Map` | Orchestrator tasks + subtasks |
| `audit` | `Y.Array` | Audit trail |
| `terminal` | `Y.Text` | Shared terminal output mirror |
| *(awareness)* | y-protocols | Presence: participant (name, color, kind human/agent, agentId) + cursor |

### 5.5 Key design decisions (ADRs, summarised)

| # | Decision | Why |
|---|---|---|
| 000 | Three-sources-of-truth law | Prevents lost code |
| 001 | Shared live workspace, not per-agent isolation | The product's differentiator |
| 002 | CodeMirror 6, not a VS Code fork | Light, web-native, first-class Yjs binding, no marketplace/licence risk |
| 003 | Yjs + Hocuspocus | One mature CRDT; y-sweet only as future scale swap |
| 004 | Agents via ACP client, write through Yjs, MCP for tools | Model-agnostic, BYO-key, no bundled model |
| 005 | LiveKit voice, no video | Don't hand-roll WebRTC |
| 006 | Chat/presence reuse Yjs layer | No separate chat DB |
| 007 | isomorphic-git + git-http-backend | Own git without building a forge |
| 008 | SQLite default, Postgres opt-in | Zero-config self-host |
| 009 | Email/password + invite links, OIDC later | Squads, not enterprises |
| 010 | Single docker-compose | One command to run |
| 011 | Apache-2.0 | Forkable forever |
| 012 | TypeScript everywhere | One toolchain |

### 5.6 Design patterns used (good for the report)
- **Single source of truth + event projection** (Yjs → FS → git).
- **Adapter pattern** (ACP↔Yjs adapter).
- **Strategy / dependency injection** (`TerminalRunner`, `RoleStore`, agent backends injected via interfaces).
- **Registry** (PolicyRegistry, McpRegistry, agent registry).
- **Mutex / critical section** (per-room FIFO lock).
- **Chain of responsibility / fallback** (local engine → Gemini).
- **Pub/Sub** (Redis extension for multi-node).
- **Pipeline** (planner → orchestrator → squad agents).
- **Mock object** (MockAgentBackend for testing).

---

## 6. How things look (UI)

### 6.1 Screens
| Screen | Component | What the user sees |
|---|---|---|
| **Landing** | `Landing.tsx` | Pick a display name/identity, create a room, or login/register/guest |
| **Home / Start page** | `Home.tsx`, `StartPage.tsx` | List of remembered rooms, "create room", join via link |
| **Room (main IDE)** | `Room.tsx`, `App.tsx` | The workspace described below |

### 6.2 The room layout (wireframe)

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ TopBar: room name · presence avatars (humans + agents) · RollbackBar · SnapshotBar · ✦Convert│
├───────────┬───────────────────────────────────────────────────────────┬──────────────────┤
│ File tree │  CodeMirror 6 editor (dark theme, syntax highlight)        │ Right rail tabs: │
│           │  • remote named cursors (colored)                          │  🤖 Agents       │
│  src/     │  • agent edits show as attributed, colored changes         │  🌐 Squad        │
│   main.ts │                                                            │  💬 Chat         │
│   utils/  │                                                            │  🌿 Git          │
│           │                                                            │  🎙 Voice        │
│           │                                                            │  🕘 Blame        │
│           ├───────────────────────────────────────────────────────────┤  👁 Preview      │
│           │  Shared Terminal (xterm.js) — everyone sees the same output│                  │
└───────────┴───────────────────────────────────────────────────────────┴──────────────────┘
```
Panels are resizable (`Resizer.tsx`). Icons come from **lucide-react** (Bot, Network, MessageSquare, GitBranch, Mic, History, Eye, TerminalSquare, Languages…).

### 6.3 Panels in detail
- **Agents panel:** start an agent, chat with it, see its status, **Approve / Reject** buttons when an action awaits approval.
- **Squad panel:** enter a goal → orchestrator shows the plan (task + subtasks per role), progress, interrupt button.
- **Chat panel:** group channels + DMs.
- **Git panel:** commit message box, branch list, commit log.
- **Voice panel:** join/leave voice, mute, push-to-talk, talking indicators.
- **Blame view:** per-line attribution (human vs agent).
- **Preview pane:** rendered output of the workspace.
- **Convert dialog:** choose source & target language (C++/Java/Python/JavaScript), convert the current file, shows backup-API status chip.
- **Snapshot bar:** create / merge / discard a safe "try it" snapshot.
- **Rollback bar:** undo the last changes made by a specific agent.

### 6.4 Visual style
Tailwind CSS 3, dark IDE theme, per-participant deterministic colors (`color.ts`), accessible tooltips and icon buttons (`ui.tsx`).

> **Report tip:** take real screenshots of each screen above and number them (Fig 6.1, 6.2 …).

---

## 7. How things work (flows)

### 7.1 Joining a room and live editing
1. User opens `/r/<roomId>` (or an invite link). Identity (name/color) is stored in the browser.
2. Web calls `POST /api/rooms/:id/access` (with invite/session) → server returns a **room token** (JWT).
3. `@hocuspocus/provider` opens a WebSocket to `/sync` with the token; the Hocuspocus **auth hook** (`realtime.ts`) validates it and stamps the participant on the connection.
4. The server loads the room's Y.Doc from `ydoc.sqlite` (or seeds from git via `loadRoomFromGit`).
5. CodeMirror binds to `Y.Text` with `y-codemirror.next`; awareness publishes cursor/identity.
6. Every keystroke → Yjs update → broadcast to all clients → persisted. Concurrent edits **merge automatically** (CRDT).

### 7.2 AI agent edit (the ACP↔Yjs adapter)
```
User message ─► POST /api/rooms/:id/agent/message
                  │
          Agent host (per room+agent)
                  │ backend (ACP agent process or Mock)
                  ▼ emits AgentEvents (message / edit / tool-call / status)
          YjsAgentAdapter  ← the ONLY place intents become effects
             ├─ read file     → from Y.Text
             ├─ write/edit    → origin-tagged Y.Transaction ⇒ appears live, attributable, undoable
             ├─ run command   → flush ➜ shared terminal (node-pty) ⇒ output streamed to all
             └─ destructive?  → status "awaiting-approval" ──► human clicks Approve/Reject
                                  (POST /agent/approve) ──► apply or discard
```

### 7.3 Multi-agent squad (orchestrator)
1. `POST /api/rooms/:id/orchestrate` with a goal.
2. **Planner** decomposes into subtasks and assigns roles (architect, coder, debugger, reviewer).
3. **Squad** spins up distinct agents; each works concurrently, writing through the doc.
4. **Task doc** (`tasks`) records progress; `POST .../orchestrate/interrupt` stops it.
5. **Policies** (per agent: allowed tools, writable paths, approval rules) are decided by `enforce()`; actions recorded in the **audit** log.
6. **Snapshots** let the squad try a risky change on a branch and merge/discard.

### 7.4 Git convergence (commit)
1. User clicks **Commit** → `POST /api/rooms/:id/commit`.
2. Convergence module takes the **per-room lock**.
3. **Flush:** write every Yjs file to the room working tree on disk (`data/repos/worktrees/<room>`).
4. `git add` + `commit` with author = originating identity (human/agent) into the bare repo `data/repos/<room>.git`.
5. Lock released. `GET /branches` and `GET /commits` read history. External users can `git clone http://host/…`.

### 7.5 Voice
1. Client calls `POST /api/rooms/:id/voice/token` (session-aware identity).
2. Server uses `livekit-server-sdk` to sign a LiveKit JWT for that room.
3. Browser connects to the LiveKit SFU (`:7880`, UDP `:7882`) with `livekit-client`.

### 7.6 Code conversion (Altern)
```
UI ConvertDialog ──POST /api/convert {code, from, to}──► Hono route
   │                         (limit 60,000 chars, 4 languages)
   ▼
convertCode():
  1. spawn  python convert_cli.py  (stdin JSON → stdout JSON, 45 s timeout)
        engine_v2.full_translate(code, src, tgt)   # regex/structure based rule engine
        then SYNTAX CHECK with the real toolchain (node/python/g++/javac) or bracket balance
        → ok=false if it does not parse
  2. if manual failed/invalid → Gemini (models tried in order, retries, 429/5xx handling,
        temperature 0, output must be one fenced code block, then fences stripped)
  3. else → generic failure (the UI never reveals which path was used)
```
The standalone `server.py` (FastAPI, port 8000) offers `/translate` with: LRU cache (MD5 key) → optional local DeepSeek-Coder-1.3B (HuggingFace, bf16) → structural engine fallback (<5 ms), plus `/execute` and `/ws/execute` which run code in a temp dir with a 10 s timeout and a Node shim that adds `prompt/readline/alert/print`.

### 7.7 Scale-out
With `REDIS_URL` set, `maybeRedisExtension()` adds `@hocuspocus/extension-redis`; every replica publishes/subscribes document updates and awareness so two users on different replicas stay in sync. (Documented limitation: the convergence lock is process-local — planned fix in v2.1.)

---

## 8. Tech stack (every single piece)

### 8.1 Languages
TypeScript 5.7 · JavaScript (ESM) · Python 3 · SQL · YAML · Nginx config · Bash/sh · HTML/CSS · Markdown · Helm templates (Go templating).

### 8.2 Frontend (`apps/web`)
| Technology | Version (package.json) | Purpose |
|---|---|---|
| React | ^19 | UI library |
| Vite | ^6 + `@vitejs/plugin-react` | Dev server and bundler (vendor chunk splitting: react, yjs, codemirror) |
| Tailwind CSS | ^3.4 + PostCSS + Autoprefixer | Styling |
| CodeMirror 6 | `codemirror`, `@codemirror/{state,view,commands,language,lang-javascript,theme-one-dark}`, `@lezer/highlight` | Code editor |
| Yjs | ^13.6 | CRDT |
| `y-codemirror.next` | ^0.3.5 | CodeMirror ⇄ Yjs binding |
| `y-protocols` | ^1.0 | Awareness (presence) |
| `@hocuspocus/provider` | ^4.1 | WebSocket client for Yjs sync |
| `livekit-client` | ^2.19 | Voice (WebRTC) |
| `@xterm/xterm` + `@xterm/addon-fit` | ^6 / ^0.11 | Terminal emulator UI |
| `lucide-react` | ^1.77 | Icons |
| TypeScript | ^5.7 | Type safety |
| Custom router | — | `window.location` + `popstate` (no router library) |

### 8.3 Backend (`apps/server`)
| Technology | Purpose |
|---|---|
| Node.js 22 (>=20) + `tsx` | Runtime, runs TS directly |
| **Hocuspocus** (`@hocuspocus/server`) | Yjs WebSocket sync, persistence hooks, auth hook |
| `@hocuspocus/extension-sqlite` | Persist Yjs documents (`ydoc.sqlite`) |
| `@hocuspocus/extension-redis` + `ioredis` | Multi-node scale-out |
| **Hono** + `@hono/node-server` | REST API framework |
| **SQLite** (`better-sqlite3` native module) | Metadata DB (users, rooms, invites) |
| `pg` | Optional PostgreSQL store |
| `jose` | JWT sign/verify (HS256) |
| `node:crypto` scrypt | Password hashing |
| `openid-client` | OIDC login |
| `isomorphic-git` | Git operations in JS |
| `node-git-server` + system `git http-backend` | Git smart-HTTP server |
| `@zed-industries/agent-client-protocol` | ACP client for agents |
| `@modelcontextprotocol/sdk` | MCP tool servers/client |
| `node-pty` | Real PTY shared terminal (child-process fallback) |
| `livekit-server-sdk` | Mint voice tokens |
| `yjs` | Server-side doc manipulation |
| **Vitest** ^4 | Unit/integration tests |
| Python 3 subprocess | Code conversion engine |
| Gemini REST API (`generativelanguage.googleapis.com`) | Backup code conversion |

### 8.4 Shared package (`packages/shared`)
TypeScript source consumed directly (`workspace:*`): `protocol.ts`, `ydoc.ts`, `agent.ts`, `comms.ts`, `git.ts`, `orchestration.ts`, `audit.ts`. Only dependency: `yjs`.

### 8.5 Python service (Altern)
| Technology | Purpose |
|---|---|
| FastAPI + Uvicorn | HTTP + WebSocket service |
| Pydantic | Request/response models |
| `re` regex engine (`engine_v2.py`) | Rule-based structural translator, 20 language pairs |
| HuggingFace Transformers + PyTorch (optional) | Local DeepSeek-Coder-1.3B-instruct, bfloat16 |
| Ollama probe (optional) | Local LLM backend |
| `subprocess`, `tempfile`, `asyncio`, `threading`, `OrderedDict`, `hashlib` | Execution sandboxing, LRU cache, timeouts |

### 8.6 Infrastructure / DevOps
| Technology | Purpose |
|---|---|
| Docker + Docker Compose | `web`, `server`, `livekit` services, named volume `ice-data`, bridge network `ice` |
| Nginx | Serves SPA, proxies `/api` and WebSocket `/sync`, SPA fallback, `/healthz` |
| LiveKit server (`livekit/livekit-server`) | Voice SFU (ports 7880, 7881, 7882/udp) |
| Redis | Optional pub/sub for scale-out (`deploy/compose.scale.yml`) |
| Forgejo | Optional full git forge (`deploy/forgejo/compose.forgejo.yml`) |
| Helm chart (`deploy/helm/ice`) | Kubernetes deployment (server, web, livekit, redis, ingress, secret) |
| pnpm 9.12 workspaces + Turborepo | Monorepo build/test/typecheck orchestration with caching |
| GitHub templates | Issue/PR templates |
| Entrypoint script | Auto-generates and persists `ICE_SESSION_SECRET` |

### 8.7 Protocols and standards
Yjs CRDT sync protocol · y-protocols awareness · **ACP** (editor⇄agent) · **MCP** (agent⇄tools) · Git smart-HTTP · WebRTC (via LiveKit) · WebSocket · REST/JSON · JWT (HS256) · OIDC / OAuth2 · HTTP cookies.

### 8.8 Ports
| Port | Service |
|---|---|
| 3000 | Web (Nginx) — the only app port published |
| 8080 | Server (REST + `/sync` WebSocket), internal in Docker |
| 7880 / 7881 / 7882-udp | LiveKit |
| 8000 | Altern standalone FastAPI |
| ICE_GIT_PORT | Git server (configurable) |

### 8.9 Environment variables
`PORT`, `HOST`, `PUBLIC_URL`, `NODE_ENV`, `ICE_DATA_DIR`, `ICE_GIT_ROOT`, `ICE_GIT_PORT`, `DATABASE_URL`, `ICE_SESSION_SECRET`, `ANTHROPIC_API_KEY`, `ICE_AGENT_MODEL`, `ICE_YJS_PORT`, `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `REDIS_URL`, `ICE_MCP_SERVERS`, `GEMINI_CONVERT_API_KEY`, `GEMINI_CONVERT_MODEL`, `ICE_PYTHON`, `ICE_FORCE_PTY`.
> Never put real values for these in the report. `.env` is git-ignored and must stay private.

---

## 9. Repository structure

```
ice-main/
├─ apps/
│  ├─ web/                      React SPA
│  │  ├─ src/App.tsx, main.tsx, room/Room.tsx, editor/Editor.tsx
│  │  ├─ src/components/        AgentsPanel, SquadPanel, ChatPanel, VoicePanel, GitPanel,
│  │  │                         SourceControl, BlameView, FileTree, TerminalPane, PreviewPane,
│  │  │                         ConvertDialog, RollbackBar, SnapshotBar, TopBar, Landing, Home …
│  │  ├─ src/lib/               api, connection (Yjs provider), identity, chat, useAgents,
│  │  │                         useTree, voice, convert, squad, gitui, color, importFiles …
│  │  └─ scripts/               e2e check scripts (sync, git, agent, squad)
│  └─ server/
│     └─ src/
│        ├─ index.ts, api.ts, config.ts, auth.ts, oidc.ts, db.ts, db-postgres.ts
│        ├─ realtime.ts, room-doc.ts, repos.ts, roles.ts, v15.ts
│        ├─ agent/              host, adapter (ACP↔Yjs), acp-backend, mock-backend, types
│        ├─ agent-policy/       policy engine + snapshot
│        ├─ orchestrator/       planner, orchestrator, squad, task-doc
│        ├─ convergence/        convergence, git, lock  ← the owned seam
│        ├─ git/                git smart-HTTP server
│        ├─ terminal/           pty/child-process backends, room-terminal, ydoc-sink
│        ├─ voice/              LiveKit token
│        ├─ mcp/                registry, routes, config
│        ├─ audit/              recorder, routes
│        ├─ scale/              Redis extension, status
│        ├─ extensions/         community extension loader
│        └─ convert/            convert.ts + convert_cli.py + engine_v2.py
├─ packages/shared/             types + Yjs schema
├─ deploy/                      compose.scale.yml, forgejo compose, Helm chart
├─ docs/                        VISION, ARCHITECTURE, DECISIONS, THREAT_MODEL, SCALING, SELF_HOSTING,
│                               BACKUP, COMPETITION, ROADMAP(_V3), EXTENSIONS, INTEGRATIONS, RFCs …
├─ plans/releases/              v0.1 … v3.0 per-release specs
├─ scripts/                     docker-entrypoint.sh, gen-secrets.mjs, web-nginx.conf
├─ server.py, engine_v2.py      Altern standalone translation/execution service
├─ docker-compose.yml, turbo.json, pnpm-workspace.yaml, tsconfig.base.json
└─ README, PROGRESS, GOVERNANCE, SECURITY, CONTRIBUTING, LICENSE, NOTICE
```

---

## 10. Data design

### 10.1 Metadata DB (SQLite `ice.sqlite`, optional Postgres)
```sql
users   (id PK, email UNIQUE, display_name, password_hash, created_at)
rooms   (id PK, name, created_by, created_at)
invites (token PK, room_id FK→rooms ON DELETE CASCADE, created_by, expires_at, created_at)
-- index idx_invites_room(room_id)
-- roles (roomId, participantId, role: owner|member) via RoleStore (SQLite / Postgres / in-memory)
```
Password hash format: `scrypt:N:r:p:<saltHex>:<hashHex>`.

### 10.2 Document DB (`ydoc.sqlite`)
`documents(name varchar(255) UNIQUE, data blob)` — `name` = roomId, `data` = encoded Yjs state.

### 10.3 Git storage
`data/repos/<roomId>.git` (bare) and `data/repos/worktrees/<roomId>/` (flushed working tree). Snapshot branches live under `refs/heads/snapshots/...`.

### 10.4 Suggested ER diagram (for the report)
```
USER 1───* ROOM (created_by)        ROOM 1───* INVITE
USER *───* ROOM  (through ROLE: owner|member)
ROOM 1───1 YDOC  (files, tree, chat, channels, agents, tasks, audit)
ROOM 1───1 GIT REPO (bare) 1───* COMMIT / BRANCH / SNAPSHOT
YDOC 1───* AGENT 1───* POLICY
YDOC 1───* TASK 1───* SUBTASK (role: architect|coder|debugger|reviewer)
```

---

## 11. API reference

### 11.1 ICE server (Hono, prefix `/api`)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Health check |
| POST | `/api/auth/register` | Create account |
| POST | `/api/auth/login` | Login (sets cookie) |
| POST | `/api/auth/guest` | Guest session |
| GET | `/api/auth/me` | Current user |
| POST | `/api/auth/logout` | Logout |
| POST | `/api/rooms` | Create room |
| POST | `/api/rooms/:roomId/invites` | Create invite link |
| POST | `/api/rooms/:roomId/access` | Exchange invite/session for room token |
| POST | `/api/rooms/:roomId/commit` | Flush + git commit |
| GET | `/api/rooms/:roomId/branches` | List branches |
| GET | `/api/rooms/:roomId/commits` | Commit log |
| POST | `/api/rooms/:roomId/agent` | Start agent |
| POST | `/api/rooms/:roomId/agent/message` | Send message to agent |
| POST | `/api/rooms/:roomId/agent/approve` | Approve/reject pending action |
| POST | `/api/rooms/:roomId/voice/token` | Mint LiveKit token |
| POST | `/api/rooms/:roomId/orchestrate` | Start squad task |
| POST | `/api/rooms/:roomId/orchestrate/interrupt` | Stop squad |
| PUT/GET | `/api/rooms/:roomId/agents/:agentId/policy` | Set/get agent policy |
| POST | `/api/rooms/:roomId/snapshots` (+ `/:id/merge`, `/:id/discard`) | Snapshot lifecycle |
| GET | `/api/rooms/:roomId/snapshots` | List snapshots |
| POST | `/api/rooms/:roomId/terminal/run` | Run command in shared terminal |
| POST | `/api/convert` | Convert code (C++/Java/Python/JS) |
| GET | `/api/convert/status` | Backup-API status |
| POST | `/api/convert/status/recheck` | Re-probe backup API |
| * | MCP routes | List/call MCP tools |
| GET | `/audit` routes | Audit trail |
| WS | `/sync` | Yjs sync (Hocuspocus) |
| — | git smart-HTTP | `git clone/push/pull` |

### 11.2 Altern FastAPI (`server.py`, port 8000)
| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Serve frontend or status JSON |
| GET | `/health` | Model-loaded flag, supported languages |
| POST | `/translate` | `{source_code, source_lang, target_lang}` → converted code, `model_used`, time, `cached` |
| POST | `/execute` | `{code, language, stdin}` → stdout/stderr/exit code/time |
| WS | `/ws/execute` | Interactive execution streaming (stdout/stderr/exit events) |

---

## 12. Security design

| Area | Mechanism |
|---|---|
| Passwords | Salted **scrypt**, parameters stored with hash, timing-safe compare |
| Sessions | **JWT HS256** (jose) in cookie `ice_session`; secret from `ICE_SESSION_SECRET` (auto-generated + persisted in the volume if unset) |
| Room access | Room token verified in Hocuspocus `onAuthenticate`; invite links are bearer tokens with optional expiry |
| Authority | Browser is untrusted; the server decides everything |
| Agents | Out-of-process; write only through the adapter; **approval gate**; per-agent **policy** (tools, paths); audit trail; per-origin rollback |
| Terminal | `no-shell` tests, PTY with fallback; commands gated for agents |
| Convert | 60,000-char input cap, 45 s timeout, generic errors (no backend leakage), output syntax-checked |
| Code execution (Altern) | Temp dir per run, 10 s timeout |
| Network | Only `web` port published in Docker; `server` internal; Nginx edge |
| Secrets | `.env` git-ignored; `.env.example` provided; Redis bus must be on private network |
| Governance | `SECURITY.md`, **THREAT_MODEL.md** (STRIDE-style per component), RFC process, DCO |

Threat actors considered: unauthenticated attacker, leaked-invite holder, malicious room member, **prompt-injected/compromised agent**, malicious dependency/extension, network adversary.

---

## 13. Deployment and scaling

### 13.1 One-command deploy
```
docker compose up --build        # then open http://localhost:3000
```
- `server` image: multi-stage Node 22 image, runs with `tsx`, healthcheck hits `/api/health`.
- `web` image: Vite build served by Nginx on 3000, proxies `/api` and `/sync`.
- `livekit`: `--dev` mode with dev key/secret (use real keys in production).
- Volume `ice-data` persists SQLite, generated secret and git repos.

### 13.2 Scale-out
Add Redis (`deploy/compose.scale.yml`), set `REDIS_URL`, raise replica count. Without Redis, replicas diverge. Helm chart provides server/web/livekit/redis/ingress/secret templates.

### 13.3 Backup
See `docs/BACKUP.md` — back up the `ice-data` volume (SQLite + ydoc + repos).

---

## 14. Testing and verification

- **~198 server unit/integration tests (Vitest)** covering: roles, agent adapter, host, approval gate, mock backend, ACP backend, policy, snapshots, orchestrator/planner/task-doc, convergence, terminal (no-shell, room-terminal), voice token, MCP registry, audit recorder/routes, Redis scale, extensions loader.
- **Per-release end-to-end scripts** (`apps/web/scripts/`): `sync-check.mjs` (live sync), `v0_3-git-check.mjs`, `v0_5-agent-check.mjs` (12/12 pass: agent edit through doc, approval gate reject/approve, shared terminal), `v1_5-squad-check.mjs` (8/8: 3 specialist agents, 1 task/3 subtasks, concurrent co-edit, snapshot merge, MCP).
- Web smoke tests for chat, agents, file tree (`*.smoke.ts`).
- `pnpm typecheck`, `pnpm build`, `docker compose config` validated.
- Real-service paths (LiveKit audio, OIDC IdP, Postgres, multi-node Redis, real ACP agent with key) are wired and unit-tested but need external services → "bring-your-own".

---

## 15. Release history and roadmap

| Release | Theme | Added |
|---|---|---|
| **v0.1** | Two friends, one live file | CodeMirror 6 + Yjs live editing, named cursors, durable rooms, auth + invite links, self-host |
| **v0.3** | Git comes home | Bundled git server, CRDT↔git convergence, file tree, source control |
| **v0.5** | Your first AI teammate | ACP↔Yjs adapter, approval gate, shared terminal |
| **v1.0** | Code with friends, out loud | LiveKit voice, group/DM chat, in-UI git, agent rollback, preview, OIDC/Postgres/roles, docs |
| **v1.5** | A squad of agents | Orchestrator + specialist roles, multi-agent co-editing, policies, MCP, snapshots, blame |
| **v2.0** | Scale out and integrate | Redis scale-out, audit log, Forgejo + Helm, governance/RFC/threat model, extensions |
| **v2.1** *(planned)* | Enforce the edge | Live policy enforcement, CI wall, sound multi-node lock, sandbox, rate limits, vendor `y-codemirror.next` |
| **v2.2** *(planned)* | Prove it against reality | Real-service verification, real ACP agent path, metrics/health, spend caps |
| **v2.3** *(planned)* | Legible, coordinating squad | Intent-locks/turn-taking, reviewer agent, full blame, merge-review surface |
| **v3.0** *(planned)* | Bidirectional convergence + trust | Live 3-way merge of external pushes, chaos testing, security audit |

---

## 16. How to run it

### 16.1 Docker (easiest)
```bash
docker compose up --build
# open http://localhost:3000, create a room, share the invite link
```

### 16.2 Local development
```bash
# prerequisites: Node >= 20, pnpm 9.12 (corepack enable), git, (optional) Python 3 for conversion
pnpm install
cp .env.example .env            # fill ICE_SESSION_SECRET, optional keys
pnpm dev                        # turbo runs web (Vite) + server (tsx watch)
pnpm typecheck && pnpm build && pnpm test
```
- Web dev server: Vite (default 5173) proxying to the server on 8080.
- Optional voice: `livekit-server --dev` on 7880.
- Optional conversion backup: set `GEMINI_CONVERT_API_KEY`.

### 16.3 Altern standalone
```bash
pip install fastapi uvicorn pydantic        # (+ torch transformers for the optional local model)
python server.py                            # http://localhost:8000/docs
```

---

## 17. Known limitations (be honest in the report)

1. **Policy enforcement not yet live in the agent host:** the policy engine, registry, routes and tests exist, but the per-tool-call hook into the live adapter is a documented follow-up (v2.1).
2. **Convergence lock is process-local** — not sound across multiple server nodes (scale-out marked experimental).
3. **Live merge of external git pushes into an open room** is not implemented (v3.0).
4. **Real ACP agent needs your own API key**; verification used a mock agent.
5. LiveKit voice, OIDC, Postgres, Redis multi-node are code-complete but need external services to demo.
6. `y-codemirror.next` is a lightly maintained dependency (planned to vendor/pin).
7. **Altern engine is rule-based/regex-based**, so complex programs may translate imperfectly; that's why it is syntax-checked and backed by Gemini. The standalone `server.py` imports `model_config.py` (not included in this repository snapshot) and looks for a `../frontend` folder, so it needs those supplied before it runs on its own.
8. `README` quickstart line still says the one-command flow is "not yet wired up", although `docker-compose.yml` exists — update before submission.
9. Agent sandboxing is OS-level/optional, not per-agent container isolation (by design).
10. Rate limiting, metrics and spend caps are planned, not shipped.

---

## 18. WHAT TO ADD IN THE COLLEGE MAJOR PROJECT REPORT

Below is a complete, standard chapter structure (works for most Indian university B.Tech/BCA/MCA formats). Adjust to your college's template, but include all of these.

### 18.1 Front matter (pages numbered in Roman numerals)
- [ ] **Title page** — project title, "submitted in partial fulfilment of …", degree, branch, university, college logo, academic year, student name(s) + roll numbers, guide name/designation, HOD.
- [ ] **Certificate** (from college/guide, signed).
- [ ] **Declaration / Undertaking** by students (originality).
- [ ] **Acknowledgement**.
- [ ] **Abstract** (150–300 words): problem, approach (Yjs CRDT + agents + git), tech, results.
- [ ] **Table of contents**, **List of figures**, **List of tables**, **List of abbreviations** (CRDT, ACP, MCP, SFU, JWT, OIDC, REST, WebRTC, SPA, ADR, STRIDE …).

### 18.2 Main chapters
1. **Introduction**
   - Background (rise of AI-assisted coding, remote teamwork).
   - Motivation, problem statement (use Section 2), objectives (Section 3), scope and limitations, project organisation (what each chapter contains).
2. **Literature survey / Existing system study**
   - Compare with: VS Code Live Share, Google Docs, Replit Multiplayer, Zed collaboration, GitHub Codespaces, Cursor/Copilot, Claude Squad/Sculptor (isolation-based agent tools), CodeSandbox. (See `docs/COMPETITION.md` for material.)
   - Research papers/tech to cite: CRDTs (Shapiro et al.), Yjs (Nicolaescu et al., "Near real-time peer-to-peer shared editing on extensible data types"), Operational Transformation (Ellis & Gibbs), WebRTC, Language Server/Agent Client Protocols, Model Context Protocol.
   - **Comparison table** (feature matrix) and identified **research gap**.
3. **System analysis**
   - Feasibility: technical, economic (open source, free tier), operational, schedule.
   - **Requirement analysis**: functional + non-functional (performance, security, availability, scalability, usability, portability).
   - Hardware and software requirements (dev + deploy).
   - Stakeholders/actors (guest, member, owner, agent, admin/operator).
4. **System design**
   - Architecture diagram (5.1), module diagram (5.3), technology rationale.
   - **UML diagrams:** Use-case, Class (key domain types), Sequence (join room, agent edit with approval, commit, voice token, convert), Activity (orchestrated task), State (agent status: idle → working → awaiting-approval → done), Component and Deployment diagrams.
   - **Data Flow Diagrams** level 0, 1.
   - **ER diagram + database schema** (Section 10) and Yjs document model.
   - **API design** table (Section 11).
   - Algorithm descriptions: CRDT merge idea, per-room FIFO mutex, convergence flush, planner/role routing, policy `enforce()` decision, conversion fallback chain.
   - Security design and threat model (Section 12).
5. **Implementation**
   - Tools/environment, folder structure (Section 9).
   - Module-by-module description with **short, key code snippets** (adapter, lock, auth hook, convert pipeline) — not entire files.
   - Challenges faced and how you solved them (three-sources-of-truth, agents needing FS, WebSocket proxying, native module `better-sqlite3`/`node-pty` builds, Windows vs Linux).
   - **Screenshots** of every screen (Section 6).
6. **Testing**
   - Test strategy: unit, integration, e2e, smoke, security, performance.
   - **Test case table** (ID, module, input, expected, actual, pass/fail) — use real cases such as: two clients type simultaneously → both edits preserved; delete file by agent → awaits approval → reject preserves; invalid invite → denied; conversion output fails syntax check → falls back to Gemini.
   - Results: ~198 automated server tests, e2e 12/12 and 8/8; screenshots of test output.
   - Performance numbers (measure yourself): sync latency, structural conversion time (<5 ms claimed), memory, concurrent users.
7. **Results and discussion**
   - What works, demo walkthrough, comparison against objectives, comparison with existing tools.
8. **Conclusion and future scope**
   - Summary of achievements, limitations (Section 17), future work (Section 15 roadmap: policy enforcement, 3-way merge, sandboxing, metrics, mobile client, video, plugin ecosystem).
9. **References** (IEEE/APA): official docs for Yjs, Hocuspocus, CodeMirror, Hono, LiveKit, Docker, Git, ACP, MCP; academic papers; competing products. Use proper citation numbering.
10. **Appendices**
    - A: Complete or selected source code listings.
    - B: Installation / user manual (Section 16 + screenshots).
    - C: API documentation.
    - D: Full test cases.
    - E: Plagiarism report (if required), GitHub link, hosted demo/video link, QR code.
    - F: Gantt chart / project timeline, team contribution table, weekly guide-meeting log.

### 18.3 Extra items that impress examiners
- [ ] A clear **novelty statement**: "humans and multiple AI agents in one CRDT workspace with write-through attribution and approval gate."
- [ ] **Architecture + sequence diagrams** drawn cleanly (draw.io / Mermaid / PlantUML).
- [ ] **Comparison table** vs existing tools.
- [ ] **Live demo script** (3–5 min): open two browsers → type simultaneously → start mock agent → show edit attribution → trigger delete → approve/reject → commit → `git clone` the room → convert a C++ file to Python.
- [ ] **Metrics:** lines of code per package, number of tests, number of modules, number of API endpoints, release timeline.
- [ ] **Ethical, social and legal considerations:** open-source licensing (Apache-2.0), AI-generated code responsibility, data privacy (self-host, no telemetry), security of agent execution.
- [ ] **Cost analysis:** zero licence cost, hosting cost on a small VPS, API cost is BYO.
- [ ] **SDLC model** used (Agile/iterative; releases v0.1 → v2.0 in `plans/releases/`) and **project management** evidence (PROGRESS.md log, git history).
- [ ] **Team contribution table** and **individual module ownership**.
- [ ] **Plagiarism/AI-use disclosure** per your college policy; write the report in your own words.
- [ ] **Deployment evidence:** screenshot of `docker compose up`, running containers, healthchecks.
- [ ] **SWOT analysis** and **risk analysis** (use top risks from `docs/DECISIONS.md`).

### 18.4 Diagrams checklist (draw these)
1. System architecture (Section 5.1)
2. Three-sources-of-truth flow (5.2)
3. Use-case diagram
4. Class diagram (Room, Participant, Agent, AgentPolicy, OrchestrationTask, Subtask, AuditEntry, Channel)
5. Sequence: join + live edit
6. Sequence: agent edit + approval
7. Sequence: squad orchestration
8. Sequence: commit/convergence
9. Sequence: voice token
10. Flowchart: code conversion pipeline
11. ER diagram
12. Deployment diagram (Docker Compose)
13. Gantt chart

### 18.5 Formatting checklist
Times New Roman 12 pt (or your college's rule), 1.5 line spacing, 1-inch margins (left 1.5 in for binding), chapter headings 14–16 pt bold, figure captions below figures, table captions above tables, page numbers, consistent numbering (1.1, 1.2 …), bound hard copy + soft copy + code CD/GitHub link.

---

## 19. Viva questions and answers

**Q1. What is the main idea of your project?**
A self-hostable, real-time collaborative IDE where humans and AI agents edit the same workspace together, with voice/chat and a built-in git server.

**Q2. Why a CRDT instead of Operational Transformation?**
CRDTs (Yjs) merge concurrent edits deterministically without a central transformer, work offline/reconnect well, and Yjs has mature bindings for CodeMirror.

**Q3. What is the "three sources of truth" problem?**
Live Yjs buffer, server filesystem, and git can diverge. Our rule: Yjs is the truth; the filesystem is projected from it under a lock; git commits come from the flushed tree.

**Q4. How do AI agents edit safely?**
They run out-of-process through ACP; an adapter converts their file operations into origin-tagged Yjs transactions; destructive actions need human approval; policies limit tools/paths; everything is audited and can be rolled back per agent.

**Q5. What if two agents/humans edit the same line?**
Yjs merges both inserts/deletes deterministically; no data is lost. (v2.3 adds advisory intent-locks to reduce trampling.)

**Q6. Why Hocuspocus, Hono, SQLite?**
Hocuspocus is the production Yjs server with auth/persistence hooks; Hono is a tiny fast TypeScript web framework; SQLite gives zero-config self-hosting (Postgres optional).

**Q7. How is authentication done?**
scrypt-hashed passwords, HS256 JWT in a cookie, invite links as bearer tokens, room token checked in the WebSocket auth hook, optional OIDC.

**Q8. How does voice work?**
Server issues LiveKit JWTs; clients connect to a LiveKit SFU over WebRTC.

**Q9. How does code conversion work and how do you ensure correctness?**
A rule-based engine translates; output is syntax-checked with the real compiler/interpreter (or bracket balance); if it fails, Gemini is used as backup. Limitation: rule-based translation is not semantically perfect.

**Q10. How does it scale?**
Single node by default; add Redis pub/sub extension for multiple replicas; Helm chart for Kubernetes. Known limitation: the convergence lock is per-process (fix planned).

**Q11. How did you test it?**
~198 Vitest tests, e2e scripts per release, smoke tests, typecheck/build, compose validation, mock agent for determinism.

**Q12. What are the limitations and future work?**
See Section 17 and roadmap Section 15.

**Q13. Why not fork VS Code?**
Licensing/marketplace risk, heavy, buries the differentiator; CodeMirror 6 is web-native and Yjs-friendly.

**Q14. Why TypeScript everywhere?**
Shared types between client/server (`packages/shared`), one toolchain, fewer integration bugs.

---

## 20. Glossary

| Term | Meaning |
|---|---|
| **CRDT** | Conflict-free Replicated Data Type — data structure that merges concurrent edits without conflicts |
| **Yjs** | JavaScript CRDT library used for shared documents |
| **Awareness** | Yjs protocol for ephemeral presence (cursors, names) |
| **Hocuspocus** | Yjs WebSocket backend with hooks/extensions |
| **ACP** | Agent Client Protocol — editor ⇄ AI agent protocol |
| **MCP** | Model Context Protocol — agent ⇄ tools protocol |
| **Adapter** | Component translating agent file/command intents into Yjs transactions |
| **Origin tag** | Label on a Yjs transaction identifying who made the change (for attribution/undo) |
| **Convergence** | Keeping Yjs, filesystem and git consistent |
| **Flush** | Writing the Yjs doc contents to the filesystem |
| **SFU** | Selective Forwarding Unit — WebRTC media relay (LiveKit) |
| **OIDC** | OpenID Connect — SSO login standard |
| **Snapshot** | Opt-in safe branch an agent can work on and later merge/discard |
| **Squad** | A group of specialist agents coordinated by the orchestrator |
| **Altern** | Name of the code-translation module/service |
| **ADR** | Architecture Decision Record |
| **RFC** | Request For Comments — proposal process for significant changes |
| **STRIDE** | Threat model categories: Spoofing, Tampering, Repudiation, Info disclosure, DoS, Elevation of privilege |
| **BYO-key** | Bring your own API key |
| **Monorepo** | One repository containing multiple apps/packages (pnpm + Turborepo) |

---

*End of everything.md — generated from the repository contents. Verify screenshots, measurements, and any numbers (tests, latencies) on your own machine before putting them in the report.*
