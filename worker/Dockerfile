FROM docker.io/oven/bun:1.3.0-debian

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
  && rm -rf /var/lib/apt/lists/* \
  && for family in "DejaVu Sans" "Liberation Sans" "Roboto" "Open Sans" "Liberation Serif" "DejaVu Sans Mono"; do \
       fc-match --format='%{family}' "$family" | grep -qiF "$family" \
         || { echo "missing font: $family"; exit 1; }; \
     done

RUN pip3 install --break-system-packages --no-cache-dir --upgrade \
      "pip==25.3" "setuptools==80.9.0" "wheel==0.45.1" "typing-extensions==4.15.0"

# Local transcription and diarization only. The worker runs every ffmpeg job
# without them, so a wheel that will not build here is not a reason to have no
# image at all.
RUN pip3 install --break-system-packages --no-cache-dir \
       --index-url https://download.pytorch.org/whl/cpu \
       torch \
  && pip3 install --break-system-packages --no-cache-dir faster-whisper numpy soundfile scipy pyannote.audio \
  || echo "optional python packages skipped; local transcription and diarization will fail until they are present"

# Reproducible local visual analysis for short-form framing. These are core
# short-form dependencies, so a missing wheel fails the image build visibly.
# MediaPipe declares desktop OpenCV plus optional task families; install its
# pinned runtime set explicitly in an isolated environment so the worker keeps
# a headless OpenCV build without changing transcription's NumPy requirements.
RUN python3 -m venv /opt/openframe-visual \
  && /opt/openframe-visual/bin/pip install --no-cache-dir --upgrade \
       "pip==25.3" "setuptools==80.9.0" "wheel==0.45.1" \
  && /opt/openframe-visual/bin/pip install --no-cache-dir \
       "absl-py==2.2.2" \
       "attrs==25.3.0" \
       "flatbuffers==25.2.10" \
       "jax==0.4.35" \
       "jaxlib==0.4.35" \
       "matplotlib==3.10.1" \
       "ml-dtypes==0.5.1" \
       "numpy==1.26.4" \
       "opt-einsum==3.4.0" \
       "protobuf==4.25.6" \
       "sounddevice==0.5.1" \
       "sentencepiece==0.2.0" \
       "click==8.2.1" \
       "platformdirs==4.3.8" \
       "tqdm==4.67.1" \
       "opencv-contrib-python-headless==4.11.0.86" \
  && /opt/openframe-visual/bin/pip install --no-cache-dir --no-deps \
       "mediapipe==0.10.18" "scenedetect==0.7.1" \
  && /opt/openframe-visual/bin/python -c "import urllib.request; urllib.request.urlretrieve('https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task', '/worker/face_landmarker.task')" \
  && /opt/openframe-visual/bin/python -c "import cv2, mediapipe, scenedetect; from mediapipe.tasks.python import vision; assert vision.FaceLandmarker"

ENV SHORT_FORM_VISUAL_PYTHON=/opt/openframe-visual/bin/python

COPY worker/package.json ./
RUN bun install

COPY worker/src ./src
COPY worker/whisper_local.py ./whisper_local.py
COPY worker/sync_offsets.py ./sync_offsets.py
COPY worker/diarize.py ./diarize.py
COPY worker/short_form_analyze.py ./short_form_analyze.py
COPY lib/timecode.ts ./lib/timecode.ts
COPY lib/folders.ts ./lib/folders.ts
COPY lib/export-file-names.ts ./lib/export-file-names.ts
COPY lib/media-job-queue.ts ./lib/media-job-queue.ts
# The one WebVTT serializer, shared with the app. Imports nothing.
COPY lib/subtitle-validation.ts ./lib/subtitle-validation.ts
COPY lib/rough-cut ./lib/rough-cut
COPY lib/short-form ./lib/short-form

CMD ["bun", "run", "start"]
