# A2A Protocol Evaluation

> **Decision: DECLINE for v2.0.** ICE will **not** adopt the A2A (Agent-to-Agent) protocol as an inter-agent coordination layer. Agent coordination stays where it already works: the **shared Yjs workspace** plus the **orchestrator**. We keep A2A on the radar strictly as a *future interop boundary* (one ICE squad talking to a foreign agent system), not as our internal mechanism.
>
> This is the ratification of the deferral in [ADR-004](DECISIONS.md): *"No A2A before v2."* v2.0 is the decision point, the shared-workspace model is now proven, and the answer is a deliberate, decisive **no — for now, for the internal case.** Recorded per the [RFC process](rfcs/README.md); reflected in [DECISIONS.md](DECISIONS.md).

---

## What A2A is

A2A (Agent-to-Agent) is an open protocol for **autonomous agents to discover and delegate to each other across systems**: an agent publishes a capability/"agent card", others discover it, and they exchange tasks and results over a defined RPC/streaming envelope. Its center of gravity is **interop between *separately-built, separately-hosted* agents** that have no shared memory — a lingua franca so agent A (vendor X) can hand a task to agent B (vendor Y).

That framing is the crux of this evaluation: **A2A solves coordination for agents that do *not* share state.** ICE's entire thesis is the opposite.

## How ICE already coordinates agents (the thing that's proven)

By v1.5, ICE coordinates a *squad* of agents without any inter-agent protocol, because it gives them something stronger than a message bus — **a shared, live, conflict-free workspace and a conductor:**

1. **The shared Yjs document is the coordination substrate.** Every agent is a first-class `{kind:'agent', agentId}` participant editing the *same* CRDT doc ([ADR-000/001](DECISIONS.md)). Agents don't *message* each other about state — they *see the same state*, live. One agent's edit is immediately visible to every other agent and human, origin-tagged and attributable. This is the [VISION](VISION.md) bet: shared workspace, not isolated worktrees stitched together afterward.
2. **The orchestrator is the conductor.** `apps/server/src/orchestrator` decomposes a task into role-tagged subtasks (architect/coder/debugger/reviewer), routes each to a specialist agent, runs them concurrently on **distinct files** (conflict-free by construction), and tracks the live plan in `getTasks(doc)` ([orchestrator/index.ts](../apps/server/src/orchestrator/index.ts)). Delegation, sequencing, and "who does what" are *already* solved here — centrally, observably, interruptibly.
3. **Shared structured channels already exist** for whatever messaging a squad needs: the task doc (subtask state), the audit trail (`getAudit`), agent chat, and per-agent `AgentPolicy` ([orchestration.ts](../packages/shared/src/orchestration.ts)). These are *in the doc*, so they inherit attribution, undo, persistence, and the human-in-the-loop approval gate for free.

In ICE, the coordination problem A2A exists to solve — *how do independent agents find and delegate to each other?* — is **dissolved**, not merely handled: the agents are not independent and not stateless. They share a workspace and a conductor.

---

## Evaluation: value vs. cost

### Where A2A's value would have to come from

For A2A to earn adoption *as ICE's internal coordination mechanism*, it would need to provide something the shared doc + orchestrator don't. We looked hard for it:

- **Discovery / capability advertisement?** Inside one ICE deployment the orchestrator already knows the roster and each agent's role + policy. There's nothing to "discover" — the conductor assigned it.
- **Delegation / task handoff?** Already the orchestrator's core job, with live state in the doc and human interrupt/approval. An A2A handoff would be a *weaker* delegation: opaque RPC instead of a visible, attributable, undoable shared-doc transition.
- **Cross-agent messaging?** Available today via doc-backed channels that are observable and persisted. A2A messages would be *off to the side* of the source of truth — exactly the split-brain the [architectural law](DECISIONS.md) forbids.
- **Result aggregation?** Agents converge results *in the shared doc*; there is no separate "collect the replies" step to standardize.

Net: for the **internal** case, A2A's headline features are redundant with capabilities ICE already has in a *stronger* form (shared state beats message passing for collaborative editing).

### What adopting A2A would cost

