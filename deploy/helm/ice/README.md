# ICE Helm chart

A real, lint-clean Helm chart for running [ICE](../../..) on Kubernetes.

> **Helm is the optional path.** The default, zero-config way to self-host ICE
> is `docker compose up` from the repo root. Reach for this chart when you want
> ICE on a cluster — multiple replicas, an Ingress with TLS, managed storage.

## What it deploys

| Component | Always | What it is |
|-----------|--------|------------|
| `web`     | yes    | nginx edge: serves the SPA, reverse-proxies `/api` + `/sync` to the server |
| `server`  | yes    | Node: Hocuspocus realtime + Hono REST + bundled smart-HTTP git server; PVC at `/app/data` |
| `secret`  | yes\*  | `ICE_SESSION_SECRET` + `LIVEKIT_*` (\*unless you supply `secret.existingSecret`) |
| `redis`   | opt-in | pub/sub + presence bus for horizontal scale-out (`redis.enabled=true`) |
| `livekit` | opt-in | self-hosted SFU for voice rooms (`livekit.enabled=true`) |
| `ingress` | opt-in | external access to the web edge (`ingress.enabled=true`) |

## Prerequisites

- Kubernetes 1.23+ and Helm 3.8+
- A default `StorageClass` (or set `server.persistence.storageClass`)
- The ICE images reachable by your nodes. Build + push them first:

  ```sh
  # from the repo root
  docker build -t <registry>/ice/server:2.0 -f apps/server/Dockerfile .
  docker build -t <registry>/ice/web:2.0    -f apps/web/Dockerfile .
  docker push <registry>/ice/server:2.0
  docker push <registry>/ice/web:2.0
  ```

  Then set `server.image.repository` / `web.image.repository` (and `tag`) to match.

## Install

The chart **refuses to deploy the placeholder session secret** — generate a real
one. Either let the chart create the Secret:

```sh
helm install ice ./deploy/helm/ice \
  --namespace ice --create-namespace \
  --set secret.sessionSecret="$(openssl rand -hex 32)" \
  --set server.image.repository=<registry>/ice/server \
  --set web.image.repository=<registry>/ice/web \
  --set server.image.tag=2.0 --set web.image.tag=2.0
```

…or reference a Secret you created out of band (keys: `ICE_SESSION_SECRET`,
`LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`):

```sh
kubectl -n ice create secret generic ice-creds \
  --from-literal=ICE_SESSION_SECRET="$(openssl rand -hex 32)" \
  --from-literal=LIVEKIT_URL=wss://livekit.example.com \
  --from-literal=LIVEKIT_API_KEY=... \
  --from-literal=LIVEKIT_API_SECRET=...

helm install ice ./deploy/helm/ice -n ice \
  --set secret.create=false --set secret.existingSecret=ice-creds
```

### Try it without an Ingress

```sh
kubectl -n ice port-forward svc/ice-web 3000:3000
open http://localhost:3000
```

### Expose it with an Ingress + TLS

```sh
helm upgrade ice ./deploy/helm/ice -n ice --reuse-values \
  --set ingress.enabled=true \
  --set ingress.host=ice.example.com \
  --set ingress.tls.enabled=true \
  --set ingress.tls.secretName=ice-tls \
  --set server.env.publicUrl=https://ice.example.com
```

`server.env.publicUrl` must match the external URL — it is what ICE advertises in
invite links.

## Horizontal scale-out (multiple server replicas)

`server` holds live Yjs documents in memory. A second replica is only correct if
the replicas share state through Redis; otherwise collaborators on different
replicas diverge. So scaling is a two-step toggle:

```sh
helm upgrade ice ./deploy/helm/ice -n ice --reuse-values \
  --set redis.enabled=true \
  --set server.replicas=3
```

Two caveats — both covered in [`docs/SCALING.md`](../../../docs/SCALING.md):

1. **Redis fan-out must be wired in the server build.** This chart sets
   `REDIS_URL` on the server pods; the realtime layer attaches the Hocuspocus
   Redis extension when that variable is present. If the running image predates
   that wiring, `REDIS_URL` is simply ignored and replicas stay islands.
2. **Storage.** The default `server.persistence` is a single `ReadWriteOnce`
   PVC, which only one node can mount. For replicas across nodes, use a
   `ReadWriteMany` StorageClass (set `server.persistence.accessMode=ReadWriteMany`
   and a suitable `storageClass`), or give each replica its own durable git via
   external storage. SQLite-on-RWX is acceptable because durable truth is git +
   Redis, not the local SQLite cache.

## Voice (LiveKit)

Voice is off by default and the app degrades gracefully without it. To run the
bundled SFU in dev mode (well-known devkey/secret, matched by the Secret
defaults):

```sh
helm upgrade ice ./deploy/helm/ice -n ice --reuse-values --set livekit.enabled=true
```

For production, set real `secret.livekit.*` values, `livekit.devMode=false`, and
front the SFU with the UDP/TCP networking LiveKit needs (see LiveKit's own docs).

## Common values

| Key | Default | Notes |
|-----|---------|-------|
| `web.replicas` | `1` | stateless; scale freely |
| `server.replicas` | `1` | >1 needs `redis.enabled=true` |
| `server.persistence.size` | `10Gi` | SQLite + session secret + bare repos |
| `server.persistence.storageClass` | `""` | empty = cluster default |
| `server.env.publicUrl` | `http://localhost:3000` | set to your external URL |
| `redis.enabled` | `false` | scale-out prerequisite |
| `livekit.enabled` | `false` | voice rooms |
| `ingress.enabled` | `false` | external access |
| `secret.sessionSecret` | placeholder | **must change**; `openssl rand -hex 32` |
| `secret.existingSecret` | `""` | use instead of chart-created Secret |

See [`values.yaml`](values.yaml) for the full, commented set.

## Uninstall

```sh
helm uninstall ice -n ice
# PVCs are retained by default so room repos survive. Remove explicitly:
kubectl -n ice delete pvc -l app.kubernetes.io/instance=ice
```

## Validate locally

```sh
helm lint ./deploy/helm/ice --set secret.sessionSecret="$(openssl rand -hex 32)"
helm template ice ./deploy/helm/ice \
  --set secret.sessionSecret="$(openssl rand -hex 32)" \
  --set redis.enabled=true --set livekit.enabled=true --set ingress.enabled=true
```
