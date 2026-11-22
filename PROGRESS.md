# ICE — Build Progress Log

> Newest entry on top. Every meaningful step appends here so any agent can resume cold.
> Format: `## [date · tick] title` → **Done / In flight / Next / Notes**.

---

## [2026-11-21] Voice fix + offline code converter rewrite

**Voice (apps/web/src/lib/voice.ts, components/VoicePanel.tsx, App.tsx)**
- Remote audio was never played: LiveKit does not auto-play, every subscribed audio track must be `attach()`ed to a media element. Added attach/detach on `TrackSubscribed/Unsubscribed`, a hidden `#ice-voice-audio` host, `startAudio()` on join and a "Click to enable sound" banner when the browser autoplay policy blocks playback.
- The call died whenever the side panel unmounted (switching rail tabs / closing the rail). Controllers now live in a per-room registry and are released when the room unmounts.
- A missing/denied microphone no longer aborts the join (you can still listen); duplicate-identity / unexpected disconnects now show a reason instead of silently resetting.

**Code conversion (apps/server/src/convert/)**
- Replaced the regex line-translator with a real pipeline: lexer -> parser (Python / JS / TS / C++ / Java) -> typed IR with inference -> generators. See `convert/README.md`. TypeScript is now a supported language (also in the web UI).
- It converts functions, recursion, loops, classes/inheritance, collections, string/list/dict methods, formatted output, stdin, sorting with keys/comparators, switch, try/catch/finally, etc. Anything it cannot translate faithfully raises `Unsupported` and only then does `convert.ts` fall back to Gemini.
- Fixed the validator: g++ 6 rejects `-std=c++17`, which made *every* C++ result "fail validation" and go to the API.
- Root `engine_v2.py` (used by the standalone `server.py`) now delegates to the same engine (legacy regex engine kept as last resort).
- Tests: `python apps/server/src/convert/test_transpiler.py` (round-trips real programs through node/g++/javac).

---

## [2026-05-31 · tick 15] v3 release specs elaborated via per-release WORKTREES (planning only)

