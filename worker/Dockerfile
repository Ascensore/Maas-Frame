FROM docker.io/oven/bun:1

WORKDIR /worker

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip python3-venv \
  && rm -rf /var/lib/apt/lists/* \
  && pip3 install --break-system-packages --no-cache-dir \
       --index-url https://download.pytorch.org/whl/cpu \
       torch \
  && pip3 install --break-system-packages --no-cache-dir faster-whisper numpy soundfile scipy pyannote.audio \
  || echo "optional python packages skipped; local transcription and diarization will fail until they are present"

COPY worker/package.json ./
RUN bun install

COPY worker/src ./src
COPY worker/whisper_local.py ./whisper_local.py
COPY worker/sync_offsets.py ./sync_offsets.py
COPY worker/diarize.py ./diarize.py
COPY lib/timecode.ts ./lib/timecode.ts
COPY lib/folders.ts ./lib/folders.ts
COPY lib/export-file-names.ts ./lib/export-file-names.ts
COPY lib/media-job-queue.ts ./lib/media-job-queue.ts
COPY lib/rough-cut ./lib/rough-cut

CMD ["bun", "run", "start"]
