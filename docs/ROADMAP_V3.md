# ICE — v3 Roadmap ("Trust the squad")

> **Status: 📋 PLANNED — not built.** Ratified by the `ice-v3-council` (6 PM personas → Head-of-Product synthesis) on 2026-05-31. This is the plan for the next arc after the shipped v0.1 → v2.0. Per-release specs (build them in order): [`plans/releases/v2.1.md`](../plans/releases/v2.1.md) · [`v2.2.md`](../plans/releases/v2.2.md) · [`v2.3.md`](../plans/releases/v2.3.md) · [`v3.0.md`](../plans/releases/v3.0.md). Honors the v0.1 anti-bloat charter in [DECISIONS.md](DECISIONS.md) — **no new pillars.**

## North star

**v3 = "Trust the squad."** The shared multi-agent workspace — humans plus multiple AI agents editing ONE live buffer — is already **built** (v0.1→v2.0). v3 doesn't add pillars; it **earns the right to be trusted with code people care about.**

The bar: a 2–8 person squad self-hosts ICE with one `docker compose up`, points a **real** ACP agent (Claude Code/Codex/Gemini) with their own key at a real repo that is **also being pushed to from outside**, several humans co-edit, they **walk away overnight**, and come back to a workspace that is **intact, attributable** ("which agent did this, and was it allowed?"), and **reversible** — all guarded by **green CI**.

Every v3 feature either **(a)** closes a correctness/safety/runtime-verification gap on something already shipped, or **(b)** deepens the ONE differentiator: *coordination of agents in shared context* (presence, intent, turn-taking) that the worktree-isolation crowd structurally cannot copy. "A collaborative IDE that loses your code" is the only fatal outcome — v3 makes losing it impossible.

## Themes

1. **Enforce the edge** — make the agent safety rails real (policy enforcement wired live, agent sandbox, node-sound convergence lock) behind a CI wall that never lets a regression land.
2. **Prove it against reality** — every shipped pillar verified against **real** services and at least one **real** agent; the operator can **see** (metrics/health) and **survive** abuse (rate limits, spend caps).
3. **Legible, coordinating squad** — deepen the moat where it's thin: advisory intent-locks / turn-taking so agents co-edit the same code without trampling, full provenance, a real review surface.
4. **Bidirectional convergence + audited trust contract** — the git-in-the-box pillar becomes truly two-way (live external-push merge) on a hardened, security-audited, CI-proven base. The change that earns the v3.0 stamp.
5. **Anti-bloat discipline** — no new pillars, no enterprise sprawl, no second coordination substrate. Finish and harden what shipped.

## Release arc

| Version | Theme | The point |
|---|---|---|
| **v2.1** | Enforce the edge | Make the safety rails actually fire; build the CI wall; fix the latent multi-node lock bug — cheapest, highest-trust wins, before anything risky lands |
| **v2.2** | Prove it against reality | Convert "mock/single-node tested" → "verified against the real thing"; the BYO-key real-agent path becomes first-class; operator gets eyes + spend governor |
| **v2.3** | Legible, coordinating squad | Advisory intent-locks/turn-taking, reviewer-agent, full blame, agent commit authorship, a real merge-review surface — the on-charter sliver of moat depth |
| **v3.0** | Bidirectional convergence + audited trust contract | Live 3-way external-push merge (lands DEAD LAST), chaos/stress proof, external security audit, the GA trust artifact |

---