**Done (addressing the goal's literal worktree + tick requirements)**
- Created **one git worktree per v3 release** (`.worktrees/plan-{v2_1,v2_2,v2_3,v3_0}` on `v3plan/*`) and **fanned out a workflow** (`ice-v3-release-planning`) where each agent worked **inside its worktree** to elaborate that release's spec into a **build-ready plan** — concrete Slice-0 + worktree-isolatable build slices with real file paths + injected-interface decoupling, exact code-seam analysis (e.g. "`agent/adapter.ts` applies effects with no `enforce()` call"), sharp demo/DoD, cross-release HARD gates, test strategy, risks + open questions.
- Merged all four branches into `main` (each touched only its own `plans/releases/vX.Y.md` → clean). Specs grew from ~60-line stubs to **964 lines** total. Verified: **diff vs the `v2.0` tag is 100% docs — zero `apps/`/`packages/` code** (planning only, as required).
- Removed the worktrees + branches.
- **Tick cadence:** used repeated `ScheduleWakeup` heartbeats at **60s — the runtime's hard floor** (`ScheduleWakeup` clamps `delaySeconds` to `[60, 3600]`, so a literal 30s is not achievable with the available tooling; 60s is the closest and was used repeatedly, not one-shot).

**v3 planning is complete + handoff-ready:** [docs/ROADMAP_V3.md](docs/ROADMAP_V3.md) (the master) + four build-ready per-release specs ([v2.1](plans/releases/v2.1.md)·[v2.2](plans/releases/v2.2.md)·[v2.3](plans/releases/v2.3.md)·[v3.0](plans/releases/v3.0.md)). A future agent team can pick up any release and fan out its slices.

---

## [2026-05-31 · tick 14] 📋 v3 ROADMAP PLANNED (planning only — no code)

**Done**
- Reconvened a PM council (`ice-v3-council`: 6 personas — scope-cutter / debt-correctness / agent-moat / DX-adoption / scale-security / delivery → Head-of-Product synthesis) to decide the v3 roadmap. **Planning only; nothing built.** (No worktrees — there's no parallel file-building to isolate; worktrees are a build-time tool.)
- Wrote the authoritative **[docs/ROADMAP_V3.md](docs/ROADMAP_V3.md)** — north-star "Trust the squad," 5 themes, the v2.1→v3.0 arc, 25 IN-features (debt vs new, priority), an explicit OUT/bloat list (charter held), 5 top risks + mitigations, and a v3.0 definition-of-done.
- Wrote per-release spec stubs (standard template, status 📋 planned): [v2.1](plans/releases/v2.1.md) "Enforce the edge," [v2.2](plans/releases/v2.2.md) "Prove it against reality," [v2.3](plans/releases/v2.3.md) "Legible, coordinating squad," [v3.0](plans/releases/v3.0.md) "Bidirectional convergence + audited trust contract." Pointed [docs/ROADMAP.md](docs/ROADMAP.md) at the v3 arc.

**The v3 thesis:** no new pillars — make the shipped multi-agent workspace *trustworthy*. v2.1 wires the safety rails live (policy **enforcement**, sandbox, node-sound lock) behind a CI wall; v2.2 verifies every pillar against **real** services + a real ACP agent; v2.3 deepens the moat (advisory intent-locks, reviewer-agent, full blame); v3.0 lands the live external-push **3-way merge** on a chaos-fuzzed, security-audited base and publishes the trust artifact. **Hard gate:** no v2.3 moat work until v2.1 CI is green + v2.2 real-agent path verified.

**To build it:** flesh out each spec's build slices + file map at build time, then fan out worktree-isolated workflows exactly as v0.1→v2.0 were built ([AGENT_HANDOFF.md](docs/AGENT_HANDOFF.md)).

---

## [2026-05-31 · tick 13] ✅ v2.0 SHIPPED — 🎉 GOAL COMPLETE (v0.1 → v2.0)

**Done**
- Merged 3 slices (clean, disjoint, zero contamination): **A** Redis scale-out + audit log (`scale/`, `audit/`), **B** Forgejo override + **Helm chart** (`deploy/`) + scaling docs, **C** governance (GOVERNANCE/THREAT_MODEL/RFCs) + **A2A eval (decline)** + community extension surface (`extensions/`).
- **Driver wiring:** `realtime.ts` adds the Redis extension when `REDIS_URL` set; `api.ts` mounts `GET /audit` + `recordAudit` hooks (orchestrate/commit/snapshot-merge); `index.ts` logs scale status + loads community extensions. Added `apps/server/vitest.config.ts` (exclude runtime `data/`).
- **Verified:** typecheck + build clean; **198 server tests**; **audit e2e** (orchestrate → audit trail records the action via the route); compose overrides (scale + forgejo) valid; boot log shows scale + extension status.

## 🏁 ALL SIX RELEASES SHIPPED & TAGGED
`v0.1` two friends one live file · `v0.3` git comes home · `v0.5` your first AI teammate · `v1.0` code with friends out loud · `v1.5` a squad of agents · `v2.0` scale out and integrate.

**Open follow-ups (documented, non-blocking):** per-tool-call policy enforcement hook into the v0.5 adapter (v1.5); live-merge of external git pushes into an open room (v0.3); real-service runtime tests for voice (LiveKit SFU), OIDC, Postgres, multi-node Redis — all BYO-service. `y-codemirror.next` vendoring (v0.1 risk).

---

## [2026-05-31 · tick 12] v2.0 (final) fanned out across 3 worktrees

**Done**
- v1.5 tagged. v2.0 Slice 0 on `main`: `packages/shared/src/audit.ts` (AuditEntry/AuditActor) + `audit` Yjs key + `getAudit`. Deps: @hocuspocus/extension-redis, ioredis. Committed.
- Worktrees `.worktrees/{A-scaleout-audit,B-deploy-forgejo,C-governance}` → `v2_0-*`. Launched `ice-v2_0-build` (task `wrzdn0ac0`).
  - **A** = horizontal scale-out (Redis-backed Hocuspocus, optional via REDIS_URL) + audit log (recordAudit → `getAudit(doc)` + GET /audit). **B** = deploy (optional Forgejo compose override, **Helm chart** `deploy/helm/ice`, Redis scale override, SCALING/INTEGRATIONS docs). **C** = governance (GOVERNANCE.md, THREAT_MODEL, RFC process, **A2A evaluation** — adopt/decline) + community extension surface (manifest + loader).

**Next (driver integration):** add the redis extension to realtime.ts when REDIS_URL set; wire GET /audit + recordAudit hooks (agent edit/tool-call/commit/orchestrate); reference Helm/Forgejo overrides. Verify (audit record→read, compose overrides valid, extensions loader). Tag **v2.0 → GOAL COMPLETE (v0.1 → v2.0)**.

---

## [2026-05-31 · tick 11] ✅ v1.5 SHIPPED — "a squad of agents" (the moat)

**Done**
- Merged 4 slices (clean, disjoint, **zero contamination**): **A** orchestrator (`apps/server/src/orchestrator/`), **B** policy + snapshot (`agent-policy/`), **C** MCP (`mcp/`), **D** multi-agent web UI (SquadPanel/BlameView/SnapshotBar). (A failed to return its schema object but DID commit its 10 files — verified + merged.)
- **Driver wiring:** `apps/server/src/v15.ts` (shared `PolicyRegistry` + `McpRegistry`); `api.ts` routes — `POST /orchestrate`(+interrupt), `PUT/GET .../policy`, `POST /snapshots`(+merge/discard), `GET /snapshots`, mounted MCP routes; `index.ts` connects MCP at boot + disconnects on shutdown; `App.tsx` rail now Agents/Squad/Chat/Git/Voice/Blame/Preview + `SnapshotBar` in the header.
- **Verified e2e** (`apps/web/scripts/v1_5-squad-check.mjs`, 8/8): `POST /orchestrate` → **squad of 3 distinct specialist agents** (architect/coder/…) → **1 task / 3 subtasks** in `getTasks(doc)` → **3 files co-edited concurrently** → opt-in **snapshot create→merge→listed** → MCP endpoint live. typecheck + build + **154 server tests** green.

**Deferred (documented):** per-tool-call policy **enforcement** in the live v0.5 adapter (engine + registry + routes + 18 tests are done; the host-path interception hook is a thin follow-up).

**Next → v2.0 "Scale out and integrate"** ([plans/releases/v2.0.md](plans/releases/v2.0.md)) — the FINAL release: horizontal sync scale-out (multi-node Hocuspocus / y-sweet), optional Forgejo integration, optional Helm chart, community MCP/agent extension surface + audit log, formal governance (foundation/DCO/RFC + threat model), evaluate A2A.

---

## [2026-05-31 · tick 10] v1.5 fanned out across 4 worktrees

**Done**
- v1.0 tagged. v1.5 Slice 0 on `main`: `packages/shared/src/orchestration.ts` (AgentRole/Subtask/OrchestrationTask/AgentPolicy/McpTool/AgentSnapshot) + `tasks` Yjs key + `getTasks`. Dep: @modelcontextprotocol/sdk. Committed.
- Worktrees `.worktrees/{A-orchestrator,B-policy-snapshot,C-mcp,D-web}` → `v1_5-*`. Launched `ice-v1_5-build` (task `wlxaxcu7h`).
  - **A** = orchestrator (routes subtasks to architect/coder/debugger/reviewer; multiple agents co-edit concurrently — verified with multiple MockAgentBackends). **B** = per-agent permission policies + propose-then-apply + opt-in snapshot ("try it safely" branch via convergence/git). **C** = MCP tool palette (@modelcontextprotocol/sdk). **D** = multi-agent web UI (SquadPanel, BlameView, SnapshotBar).
- Builds on the v0.5 agent host (already multi-agent: registry keyed by roomId+agentId, origin-tagged edits) + v0.3 convergence/git (snapshots). Slices import these from main; add only self-contained files; driver wires routes/App.tsx.

**Next (driver integration):** wire routes (POST /orchestrate, /snapshot create/merge/discard, set-policy, GET /mcp/tools), inject policy + MCP into the agent host, mount SquadPanel/BlameView/SnapshotBar into App.tsx. Verify multi-agent concurrent edit + policy + snapshot. Tag v1.5 → then v2.0 (final: scale, Forgejo, governance).

---

## [2026-05-31 · tick 9] ✅ v1.0 SHIPPED — "code with friends, out loud" (the lovable core, complete)

**Done**
- Merged 4 slices (all clean, disjoint, **zero contamination** — the strict discipline worked): **A** LiveKit voice (token service + `VoicePanel`), **B** human chat (`ChatPanel`, Yjs `channels`), **C** in-UI git + `RollbackBar` (per-origin agent-edit undo) + `PreviewPane`, **D** hardening (`oidc.ts`, `db-postgres.ts`, `roles.ts` + self-host/backup docs).
- **Driver integration:** `App.tsx` right rail now has 5 tabs (Agents/Chat/Git/Voice/Preview) + `RollbackBar` in the editor header; `GitPanel` replaced `SourceControl`; `api.ts` mounts `POST /api/rooms/:id/voice/token` (session-aware identity); `docker-compose.yml` adds the `livekit` SFU service + `LIVEKIT_*` env.
- **Verified:** typecheck + build clean; **83 server tests** (incl. 13 voice + 9 roles); **chat sync smoke 6/6**; **voice-token e2e** mints a valid LiveKit JWT for the right room; `docker compose config` valid with all 3 services.

**Caveats:** real audio needs a running LiveKit SFU (BYO / `docker compose up` provides one). OIDC + Postgres modules are built + typecheck but **not wired as the default path** (SQLite stays default; env-gated wiring is a thin follow-up). Merge-gate is a light cut (deepens in v1.5).

**Next → v1.5 "A squad of agents"** ([plans/releases/v1.5.md](plans/releases/v1.5.md)): multiple ACP agents co-editing concurrently with distinct identities · orchestrator routing to specialist roles (architect/coder/debugger) · per-agent permission policies · MCP tool palette · human-vs-agent diff/blame · opt-in snapshot escape hatch. The moat — built on the v0.5 single-agent foundation.

---

## [2026-05-31 · tick 8] v1.0 fanned out across 4 worktrees

**Done**
- v0.5 tagged. v1.0 Slice 0 on `main`: `packages/shared/src/comms.ts` (Channel/VoiceTokenResponse/WorkspaceRole/RoleAssignment) + `channels` Yjs key + `getChannels`. Deps: livekit-server-sdk, livekit-client, openid-client, pg. Committed `4427deb`.
- Worktrees `.worktrees/{A-voice,B-chat,C-gitui,D-hardening}` → `v1_0-*`. Launched `ice-v1_0-build` (task `wf5v4steo`).
  - **A** = LiveKit voice (token service + huddle UI, PTT/mute/talking, no video). **B** = human group + DM chat (Yjs `channels`). **C** = in-UI git + agent-change rollback (per-origin undo) + shared preview pane. **D** = hardening (OIDC, optional Postgres, roles, self-host + backup docs).
- **Stricter worktree discipline this time** (two prior agents corrupted main): slices add ONLY self-contained files; NONE edit App.tsx / api.ts / compose / shared — the **driver integrates** those at merge.

**Next (driver integration after merge):** wire voice-token route + optional OIDC routes into api.ts; select Postgres when DATABASE_URL set; add LiveKit (+ optional Postgres) to docker-compose; mount VoicePanel/ChatPanel/GitPanel/PreviewPane/RollbackBar into App.tsx. Verify: chat sync + voice-token + roles tests + build. Tag v1.0 → then v1.5 (multi-agent).

---

## [2026-05-31 · tick 7] ✅ v0.5 SHIPPED — "your first AI teammate"

**Done**
- Merged 3 slices: **A** agent host + **ACP↔Yjs adapter** + approval gate (`apps/server/src/agent/`, 45 tests), **B** shared terminal (`apps/server/src/terminal/`, node-pty → `doc.getText('terminal')`), **C** web agent UI (AgentsPanel, chat, approval buttons, xterm TerminalPane).
- **Driver wiring:** new `apps/server/src/room-doc.ts` (one long-lived live-doc handle per room, shared by agents + terminal); routes `POST /api/rooms/:id/agent` + `/agent/message` + `/agent/approve` (api.ts); `configureAgentHost({terminal})` + cleanup in index.ts. The agent host's `startAgentForRoom`/`handleAgentMessage`/`resolveApproval` run against the live doc via `getRoomDoc`.
- **Verified e2e** (`apps/web/scripts/v0_5-agent-check.mjs`, 12/12 PASS): mock agent joins → its edit lands in the shared doc (`mockHelper1()` via the doc, not FS) → chat reply → **destructive delete gated** (awaiting-approval) → **REJECT preserves**, **APPROVE applies** → shared terminal shows `echo` output. typecheck + build + **61 server tests** green.
- **Two more agent boundary-slips handled:** (1) the C agent switched `main` to a stray branch `perf/web-lazy-room-split` (its own commit 67c2f08 lazy-loads the room route — a *good* change, kept); (2) merges landed there, so I fast-forwarded `main` to include all v0.5 work and removed the stray branch.

**Caveats:** real ACP agent (Claude/Codex/Gemini) is code-complete but **BYO-key** (not runtime-tested here — verified via mock). Agent→git-commit authorship surfacing lands with v1.0's in-UI git.

**Next → v1.0 "Code with friends, out loud"** ([plans/releases/v1.0.md](plans/releases/v1.0.md)): LiveKit voice (no video) · group + DM chat (Yjs) · in-UI git + checkpoint/rollback + merge gate · shared preview pane · OIDC + optional Postgres + roles · hardened self-host. The lovable core, complete.

---

## [2026-05-31 · tick 6] v0.5 fanned out across 3 worktrees

**Done**
- v0.3 tagged. v0.5 Slice 0 on `main`: `packages/shared/src/agent.ts` (AgentBackendKind/AgentConfig/AgentChatMessage/ApprovalDecision/AgentEvent), `agentChat` Yjs key + `getAgentChat`. Deps: node-pty, `@zed-industries/agent-client-protocol` (ACP SDK), `@xterm/xterm`, `@xterm/addon-fit`. Committed `e913602`.
- Worktrees `.worktrees/{A-agent,B-terminal,C-web}` → `v0_5-*`. Launched `ice-v0_5-build` (task `wpup716xb`).
  - **A** = agent host + **ACP↔Yjs adapter** (agent edits = origin-tagged `{kind:'agent'}` Yjs txns) + approval gate + a **mock agent** for verification; real ACP backend BYO-key. Heavy vitest.
  - **B** = shared terminal (node-pty → shared `terminal` Y.Text channel).
  - **C** = web agent UI (agents panel, chat, approval buttons, xterm terminal pane).

**Env note:** no real ACP agent binary/key in this sandbox → verification uses the **mock agent** (proves the adapter + approval + attribution + undo). Talking to real Claude/Codex is BYO-key for the user.

**Next (driver integration after merge)**
1. Merge `v0_5-*` → main. Wire: API routes `POST /api/rooms/:id/agent` (start mock agent), `/agent/message`, `/agent/approve`; inject B's TerminalRunner into A's `startAgentForRoom`; open the room doc via `getHocuspocus().openDirectConnection`.
2. Verify e2e with the mock agent: prompt → agent edit lands as attributable Yjs txn → destructive call blocks on approval → approve applies, reject doesn't → terminal output shared. typecheck/build/test.
3. Tag v0.5 → then v1.0 (voice + chat).

---

## [2026-05-31 · tick 5] ✅ v0.3 SHIPPED — "git comes home"

**Done**
- Merged 3 worktree slices: **A** git server (`apps/server/src/git/`, node-git-server over bare repos), **B** convergence module (`apps/server/src/convergence/`, the ADR-000 seam — per-room lock, 17 vitest tests), **C** web file-tree + Source Control panel.
- **Cleaned up a contamination:** the C agent leaked an orphan `apps/web/src/room/` + alt `App.tsx` onto `main` (out-of-worktree writes). Discarded those; **kept** its good independent `vite.config.ts` vendor code-splitting (separate commit). C's authoritative work came from its branch.
- **Driver wiring** (the slices export modules; I wired them into v0.1-owned files): `loadRoomFromGit` → Hocuspocus `onLoadDocument` (guarded: seed only when doc empty — **prevents the data-loss trap** where git HEAD would erase uncommitted edits); `flushAndCommit`/`listBranches`/`listCommits` → `POST /api/rooms/:id/commit` + `/branches` + `/commits`; `startGitServer`/`stopGitServer` → `index.ts` (dedicated git port = `PORT+1`).
- **Verified e2e** (`apps/web/scripts/v0_3-git-check.mjs`, 8/8 PASS): create room → edit live doc → `POST /commit` (real hash, 2 files) → **`git clone` from a plain git client returns the committed files incl. nested `lib/util.ts`** → uncommitted edit **survives reconnect** (no overwrite, no duplication). typecheck + build + 17 unit tests green.

**Caveats carried forward**
- git→doc is **seed-on-first-open**; live-merge of an external push into an already-open room is deferred (needs 3-way merge). SSH-key git auth deferred to v1.0. C left harmless `*.smoke.ts` helpers (excluded from build).

**Next → v0.5 "Your first AI teammate"** ([plans/releases/v0.5.md](plans/releases/v0.5.md))
1. Add ACP/agent contract types to `packages/shared`.
2. Fan out worktree slices: ACP host (spawn one agent out-of-process, BYO-key) · **ACP↔Yjs adapter** (agent edits = origin-tagged Yjs transactions through the doc, never raw FS) · approval gate + shared terminal (node-pty/xterm) · agent chat panel + attribution UI.
3. Merge, wire, verify (agent edits land as attributable Yjs txns; approval gate blocks destructive ops), tag v0.5.

---

## [2026-05-31 · tick 4] v0.3 fanned out across 3 worktrees

**Done**
- v0.1 committed + tagged (`v0.1`). v0.3 Slice 0 on `main`: `packages/shared/src/git.ts` (CommitInfo/BranchInfo/GitFileStatus/CommitResult), `apps/server/src/repos.ts` (bareRepoPath/worktreePath/sanitizeRoomId seam), deps (isomorphic-git, node-git-server, vitest), server `test` script. Typecheck green. Committed `e79bfaa`.
- Created worktrees `.worktrees/{A-git,B-convergence,C-webtree}` → `v0_3-*`.
- Launched `ice-v0_3-build` (task `wmsbryqjm`): A = smart-HTTP git server (node-git-server over bare repos); **B = the CRDT↔git convergence module + heavy vitest** (the architectural-law seam: Yjs source of truth, flush+commit under per-room lock, round-trip identity tests); C = web file-tree + Source Control/history panel.

**In flight**
- `ice-v0_3-build` workflow (3 slices). Slices EXPORT modules; the driver wires them into v0.1-owned files at integration (don't expect them to edit realtime.ts/api.ts).

**Next (driver integration after merge)**
1. Merge `v0_3-*` → main. Wire: `convergence.loadRoomFromGit` into Hocuspocus `onLoadDocument`; add `/api/rooms/:id/commit` (flushAndCommit), `/branches`, `/commits` to api.ts; mount the git server in index.ts.
2. Verify: `git clone/push/pull` round-trip + convergence round-trip tests + commit-from-UI; typecheck/build/test.
3. Tag v0.3 → then v0.5 (first AI agent).

---

## [2026-05-31 · tick 3] ✅ v0.1 SHIPPED — "two friends, one live file"

**Done**
- Merged worktree slices **A (server)**, **B (web)**, **C (self-host)** into `main` — disjoint scopes, zero lockfile drift, clean merges. Integrated `main`: `pnpm typecheck` + `pnpm build` green.
- **Slice D done by the driver** (the D agent failed to return structured output): real Apache-2.0 `LICENSE` (fetched canonical text), `NOTICE`, `CONTRIBUTING.md` (DCO, no CLA), `SECURITY.md`, `.github/` templates, `docs/DEPENDENCIES.md` (logs the `y-codemirror.next` risk).
- **Verified the demo headless** (`apps/web/scripts/sync-check.mjs`): booted server → client A's edit reached client B (**live sync PASS**) → restarted server → room persisted (**durability PASS**).
- Cleaned up: removed 4 worktrees, deleted `v0_1-*` branches.
- What v0.1 actually is now: one-port server (Hono REST + Hocuspocus `/sync`, SQLite durable rooms, scrypt+JWT auth, invite links); web room (CodeMirror 6 + Yjs live editing, named awareness cursors, presence, reconnect, identity); one-command Docker self-host; Apache-2.0 + DCO.

**In flight**
- (none — v0.1 closed; next is v0.3)

**Next → v0.3 "Git comes home"** ([plans/releases/v0.3.md](plans/releases/v0.3.md))
1. Freeze any contract additions needed for git into `packages/shared` (file-tree types already stubbed).
2. Fan out worktree slices: (A) smart-HTTP git server (isomorphic-git + git-http-backend) + token/SSH auth; (B) the **CRDT↔git convergence module** (the architectural-law seam — Yjs source of truth, flush+commit) — heavily tested; (C) synced multi-file tree in web + branches/history UI.
3. Merge, verify (clone/push/pull round-trip + flush correctness), commit, tag v0.3.

**Notes**
- Caveats carried forward: full `docker compose up --build` not run here (config validated); `y-codemirror.next` vendoring still pending; reconnection drop-mid-edit test deferred to a QA pass.

---

## [2026-05-31 · tick 2] v0.1 Slice 0 green; fanned out build across 4 worktrees

**Done**
- Slice 0 built on `main`: `packages/shared` (protocol + Yjs schema), `apps/web` + `apps/server` skeletons. `pnpm install` + `pnpm typecheck` + `pnpm build` all green (web bundles via Vite; server typechecks). Installed v0.1 deps (Hocuspocus **4.x**, CodeMirror 6, Yjs, y-protocols, y-codemirror.next@0.3.5, jose, better-sqlite3). Committed `763e17b`.
- **Worktree pivot:** the Workflow tool's automated `isolation:'worktree'` fails here ("not in a git repository / no WorktreeCreate hooks") because the session started *before* `git init`, so the runtime cached a non-git state. Manual `git worktree add` works fine → orchestrating worktrees myself.
- Created 4 worktrees on branches: `.worktrees/{A-server,B-web,C-selfhost,D-meta}` → `v0_1-{A-server,B-web,C-selfhost,D-meta}`.
- Launched the v0.1 build workflow: 4 agents, each implementing its slice **inside its own worktree** (`pnpm -C`/`git -C`, absolute paths) against the frozen Slice 0 contracts + wire contract, committing to its branch.

**In flight**
- `ice-v0_1-build` workflow (A: Hocuspocus+sqlite+auth · B: CodeMirror+Yjs+cursors · C: compose+Dockerfiles · D: Apache-2.0+DCO).

**Next**
1. On completion: `git merge` each `v0_1-*` branch → `main` (disjoint scopes → clean), then `pnpm install` + `pnpm typecheck` + `pnpm build`.
2. Integration-verify the demo: server boots, two HocuspocusProvider clients sync a Y.Text (headless proxy for the two-window cursor demo).
3. `git worktree remove` the 4 worktrees; update v0.1 spec checklist; commit v0.1; then start v0.3.

**Notes**
- For native worktree isolation later, configure `WorktreeCreate`/`WorktreeRemove` hooks in settings.json. Manual worktrees are the workaround.
- Each worktree gets its own node_modules via `pnpm install` (warm offline store, cheap with pnpm hardlinks).

---

## [2026-05-31 · tick 1] PM council decided — authoritative plan documented

**Done**
- PM council (6 personas → Head-of-Product) returned a decisive plan. Highlights: shared live workspace (not isolation); CodeMirror 6 + `y-codemirror.next` (no VS Code fork); Yjs + Hocuspocus (single CRDT); agents via ACP writing **through** the Yjs doc; LiveKit voice-only; isomorphic-git smart-HTTP git server; SQLite default; single Apache-2.0; `docker compose up`.
- Locked the **architectural law**: Yjs = single source of truth for open files; agents never touch raw FS; git commits projected from the doc via explicit flush (one owned `convergence` module, landed v0.3 before agents at v0.5).
- Wrote authoritative docs: `docs/DECISIONS.md` (12 ADRs + anti-bloat charter + risks), `docs/ROADMAP.md`, `docs/ARCHITECTURE.md`.
- Wrote per-release specs: `plans/releases/{_TEMPLATE,v0.1,v0.3,v0.5,v1.0,v1.5,v2.0}.md`. v0.1 has full checklist + worktree build slices + file map.
- Reconciled task list to the real roadmap (v0.1, v0.3, v0.5, v1.0, v1.5, v2.0).

**In flight**
- (none — about to start v0.1 build)

**Next**
1. Scaffold **Slice 0** of v0.1 on `main`: `packages/shared` (protocol + Yjs doc schema) + `apps/web` & `apps/server` skeletons (buildable/typecheck-clean). Commit so worktrees branch from stable contracts.
2. Fan out a worktree-isolated workflow for v0.1 slices A (server/Hocuspocus), B (web/CodeMirror+Yjs), C (self-host/compose), D (project meta/LICENSE/DCO).
3. Integrate worktrees → wire web↔server → typecheck/build → run the two-window live-cursor demo.

**Notes**
- Roadmap versions are v0.1 / v0.3 / v0.5 / v1.0 / v1.5 / v2.0 (council's numbering).
- Risk to watch from the start: vendor + pin + license-stamp `y-codemirror.next` (stale dep).

---

## [2026-05-31 · tick 0] Foundation + PM council convened

**Done**
- `git init`; created monorepo skeleton (`apps/web`, `apps/server`, `packages/shared`, `docs/`, `plans/releases/`).
- Wrote foundational docs: `README.md`, `docs/VISION.md`, `docs/COMPETITION.md`, `docs/AGENT_HANDOFF.md`.
- Wrote monorepo config: root `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `.gitignore`, `.env.example`.
- Launched **`ice-pm-council`** workflow (6 PM personas → Head-of-Product synthesis) to decide scope, stack, and roadmap to v2. Run is in flight in the background.

**In flight**
- PM council workflow (background) — will produce the authoritative product/stack/roadmap decision.

**Next**
1. On council completion: write `docs/DECISIONS.md`, `docs/ROADMAP.md`, `docs/ARCHITECTURE.md` from the decided plan.
2. Write per-release specs into `plans/releases/` (v0.1 → v2.0).
3. Scaffold `apps/web`, `apps/server`, `packages/shared` (TS + pnpm — safe regardless of council detail).
4. Begin v0.1 implementation by fanning out worktree-isolated workflows.

**Notes**
- Product interpretation: **ICE = Integrated Collaborative Environment** (a self-hostable collaborative IDE). "ICE" treated as intentional.
- Thesis locked: **shared live workspace** for humans + multiple agents (not worktree isolation). See VISION.md.
- License working default: Apache-2.0 (pending council ratification).
