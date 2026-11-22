- RFC: 0001
- Title: Horizontal scale-out for the sync server
- Status: accepted
- Authors: ICE maintainers (worked example)
- Area: sync
- Created: 2026-05-31
- Decision recorded: docs/DECISIONS.md (ADR for v2.0 scale-out)

---

# RFC 0001: Horizontal scale-out for the sync server

> **This is a worked example RFC**, written to demonstrate the format and the
> level of rigor we expect. It documents a real decision taken for v2.0 ("Scale
> out and integrate"), but its primary job here is to be a model to copy. See
> [the RFC process](README.md) and [`0000-template.md`](0000-template.md).

## Summary

Let multiple ICE server instances serve the *same* room concurrently by sharing
Yjs document updates and awareness over **Redis pub/sub**, using Hocuspocus's
Redis extension. A single room's editing session can then be spread across N
processes behind a sticky-or-not load balancer, removing the "one room = one
process" ceiling without changing the [architectural law](../DECISIONS.md) (Yjs
stays the single source of truth) or the client wire protocol.

## Motivation

ICE v1.x runs sync in a **single process per deployment**: every client for every
room connects to one Hocuspocus instance, which holds the authoritative
`Y.Doc` in memory and persists it (SQLite/Postgres). That is correct and simple,
but it caps a deployment at one box's CPU/RAM and makes zero-downtime deploys
disruptive (every reconnecting client re-syncs against a cold process).

v2.0's thesis is **"scale out and integrate."** Self-hosters running ICE for a
real team — many rooms, large docs, voice + agents + terminals all live — hit
the single-process ceiling. We need a horizontal story that:

- keeps a busy room responsive under more concurrent editors than one process
  can serve;
