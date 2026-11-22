# Integrating ICE with the rest of your stack

ICE is deliberately self-contained — live editing, a git server, AI agents and
voice all run in one stack you own. But it is built to plug into the tools a team
already has rather than replace them. This page covers the three integration
surfaces that ship with ICE:

1. **[Forgejo](#1-forgejo--a-full-forge-alongside-ice)** — a full self-hosted
   forge (PRs, issues, review, mirrors) running next to ICE.
2. **[External CI](#2-external-ci-via-the-git-server)** — driving your existing
   CI off ICE's bundled git server.
3. **[MCP servers](#3-mcp-servers--giving-agents-tools)** — giving ICE's AI
   agents extra tools via the Model Context Protocol.

The guiding principle, the same one ICE follows internally: **integrate proven
tools; never rebuild them.**

---

## 1. Forgejo — a full forge alongside ICE

### What ICE's git server is, and what it isn't

Every ICE room is a **real bare git repository**, served over git's smart-HTTP
protocol by the bundled git server (`apps/server/src/git/`):

```sh
git clone http://<host>:8081/git/<roomId>.git
```

That is enough to clone, fetch, push, pull, branch and tag a room, and to run CI
against it (see §2). It is intentionally **not** a forge: there is no web UI for
pull requests, code review, issues, releases, mirrors, or org/team management.

[Forgejo](https://forgejo.org) (the community fork of Gitea) **is** that forge.
ICE ships an optional Compose override that runs Forgejo next to ICE so you get
both: ICE remains the live collaborative editing surface, Forgejo becomes the
durable home for review and history. ICE does not reimplement any of it.

### Bring Forgejo up

```sh
docker compose -f docker-compose.yml -f deploy/forgejo/compose.forgejo.yml up -d
open http://localhost:3001          # complete Forgejo's one-time installer
```

The two git servers coexist with **no port or volume collision**:

| Service | Port | Path / data |
|---------|------|-------------|
| ICE git server | `8081` (internal `ICE_GIT_PORT`) | `/git/<roomId>.git`, in `ice-data` |
| Forgejo HTTP | `3001` (published) | its own `forgejo-data` volume |
| Forgejo SSH | `2222` (published) | (never the host's port 22) |
| ICE web edge | `3000` (published) | the SPA |

They are independent services on the same Compose network. Neither knows about
the other until you connect a remote — which is the next step.

### Push a room repo into Forgejo

Per room, once:

1. In Forgejo's UI, create an empty repo, e.g. `acme/room-<roomId>`.
2. Clone the ICE room repo, add Forgejo as a second remote, and push:

   ```sh
   git clone http://<host>:8081/git/<roomId>.git room && cd room
   git remote add forge http://<host>:3001/acme/room-<roomId>.git
   git push forge --all && git push forge --tags
   ```

Now the same history lives in both: ICE for live editing, Forgejo for review.

### Keep them in sync

Three patterns, pick per workflow:

- **Manual push** — push to `forge` whenever you want a review snapshot. Simplest.
- **Push to both from convergence** — ICE's convergence job already commits the
  flushed working tree into each room's bare repo. Add a post-commit step (a git
  hook in the bare repo, or an external watcher) that runs `git push forge --all`
  so every converged commit lands in Forgejo automatically.
- **Forgejo pull mirror** — in Forgejo, create the repo as a *pull mirror* of the
  ICE git URL (`http://server:8081/git/<roomId>.git`, reachable on the Compose
  network as host `server`). Forgejo then periodically fetches new commits from
  ICE on its own schedule — zero changes on the ICE side.

  > Auth: if you run ICE in production (`NODE_ENV=production`), its git server
  > requires a valid ICE token (Bearer header or HTTP basic, token as the
  > password). Give Forgejo's mirror an ICE room or session token as the mirror
  > credential. In dev mode the git server is open and no credential is needed.

### Direction of truth

ICE is the live editing surface; Forgejo is the review/archive home. Treat
**Forgejo as downstream of ICE** (ICE → Forgejo), not the other way around.
Pushing *into* an open ICE room from outside needs a real 3-way merge against the
live CRDT and is deliberately not wired (losing in-flight edits is unacceptable —
see [DECISIONS.md](./DECISIONS.md)). So: edit in ICE, review in Forgejo.

---

## 2. External CI via the git server

Because each room is an ordinary git repo, **any CI system that can clone a git
URL can build a room** — no ICE-specific plugin required.

### Clone URL + auth

```
http://<host>:8081/git/<roomId>.git
```

- **Dev** (`NODE_ENV` unset/not `production`): open, clone freely.
- **Production**: a valid ICE token is required. Supply it as either:
  - a Bearer header — `git -c http.extraHeader="Authorization: Bearer <token>" clone …`
  - HTTP basic — `http://x-access-token:<token>@<host>:8081/git/<roomId>.git`
    (the git server accepts the token as the basic-auth password).

  A token is valid if it verifies as a **room token** (scoped to one room) or a
  **session token**. Mint a room token from the ICE API for the room you want CI
  to read; scope CI to exactly the rooms it needs.

### Wire it into CI

Generic pattern (works in GitHub Actions, GitLab CI, Woodpecker, Jenkins, Forgejo
Actions, …):

```yaml
steps:
  - name: Clone the ICE room
    run: |
      git clone \
        -c http.extraHeader="Authorization: Bearer ${ICE_CI_TOKEN}" \
        "http://${ICE_HOST}:8081/git/${ROOM_ID}.git" workspace
  - name: Build & test
    run: cd workspace && <your build command>
```

Store `ICE_CI_TOKEN` as a CI secret. Trigger options, cheapest first:

- **Push to Forgejo and use Forgejo Actions / webhooks** (§1) — if you already
  mirror to Forgejo, let Forgejo drive CI on push. Recommended: it gives you the
  forge's native webhook + Actions surface for free.
- **Scheduled poll** — a cron CI job clones the room periodically and builds if
  HEAD changed. Zero ICE-side wiring.
- **Convergence-triggered** — fire a CI webhook from the same post-commit hook
  you'd use to mirror (§1), so a build kicks off the moment a room converges.

ICE does not embed a CI runner — it exposes a plain git endpoint and lets your CI
do what it already does well.

---

## 3. MCP servers — giving agents tools

ICE's AI agents can call external tools through the
[Model Context Protocol](https://modelcontextprotocol.io). You register MCP
servers; ICE discovers their tools and offers them to the agent host. ICE is the
**client/host** here — it speaks MCP to tool servers you choose, and does not
reimplement those tools.

### Configure servers

Workspace MCP servers are declared in **one environment variable**,
`ICE_MCP_SERVERS`: a JSON array of stdio server specs. Set it in your `.env`
(Compose) or via `server.env.extra` (Helm).

```sh
ICE_MCP_SERVERS='[
  { "name": "search", "command": "npx", "args": ["-y", "@org/search-mcp"] },
  { "name": "github", "command": "github-mcp", "env": { "GITHUB_TOKEN": "..." } }
]'
```

Each entry is a **stdio** server (the only kind expressible as JSON):

| field | required | meaning |
|-------|----------|---------|
| `name` | yes | unique id; duplicates are de-duped, first wins |
| `command` | yes | executable ICE spawns |
| `args` | no | argv for the command |
| `env` | no | extra environment for the spawned server |
| `cwd` | no | working directory |
| `timeoutMs` | no | per-call timeout |

Parsing is **defensive**: a malformed variable yields an empty registry (no
crash), and individual bad entries are dropped with a warning. Unset/empty ⇒ no
MCP servers, and nothing is spawned — MCP is fully optional.

> **Packaging tip (containers).** ICE spawns these `command`s *inside the server
> container*, so the binary must exist there. Either use servers runnable via
> `npx -y …` (fetched on demand), bake the tool into a derived server image, or
> mount it in. Pass per-server credentials through the entry's `env`, not the
> global environment, so each tool only sees its own secret.

### Discover what the agent can use

The available tools per room are served by the REST API:

```
GET /api/rooms/<roomId>/mcp/tools   →   { tools: McpTool[], servers: [...] }
```

That is the same surface the agent host consults before a run, so you can hit it
to confirm a freshly added server's tools are visible. The agent then invokes
those tools as part of its normal turn (subject to the workspace's agent policy).

---

## Where integrations live

| Integration | Artifact | Default |
|-------------|----------|---------|
| Forgejo forge | `deploy/forgejo/compose.forgejo.yml` | off (override) |
| External CI | bundled git server, port `8081` | always on |
| MCP tools | `ICE_MCP_SERVERS` env var | off (empty) |
| Postgres metadata | `DATABASE_URL=postgres://…` | off (SQLite) |
| Voice (LiveKit) | bundled `livekit` service | on in Compose |

Horizontal scale-out (Redis + multiple replicas) is its own topic — see
[SCALING.md](./SCALING.md). Production hardening (TLS, OIDC, backups) is in
[SELF_HOSTING.md](./SELF_HOSTING.md).
