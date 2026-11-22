#!/bin/sh
# ICE server container entrypoint.
#
# Goal: ZERO required configuration. On first boot, if no ICE_SESSION_SECRET is
# provided via the environment, we generate one and persist it inside the data
# volume (/app/data) so it survives container restarts and recreation. The cookie
# HMAC key therefore stays stable across deploys without the operator having to
# manage any secret by hand.
#
# Order of precedence for the secret:
#   1. ICE_SESSION_SECRET from the environment (operator-provided) — always wins.
#   2. Previously-generated secret persisted at $SECRET_FILE in the data volume.
#   3. A freshly generated secret, which we then persist for next time.
#
# After the secret is resolved we exec the real server process (PID 1 hand-off so
# signals / graceful shutdown work correctly under `docker compose`).
set -eu

DATA_DIR="${ICE_DATA_DIR:-/app/data}"
SECRET_FILE="${DATA_DIR}/session.secret"

mkdir -p "${DATA_DIR}"

if [ -z "${ICE_SESSION_SECRET:-}" ]; then
  if [ -s "${SECRET_FILE}" ]; then
    ICE_SESSION_SECRET="$(cat "${SECRET_FILE}")"
    echo "[ice] reusing persisted ICE_SESSION_SECRET from ${SECRET_FILE}"
  else
    ICE_SESSION_SECRET="$(node /app/scripts/gen-secrets.mjs)"
    # Write atomically-ish and lock down permissions before anyone else can read it.
    ( umask 077; printf '%s' "${ICE_SESSION_SECRET}" > "${SECRET_FILE}" )
    echo "[ice] generated a new ICE_SESSION_SECRET and persisted it to ${SECRET_FILE}"
  fi
  export ICE_SESSION_SECRET
else
  echo "[ice] using ICE_SESSION_SECRET from environment"
fi

# Default the SQLite location into the persisted data volume unless overridden.
export DATABASE_URL="${DATABASE_URL:-file:${DATA_DIR}/ice.sqlite}"
export ICE_GIT_ROOT="${ICE_GIT_ROOT:-${DATA_DIR}/repos}"
export PORT="${PORT:-8080}"

echo "[ice] starting @ice/server on port ${PORT} (data dir: ${DATA_DIR})"

# Hand off to the server. "$@" is the CMD from the Dockerfile (pnpm start).
exec "$@"
