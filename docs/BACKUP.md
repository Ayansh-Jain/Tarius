# Backing up & restoring ICE

ICE keeps **all** durable state in one place, so backups are simple. This page
covers what to back up, how to do it consistently (no torn writes), and how to
restore. Pair it with [SELF_HOSTING.md](./SELF_HOSTING.md).

---

## 1. What state exists

With the default Docker Compose deployment, everything lives in the single
`ice-data` volume, mounted at `/app/data` in the `server` container:

| Path (in volume) | What it is | Lose it and… |
|---|---|---|
| `ice.sqlite` (+ `-wal`, `-shm`) | **Metadata DB** — users, rooms, invites, workspace roles. | accounts, room ownership, and invites are gone. |
| `ydoc.sqlite` (+ `-wal`, `-shm`) | **Yjs documents** — the live, collaborative file content for every room (Hocuspocus persistence). | the actual editable content of every room is gone. |
| `repos/<roomId>.git` | **Bare git repo per room** — committed history (CRDT↔git convergence). | git history / branches are gone (working content may still be reconstructable from `ydoc.sqlite`). |
| the persisted session secret | Auto-generated `ICE_SESSION_SECRET` (only if you didn't set your own). | all sessions invalidate on next boot (users just log in again). |

> The three "sources of truth" (Yjs docs, git repos, metadata) are independent
> files. **Back them up together** so a restore is internally consistent — e.g.
> a room row in `ice.sqlite` should have its matching `ydoc.sqlite` doc and
> `repos/<roomId>.git`.

If you switched the metadata store to **Postgres** (`DATABASE_URL=postgres://…`),
then `ice.sqlite` is unused and the metadata lives in Postgres instead — back
that up with `pg_dump` (§5) **plus** the `ydoc.sqlite` and `repos/` from the
volume.

---

## 2. The simplest backup: snapshot the volume

Because all state is one volume, a tarball of it is a complete backup. Briefly
stopping the server guarantees a consistent snapshot (no in-flight WAL writes):

```bash
# Consistent cold backup (recommended): a few seconds of downtime.
docker compose stop server
docker run --rm \
  -v ice_ice-data:/data:ro \
  -v "$PWD":/backup \
  alpine tar czf /backup/ice-backup-$(date +%F).tar.gz -C /data .
docker compose start server
```

- `ice_ice-data` is `<project>_<volume>`; the compose project is `ice` (set by
  `name: ice` in `docker-compose.yml`). Confirm with `docker volume ls`.
- The result, `ice-backup-YYYY-MM-DD.tar.gz`, is your whole deployment's state.

Automate it with cron and ship the tarball off-box (S3, another host, etc.).
**Test a restore periodically** — an untested backup is a hope, not a backup.

---

## 3. Hot backup (no downtime)

If you can't take even a few seconds of downtime, back up the SQLite files using
SQLite's online backup so you never copy a torn WAL. Do **not** just `cp` a live
`*.sqlite` while the server is running.

```bash
# Back up each SQLite DB live, inside the running container.
docker compose exec server sh -lc '
  mkdir -p /app/data/_backup
  sqlite3 /app/data/ice.sqlite  ".backup /app/data/_backup/ice.sqlite"
  sqlite3 /app/data/ydoc.sqlite ".backup /app/data/_backup/ydoc.sqlite"
'

# Copy the consistent backups + git repos out of the volume.
docker run --rm -v ice_ice-data:/data:ro -v "$PWD":/backup \
  alpine sh -lc 'cd /data && tar czf /backup/ice-hot-$(date +%F).tar.gz _backup repos'

# Tidy up the in-volume staging copies.
docker compose exec server rm -rf /app/data/_backup
```

> `sqlite3` may not be present in a minimal server image; if so, prefer the cold
> snapshot in §2, or add `sqlite` to the image. The bare git repos in `repos/`
> are safe to copy hot — committed git objects are immutable — though for a fully
> point-in-time-consistent set, the cold snapshot is cleanest.

---

## 4. Restore

```bash
# 1. Stop the stack.
docker compose down

# 2. (If restoring over an existing deployment) reset the volume.
docker volume rm ice_ice-data
docker volume create ice_ice-data

# 3. Unpack the backup tarball into the volume.
docker run --rm -v ice_ice-data:/data -v "$PWD":/backup \
  alpine sh -lc 'cd /data && tar xzf /backup/ice-backup-YYYY-MM-DD.tar.gz'

#    If you restored a §3 HOT backup, the SQLite files are under _backup/ —
#    move them into place:
docker run --rm -v ice_ice-data:/data alpine sh -lc '
  cd /data && [ -d _backup ] && mv -f _backup/*.sqlite . && rm -rf _backup || true'

# 4. Bring it back up and verify health.
docker compose up -d
curl -fsS "${PUBLIC_URL:-http://localhost:3000}/api/health"   # -> {"status":"ok"}
```

After a restore, spot-check: log in, open a known room, confirm its files and git
history (`/git/<roomId>.git`) are intact.

---

## 5. Postgres metadata backups

When `DATABASE_URL` points at Postgres, dump/restore the metadata DB with the
standard tools, and **still** back up `ydoc.sqlite` + `repos/` from the volume
(those stay on the server regardless of the metadata backend).

```bash
# Dump (run from anywhere that can reach the DB).
pg_dump "$DATABASE_URL" -Fc -f ice-meta-$(date +%F).dump

# Restore into a fresh, empty database.
pg_restore --clean --if-exists --no-owner -d "$DATABASE_URL" ice-meta-YYYY-MM-DD.dump
```

The ICE schema (`users`, `rooms`, `invites`, `room_roles`) is also re-created
automatically on boot if missing, so restoring data into an empty database and
letting ICE start is fine.

For production Postgres, prefer your provider's **point-in-time recovery** (WAL
archiving) over periodic dumps where available.

---

## 6. What you can skip

- **The session secret** doesn't need separate backup if you set
  `ICE_SESSION_SECRET` yourself (it's in your secret manager, not the volume). If
  you rely on the auto-generated one, it's inside the volume and covered by §2;
  losing it only forces users to log in again.
- **Container images** are rebuildable from source — back up your **fork/source**
  and the **volume/database**, not the images.

---

## 7. Backup checklist

- [ ] A scheduled job snapshots the `ice-data` volume (§2) **or** does a hot
      SQLite backup (§3) at a sensible cadence.
- [ ] Postgres (if used) is dumped or has PITR enabled (§5).
- [ ] Backups are copied **off-box** (different host / object storage).
- [ ] A restore has been **tested end-to-end** (§4) at least once.
- [ ] Backups containing user data are encrypted at rest and access-controlled.