- survives a rolling restart without a thundering re-sync;
- requires **no new mandatory dependency** for small self-hosters (single-process
  stays the default and the air-gappable baseline — see
  [GOVERNANCE §8](../../GOVERNANCE.md#8-what-cannot-change)).

[ADR-003](../DECISIONS.md) already names this as the planned v2 direction (with
`y-sweet` as the *documented* alternative swap, not a maintained second backend).
This RFC picks the concrete mechanism.

## Guide-level explanation

A self-hoster who wants to scale sets one environment variable:

```bash
ICE_REDIS_URL=redis://redis:6379
```

With it set, every ICE server process attaches a Redis pub/sub channel per room.
When a client edits a doc on process A, A applies the update locally, persists it,
and **publishes** it; processes B and C, which also have that room open, receive
it and apply it to their in-memory copy and forward it to *their* connected
clients. Awareness (cursors/presence) rides the same bus. To the browser nothing
changes — it still speaks the same `/sync` WebSocket protocol; it just might land
on any process.

With `ICE_REDIS_URL` **unset**, ICE behaves exactly as today: a single process,
no Redis, fully air-gappable. Scale-out is strictly opt-in.

```
        ┌─────────┐     ┌─────────┐     ┌─────────┐
client─▶│ server A│     │ server B│     │ server C│◀─client
        └────┬────┘     └────┬────┘     └────┬────┘
             └──── Redis pub/sub (per-room) ──┘
                 (Yjs updates + awareness)
```

## Reference-level explanation

- **Transport.** Use [`@hocuspocus/extension-redis`](../DEPENDENCIES.md) (already a
  dependency) backed by `ioredis` (already a dependency). It hooks Hocuspocus's
  document lifecycle to publish/subscribe each document's updates and awareness on
  a Redis channel keyed by room id.
- **Wiring (decoupled).** Attach the extension in the existing realtime seam
  (`apps/server/src/realtime.ts`, which already constructs the Hocuspocus server
  and exposes `getHocuspocus()`) **only when `ICE_REDIS_URL` is set**. The
  extension list becomes `[SQLite/Postgres persistence, …, Redis?]`. No client or
  `packages/shared` change.
- **Persistence is unchanged and authoritative.** Redis is a *transport for live
  updates*, not the store of record. The existing persistence extension remains
  the durable source; Redis carries deltas between live processes. A process
  restart still rehydrates from persistence, then re-subscribes. This preserves
  [ADR-000](../DECISIONS.md): Yjs (rehydrated from the durable store) is the single
  source of truth; agents still write *through* the doc.
- **Convergence.** The git/filesystem convergence module
  (`apps/server/src/convergence`) must run **once per room**, not once per process,
  or two processes could race a commit. Introduce a Redis-based **per-room leader
  lock** (e.g. `SET room:lock NX PX`): the lock holder owns commit projection and
  the room's filesystem materialisation; non-holders skip it. (Detailed in a
  follow-up RFC if the lock semantics grow; for v2.0 a lease with renewal suffices.)
- **Config.** Add `ICE_REDIS_URL` to [config](../../apps/server/src/config.ts) and
  `.env.example`. Document it in [SELF_HOSTING.md](../SELF_HOSTING.md) and
  [docker-compose.yml](../../docker-compose.yml) (a commented optional `redis`
  service). Unset ⇒ no Redis client constructed.
- **Failure modes.** If Redis is unreachable at boot with `ICE_REDIS_URL` set, fail
  fast with a clear error (don't silently degrade to a split-brain where two
  processes each think they're authoritative for live updates). If Redis drops
  mid-session, processes keep serving their local clients from the in-memory doc
  and reconcile on reconnect (Yjs updates are idempotent/commutative, so replays
  are safe).

## Drawbacks

- **A new optional dependency** (Redis) for scaled deployments — more to run,
  monitor, and secure. Mitigated by keeping it strictly opt-in and off by default.
- **The convergence leader lock is the hard part** — getting "exactly one process
  commits this room" right under failover is subtle. This RFC scopes it to a
  lease; a bug here risks duplicate or lost commits, so it needs dedicated tests.
- **More moving parts in the threat model** — Redis becomes a trust boundary
  carrying document deltas (see below).

## Alternatives

- **Do nothing / vertical scale only.** Simplest, but doesn't meet the v2.0
  "scale out" goal; a single large team can still exhaust one box.
- **Swap the backend to `y-sweet`.** Named in [ADR-003](../DECISIONS.md) as the
  documented alternative. Rejected for v2.0 as the *primary* path because it
  replaces (rather than extends) the Hocuspocus stack we already ship and test,
  and changes the operational story more than a self-hoster wants mid-life. Kept
  documented as a future swap, not adopted now.
- **Shard rooms across processes (each room pinned to one process via the LB).**
  Easier than shared rooms (no cross-process doc sync), but caps a *single hot
  room* at one process — which is exactly the case we want to scale. Good as a
  complementary placement strategy, insufficient alone.

## Security & threat-model impact

Adds Redis as a component that **carries live document content and awareness**
between processes — a new trust boundary. Required mitigations, to be added to
[THREAT_MODEL.md](../THREAT_MODEL.md):

- Redis must be **network-isolated** (private network / VPC), never exposed to the
  public internet, and **password-protected** (and TLS where the deployment spans
  hosts) — an attacker on the Redis bus could read or inject document updates.
- `ICE_REDIS_URL` is a **secret** (it may embed credentials) — same handling as
  `ICE_SESSION_SECRET`: env-injected, never committed.
- No change to client auth or room access control: clients still authenticate to a
  server process exactly as before; Redis is server-to-server only.

## Prior art

- Hocuspocus documents the Redis extension as the standard multi-node pattern for
  Yjs collaboration servers.
- Yjs updates are CRDT deltas: commutative and idempotent, which is what makes
  fan-out over a lossy/at-least-once bus safe (replays converge).

## Open questions

- Lease duration + renewal interval for the convergence leader lock under a slow
  GC pause — pick conservative defaults and make them configurable.
- Do we also fan out **terminal** and **voice token** events over the same bus, or
  keep those process-local for v2.0? (Leaning: keep process-local initially.)

## Implementation

- Slice: extend `apps/server/src/realtime.ts` to conditionally attach the Redis
  extension (config-gated).
- Slice: convergence leader lock in `apps/server/src/convergence`.
- Docs: `config.ts`, `.env.example`, `SELF_HOSTING.md`, `docker-compose.yml`
  (optional `redis` service), `THREAT_MODEL.md` (Redis boundary).
- Target release: **v2.0**.

## Resolution

- Decided: 2026-05-31
- Outcome: **accepted**
- Decided by: lazy consensus of maintainers (worked example)
- Rationale: Meets the v2.0 scale-out goal using dependencies already vendored,
  keeps single-process the air-gappable default, and preserves the architectural
  law (persistence remains authoritative; Redis is a live-update transport). The
  convergence leader lock is the known risk and is scoped explicitly.
- ADR: recorded in [docs/DECISIONS.md](../DECISIONS.md) under the v2.0 scale-out
  decision.
