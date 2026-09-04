import { describe, expect, it } from 'vitest';
import {
  applySequentialOffsets,
  guessRoughCutLayout,
  naturalCompare,
  parseRecordedAtMs,
  parseRoughCutLayout,
  sortClipsChronologically,
  type LayoutGuessClip,
} from '@/lib/rough-cut/layout';
import type { CameraClip } from '@/lib/rough-cut/types';

function clip(
  overrides: Partial<LayoutGuessClip> & Pick<LayoutGuessClip, 'id' | 'title'>
): LayoutGuessClip {
  return {
    position: 0,
    durationSeconds: 60,
    startTimecode: null,
    recordedAt: null,
    createdAt: null,
    metadata: {},
    ...overrides,
  };
}

describe('parseRoughCutLayout', () => {
  it('accepts the three layout names and nothing else', () => {
    expect(parseRoughCutLayout('MULTICAM')).toBe('MULTICAM');
    expect(parseRoughCutLayout('sequential')).toBe('SEQUENTIAL');
    expect(parseRoughCutLayout(' LINEAR ')).toBe('LINEAR');
    expect(parseRoughCutLayout('stacked')).toBeNull();
    expect(parseRoughCutLayout(1)).toBeNull();
    expect(parseRoughCutLayout(null)).toBeNull();
  });
});

describe('naturalCompare', () => {
  it('orders numbered filenames the way a camera roll is numbered', () => {
    expect(naturalCompare('Clip_2', 'Clip_10')).toBeLessThan(0);
    expect(naturalCompare('A001_C001', 'A001_C002')).toBeLessThan(0);
  });
});

describe('sortClipsChronologically', () => {
  it('orders by start timecode even when folder position is reversed', () => {
    const ordered = sortClipsChronologically([
      clip({ id: 'late', title: 'B', position: 0, startTimecode: '01:00:10:00' }),
      clip({ id: 'early', title: 'A', position: 1, startTimecode: '01:00:00:00' }),
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual(['early', 'late']);
  });

  it('orders by recorded-at metadata when timecode is missing', () => {
    const ordered = sortClipsChronologically([
      clip({
        id: 'second',
        title: 'Take B',
        recordedAt: '2026-01-01T10:05:00.000Z',
      }),
      clip({
        id: 'first',
        title: 'Take A',
        metadata: { creation_time: '2026-01-01T10:00:00.000Z' },
      }),
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual(['first', 'second']);
  });

  it('falls back to numbered filenames', () => {
    const ordered = sortClipsChronologically([
      clip({ id: 'b', title: 'Clip_002', position: 0 }),
      clip({ id: 'a', title: 'Clip_001', position: 1 }),
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual(['a', 'b']);
  });
});

describe('guessRoughCutLayout', () => {
  it('guesses LINEAR for a single clip', () => {
    const guess = guessRoughCutLayout([clip({ id: 'only', title: 'Interview' })]);
    expect(guess.layout).toBe('LINEAR');
    expect(guess.reason).toBe('single-clip');
    expect(guess.orderedIds).toEqual(['only']);
  });

  it('does not treat an empty folder as a single clip', () => {
    const guess = guessRoughCutLayout([]);
    expect(guess.layout).toBe('MULTICAM');
    expect(guess.reason).toBe('default-multicam');
    expect(guess.orderedIds).toEqual([]);
  });

  it('guesses MULTICAM when start timecodes overlap', () => {
    const guess = guessRoughCutLayout([
      clip({
        id: 'a',
        title: 'Cam A',
        startTimecode: '01:00:00:00',
        durationSeconds: 60,
        metadata: { camera: 'A' },
      }),
      clip({
        id: 'b',
        title: 'Cam B',
        startTimecode: '01:00:10:00',
        durationSeconds: 60,
        metadata: { camera: 'B' },
      }),
    ]);
    expect(guess.layout).toBe('MULTICAM');
    expect(guess.reason).toBe('overlapping-timecode');
  });

  it('guesses SEQUENTIAL when start timecodes do not overlap', () => {
    const guess = guessRoughCutLayout([
      clip({
        id: 'b',
        title: 'Take 2',
        position: 0,
        startTimecode: '01:02:00:00',
        durationSeconds: 30,
      }),
      clip({
        id: 'a',
        title: 'Take 1',
        position: 1,
        startTimecode: '01:00:00:00',
        durationSeconds: 60,
      }),
    ]);
    expect(guess.layout).toBe('SEQUENTIAL');
    expect(guess.reason).toBe('sequential-timecode');
    expect(guess.orderedIds).toEqual(['a', 'b']);
  });

  it('guesses MULTICAM from distinct camera metadata even with numbered names', () => {
    const guess = guessRoughCutLayout([
      clip({ id: 'a', title: 'Clip_001', metadata: { camera: 'A' } }),
      clip({ id: 'b', title: 'Clip_002', metadata: { camera: 'B' } }),
    ]);
    expect(guess.layout).toBe('MULTICAM');
    expect(guess.reason).toBe('distinct-camera-metadata');
  });

  it('guesses SEQUENTIAL from incrementing filenames when roles match', () => {
    const guess = guessRoughCutLayout([
      clip({ id: 'b', title: 'Clip_002', position: 0 }),
      clip({ id: 'a', title: 'Clip_001', position: 1 }),
    ]);
    expect(guess.layout).toBe('SEQUENTIAL');
    expect(guess.reason).toBe('sequential-filenames');
    expect(guess.orderedIds).toEqual(['a', 'b']);
  });

  it('guesses MULTICAM from Cam A / Cam B filenames', () => {
    const guess = guessRoughCutLayout([
      clip({ id: 'a', title: 'Cam A' }),
      clip({ id: 'b', title: 'Cam B' }),
    ]);
    expect(guess.layout).toBe('MULTICAM');
    expect(guess.reason).toBe('distinct-camera-roles');
  });
});

describe('applySequentialOffsets', () => {
  it('places each clip after the previous one ends', () => {
    const clips: CameraClip[] = [
      {
        videoId: 'a',
        versionId: 'va',
        title: 'A',
        role: 'CAM',
        position: 0,
        offsetSeconds: 99,
        durationSeconds: 10,
        frameRateNum: 24,
        frameRateDen: 1,
        dropFrame: false,
        startTimecode: null,
        originalUrl: '/a.mp4',
        versionNumber: 1,
        versionLabel: null,
      },
      {
        videoId: 'b',
        versionId: 'vb',
        title: 'B',
        role: 'CAM',
        position: 1,
        offsetSeconds: 99,
        durationSeconds: 5,
        frameRateNum: 24,
        frameRateDen: 1,
        dropFrame: false,
        startTimecode: null,
        originalUrl: '/b.mp4',
        versionNumber: 1,
        versionLabel: null,
      },
    ];
    const sequenced = applySequentialOffsets(clips);
    expect(sequenced.map((entry) => entry.offsetSeconds)).toEqual([0, 10]);
  });
});

describe('parseRecordedAtMs', () => {
  it('parses ffmpeg creation_time and rejects junk', () => {
    expect(parseRecordedAtMs('2026-01-15T10:22:03.000000Z')).toBe(
      Date.parse('2026-01-15T10:22:03.000Z')
    );
    expect(parseRecordedAtMs('2026-01-15 10:22:03')).toBe(Date.parse('2026-01-15T10:22:03'));
    expect(parseRecordedAtMs('not-a-date')).toBeNull();
    expect(parseRecordedAtMs('')).toBeNull();
  });
});
