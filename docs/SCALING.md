# Scaling ICE horizontally

ICE ships as a single-node stack and that is the right default: one `server`
process holds every room's live Yjs document in memory and persists it to SQLite.
This page is about the other end — running **multiple `server` replicas** so a
busy instance survives node loss and spreads load. The web edge is already
stateless; the interesting part is the realtime layer.

> TL;DR — add **Redis** and the replicas can share realtime state; then raise the
> replica count. Without Redis a second replica is an island, and two people in
> the same room on different replicas will silently diverge. Redis first, always.

---

## 1. Why a second replica needs Redis

Each room is a CRDT (Yjs) document. The source of truth is the document plus its
committed git history; the `server` keeps the *live* copy in memory and fans
every edit out to the WebSocket clients connected **to that process**.

Run two `server` processes with no shared bus and you get two independent live
copies of the same room:

```
   client A ──► server-1   (has live room R)        ✗ no shared updates
   client B ──► server-2   (has its own live room R)
```

A's keystrokes never reach B. Both copies still converge *locally* and both still
flush to git, but until the next reload the two humans are editing divergent
state. That is the failure ICE refuses to ship by accident.

**Redis closes the loop.** The Hocuspocus realtime layer supports a Redis
extension that publishes every document update (and awareness/presence) to a
shared channel; every replica subscribed to that room replays peers' updates into
its own copy. Now:

```
   client A ──► server-1 ─┐                ┌─► server-2 ◄── client B
                          ├─ Redis pub/sub ┤
        (R updates) ◄─────┘                └─────► (R updates)
```

Both replicas hold the same live room; A and B see each other in real time.

> **Wiring note.** Redis fan-out lives in the *server* (the `@hocuspocus/extension-redis`
> attachment, gated on `REDIS_URL`), not in this deploy slice. The deploy
> artifacts here (`deploy/compose.scale.yml`, the Helm `redis` option) **provide**
> Redis and set `REDIS_URL` on the server; the server build is what consumes it.
> If you point a pre-Redis server build at Redis, `REDIS_URL` is simply ignored
> and you are back to islands — so confirm your server image attaches the Redis
> extension before scaling past one replica.

---

## 2. Scale out with Docker Compose

The base `docker-compose.yml` is single-node. Layer the scale override on top:

```sh
# Bring up Redis + point the server at it.
docker compose -f docker-compose.yml -f deploy/compose.scale.yml up --build -d

# Then run N server replicas. The web edge load-balances across them.
docker compose -f docker-compose.yml -f deploy/compose.scale.yml \
  up --build --scale server=3 -d
```

Why no nginx change is needed: the bundled web edge resolves the `server`
upstream **lazily** through Docker's embedded DNS (`set $ice_server "server:8080"`
with `resolver 127.0.0.11`). Docker DNS round-robins the replica IPs, so each new
proxied request can land on any replica. Because Redis carries the shared state,
that is fine — a client can even reconnect to a different replica and catch up.

State volumes under scale-out:

- `ice-redis` — Redis AOF, the shared bus. Small, durable.
- `ice-data` — SQLite + session secret + bare git repos. With Compose's default
  local volume **every replica mounts the same `ice-data`**, so they share one
  git root and one session secret. That works on a single host. Across hosts you
  need shared storage (see §4).

---

## 3. Scale out with Helm (Kubernetes)

The chart makes it a two-key toggle (see `deploy/helm/ice/README.md`):

```sh
helm upgrade ice ./deploy/helm/ice -n ice --reuse-values \
  --set redis.enabled=true \
  --set server.replicas=3
```

`redis.enabled=true` adds a Redis Deployment/Service/PVC and injects
`REDIS_URL=redis://<release>-redis:6379` into every server pod. The web edge’s
nginx upstream is the `server` Service, so kube-proxy spreads requests across the
replica pods.

The chart's `NOTES.txt` prints a **warning if `server.replicas > 1` while
`redis.enabled` is false** — the one combination that silently diverges.

---

## 4. Sticky vs stateless — what actually has to be sticky

Short answer: **with Redis, nothing has to be sticky for correctness.** The point
of the shared bus is that any replica can serve any room. Stickiness is a
*performance/efficiency* choice, not a correctness one.

What is and isn't stateful:

