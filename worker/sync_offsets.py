#!/usr/bin/env python3
"""FFT cross-correlation offsets relative to a reference wav. Prints JSON to stdout."""

from __future__ import annotations

import json
import sys
from pathlib import Path


def _load(path: str):
    import numpy as np
    import soundfile as sf

    samples, rate = sf.read(path, always_2d=False)
    if getattr(samples, "ndim", 1) > 1:
        samples = np.mean(samples, axis=1)
    return np.asarray(samples, dtype=np.float64), int(rate)


def _offset(reference, other):
    import numpy as np

    a = reference - np.mean(reference)
    b = other - np.mean(other)
    n = 1 << int(np.ceil(np.log2(max(1, len(a) + len(b) - 1))))
    spectrum_a = np.fft.rfft(a, n)
    spectrum_b = np.fft.rfft(b, n)
    correlation = np.fft.irfft(spectrum_a * np.conj(spectrum_b), n)
    lag = int(np.argmax(correlation))
    if lag > n // 2:
        lag -= n
    peak = float(np.max(np.abs(correlation)))
    energy = float(np.sqrt(np.sum(a * a) * np.sum(b * b)) + 1e-12)
    return lag, min(1.0, peak / energy)


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: sync_offsets.py <ref.wav> <other.wav>...", file=sys.stderr)
        return 2

    try:
        import numpy as np  # noqa: F401
        import soundfile as sf  # noqa: F401
    except ImportError:
        print("numpy/soundfile is not installed", file=sys.stderr)
        return 1

    ref_path = sys.argv[1]
    other_paths = sys.argv[2:]
    reference, ref_rate = _load(ref_path)
    offsets = [
        {
            "path": str(Path(ref_path).resolve()),
            "offsetSeconds": 0.0,
            "confidence": 1.0,
        }
    ]
    for path in other_paths:
        samples, rate = _load(path)
        if rate != ref_rate:
            print(json.dumps({"error": f"sample rate mismatch for {path}"}))
            return 1
        lag, confidence = _offset(reference, samples)
        offsets.append(
            {
                "path": str(Path(path).resolve()),
                "offsetSeconds": float(lag) / float(ref_rate),
                "confidence": confidence,
            }
        )

    print(json.dumps({"offsets": offsets}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
