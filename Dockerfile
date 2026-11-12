FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 LOOT_DATA=/data LOOT_WHISPER_DIR=/opt/whisper \
    LOOT_WHISPER_MODEL=small.en SWAMP_NO_INBOX_NOTICE=1

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

# DeepFilterNet noise remover (open source, single binary)
RUN curl -fsSL -o /usr/local/bin/deep-filter \
      https://github.com/Rikorose/DeepFilterNet/releases/download/v0.5.6/deep-filter-0.5.6-x86_64-unknown-linux-musl \
    && chmod +x /usr/local/bin/deep-filter

# Swamp CLI, which runs the LOOT workflows
RUN curl -fsSL https://swamp-club.com/install.sh | sh -s -- -d /usr/local/bin

COPY requirements.txt /tmp/requirements.txt
RUN pip install -r /tmp/requirements.txt

# Bake the Whisper model into the image so the first recording does not wait for a download
RUN python -c "from faster_whisper import WhisperModel; WhisperModel('small.en', device='cpu', compute_type='int8', download_root='/opt/whisper')"

RUN useradd -m -u 1000 loot && mkdir -p /data && chown loot:loot /data
WORKDIR /app
COPY engine /app/engine
COPY app /app/app
COPY automation /app/automation
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh && chmod -R a+rX /opt/whisper /app
USER loot
EXPOSE 8000
ENTRYPOINT ["tini", "--", "/app/entrypoint.sh"]
