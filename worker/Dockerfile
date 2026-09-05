FROM docker.io/oven/bun:1

WORKDIR /worker

# ffmpeg and the fonts the burn-in job draws with. libass finds a family by
# name through fontconfig and silently substitutes one it cannot find rather
# than reporting it, so every family the style picker offers has to be here.
# Its own step, with no fallback: a package that stops existing has to fail the
# build rather than take ffmpeg down with it into the `|| echo` below.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ffmpeg python3 python3-pip python3-venv \
       fontconfig fonts-dejavu-core fonts-liberation2 fonts-roboto fonts-open-sans \
  && rm -rf /var/lib/apt/lists/*

# Local transcription and diarization only. The worker runs every ffmpeg job
# without them, so a wheel that will not build here is not a reason to have no
# image at all.
RUN pip3 install --break-system-packages --no-cache-dir \
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
