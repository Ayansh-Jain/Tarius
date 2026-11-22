# ICE — Agent Handoff & Operating Manual

**Read this first if you are an agent (re)joining the ICE build.** It tells you where things are, how we work, and how to pick up exactly where the last agent left off.

## 1. Where to look (in order)

1. **[PROGRESS.md](../PROGRESS.md)** — the running build log. The newest entry at the top tells you what's done, what's in flight, and the immediate next action.
2. **[docs/DECISIONS.md](DECISIONS.md)** — the authoritative product + tech decisions (from the PM council). Do not relitigate these without a new council.
3. **[docs/ROADMAP.md](ROADMAP.md)** — releases v0.1 → v2.0 and their themes.
4. **[plans/releases/](../plans/releases/)** — the detailed spec for each release. Build against the spec for the current release.
5. **[docs/ARCHITECTURE.md](ARCHITECTURE.md)** — system design, module boundaries, data/protocol shapes.
6. **[docs/VISION.md](VISION.md)** + **[docs/COMPETITION.md](COMPETITION.md)** — the "why," and the anti-bloat charter. When in doubt about whether to add something, check VISION's "What ICE is NOT."

## 2. How we work (process)

- **PM council decides, workflows build.** Scope/stack/roadmap come from the `ice-pm-council` workflow → written to DECISIONS.md & ROADMAP.md. Implementation is fanned out via `Workflow` runs.
- **One release at a time**, in roadmap order. Each release has a spec in `plans/releases/vX.Y.md` with a checklist. A release is "done" when its checklist passes and it is independently demoable.
- **Worktrees for parallel build.** When multiple agents implement parts of a release concurrently and would touch files in parallel, they run with `isolation: 'worktree'` so they don't collide. Integration happens back on the working branch.
- **Document as you go.** Every meaningful step appends to PROGRESS.md. Plans live in `plans/`. If you discover something that changes a decision, update DECISIONS.md and note it in PROGRESS.md.

## 3. Conventions

- **Language:** TypeScript everywhere. **Monorepo:** pnpm workspaces + Turborepo.
- **Apps:** `apps/web` (client), `apps/server` (realtime + API + agent host + git server). **Shared code:** `packages/shared`.
- **Commits:** small, scoped, present-tense. Branch off the working branch; never commit secrets. `.env` is git-ignored; keep `.env.example` current.
- **Protocols over bespoke:** ACP (editor↔agent), MCP (agent↔tools), Yjs (CRDT), Git (source), LiveKit/WebRTC (voice).
- **No bloat:** if a feature isn't in the current release spec or DECISIONS.md, don't build it. Flag it for the next council instead.

## 4. Resuming a build — exact steps

1. `git status` and read the top of **PROGRESS.md**.
2. Identify the **current release** from ROADMAP.md and open its spec in `plans/releases/`.
3. Find the first unchecked item in that spec's checklist.
4. If it's parallelizable with other unchecked items, spin a `Workflow` that fans out worktree-isolated agents, one per independent item; otherwise implement directly.
5. Make it run. Verify (build/typecheck/manual). Check the box in the spec.
6. Append a PROGRESS.md entry: what you did, what's next, any new decisions.
7. Repeat until the release checklist is green, then move to the next release.

## 5. Tick discipline (autonomous mode)

This build runs autonomously under a `/goal`. The driver agent paces itself with timer ticks and keeps PROGRESS.md current so any agent can take over at any tick. If you are a fresh agent: the latest PROGRESS.md entry + the current release spec are sufficient to continue without the prior conversation.

## 6. Useful commands (target state)

```bash
pnpm install            # install workspace deps
pnpm dev                # run web + server in watch mode
pnpm build              # build all packages
pnpm typecheck          # tsc across the workspace
docker compose up       # full self-hosted stack (web, server, git, livekit)
```
