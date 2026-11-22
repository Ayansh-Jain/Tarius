# Self-hosting ICE in production

ICE is open-source and self-hostable: you run the whole thing — realtime editing,
git, AI agents, voice token minting — on your own box, owning every byte. This
page is the one-stop production guide. For the 60-second local demo, see the
project README; everything below is about running ICE for a *team*, durably and
securely.

> TL;DR — set `ICE_SESSION_SECRET` and `PUBLIC_URL`, terminate TLS at a reverse
> proxy, `docker compose up -d`, done. Postgres, OIDC, and LiveKit voice are
> optional and degrade gracefully when their env vars are unset.

---

## 1. Topology

A single Docker Compose stack with two services on a private network:

```
                         (you, on TLS)
                              │
                              ▼
   web  (nginx)  :3000  ── serves the built SPA, reverse-proxies /api + /sync + /git
                              │   (internal compose network only)
                              ▼
   server (node) :8080  ── Hocuspocus realtime + Hono REST + git smart-HTTP
                              │
                              ├─ metadata   → SQLite (default) or Postgres
                              ├─ Yjs docs   → ydoc.sqlite (Hocuspocus persistence)
                              └─ git repos  → one bare repo per room
```

Only the **web** port is published to the host. `server` is reachable only on the
internal network — exactly as a single-origin deployment should be. All durable
state lives in **one** Docker volume (`ice-data`), which is all you back up
(see [BACKUP.md](./BACKUP.md)).

---

## 2. Quick start

```bash
git clone <your-fork> ice && cd ice

# 1. Create a .env next to docker-compose.yml (see §3). At minimum:
cat > .env <<'ENV'
ICE_SESSION_SECRET=$(openssl rand -hex 32)
PUBLIC_URL=https://ice.example.com
ENV

# 2. Build images + run.
docker compose up -d --build

# 3. Tail logs until healthy, then open your PUBLIC_URL.
docker compose logs -f server
```

`docker compose` reads `.env` automatically; the file is optional (compose
ignores a missing one) but **strongly recommended** in production so secrets
never live in your shell history or the compose file.

---

## 3. Environment variables

All configuration is environment-derived. Unset optional vars degrade safely.

### Core (set these)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `ICE_SESSION_SECRET` | **Yes (prod)** | random per-boot | HMAC key signing session + room JWTs. **Must** be set and stable in production, or every restart logs out every user. Generate with `openssl rand -hex 32`. With the bundled compose file, if you leave it unset the server generates one **and persists it inside the `ice-data` volume**, so it survives restarts — but pinning your own is clearer and lets you rotate deliberately. |
| `PUBLIC_URL` | Recommended | `http://localhost:3000` | The public origin the SPA is served from. Used to build invite links and the OIDC redirect URI. Set to your real `https://…` origin. |
| `NODE_ENV` | Recommended | `development` | Set to `production`. This flips on secure cookies, requires invites for room access, and refuses unverified OIDC emails. The web/server Docker images already set it. |
| `PORT` | No | `8080` | Server HTTP+WS port (internal). |
| `HOST` | No | `0.0.0.0` | Bind address. |
| `ICE_DATA_DIR` | No | `apps/server/data` | Root for all durable state. Compose sets it to `/app/data` (the volume). |
| `ICE_GIT_ROOT` | No | `$ICE_DATA_DIR/repos` | Where per-room bare git repos live. |
| `ICE_GIT_PORT` | No | `PORT + 1` | Internal git smart-HTTP port. |

### Metadata database (optional — SQLite is the default)

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | `file:…/ice.sqlite` | **Backend selector.** A `postgres://` or `postgresql://` URL switches the users/rooms/invites/roles store to Postgres. Anything else (unset, or `file:…`) keeps the built-in SQLite store. Collaborative file content is **never** here — that's the Yjs doc. |

SQLite is excellent for a single server. Choose Postgres when you want managed
backups / PITR, or to run **multiple** server instances against one database. See
§6.

### Voice (optional — LiveKit)

ICE only **mints short-lived tokens**; media never touches ICE. Point it at any
LiveKit server (self-hosted or LiveKit Cloud). Voice is disabled when these are
unset.

| Variable | Notes |
|---|---|
| `LIVEKIT_URL` | `wss://…` URL of your LiveKit server, advertised to clients. |
| `LIVEKIT_API_KEY` | LiveKit API key (token signing). |
| `LIVEKIT_API_SECRET` | LiveKit API secret. **Keep server-side only.** |

### Single sign-on (optional — OIDC / bring-your-own-IdP)

Plug in any OpenID Connect provider (Authentik, Keycloak, Auth0, Okta, Google,
Dex, …) **alongside** email/password. Uses Authorization Code + PKCE. Disabled
unless `ICE_OIDC_ISSUER` **and** `ICE_OIDC_CLIENT_ID` are both set — no error
when unset.

| Variable | Required to enable | Notes |
|---|---|---|
| `ICE_OIDC_ISSUER` | Yes | Issuer URL, e.g. `https://idp.example.com/realms/ice`. ICE auto-discovers `/.well-known/openid-configuration`. |
| `ICE_OIDC_CLIENT_ID` | Yes | OAuth client id. |
| `ICE_OIDC_CLIENT_SECRET` | No | Omit for a **public** client (PKCE still secures the exchange); set for a confidential client. |
| `ICE_OIDC_REDIRECT_URI` | No | Defaults to `${PUBLIC_URL}/api/auth/oidc/callback`. Register this exact URI with your IdP. |
| `ICE_OIDC_SCOPE` | No | Defaults to `openid email profile`. |

