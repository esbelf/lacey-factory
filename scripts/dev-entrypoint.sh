#!/bin/sh
# Entrypoint for the local dev containers (Dockerfile.dev).
# node_modules live in anonymous volumes, which Docker keeps across
# `docker compose up --build` — so after a dependency change a container would
# still see the old packages. If package-lock.json changed since this volume
# was filled, install again before starting.
set -e
start_dir=$(pwd)
cd /app
if ! sha256sum -c node_modules/.lock-sha256 >/dev/null 2>&1; then
  echo "package-lock.json changed since this container's node_modules were installed — running npm install…"
  # npm install, not npm ci: ci deletes node_modules, which is a volume mount point here.
  npm install --no-audit --no-fund
  sha256sum package-lock.json > node_modules/.lock-sha256
fi
cd "$start_dir"
exec "$@"
