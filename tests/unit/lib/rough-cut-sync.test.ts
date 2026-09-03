import { describe, expect, it } from 'vitest';
import { computeTimecodeOffsets } from '@/lib/rough-cut/sync';

describe('computeTimecodeOffsets', () => {
  const rate = { num: 24, den: 1, dropFrame: false };

  it('offsets every clip from the earliest start timecode', () => {
    const result = computeTimecodeOffsets(
      [
        { versionId: 'a', startTimecode: '01:00:02:00' },
        { versionId: 'b', startTimecode: '01:00:00:00' },
      ],
      rate
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.offsets.get('a')).toBe(2);
    expect(result.offsets.get('b')).toBe(0);
  });

  it('fails when a start timecode is not SMPTE', () => {
    const result = computeTimecodeOffsets(
      [
        { versionId: 'a', startTimecode: '01:00:00:00' },
        { versionId: 'b', startTimecode: 'not-a-timecode' },
      ],
      rate
    );
    expect(result).toEqual({ ok: false, reason: 'invalid-timecode' });
  });

  it('fails when any clip is missing timecode', () => {
    const result = computeTimecodeOffsets(
      [
        { versionId: 'a', startTimecode: '01:00:00:00' },
        { versionId: 'b', startTimecode: null },
      ],
      rate
    );
    expect(result).toEqual({ ok: false, reason: 'missing-timecode' });
  });
});