Login flow once enabled:

- `GET /api/auth/oidc/login` → 302 to your IdP.
- `GET /api/auth/oidc/callback` → exchanges the code, JIT-provisions a local user
  keyed by **verified email**, and sets the same httpOnly session cookie as
  email/password (the rest of the app is oblivious to how you logged in).

### AI agents (optional)

The default agent backend is the dependency-free **mock** agent (no key needed).
For real agents (`claude-code`, `codex`, `gemini`) supply the relevant provider
key the chosen ACP backend expects, e.g. `ANTHROPIC_API_KEY`.

---

## 4. Reverse proxy & TLS

Terminate TLS at a proxy in front of the published `web` port. ICE is
**single-origin**: the SPA, REST API (`/api`), realtime (`/sync`, a WebSocket),
and git (`/git`) are all served from `PUBLIC_URL`, so you only need one
vhost/cert. The bundled `web` (nginx) already reverse-proxies `/api`, `/sync`,
and `/git` to `server` internally.

Caddy (auto-HTTPS) example:

```caddy
ice.example.com {
    reverse_proxy localhost:3000
}
```

nginx example — note the WebSocket upgrade headers, required for `/sync`:

```nginx
server {
    listen 443 ssl http2;
    server_name ice.example.com;
    # ssl_certificate / ssl_certificate_key …

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        # WebSocket upgrade for /sync (live editing) — without these, collab breaks.
        proxy_set_header   Upgrade           $http_upgrade;
        proxy_set_header   Connection        "upgrade";
        proxy_read_timeout 86400s;  # keep long-lived sync sockets open
    }
}
```

Then set `PUBLIC_URL=https://ice.example.com` and `NODE_ENV=production` so
cookies are issued with `Secure`.

---

## 5. Scaling out (multiple server instances)

The default SQLite metadata store and the file-backed Hocuspocus persistence are
single-node. To run more than one `server` replica:

1. Set `DATABASE_URL` to a shared **Postgres** (the users/rooms/invites/roles
   store becomes shared — see §6).
2. Front the realtime layer with a Hocuspocus-compatible shared persistence /
   pub-sub (e.g. the Redis/Postgres extensions) so a room's Yjs doc is
   consistent across replicas. (Out of scope for the default single-node image.)
3. Put the replicas behind a load balancer with **sticky sessions** on `/sync`.

For most teams, a single well-backed-up node is the right answer — reach for
multi-node only when you actually need the headroom.

---

## 6. Postgres backend

Switching the metadata store to Postgres is a one-line change — point
`DATABASE_URL` at it:

```bash
DATABASE_URL=postgres://ice:secret@db.internal:5432/ice
```

- The schema (users, rooms, invites, room_roles) is created automatically on
  first boot and is idempotent — safe to run many instances against one database.
- The query surface is identical to SQLite, so it's a true drop-in. Roles
  (owner/member) are stored in the same database.
- `pg` is only loaded when a `postgres://` URL is present; SQLite deployments
  never touch the driver.

There is no built-in SQLite→Postgres data migration — switch backends on a fresh
deployment, or migrate rows yourself. See [BACKUP.md](./BACKUP.md) for dumps.

---

## 7. Workspace roles (teams)

Each room has two roles:

- **owner** — the room creator. Manages members, rotates invites, deletes the
  room.
- **member** — anyone who has joined. Edits, chats, talks.

Roles live in the metadata store (SQLite or Postgres) — never in the room's Yjs
doc, which any client can mutate. Owner-only API routes are guarded server-side;
membership is granted on room access.

---

## 8. Security checklist

Before you expose ICE to the internet:

- [ ] **`ICE_SESSION_SECRET` is set to a strong random value** (`openssl rand -hex
      32`) and stored as a secret, not in the compose file or shell history.
- [ ] **`NODE_ENV=production`** — enables `Secure` cookies, requires invites for
      room access, and rejects unverified OIDC emails.
- [ ] **TLS terminates at the proxy**; `PUBLIC_URL` is the `https://` origin.
- [ ] **Only the web port is published.** `server`, the database, and LiveKit are
      not reachable from the public internet.
- [ ] **Database credentials and `LIVEKIT_API_SECRET` are secrets**, injected via
      env/secret manager, never committed.
- [ ] **OIDC `ICE_OIDC_REDIRECT_URI` exactly matches** what's registered with your
      IdP, over HTTPS.
- [ ] **Back up the `ice-data` volume** (or your Postgres) on a schedule and test
      a restore — see [BACKUP.md](./BACKUP.md).
- [ ] **Keep the host and images patched**; rebuild periodically to pull security
      updates (`docker compose build --pull`).
- [ ] Invite links are bearer tokens with a 7-day TTL — treat them as secrets and
      rotate if leaked.

---

## 9. Health & operations

- Liveness: `GET ${PUBLIC_URL}/api/health` → `{ "status": "ok" }`. The compose
  healthcheck already polls this.
- Logs: `docker compose logs -f server` (and `web`).
- Graceful shutdown: the server flushes pending Yjs writes, stops agents, and
  closes git on `SIGTERM` — `docker compose stop` is safe.
- Upgrades: `git pull && docker compose up -d --build`. Durable state in the
  volume is preserved; the metadata schema migrates forward automatically.
