# ICE Threat Model (self-hoster)

> The formal threat model promised by [SECURITY.md](../SECURITY.md), shipped with v2.0. It is written **for the operator who runs ICE** — the person who decides who joins, where it runs, and what agents may do. It is not a compliance certificate; it is a map of the trust boundaries, the realistic threats per component, and the mitigations you are responsible for.
>
> Audience: self-hosters, security reviewers, and contributors changing a security-relevant surface (whose [RFCs](rfcs/README.md) should update this file). Scope: ICE as shipped (`apps/web`, `apps/server`, the bundled git server, the voice token service, the agent host + MCP, the optional [scale-out Redis bus](rfcs/0001-example-scale-out.md)).

---

## 0. The governing assumption

**The deployer is the administrator and owns the trust boundary.** ICE is software you run, not a service you rent. There is no vendor operating a control plane, no phone-home, no managed backstop ([GOVERNANCE §8](../GOVERNANCE.md#8-what-cannot-change)). Every mitigation below is something *the operator* configures. ICE gives you the seams (auth, approval gates, policy, isolation hooks); the surrounding controls (TLS, network isolation, OS sandboxing, secret management) are yours.

Two facts drive everything:

1. **Agents execute code.** AI agents are first-class participants that can run commands and edit the workspace (gated by an approval surface). Treat an agent's reachable capability set as code execution on your infrastructure.
2. **The room is the unit of access.** Anyone with access to a room can see and edit everything in it — files, chat, terminals, agent activity. There is no per-file ACL inside a room.

---

## 1. Assets (what we're protecting)

| Asset | Why it matters |
|---|---|
| **Source code in rooms** (Yjs docs + git history) | The product. Confidentiality + integrity + availability. |
| **The host / infrastructure** | Agents and terminals run here; RCE on the box is the worst case. |
| **Secrets** | `ICE_SESSION_SECRET`, provider keys (`ANTHROPIC_API_KEY`), `LIVEKIT_API_SECRET`, git tokens/SSH keys, `DATABASE_URL`, optional `ICE_REDIS_URL`. |
| **Identities & sessions** | Session JWTs (`ice_session` cookie), invite links, OIDC identities. |
| **The audit trail** | `getAudit(doc)` — attribution of who/what did what; integrity matters for accountability. |
| **Availability of the live workspace** | A collaborative IDE that drops edits or wedges a room is itself a failure. |

## 2. Actors (who might threaten them)

- **External unauthenticated attacker** — can reach exposed ports only.
- **Holder of a leaked invite link** — invite links are bearer secrets; possession ⇒ room access.
- **Malicious or careless room member** — already inside one room; may try to escalate to the host, other rooms, or secrets.
- **A compromised or prompt-injected agent** — an agent steered (via a poisoned file, web content, or MCP tool output) into acting against the operator's intent.
- **A malicious dependency / community extension** — third-party code the operator installs (npm deps, an [extension manifest](EXTENSIONS.md), an MCP server).
- **A network adversary on a shared/internal network** — can sniff or inject if traffic isn't encrypted/isolated (esp. the optional Redis bus).

---

## 3. Trust boundaries

```
            ┌─ Public internet ───────────────────────────────────────────────┐
            │  attacker (unauth)        invite-link holder (bearer)            │
            └───────────┬──────────────────────────────────┬──────────────────┘
   TLS / reverse proxy  │   (terminate TLS, rate-limit)     │
            ┌───────────┴──────────────────────────────────┴──────────────────┐
            │  apps/web (browser SPA) — HOLDS NO AUTHORITY; server is truth    │
            └───────────┬──────────────────────────────────┬──────────────────┘
   ws /sync, ws agents, │  git smart-HTTP, WebRTC(LiveKit)  │
            ┌───────────┴──────────────────────────────────┴──────────────────┐
   BOUNDARY │  apps/server (authoritative): sync · git · agent host · voice    │
            │  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────┐  │
            │  │ Yjs/Hocuspocus│  │ git server   │  │ AGENT HOST + MCP        │  │
            │  │ + persistence │  │ (bare repos) │  │  ⚠ runs commands/tools  │  │
            │  └──────────────┘  └──────────────┘  └───────────┬────────────┘  │
            │   convergence (FS↔git)   secrets (env)            │ approval gate │
            └───────────────────────────────┬──────────────────┴───────────────┘
   server-to-server (private net only):     │  child processes / OS  ← strongest
            ┌───────────────────────────────┴──────────────────────────────────┐
            │  optional Redis bus (scale-out)   external MCP servers   LLM APIs │
            └────────────────────────────────────────────────────────────────────┘
```

Key boundaries, strongest trust at the bottom:

- **Internet → reverse proxy/TLS → server.** Everything external should cross TLS and a proxy you control. ICE's HTTP/WS port serves both the REST API and `/sync`; do not expose it raw.
- **Browser ↔ server.** The browser is **untrusted**: it holds no authority, the server is authoritative for all state and access checks ([ARCHITECTURE.md](ARCHITECTURE.md)). Never move an authorization decision client-side.
- **Room ↔ room.** Rooms are the access unit; a member of room A must not reach room B's doc, repo, or terminals. The server enforces this on every sync/API/git request.
- **Server ↔ agent-run code.** The agent host launches out-of-process agents and (via MCP) external tools. This is the **highest-consequence** boundary: code here runs with the agent process's privileges on your host.
- **Server ↔ server (scale-out).** With the optional [Redis bus](rfcs/0001-example-scale-out.md), live document deltas cross a network hop between processes — a boundary that must stay on a private, authenticated channel.

---

## 4. Per-component analysis (STRIDE-ish)

For each component: the realistic threats (Spoofing, Tampering, Repudiation, Information disclosure, Denial of service, Elevation of privilege) and the mitigations — those ICE ships, and those **you (the operator)** must add.

### 4.1 Sync (Yjs / Hocuspocus + persistence)

The live editing plane: clients connect over `/sync`; the server holds the authoritative `Y.Doc` per room and persists it (SQLite/libSQL or Postgres via `DATABASE_URL`).

| Threat | Risk | Mitigation |
|---|---|---|
| **S** — connect to a room you're not in | Read/write another team's code | Server's auth hook validates the session/invite **per room** on the sync handshake; reject unknown/expired. *Operator:* require auth, scope invites tightly. |
| **T** — forge edits as another identity | False attribution; corrupt convergence | Edits are origin-tagged Yjs transactions; the server stamps server-known identity, never trusting a client-asserted author. |
| **I** — sniff document traffic | Source-code disclosure on the wire | **TLS terminates at your proxy** (`wss://`). ICE does not ship its own cert — *operator must* run HTTPS. |
| **D** — flood updates / open many docs to exhaust RAM | Room or host unavailability | *Operator:* rate-limit + connection caps at the proxy; size the host; consider [scale-out](rfcs/0001-example-scale-out.md). Persistence bounds memory loss on restart. |
| **R** — deny having made an edit | Accountability gap | Per-origin attribution + the [audit trail](#46-the-audit-trail) record actor + action. |

### 4.2 Git server (bundled, smart-HTTP/SSH over bare repos)

ICE ships its own git server (`apps/server/src/git`, `ICE_GIT_ROOT`) so "your code, your infra" needs no external forge.

| Threat | Risk | Mitigation |
|---|---|---|
| **S/E** — unauthenticated push/fetch | Read or rewrite history of any repo | Git endpoints require authentication (tokens/SSH keys, v0.3+) and are **room/repo-scoped**. *Operator:* never expose the git port without auth + TLS. |
| **T** — path traversal in a repo/ref name to escape `ICE_GIT_ROOT` | Read/write arbitrary host files | Server resolves and confines repo paths under `ICE_GIT_ROOT`; reject `..`/absolute traversal. *Operator:* run the server as a low-privilege user so even a miss is contained. |
| **I** — steal a git token / SSH key | Persistent repo access | Treat tokens/keys as secrets; scope and rotate them; transport over TLS/SSH only. |
| **D** — giant pushes / pack bombs | Disk/CPU exhaustion | *Operator:* quota the volume backing `ICE_GIT_ROOT`; cap request sizes at the proxy. |

### 4.3 Agent host + MCP (the sharp edge)

Out-of-process agents (ACP, BYO-key) write **through** the Yjs doc and may run commands; MCP servers add external tools. This boundary is where "an attacker" most plausibly becomes "code on your host."

| Threat | Risk | Mitigation |
|---|---|---|
| **E** — agent runs a destructive/exfiltrating command | RCE / data theft on the host | **Approval gate**: risky/destructive tool calls require explicit human approval (v0.5+). **Per-agent policy** ([`AgentPolicy`](../packages/shared/src/orchestration.ts)) bounds allow/deny tools and write paths; deny beats allow. *Operator:* **sandbox the agent host** — containerise it, drop privileges, restrict egress, mount only the workspace. This is the single most important operator control. |
| **T** — prompt injection via poisoned file / web / tool output | Agent coerced into harmful actions | The approval gate + policy mean a coerced agent still can't *destructively* act unattended; keep `requireApprovalForDestructive` on; scope `writePaths`. Review what MCP tools an agent can reach. |
| **S** — a rogue/typosquatted MCP server | Malicious tool surface | MCP servers are **operator-configured** (`ICE_MCP_SERVERS` / [community extensions](EXTENSIONS.md)) — installing one is a deliberate, vetted act. The loader validates *shape*, not *trust*; vet the source. Tools still pass policy + approval. |
| **I** — provider key / secret read by agent-run code | Key exfiltration | Inject `ANTHROPIC_API_KEY` (and friends) only into the processes that need them; don't expose host env wholesale to agent-run subprocesses; prefer a gateway with scoped keys. |
| **D** — runaway agent loop | Resource exhaustion, runaway spend | Humans can interrupt any agent/squad; *operator:* set provider spend limits and host resource limits. |
| **R** — "which agent did this?" | Attribution gap | Every agent edit is origin-tagged `{kind:'agent', agentId}`; the [audit trail](#46-the-audit-trail) records tool calls and approvals. |

### 4.4 Voice tokens (LiveKit)

The server mints short-lived LiveKit access tokens (`LIVEKIT_API_KEY`/`SECRET`) so members can join a room's voice channel; media is WebRTC to LiveKit.

| Threat | Risk | Mitigation |
|---|---|---|
| **S** — mint/replay a token for a room you're not in | Eavesdrop on a voice room | Tokens are minted **server-side only after the room access check**, scoped to that room, and **short-lived**. Never mint client-side. |
| **I** — leak `LIVEKIT_API_SECRET` | Forge arbitrary tokens | It is a top-tier secret: env-only, never to the browser, rotate on suspicion. |
| **I** — media interception | Voice disclosure | Run LiveKit with TLS/SRTP; isolate the LiveKit service network. |

### 4.5 Optional scale-out bus (Redis)

Only present when the operator opts into [horizontal scale-out](rfcs/0001-example-scale-out.md) (`ICE_REDIS_URL`). Redis then carries **live document updates + awareness** between server processes.

| Threat | Risk | Mitigation |
|---|---|---|
| **I/T** — read or inject updates on the bus | Source disclosure / forged edits across the cluster | **Network-isolate Redis** (private net/VPC), require a password, use TLS across hosts. Never expose Redis publicly. Persistence — not Redis — remains the source of truth. |
| **I** — `ICE_REDIS_URL` embeds credentials | Credential leak | Treat as a secret like `ICE_SESSION_SECRET`. |

### 4.6 The audit trail

`getAudit(doc)` (a Yjs array, `AuditEntry{actor, action, detail, at}`) is the accountability record.

- **Tampering:** it lives inside the room doc, so a room member could in principle append spurious entries; treat it as *attribution evidence*, not a tamper-proof ledger. *Operator:* for stronger guarantees, ship audit entries to an append-only external sink (out of scope for ICE core).
- **Repudiation:** combined with per-origin Yjs attribution and approval records, it answers "who/what did this, and was it approved?"

---

## 5. Cross-cutting: secrets

| Secret | Used for | Rule |
|---|---|---|
| `ICE_SESSION_SECRET` | Signs session JWTs + room/git tokens | **Set a strong, persistent value in production.** The dev default auto-generates **per boot** and *warns* — fine locally, fatal in prod (sessions die on restart; never ship the literal `change-me-in-production`). |
| `ANTHROPIC_API_KEY` (+ model gateway) | Agent provider auth | Scope/rotate; inject narrowly; consider a gateway with per-room budgets. |
| `LIVEKIT_API_SECRET` | Mint voice tokens | Server-only; rotate on suspicion. |
| Git tokens / SSH keys | git push/fetch auth | Scope per repo; rotate. |
| `DATABASE_URL`, `ICE_REDIS_URL` | Persistence / scale-out bus | May embed credentials → secrets. |

**Universal rules:** never commit `.env`; inject secrets via your orchestrator's secret store, not baked images; rotate on staff changes or suspected exposure; give each the **least scope** that works.

---

## 6. Operator recommendations (the checklist)

1. **Terminate TLS** at a reverse proxy in front of ICE; serve `https://`/`wss://` only. ICE ships no cert of its own.
2. **Sandbox the agent host.** Run agent-executed code in a container/VM with dropped privileges, a restricted filesystem (workspace only), and constrained network egress. Treat agent capability as host code execution.
3. **Network-isolate the backends** — Postgres, LiveKit, and (if used) Redis on a private network; nothing but the web/sync/git ports reachable from outside, and those only via the proxy.
4. **Run the server as a low-privilege user**, with `ICE_GIT_ROOT` and the data dir on a quota'd volume — so a path-traversal or pack-bomb miss is contained.
5. **Set a strong, persistent `ICE_SESSION_SECRET`** and manage all secrets via a real secret store; never the repo.
6. **Treat invite links as bearer secrets** — short TTLs, share over secure channels, revoke when done. (Default invite TTL is 7 days; tighten for sensitive rooms.)
7. **Keep approval-for-destructive ON** and scope each agent's `AgentPolicy` (`allowTools`/`writePaths`) to the minimum.
8. **Vet every community extension / MCP server / dependency** before installing — installing one is a privileged act ([EXTENSIONS.md](EXTENSIONS.md)). The loader checks shape, not trustworthiness.
9. **Rate-limit and size** for DoS: connection caps and request-size limits at the proxy; host resources and provider spend caps for runaway agents.
10. **Patch promptly** and watch [security advisories](../SECURITY.md); subscribe to dependency alerts.

---

## 7. Out of scope / non-goals

- **Intra-room confidentiality.** Rooms are all-or-nothing; there is no per-file ACL within a room. Put sensitive material in a separate room.
- **Defending against a malicious operator.** The operator is root of trust by design; ICE cannot protect a room from the person who runs the server.
- **Hardening the host OS / network for you.** TLS, OS sandboxing, network policy, secret storage, and backups are the operator's domain — ICE provides the seams, not the perimeter.
- **A tamper-proof audit ledger.** The in-doc audit trail is attribution evidence; export it externally if you need immutability.

---

### See also

- [SECURITY.md](../SECURITY.md) — how to report a vulnerability.
- [ARCHITECTURE.md](ARCHITECTURE.md) — components and the three-sources-of-truth law.
- [EXTENSIONS.md](EXTENSIONS.md) — the privilege of installing community extensions.
- [GOVERNANCE.md](../GOVERNANCE.md) — the self-hostable/air-gappable guarantees.
- [RFC 0001](rfcs/0001-example-scale-out.md) — the Redis scale-out boundary.
