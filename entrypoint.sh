#!/bin/sh
# The Swamp repo lives on the data volume so run history survives rebuilds.
# Definitions (behaviors and workflows) always come fresh from the image.
set -e
A=/data/automation
mkdir -p "$A" /data/projects /data/reports
rm -rf "$A/models" "$A/workflows"
cp -R /app/automation/models /app/automation/workflows "$A/"
cp /app/automation/.swamp.yaml "$A/.swamp.yaml"
[ -f /app/automation/.gitignore ] && cp /app/automation/.gitignore "$A/.gitignore"
export LOOT_AUTOMATION="$A"
exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips='*'