## v2.1 — Enforce the edge
**Goals:** make the agent safety rails fire at runtime (not just unit tests); build the CI wall so nothing below silently re-rots; fix the multi-node correctness bug before any "production-ready" messaging.
**Features**
- **[debt · P0]** Wire per-tool-call **POLICY ENFORCEMENT** into the live agent host/adapter: `enforce()` at the single tool-call interception seam (deny → block + audit; requireApproval → existing gate; allow → proceed), with an **adversarial e2e** proving a denied call never mutates the Y.Doc and is audited. _(Engine/registry/routes/18 tests already exist in `apps/server/src/agent-policy/`; the hook in `agent/host.ts`+`agent/adapter.ts` is the unbuilt piece. Today the per-agent policy is **decorative**.)_
- **[debt · P0]** **CI on every PR**: typecheck + lint + build + all server tests + the existing `apps/web/scripts/*-check.mjs` e2e scripts; **branch protection** (no green, no merge).
- **[debt · P0]** Make the **convergence lock SOUND across nodes** (sticky single-node room ownership, or a Redis-backed lease); document the invariant in the threat model + `SCALING.md`; keep scale-out **labeled experimental** until verified.
- **[new · P0]** Opt-in agent **SANDBOX** profile + "sandboxed agent host" compose flag (seccomp/bind-mount around the shared workspace, mapped to the now-enforced policy `writePaths`) — **OS-level confinement, NOT per-agent container isolation.**
- **[debt · P1]** Basic **rate limiting** on auth / agent-spawn / git-push / sync-handshake routes.
- **[debt · P1]** **Vendor + pin + license-stamp `y-codemirror.next`** into `packages/vendor/` with a thin binding regression test (remote cursors, origin-tagged remote edit, undo-by-origin). _(The documented #5 risk since v0.1 — stop deferring it.)_

**Rationale:** cheapest, highest-trust wins first, and the wall that protects everything after. The enforcement + lock + sandbox triad closes the most dangerous gaps (an unenforced policy, a corruptible multi-node commit) with the smallest diffs; no architecturally-risky build lands until CI guards it.

## v2.2 — Prove it against reality
**Goals:** turn "wired + mock/single-node tested" into "verified against the real thing"; make the BYO-key real-agent path first-class (not a sketch that falls back to a mock); give the operator eyes + survival controls.
**Features**
- **[new · P0]** **Replayable ACP transcript harness**: record a real Claude Code/Codex session once, replay it deterministically so the adapter + policy + approval + convergence path runs **keyless in CI**.
- **[debt · P0]** Opt-in **real-service integration tier** (compose + BYO secrets): boots + asserts happy-path for ≥1 **real ACP agent** end-to-end, **LiveKit** audio (token→join), **OIDC** vs a containerized IdP, **Postgres**-as-primary, and a **2-node real-Redis** cluster validating cross-node sync **AND** the v2.1 lock invariant. ≥1 real-agent backend is a **HARD release gate** (manual on a maintainer box is acceptable; "still mock-only" is not).
- **[debt · P0]** First real exercise + hardening of the **BYO-key `LlmPlanner`** (real LLM-routed orchestrator — currently entirely untested).
- **[new · P1]** Real-agent **BYO-key onboarding wizard + `doctor`/verify** command (detect ACP backends; validate the key with a live "write one line" round-trip; replace the silent mock-fallback) + a fixed, **TESTED** README quickstart (no more "not yet wired up").
- **[debt · P1]** **Minimal observability**: structured logs + correlation id, `/healthz` + `/readyz`, a Prometheus-text `/metrics` surface (rooms, active agents, sync rate, commit+flush latency, approval-gate hits, policy-deny count) — **NOT a dashboard product.**
- **[new · P1]** Provider **spend + iteration/concurrency GOVERNOR**: per-room/per-agent token + cost + loop budgets with a **hard kill + audit** on breach, surfaced in the Squad UI + `/metrics`.

**Rationale:** the whole value prop is self-hosting real infra + a real agent; "works against a mock" isn't a credible production signal, and the real ACP path (agents assume raw FS; ICE redirects every edit through Yjs) is exactly where reality bites. Proving it here — gated and metered — is what earns the trust claim.

## v2.3 — Legible, coordinating squad
**Goals:** deepen the moat where it's genuinely thin (multiple writers safely in the SAME buffer); make every agent action legible after the fact; give humans a real review surface before agent work becomes history.
**Features**
- **[new · P1]** **Soft intent-locks / turn-taking** over the existing Yjs **awareness** protocol: agents + humans broadcast an advisory, TTL'd "editing function X in foo.ts" region claim; others yield/queue/ask and see colored "agent working here" highlights, with human override. **ADVISORY only** — the CRDT stays conflict-free underneath; if the lock layer fails, degrade to today's uncoordinated-but-lossless behavior, **never to data loss**. Plus an orchestrator same-file-collision hint.
- **[new · P1]** **Reviewer-agent gate**: promote the existing (mock) "reviewer" role to review another agent's proposed diff on the propose-then-apply path, posting structured findings into agent chat, able to **block at the existing approval gate** or approve-with-comments — human is final arbiter. Reuses the approval-gate + policy machinery.
- **[debt · P2]** **Full per-line human-vs-agent BLAME**: persist each transaction's origin tag into a durable per-line attribution layer, rendered in the gutter + `BlameView`.
- **[debt · P2]** **Agent→git-commit AUTHORSHIP** end-to-end: originating identity in commit trailers (`Co-Authored-By` / agent id) + the in-UI git history.
- **[debt · P2]** Deepen the branch-diff **MERGE GATE** from the light v1.0 cut into a real review surface: side-by-side per-file/per-hunk accept-reject with "who/what authored each hunk," reusing a shared in-editor **conflict-region primitive**.
- **[new · P2]** Agent **run-record / "replay my changes"** timeline in the Squad panel (prompt → tool calls → approvals/denials → edits → commit), reconstructed from the audit trail + origin tags — a view over data already captured.
- **[new · P2]** **"First 5 minutes" guided demo room**: seeded sample repo + onboarding checklist (second cursor → voice → @-mention the agent to add a function) + a short README GIF from that exact flow.

**Rationale:** coordination is the "genuine open gap" the isolation crowd cannot copy — built entirely on the awareness + origin-tag + approval-gate substrate ICE already owns, with intent-locks kept strictly **advisory** so the differentiator can never become a data-integrity risk.

## v3.0 — Bidirectional convergence + audited trust contract
**Goals:** make the git-in-the-box pillar truly two-way (an external push lands live without losing either side); earn the v3.0 stamp by changing the trust **contract** (enforced, real-service-proven, durably correct, externally audited); ship the trust artifact.
**Features**
- **[new · P0]** **Live 3-way MERGE** of an external git push into an already-open room (base = last-synced commit, ours = live Yjs buffers, theirs = pushed HEAD), applied as origin-tagged `{kind:'git-merge'}` transactions under the now node-sound per-room lock. Sequenced **DEAD LAST** on purpose; shipped behind a flag with the existing data-loss guard as fallback.
- **[new · P0]** **In-editor conflict-resolution UX** (accept theirs / keep ours / per-hunk merge) reusing the v2.3 conflict-region primitive — conflicts surfaced to a human, **never silently auto-resolved**.
- **[new · P0]** **Concurrent multi-agent + human convergence STRESS / chaos harness** (Jepsen-style): N real-ish agents + humans hammering the same files under network jitter + reconnects, asserting **zero divergence** across Yjs↔FS↔git and **zero lost edits**. The gating bar for the live merge; ships as a published result.
- **[new · P0]** **External SECURITY AUDIT** (OWASP Top 10 + STRIDE) of the three named surfaces — agent-runs-code, the git server, voice-token mint — plus room↔room isolation tests, invite/token hardening, and an agent approval-gate-bypass adversarial pass. Fix what it finds.
- **[new · P1]** Opt-in tamper-**EVIDENT** append-only audit export (hash-chained external sink) — closing the one accountability gap the threat model admits. **NOT** a heavyweight in-core crypto ledger.
- **[debt · P1]** Promote the v2.2 real-service verification into a maintained, documented **integration suite** (the repeatable production-trust contract) + a "production self-host" golden-path doc.
- **[new · P0]** **v3.0 GA stamp**: a tagged, e2e-in-CI, security-reviewed release that publishes the stress-proof + audit results as the **trust artifact** and states the guarantee — *no lost edits, no silently-wrong commits, every agent action attributable + enforced.*

**Rationale:** the external-push live merge is the one item that completes the load-bearing convergence seam AND the one item that can break the architectural law it serves — so it lands last on a hardened, CI-gated, sandboxed, policy-enforced base, fuzzed against concurrent human+agent+push chaos and conflict-surfacing-first.

---

## Explicitly OUT of v3 (the charter holds)

| Tempting | Why it's out |
|---|---|
| **A2A protocol / inter-agent message bus** | Already DECLINED at v2.0. The shared Y.Doc + orchestrator + new v2.3 intent-locks ARE the coordination substrate — cheaper, proven, inside ADR-000. A second mechanism fights the moat and routes around the safety rails. Revisit only post-v3 if the stress harness shows the shared-doc router hits a wall. |
| **Agent memory store + real-LLM same-file/dependent-subtask decomposition** | Genuinely attractive moat depth, but **deferred to v3.x** — both stack new intelligence on a base unverified until v2.2, and same-file decomposition *depends* on intent-locks proving safe first. Don't ship the "clever broken moat." |
| **`create-ice-extension` scaffold / examples gallery / community index / templates** | Contributor-ecosystem bets, not trust bets. The extension *mechanism* shipped (v2.0); an "awesome-list" before the real-agent experience is loved is an empty storefront. v3.x. |
| **Per-file ACLs, RBAC matrices, SSO/SAML, SCIM, admin/org consoles, multi-tenant SaaS, billing** | Charter ban (ADR-009; "the room is the unit of access"). OIDC + owner/member roles already suffice for squads of 2–8 — v3 *verifies* them, doesn't grow them. The per-**agent** policy engine is the access-control work that matters. |
| **Per-agent worktree / container ISOLATION as a core execution model** | The OPPOSITE architecture (ADR-001) — the commoditized lane ICE ceded. The opt-in v1.5 snapshot + the v2.1 OS-level sandbox already serve the rare "agent needs real FS" case without partitioning agents. |
| **Video / screen share** | Permanently OUT (ADR-005) — the shared editor IS the shared screen; balloons bandwidth against self-host; heavy surface in a risk-reduction release. |
| **Full git forge (issues/PR-as-product/CI-for-users'-repos/wikis/registry) + Kanban/PM board** | Charter ban (ADR-007). Optional Forgejo already serves forge-wanters; the orchestrator task model is internal plumbing, not a Jira (Vibe Kanban's death is the signal). ICE's CI is for ICE's own repo. |
| **Own model / inference gateway / ICE-managed-keys proxy** | Bottomless cost + lock-in (ADR-004). BYO-key via ACP is the model; the moat is COORDINATION. The onboarding wizard + spend governor reduce key friction without ICE touching inference. (A thin pass-through to the user's OWN gateway purely for spend caps is acceptable; shipping inference is not.) |
| **K8s/Helm as default, operators, multi-region active-active, a second CRDT engine (Automerge/y-sweet swap)** | Charter ban (ADR-010, ADR-003). The optional Helm chart is the ceiling; `docker compose up` stays the promoted path. v3 makes the *shipped* single-region scale-out SOUND, not hyperscale; a second correctness-critical CRDT would endanger the convergence guarantees v3 exists to prove. |
| **Heavyweight observability stack (Grafana/Prometheus/tracing as default) / admin dashboard / in-core tamper-PROOF crypto ledger** | v3 observability is deliberately MINIMAL (logs + `/metrics` + health as seams the operator owns). The right durability move is the opt-in append-only audit EXPORT, not a ledger gold-plating a non-goal. |
| **Desktop (Electron/Tauri) or mobile-native client** | Charter ban (web-first, "send a friend a link"). A new client surface multiplies the verification burden v3 is paying down. The protocol lives in `packages/shared` so a TUI/desktop client stays *possible* later — not v3 scope. |
| **Web IDE feature-parity (debugger UI, LSP-everything, marketplace shell, multi-pane "pro IDE" chrome)** | The #1 named bloat trap (NOT a VS Code fork). CodeMirror 6 + the collaborative layer IS the wow; IDE chrome buries the differentiator and starts an infinite Marketplace war. Zero IDE-parity work in v3. |

## Top risks (and how the sequencing mitigates them)

1. **The runtime-verification mirage / maturity theater.** Everything is mock/single-node verified; the thesis collapses the moment a real ACP agent meets "agents write through Yjs, never the FS" (off-the-shelf agents assume raw FS). Because that path is gated behind BYO-key + SFU + IdP, the team can keep deferring it and ship a v3 that's STILL only mock-proven. **Mitigation:** v2.2 real-service verification is a hard, early, non-skippable gate (≥1 real agent = release blocker); the replayable transcript harness makes it CI-testable keyless; any ACP↔Yjs adapter rework it surfaces **is** the true scope of v3, not a side quest.
2. **Doing the merge before the wall, on an unsound lock.** The live 3-way external-push merge is the largest, most concurrency-subtle build and the one item that can break ADR-000. **Mitigation:** the sequencing is forced — CI + enforced policy + node-sound lock are P0 in v2.1; the merge lands DEAD LAST in v3.0 behind a flag with the data-loss guard as fallback, conflict-surfacing-first, gated by the chaos harness.
3. **Coordination overreach turning the conflict-free moat into a deadlock/clobber nightmare.** v2.3 intent-locks invite multiple writers into one buffer. **Mitigation (non-negotiable):** intent-locks are ADVISORY presence only, NEVER a data-integrity mechanism — failure degrades to today's conflict-free behavior, never to data loss; they land AFTER the CI wall + enforced policy; same-file LLM decomposition + agent memory are held to v3.x. If locks can't be made provably safe, ship the reviewer-agent (which never touches data integrity) and hold same-file coordination.
4. **v3 quietly slides back into feature-building and ships another impressive-but-unbootable release.** The README literally said "not yet wired up," there's zero CI, every real service is mock/single-node. **Mitigation:** v2.1 (green CI) and v2.2 (real-service proof + tested quickstart + BYO-key wizard) are HARD GATES — no v2.3 moat feature merges until CI is green on a clean machine and the real-agent path is verified; success is an adoption metric (time-from-clone-to-second-cursor-with-a-real-agent), not feature count.
5. **Unenforced policy + un-sandboxed agent host = agent RCE on the self-hoster's box.** Today a configured `AgentPolicy` is silently ignored at runtime; host containment is the operator's homework. **Mitigation:** policy enforcement is the v2.1 #1 (smallest diff, largest risk reduction), paired with the opt-in OS-level sandbox, the spend/iteration governor, and capped by the v3.0 external audit of exactly the agent-runs-code surface.

## Definition of done — v3.0

v3.0 is DONE when an external user can, with one `docker compose up` on a clean machine, self-host ICE, run the **tested** quickstart, use the BYO-key wizard to point a **real** ACP agent at a real repo, invite several humans, **push to that repo from an outside git client while the room is live**, leave it running overnight, and come back to a workspace where:

1. **No edit was lost and no commit is silently wrong** — proven by the published Jepsen-style convergence stress harness (zero divergence across Yjs↔FS↔git under concurrent human+agent+external-push chaos), and the external-push 3-way merge surfaces conflicts to a human rather than auto-clobbering.
2. **Every destructive agent tool call was provably gated** — per-tool-call policy enforced live (a denied call never mutated the doc and is audited), the agent host ran inside the shipped sandbox, and the spend/iteration governor could hard-kill a runaway.
3. **Every line and commit is attributable** to the exact human or agent that authored it, with a replayable run-record.
4. **The multi-node config is sound** (the convergence lock serializes flush+commit across nodes, verified by the 2-node real-Redis CI test) — no longer labeled experimental.
5. **All of it is guarded by a green CI wall** (typecheck + build + tests + e2e + real-service matrix) that blocks every merge, and the agent-runs-code + git + voice-token surfaces have passed an **external OWASP/STRIDE audit** with findings fixed.

The tagged v3.0 publishes the stress-proof + audit results as the trust artifact and states the guarantee: **no lost edits, no silently-wrong commits, every agent action attributable and enforced.** No new product pillar shipped; the anti-bloat charter held.

---

## How to build this (for the next agent team)

Build the releases **in order** (each is independently shippable; dependencies flow forward — the CI wall + enforced policy + node-sound lock in v2.1 gate everything after). Each has a spec stub in [`plans/releases/`](../plans/releases/) using the standard [`_TEMPLATE.md`](../plans/releases/_TEMPLATE.md) format; flesh out its build slices + file map at build time, then fan out worktree-isolated workflows exactly as v0.1→v2.0 were built (see [AGENT_HANDOFF.md](AGENT_HANDOFF.md)). **Hard gate:** do not start v2.3 moat work until v2.1 CI is green on a clean machine and v2.2 has verified the real-agent path.
