// The fixtures here are WebM files in the shape MediaRecorder emits them (see
// tests/helpers/webm-fixture.ts). The assertions parse the patched bytes back,
// because the failure mode that matters is a file that still opens but reports
// the wrong length.

import { describe, expect, it } from 'vitest';
import { injectWebmDuration } from '@/lib/webm-duration';
import {
  CLUSTER_BYTES,
  DURATION_PLACEHOLDER,
  buildLiveWebm,
  ebmlElement,
  readWebmDuration,
  timecodeScaleElement,
} from '../../helpers/webm-fixture';

describe('injectWebmDuration', () => {
  it('adds a Duration to a live-mode recording that has none', () => {
    const source = buildLiveWebm();
    expect(readWebmDuration(source)).toBeNull();

    const patched = injectWebmDuration(source, 23_400);

    expect(patched).not.toBeNull();
    expect(readWebmDuration(patched!)).toBeCloseTo(23_400, 3);
    expect(patched!.length).toBe(source.length + 11);
  });

  it('expresses the duration in timecode ticks, not milliseconds', () => {
    // A 100us scale means one tick is a tenth of a millisecond.
    const source = buildLiveWebm({ info: timecodeScaleElement(100_000) });

    const patched = injectWebmDuration(source, 5_000);

    expect(readWebmDuration(patched!)).toBeCloseTo(50_000, 3);
  });

  it('keeps the trailing clusters intact', () => {
    const patched = injectWebmDuration(buildLiveWebm(), 1_000)!;

    expect(Array.from(patched.subarray(patched.length - CLUSTER_BYTES.length))).toEqual(
      CLUSTER_BYTES
    );
  });

  it('overwrites a Duration that is already there', () => {
    const existing = [0x44, 0x89, 0x88, 0x40, 0x59, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]; // 100.0
    const source = buildLiveWebm({ info: [...timecodeScaleElement(1_000_000), ...existing] });
    expect(readWebmDuration(source)).toBeCloseTo(100, 3);

    const patched = injectWebmDuration(source, 8_250)!;

    expect(patched.length).toBe(source.length);
    expect(readWebmDuration(patched)).toBeCloseTo(8_250, 3);
  });

  // Firefox writes an empty SeekHead, a Duration reserved as 0.0, and 8-byte
  // element sizes. Its recordings were the ones still playing past their end.
  it('fills in the duration Firefox reserves and never writes', () => {
    const source = buildLiveWebm({
      info: [...timecodeScaleElement(1_000_000), ...DURATION_PLACEHOLDER],
      seekHead: 'empty',
      sizeWidth: 8,
    });
    expect(readWebmDuration(source)).toBe(0);

    const patched = injectWebmDuration(source, 9_500)!;

    expect(patched.length).toBe(source.length);
    expect(readWebmDuration(patched)).toBeCloseTo(9_500, 3);
  });

  it('splices into a file whose SeekHead is empty, because it holds no offsets', () => {
    const source = buildLiveWebm({ seekHead: 'empty' });

    const patched = injectWebmDuration(source, 3_000)!;

    expect(patched.length).toBe(source.length + 11);
    expect(readWebmDuration(patched)).toBeCloseTo(3_000, 3);
  });

  it('leaves a SeekHead that has entries alone rather than shifting its offsets', () => {
    const source = buildLiveWebm({ seekHead: 'entries' });

    expect(injectWebmDuration(source, 1_000)).toBeNull();
  });

  it('still fills in a reserved Duration when the SeekHead has entries', () => {
    const source = buildLiveWebm({
      info: [...timecodeScaleElement(1_000_000), ...DURATION_PLACEHOLDER],
      seekHead: 'entries',
    });

    // Overwriting in place moves no bytes, so the stored offsets stay correct.
    expect(readWebmDuration(injectWebmDuration(source, 6_000)!)).toBeCloseTo(6_000, 3);
  });

  it('defaults to a 1ms timecode scale when Info does not declare one', () => {
    const source = buildLiveWebm({ info: ebmlElement([0x73, 0xa4], [0x01, 0x02]) }); // SegmentUID

    expect(readWebmDuration(injectWebmDuration(source, 12_000)!)).toBeCloseTo(12_000, 3);
  });

  it('refuses durations that are not usable', () => {
    const source = buildLiveWebm();

    expect(injectWebmDuration(source, 0)).toBeNull();
    expect(injectWebmDuration(source, -5)).toBeNull();
    expect(injectWebmDuration(source, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('returns null for bytes that are not a WebM segment', () => {
    expect(injectWebmDuration(new Uint8Array([0x00, 0x01, 0x02, 0x03]), 1_000)).toBeNull();
  });
});
