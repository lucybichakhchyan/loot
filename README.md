# LOOT

LOOT is a web app for recording your screen and camera, cutting a recording by editing its transcript, and exporting it as an MP4. It is a Loom alternative that runs on a server you control, so your videos stay with you.

## What is in this repository

- `app/`: the web app. `app/main.py` is the server, `app/pages/` holds the pages, and `app/static/js/` holds the browser code.
- `engine/`: the processing steps. FFmpeg cuts and converts video, DeepFilterNet removes background noise, Whisper writes the transcript, and Claude suggests cuts from the transcript.
- `automation/`: Swamp definitions for the background jobs: processing, export, nightly cleanup and a morning health check.
- `design/`: the approved mockups and design tokens. The copies the app serves are in `app/static/`.
- `tools/`: scripts that generate page variants.
- `Dockerfile`, `docker-compose.yml`, `entrypoint.sh`: how the app is packaged and started in a container.
- `deploy.sh`: copies the project to a server and rebuilds it there.

## How the app is deployed

Run `./deploy.sh` from this folder. The script copies the design files into `app/static/`, sends the project to the server over an SSH shortcut named `loot`, and rebuilds the container with `docker compose up -d --build`. The container runs next to other services and is reached through Traefik, a reverse proxy that handles the web address and HTTPS.

Before the first deploy, set up two things on your own machine and server:

- An SSH shortcut named `loot` in `~/.ssh/config`, pointing at your server.
- A `.env` file in the project folder on the server, with the settings listed below. Never commit this file.

## Settings in the server's `.env`

- `LOOT_PASSWORD`: the password for signing in.
- `LOOT_SECRET`: a long random string that signs login cookies. Without it, everyone is signed out whenever the container restarts.
- `ANTHROPIC_API_KEY`: the Claude key used to suggest cuts. Without it, the suggestion step is skipped.
- `LOOT_OWNER_NAME`: the name shown on exported videos.
- The Swamp settings that the background jobs need.

## Making it your own

Three things are tied to the original owner and need changing for a copy: the owner name default in `engine/render.py`, the web address in `docker-compose.yml`, and the colors and fonts in `design/tokens.css`. Brand settings, where you set your own name, logo and colors inside the app, is planned but not built yet.

## Status and licence

The first-run setup, the tour and the empty home screen are designed but not built yet. No licence has been chosen yet. A licence will be added before the repository is made public.
