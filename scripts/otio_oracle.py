#!/usr/bin/env python3
"""Parse generated .otio and FCP7 .xml with real OpenTimelineIO.

The TypeScript exporters in lib/rough-cut/ are the source of truth for what
we ship. This script is the CI oracle: if those files cannot round-trip
through OTIO, the exporters drifted from the format NLEs actually read.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import opentimelineio as otio


def fail(message: str) -> None:
    print(f"otio-oracle: {message}", file=sys.stderr)
    raise SystemExit(1)


def load_otio(path: Path) -> otio.schema.Timeline:
    try:
        timeline = otio.adapters.read_from_file(str(path))
    except Exception as exc:  # noqa: BLE001 — oracle must surface adapter errors
        fail(f"failed to parse {path.name}: {exc}")
    if not isinstance(timeline, otio.schema.Timeline):
        fail(f"{path.name} did not load as a Timeline (got {type(timeline)!r})")
    return timeline


def load_fcp_xml(path: Path) -> otio.schema.Timeline:
    names = set(otio.adapters.available_adapter_names())
    if "fcp_xml" not in names:
        fail(
            "fcp_xml adapter is missing. Install otio-fcp-adapter "
            f"(available adapters: {sorted(names)})"
        )
    try:
        timeline = otio.adapters.read_from_file(str(path), adapter_name="fcp_xml")
    except Exception as exc:  # noqa: BLE001
        fail(f"failed to parse {path.name} with fcp_xml: {exc}")
    if not isinstance(timeline, otio.schema.Timeline):
        fail(f"{path.name} did not load as a Timeline (got {type(timeline)!r})")
    return timeline


def assert_program_edits(timeline: otio.schema.Timeline, expected_clip_count: int) -> None:
    if not timeline.tracks:
        fail("timeline has no tracks")
    program = timeline.tracks[0]
    clips = list(program.find_clips())
    if len(clips) != expected_clip_count:
        fail(
            f"program track has {len(clips)} clips, expected {expected_clip_count}"
        )
    first = clips[0]
    duration = first.source_range.duration.to_seconds() if first.source_range else None
    if duration is None or abs(duration - 2.0) > 1e-3:
        fail(f"first program clip duration is {duration}, expected 2.0 seconds")


def round_trip_otio(timeline: otio.schema.Timeline) -> None:
    serialized = otio.adapters.write_to_string(timeline, adapter_name="otio_json")
    again = otio.adapters.read_from_string(serialized, adapter_name="otio_json")
    if again.name != timeline.name:
        fail(f"OTIO round-trip renamed the timeline ({timeline.name!r} -> {again.name!r})")
    original_clips = list(timeline.find_clips())
    again_clips = list(again.find_clips())
    if len(again_clips) != len(original_clips):
        fail(
            f"OTIO round-trip dropped clips ({len(original_clips)} -> {len(again_clips)})"
        )


def round_trip_fcp(timeline: otio.schema.Timeline) -> None:
    serialized = otio.adapters.write_to_string(timeline, adapter_name="fcp_xml")
    again = otio.adapters.read_from_string(serialized, adapter_name="fcp_xml")
    original_clips = list(timeline.find_clips())
    again_clips = list(again.find_clips())
    if len(again_clips) != len(original_clips):
        fail(
            f"FCP XML round-trip dropped clips ({len(original_clips)} -> {len(again_clips)})"
        )


def main(argv: list[str]) -> None:
    if len(argv) != 2:
        fail("usage: otio_oracle.py <fixtures-dir>")
    fixtures = Path(argv[1])
    otio_path = fixtures / "rough-cut.otio"
    xml_path = fixtures / "rough-cut.xml"
    if not otio_path.is_file() or not xml_path.is_file():
        fail(f"missing fixtures in {fixtures}")

    payload = json.loads(otio_path.read_text())
    if payload.get("OTIO_SCHEMA") != "Timeline.1":
        fail("generated .otio is not Timeline.1")

    otio_timeline = load_otio(otio_path)
    if otio_timeline.name != "Rough Cut":
        fail(f"OTIO timeline name is {otio_timeline.name!r}, expected 'Rough Cut'")
    assert_program_edits(otio_timeline, expected_clip_count=2)
    round_trip_otio(otio_timeline)

    xml_timeline = load_fcp_xml(xml_path)
    assert_program_edits(xml_timeline, expected_clip_count=2)
    round_trip_fcp(xml_timeline)

    print("otio-oracle: .otio and .xml loaded and round-tripped")


if __name__ == "__main__":
    main(sys.argv)