- **A second coordination plane that fights the thesis.** Inter-agent state would live partly in A2A envelopes and partly in the Yjs doc — two sources of truth for "what is the squad doing." That directly violates [ADR-000](DECISIONS.md) (one source of truth) and reintroduces the divergence ICE was built to eliminate.
- **A new protocol stack to host, secure, and version.** Agent cards, an RPC/streaming endpoint, an auth model, discovery — net-new surface in the [threat model](THREAT_MODEL.md) (a new way for an agent to reach another agent, and a new external endpoint) for capability we already have internally. More attack surface, no new safety.
- **Bypass risk for the safety rails.** ICE's guarantees — approval gate, per-agent policy, attribution, one-click rollback — are enforced *at the shared-doc / tool boundary*. Agents delegating to each other over a side-channel A2A bus could route *around* those rails unless we re-implement every gate inside the A2A layer. That's a large amount of work to *recreate* protections we get for free today.
- **Complexity tax on a small team.** ICE is built release-by-release by a small crew. Adopting a coordination protocol we don't need spends scarce maintenance budget against the [low-ceremony principle](../GOVERNANCE.md#1-principles).

### The honest case *for* A2A (and why it's not now)

There is one scenario where A2A genuinely fits, and we're explicit about it: **interop across the boundary of an ICE deployment** — an ICE squad delegating to, or receiving work from, a *foreign* agent system that does **not** share ICE's Yjs workspace (a partner's agent, a SaaS agent, another org's ICE instance). There, A2A's stateless-interop design is exactly right, because the precondition that makes the shared doc work (shared state) is absent.

That is a real but **speculative, demand-driven** use case. v2.0's job is to make ICE *scale out and integrate*; we are not going to pre-build an external agent-federation surface before a concrete integration partner exists to validate the shape. Building it speculatively would be a textbook over-engineering miss.

---

## Decision

**DECLINE A2A as ICE's inter-agent coordination mechanism for v2.0.** Concretely:

1. **Do not** introduce A2A into the agent host or orchestrator. Internal squad coordination remains: shared Yjs doc (state) + orchestrator (delegation) + doc-backed channels (messaging) + policy/approval (safety).
2. **Keep the door open** as a *future interop boundary*: if and when a real cross-deployment / cross-vendor agent integration lands, evaluate A2A **then**, as an **edge adapter at the ICE boundary** — never as a replacement for the internal shared-state model. That work would start as its own [RFC](rfcs/README.md), with the [threat model](THREAT_MODEL.md) updated for the new external endpoint.
3. **Prefer MCP for tool integration**, which is the integration axis ICE *does* need and already supports (agents↔tools, [community-extensible](EXTENSIONS.md)). A2A is agent↔agent; MCP is agent↔tools — and ICE's gap is tools/integration, not internal agent federation.

### Reconsider-if (the triggers that would reopen this)

We will revisit (via a new RFC) if any of these become real:

- A concrete partner needs an **ICE squad ↔ external agent system** integration that can't be served by MCP or a plain API.
- A2A coalesces into a **clear industry default** that ecosystem agents expect ICE to speak at its boundary.
- Demand emerges to **federate multiple ICE deployments'** squads across a network boundary (where shared Yjs state genuinely cannot span the boundary).

Absent those, the shared workspace is the better answer, and it is already shipping.

---

### Summary

| | A2A (as internal mechanism) | ICE shared doc + orchestrator |
|---|---|---|
| Coordination model | message passing between independent agents | **shared live state** + central conductor |
| State source of truth | split (A2A envelopes + doc) ✗ | single Yjs doc ✓ ([ADR-000](DECISIONS.md)) |
| Discovery / delegation | re-implements what orchestrator does | native, observable, interruptible ✓ |
| Safety rails (approval/policy/attribution/rollback) | must be rebuilt in the A2A layer ✗ | enforced at the doc/tool boundary ✓ |
| New attack surface | new endpoint + protocol ✗ | none ✓ |
| Right fit | **cross-deployment / cross-vendor interop** (future, demand-driven) | **in-deployment squad coordination** (now) |

**Verdict: DECLINE for the internal case; defer the external-interop case to a future, demand-driven RFC. Recorded in [DECISIONS.md](DECISIONS.md).**
