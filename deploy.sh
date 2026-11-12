#!/bin/sh
# Copy LOOT to the server and rebuild its container. Leaves every other service on the server alone.
# LOOT_SSH is the SSH host (default: a shortcut named "loot" in ~/.ssh/config); LOOT_DIR is the folder on the server.
set -e
cd "$(dirname "$0")"
SSH_HOST="${LOOT_SSH:-loot}"
DIR="${LOOT_DIR:-/docker/loot}"
# The app serves its own copy of the design's styles, icons and fonts (app/static).
# Run with SYNC_DESIGN=1 to refresh that copy from design/ once a design change is approved.
if [ "${SYNC_DESIGN:-0}" = "1" ]; then
  # The mockups' sample picture stays in design/: the app ships a neutral placeholder, and each owner sets their own in Brand settings.
  mkdir -p app/static/assets && cp design/tokens.css design/app.css app/static/ && cp design/assets/icons.svg app/static/assets/ && cp -R design/fonts/. app/static/fonts/
fi
COPYFILE_DISABLE=1 tar --no-xattrs --exclude design --exclude docs --exclude .github --exclude .git --exclude .env --exclude 'automation/.swamp' \
  --exclude __pycache__ --exclude .DS_Store --exclude '._*' -czf - . \
  | ssh "$SSH_HOST" "tar -xzf - -C $DIR --no-same-owner 2>/dev/null"
ssh "$SSH_HOST" "cd $DIR && docker compose up -d --build 2>&1 | tail -n 25"
# Old build leftovers pile up on the server's disk; clear them (never touches running containers or their images).
ssh "$SSH_HOST" 'docker image prune -f >/dev/null 2>&1; docker builder prune -f --filter until=24h >/dev/null 2>&1' || true
