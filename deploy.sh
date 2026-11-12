#!/bin/sh
# Copy LOOT to the server and rebuild its container. Never touches n8n or Traefik.
set -e
cd "$(dirname "$0")"
# The approved design's styles, icons and fonts are served by the app.
mkdir -p app/static && cp design/tokens.css design/app.css app/static/ && rm -rf app/static/assets app/static/fonts && cp -R design/assets design/fonts app/static/
COPYFILE_DISABLE=1 tar --no-xattrs --exclude design --exclude .env --exclude 'automation/.swamp' \
  --exclude __pycache__ --exclude .DS_Store --exclude '._*' -czf - . \
  | ssh loot 'tar -xzf - -C /docker/loot --no-same-owner 2>/dev/null'
ssh loot 'cd /docker/loot && docker compose up -d --build 2>&1 | tail -n 25'
