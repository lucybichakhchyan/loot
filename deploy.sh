#!/bin/sh
# Copy LOOT to the server and rebuild its container. Never touches n8n or Traefik.
set -e
cd "$(dirname "$0")"
# The app serves its own copy of the design's styles, icons and fonts (app/static).
# Run with SYNC_DESIGN=1 to refresh that copy from design/ once a design change is approved.
if [ "${SYNC_DESIGN:-0}" = "1" ]; then
  mkdir -p app/static && cp design/tokens.css design/app.css app/static/ && cp -R design/assets/. app/static/assets/ && cp -R design/fonts/. app/static/fonts/
fi
COPYFILE_DISABLE=1 tar --no-xattrs --exclude design --exclude .git --exclude .env --exclude 'automation/.swamp' \
  --exclude __pycache__ --exclude .DS_Store --exclude '._*' -czf - . \
  | ssh loot 'tar -xzf - -C /docker/loot --no-same-owner 2>/dev/null'
ssh loot 'cd /docker/loot && docker compose up -d --build 2>&1 | tail -n 25'
# Old build leftovers pile up on the server's disk; clear them (never touches running containers or their images).
ssh loot 'docker image prune -f >/dev/null 2>&1; docker builder prune -f --filter until=24h >/dev/null 2>&1' || true
