#!/usr/bin/env python3
"""Speaker diarization with an energy-VAD fallback. Prints JSON to stdout.

Usage:
  diarize.py <wav> [language]
  diarize.py --vad-only <wav>
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def energy_vad(path: str) -> list[dict]:
    import numpy as np
    import soundfile as sf

    samples, rate = sf.read(path, always_2d=False)
    if getattr(samples, "ndim", 1) > 1:
        samples = np.mean(samples, axis=1)
    samples = np.asarray(samples, dtype=np.float64)
    frame = max(1, int(rate * 0.03))
    hop = max(1, int(rate * 0.01))
    energies = []
    for start in range(0, max(1, len(samples) - frame), hop):
        window = samples[start : start + frame]
        energies.append(float(np.sqrt(np.mean(window * window))))
    if not energies:
        return []
    threshold = max(float(np.percentile(energies, 30)) * 3.0, 1e-4)
    regions: list[dict] = []
    in_speech = False
    region_start = 0.0
    for index, energy in enumerate(energies):
        time = index * hop / rate
        if energy >= threshold and not in_speech:
            in_speech = True
            region_start = time
        elif energy < threshold and in_speech:
            in_speech = False
            end = time
            if end - region_start >= 0.2:
                regions.append(
                    {"start": region_start, "end": end, "speaker": "SPEAKER_00"}
                )
    if in_speech:
        end = len(samples) / rate
        if end - region_start >= 0.2:
            regions.append({"start": region_start, "end": end, "speaker": "SPEAKER_00"})
    return regions


def pyannote_turns(path: str) -> list[dict]:
    from pyannote.audio import Pipeline

    token = os.environ.get("HUGGINGFACE_TOKEN") or os.environ.get("HF_TOKEN")
    model = os.environ.get("OPENFRAME_DIARIZATION_MODEL") or "pyannote/speaker-diarization-3.1"
    pipeline = Pipeline.from_pretrained(model, token=token)
    diarization = pipeline(path)
    turns = []
    for turn, _, speaker in diarization.itertracks(yield_label=True):
        turns.append(
            {
                "start": float(turn.start),
                "end": float(turn.end),
                "speaker": str(speaker),
            }
        )
    turns.sort(key=lambda item: item["start"])
    return turns


def rms_window(path: str, start: float, end: float) -> float:
    import numpy as np
    import soundfile as sf

    samples, rate = sf.read(path, always_2d=False)
    if getattr(samples, "ndim", 1) > 1:
        samples = np.mean(samples, axis=1)
    start_i = max(0, int(start * rate))
    end_i = min(len(samples), int(end * rate))
    if end_i <= start_i:
        return 0.0
    window = np.asarray(samples[start_i:end_i], dtype=np.float64)
    return float(np.sqrt(np.mean(window * window)))


def main() -> int:
    args = sys.argv[1:]
    vad_only = False
    if args and args[0] == "--vad-only":
        vad_only = True
        args = args[1:]
    if args and args[0] == "--rms":
        if len(args) < 4:
            print("usage: diarize.py --rms <wav> <start> <end>", file=sys.stderr)
            return 2
        print(json.dumps({"rms": rms_window(args[1], float(args[2]), float(args[3]))}))
        return 0
    if not args:
        print("usage: diarize.py [--vad-only] <wav>", file=sys.stderr)
        return 2

    wav = args[0]
    if not Path(wav).is_file():
        print(f"file not found: {wav}", file=sys.stderr)
        return 1

    warning = None
    turns: list[dict] = []
    if not vad_only:
        try:
            turns = pyannote_turns(wav)
        except Exception as error:  # noqa: BLE001
            warning = f"pyannote unavailable ({error}); used per-camera voice activity"
            vad_only = True
    if vad_only or not turns:
        try:
            turns = energy_vad(wav)
        except Exception as error:  # noqa: BLE001
            print(json.dumps({"error": str(error)}))
            return 1
        if warning is None:
            warning = "Used per-camera voice activity"

    print(json.dumps({"turns": turns, "warning": warning}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
