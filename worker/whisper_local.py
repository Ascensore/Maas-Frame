#!/usr/bin/env python3
"""faster-whisper CLI used by the media worker. Prints JSON to stdout."""

import json
import sys


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: whisper_local.py <audio-path> [language]", file=sys.stderr)
        return 2

    audio_path = sys.argv[1]
    language = sys.argv[2] if len(sys.argv) > 2 else None

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("faster-whisper is not installed", file=sys.stderr)
        return 1

    model_size = "base"
    model = WhisperModel(model_size, device="cpu", compute_type="int8")
    segments_iter, info = model.transcribe(
        audio_path,
        language=language,
        word_timestamps=True,
        vad_filter=True,
    )

    segments = []
    for segment in segments_iter:
        words = []
        for word in segment.words or []:
            words.append(
                {
                    "start": float(word.start),
                    "end": float(word.end),
                    "text": word.word.strip(),
                }
            )
        segments.append(
            {
                "start": float(segment.start),
                "end": float(segment.end),
                "text": segment.text.strip(),
                "words": words,
            }
        )

    json.dump(
        {
            "language": info.language or language or "en",
            "segments": segments,
        },
        sys.stdout,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
