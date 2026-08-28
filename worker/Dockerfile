FROM docker.io/oven/bun:1

WORKDIR /worker

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip python3-venv \
  && rm -rf /var/lib/apt/lists/* \
  && pip3 install --break-system-packages --no-cache-dir faster-whisper \
  || echo "faster-whisper install skipped; local transcription will fail until it is present"

COPY package.json ./
RUN bun install

COPY src ./src
COPY whisper_local.py ./whisper_local.py

CMD ["bun", "run", "start"]