| Layer | Stateful? | Sticky needed? |
|-------|-----------|----------------|
| `web` (nginx SPA + proxy) | no | no — scale freely, round-robin |
| `server` REST (`/api`) | no (auth is a stateless JWT cookie) | no |
| `server` sync (`/sync` WebSocket) | live Yjs doc in memory, **shared via Redis** | not for correctness; see below |
| Redis | the shared bus | n/a (single logical endpoint) |
| git repos / SQLite | durable | shared storage across hosts (§ below) |

**Why you may still want sticky sessions.** A WebSocket is long-lived, so it
already pins to one replica for its lifetime — no per-message stickiness is
involved. The optimization is **room affinity**: if all clients of room *R* land
on the *same* replica, that replica serves them directly from memory and Redis
only carries cross-replica catch-up for reconnects and late joiners. Without
affinity, every replica that has *any* client in *R* keeps a full live copy and
replays all of *R*'s traffic over Redis — more memory and more pub/sub fan-out.
Neither is wrong; affinity just trims duplicated work at scale.

If you want room affinity, hash on the room, not the user:

- **Compose / standalone nginx:** the bundled lazy-DNS upstream round-robins. To
  pin by room, front the replicas with an nginx that has an explicit
  `upstream { hash $arg_room consistent; }` (the room id is in the `/sync` query),
  or use any L7 LB with consistent hashing on a room key.
- **Kubernetes (ingress-nginx):** cookie affinity pins a *client* to a replica
  (coarser than per-room but simpler):

  ```yaml
  ingress:
    annotations:
      nginx.ingress.kubernetes.io/affinity: "cookie"
      nginx.ingress.kubernetes.io/affinity-mode: "persistent"
      nginx.ingress.kubernetes.io/session-cookie-name: "ice_affinity"
  ```

  For true per-room hashing, use a Gateway/LB that supports consistent hashing on
  a request attribute (e.g. the `room` query param) and key on that.

**Bottom line:** start stateless + round-robin with Redis on. Add room/cookie
affinity only if Redis fan-out or replica memory becomes a measured bottleneck.

---

## 5. Durable storage across multiple hosts

Redis solves *live* state. Two durable stores still need attention once replicas
span more than one host:

1. **Git repos (`ICE_GIT_ROOT`, default `/app/data/repos`).** The committed
   history is real durable truth. Replicas must agree on it. Options:
   - **ReadWriteMany volume** (NFS, CephFS, EFS, Filestore…) mounted at
     `/app/data` on every replica — simplest; set
     `server.persistence.accessMode=ReadWriteMany` + a suitable `storageClass`.
   - **External forge as the home of record** — push room repos to Forgejo (see
     [INTEGRATIONS.md](./INTEGRATIONS.md)) and treat per-replica git as a cache.

2. **Session secret (`ICE_SESSION_SECRET`).** Cookies are signed with it, so all
   replicas **must share the same value**. In Compose-on-one-host the shared
   `ice-data` volume gives you that for free (the entrypoint persists a generated
   secret there). Across hosts, **set `ICE_SESSION_SECRET` explicitly** (Helm:
   the chart Secret, injected identically into every pod) rather than relying on
   each replica generating its own — otherwise a request proxied to a different
   replica fails auth.

3. **Metadata SQLite (`ice.sqlite`) and Yjs SQLite (`ydoc.sqlite`).** The local
   SQLite is a cache/replica of state that Redis (live) and git (durable) already
   carry, so SQLite on a shared RWX volume is acceptable. For heavier multi-writer
   metadata, point `DATABASE_URL` at Postgres (the server already supports a
   Postgres backend — see `db-postgres.ts`) and let every replica share it.

---

## 6. Capacity & rollout notes

- **Start small.** One `server` handles many rooms; most teams never need a
  second replica. Scale when you see CPU saturation on `server` or want HA across
  nodes, not preemptively.
- **Rolling updates.** With `server.replicas > 1` the chart uses a `RollingUpdate`
  strategy; with a single replica it uses `Recreate` (so a new pod doesn't fight
  the old one for a ReadWriteOnce PVC). Redis lets in-flight clients reconnect to
  a surviving replica during a roll.
- **Redis is a single point of failure** in this minimal setup. For HA Redis, run
  Redis Sentinel or a managed Redis and point `REDIS_URL` (Compose) /
  `redis.enabled=false` + `server.env.extra` `REDIS_URL` (Helm) at it instead of
  the in-chart single pod.
- **Health.** Both `web` (`/healthz`) and `server` (`/api/health`) expose liveness
  endpoints the orchestrator uses to gate traffic during a roll.
