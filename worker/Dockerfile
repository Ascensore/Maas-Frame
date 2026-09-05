FROM docker.io/oven/bun:1

WORKDIR /worker

# The font packages are what the burn-in job draws with: libass finds a family
# by name through fontconfig, and a missing one is silently replaced rather than
# reported, so the families offered in the style picker have to be installed.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip python3-venv \
       fonts-dejavu-core fonts-liberation2 fonts-roboto fonts-open-sans fontconfig \
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
# The one WebVTT serializer, shared with the app. Imports nothing.
COPY lib/subtitle-validation.ts ./lib/subtitle-validation.ts
COPY lib/rough-cut ./lib/rough-cut

CMD ["bun", "run", "start"]
