import { describe, expect, it } from 'vitest';
import {
  commentSecondsToSequenceFrames,
  deriveTimestampFrame,
  framesToSeconds,
  framesToTimecode,
  parseFrameRateString,
  parseTimecode,
  reduceFrameRate,
  secondsToFrames,
  secondsToTimecode,
  startTimecodeToSeconds,
  timecodeToFrames,
} from '@/lib/timecode';

const F24 = { num: 24, den: 1, dropFrame: false };
const F25 = { num: 25, den: 1, dropFrame: false };
const NTSC = { num: 30000, den: 1001, dropFrame: true };

describe('reduceFrameRate', () => {
  it('reduces 48000/2002 to 24000/1001', () => {
    expect(reduceFrameRate(48000, 2002)).toEqual({ num: 24000, den: 1001 });
  });

  it('leaves 25/1 alone', () => {
    expect(reduceFrameRate(25, 1)).toEqual({ num: 25, den: 1 });
  });
});

describe('parseFrameRateString', () => {
  it('parses ffprobe r_frame_rate', () => {
    expect(parseFrameRateString('30000/1001')).toEqual({ num: 30000, den: 1001 });
  });

  it('rejects junk', () => {
    expect(parseFrameRateString('29.97')).toBeNull();
    expect(parseFrameRateString('0/1')).toBeNull();
  });
});

describe('secondsToFrames / framesToSeconds', () => {
  it('maps 1 second of 24fps to frame 24', () => {
    expect(secondsToFrames(1, F24)).toBe(24);
    expect(framesToSeconds(24, F24)).toBe(1);
  });

  it('does not drift on NTSC: 10 minutes is 17982 frames of 29.97 DF', () => {
    const tenMinutes = 10 * 60;
    const frames = secondsToFrames(tenMinutes, NTSC);
    expect(frames).toBe(17982);
  });

  it('deriveTimestampFrame returns null without a rate', () => {
    expect(deriveTimestampFrame(1.5, null, null)).toBeNull();
    expect(deriveTimestampFrame(1.5, 24, 1)).toBe(36);
  });
});

describe('timecode', () => {
  it('formats NDF 24fps', () => {
    expect(framesToTimecode(24, F24)).toBe('00:00:01:00');
    expect(secondsToTimecode(65.5, F24)).toBe('00:01:05:12');
  });

  it('round-trips NDF 25fps', () => {
    const tc = '01:02:03:04';
    const frames = timecodeToFrames(tc, F25);
    expect(frames).toBe(1 * 3600 * 25 + 2 * 60 * 25 + 3 * 25 + 4);
    expect(framesToTimecode(frames!, F25)).toBe(tc);
  });

  it('formats drop-frame 29.97 at 00:01:00;02 (two frames dropped)', () => {
    const oneMinuteNominal = 30 * 60;
    expect(framesToTimecode(oneMinuteNominal, NTSC)).toBe('00:01:00;02');
  });

  it('round-trips a drop-frame timecode away from the drop boundary', () => {
    const tc = '01:00:00;00';
    const frames = timecodeToFrames(tc, NTSC);
    expect(frames).not.toBeNull();
    expect(framesToTimecode(frames!, NTSC)).toBe(tc);
  });

  it('parses both separators', () => {
    expect(parseTimecode('01:02:03:04')?.dropFrame).toBe(false);
    expect(parseTimecode('01:02:03;04')?.dropFrame).toBe(true);
    expect(parseTimecode('not a timecode')).toBeNull();
  });
});

describe('commentSecondsToSequenceFrames', () => {
  it('adds the sequence start offset', () => {
    const offset = { startTimecode: '01:00:00:00', rate: F24 };
    const frames = commentSecondsToSequenceFrames(2, offset);
    expect(frames).toBe(timecodeToFrames('01:00:00:00', F24)! + 48);
  });

  it('converts a one-hour start timecode to seconds', () => {
    expect(startTimecodeToSeconds('01:00:00:00', F24)).toBe(3600);
  });
});
