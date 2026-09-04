import { describe, expect, it } from 'vitest';
import {
  assessTranscriptQuality,
  decideTranscriptSource,
  parseTranscriptRowStatus,
  transcriptFallbackWarning,
  TRANSCRIPT_WAIT_LIMIT_SECONDS,
  turnsFromTranscriptSegments,
  WAITING_FOR_TRANSCRIPT_WARNING,
  waitingForTranscriptWarning,
  WEAK_TRANSCRIPT_WARNING,
  weakTranscriptWarning,
  type TranscriptRow,
  type TranscriptSegmentRow,
} from '@/lib/rough-cut/transcript-source';

const NOW = new Date('2026-09-04T12:00:00.000Z');
const ONE_MINUTE_AGO = new Date(NOW.getTime() - 60_000);
const AT_THE_LIMIT = new Date(NOW.getTime() - TRANSCRIPT_WAIT_LIMIT_SECONDS * 1000);
const JUST_INSIDE_THE_LIMIT = new Date(AT_THE_LIMIT.getTime() + 1000);

const WIDE = 'ver-wide';
const CAM_A = 'ver-a';

function row(
  overrides: Partial<TranscriptRow> & Pick<TranscriptRow, 'id' | 'versionId' | 'status'>
): TranscriptRow {
  return { createdAt: '2026-09-04T11:00:00.000Z', ...overrides };
}

function segment(
  startSec: number,
  endSec: number,
  text: string,
  overrides: Partial<TranscriptSegmentRow> = {}
): TranscriptSegmentRow {
  return { startSec, endSec, speaker: null, text, words: [], ...overrides };
}

function words(count: number): string {
  return Array.from({ length: count }, (_, index) => `w${index}`).join(' ');
}

describe('decideTranscriptSource', () => {
  it('reads the first candidate that has a READY transcript', () => {
    const rows = [
      row({ id: 't-wide', versionId: WIDE, status: 'READY' }),
      row({ id: 't-a', versionId: CAM_A, status: 'READY' }),
    ];

    expect(
      decideTranscriptSource({
        rows,
        candidateVersionIds: [WIDE, CAM_A],
        roughCutCreatedAt: ONE_MINUTE_AGO,
        now: NOW,
      })
    ).toEqual({ kind: 'use', transcriptId: 't-wide', versionId: WIDE });
    expect(
      decideTranscriptSource({
        rows,
        candidateVersionIds: [CAM_A, WIDE],
        roughCutCreatedAt: ONE_MINUTE_AGO,
        now: NOW,
      })
    ).toEqual({ kind: 'use', transcriptId: 't-a', versionId: CAM_A });
  });

  it('falls through to a later candidate instead of waiting on the first', () => {
    const decision = decideTranscriptSource({
      rows: [
        row({ id: 't-wide', versionId: WIDE, status: 'PENDING' }),
        row({ id: 't-a', versionId: CAM_A, status: 'READY' }),
      ],
      candidateVersionIds: [WIDE, CAM_A],
      roughCutCreatedAt: ONE_MINUTE_AGO,
      now: NOW,
    });

    expect(decision).toEqual({ kind: 'use', transcriptId: 't-a', versionId: CAM_A });
  });

  it('prefers the oldest READY transcript of a version, which is the original language', () => {
    const decision = decideTranscriptSource({
      rows: [
        row({
          id: 't-en',
          versionId: WIDE,
          status: 'READY',
          createdAt: '2026-09-04T11:30:00.000Z',
        }),
        row({
          id: 't-it',
          versionId: WIDE,
          status: 'READY',
          createdAt: new Date('2026-09-04T11:00:00.000Z'),
        }),
      ],
      candidateVersionIds: [WIDE],
      roughCutCreatedAt: ONE_MINUTE_AGO,
      now: NOW,
    });

    expect(decision).toEqual({ kind: 'use', transcriptId: 't-it', versionId: WIDE });
  });

  it('waits for an in-progress transcript while the run is younger than the limit', () => {
    const rows = [row({ id: 't-wide', versionId: WIDE, status: 'RUNNING' })];

    expect(
      decideTranscriptSource({
        rows,
        candidateVersionIds: [WIDE],
        roughCutCreatedAt: ONE_MINUTE_AGO,
        now: NOW,
      })
    ).toEqual({ kind: 'wait', transcriptId: 't-wide', versionId: WIDE });
    expect(
      decideTranscriptSource({
        rows,
        candidateVersionIds: [WIDE],
        roughCutCreatedAt: JUST_INSIDE_THE_LIMIT,
        now: NOW,
      })
    ).toEqual({ kind: 'wait', transcriptId: 't-wide', versionId: WIDE });
  });

  it('stops waiting once the run reaches the limit', () => {
    const decision = decideTranscriptSource({
      rows: [row({ id: 't-wide', versionId: WIDE, status: 'PENDING' })],
      candidateVersionIds: [WIDE],
      roughCutCreatedAt: AT_THE_LIMIT,
      now: NOW,
    });

    expect(decision).toEqual({ kind: 'fallback', reason: 'timed-out' });
  });

  it('treats an unreadable creation time as past the limit', () => {
    const decision = decideTranscriptSource({
      rows: [row({ id: 't-wide', versionId: WIDE, status: 'PENDING' })],
      candidateVersionIds: [WIDE],
      roughCutCreatedAt: 'not-a-date',
      now: NOW,
    });

    expect(decision).toEqual({ kind: 'fallback', reason: 'timed-out' });
  });

  it('reports failed and missing transcripts separately and ignores other versions', () => {
    expect(
      decideTranscriptSource({
        rows: [row({ id: 't-wide', versionId: WIDE, status: 'FAILED' })],
        candidateVersionIds: [WIDE],
        roughCutCreatedAt: ONE_MINUTE_AGO,
        now: NOW,
      })
    ).toEqual({ kind: 'fallback', reason: 'failed' });
    expect(
      decideTranscriptSource({
        rows: [],
        candidateVersionIds: [WIDE],
        roughCutCreatedAt: ONE_MINUTE_AGO,
        now: NOW,
      })
    ).toEqual({ kind: 'fallback', reason: 'missing' });
    expect(
      decideTranscriptSource({
        rows: [row({ id: 't-other', versionId: 'ver-other', status: 'READY' })],
        candidateVersionIds: [WIDE],
        roughCutCreatedAt: ONE_MINUTE_AGO,
        now: NOW,
      })
    ).toEqual({ kind: 'fallback', reason: 'missing' });
  });
});

describe('turnsFromTranscriptSegments', () => {
  const options = { versionId: CAM_A, offsetSeconds: 0, durationSeconds: 60, maxGapSeconds: 0.8 };

  it('absorbs pauses up to the gap and cuts at longer ones', () => {
    const turns = turnsFromTranscriptSegments(
      [segment(1, 4, 'first'), segment(4.8, 8, 'second'), segment(8.81, 12, 'third')],
      options
    );

    expect(turns).toEqual([
      { start: 1, end: 8, versionId: CAM_A, speaker: null, confidence: 1 },
      { start: 8.81, end: 12, versionId: CAM_A, speaker: null, confidence: 1 },
    ]);
  });

  it('never absorbs a speaker change, but lets unlabelled segments join', () => {
    const turns = turnsFromTranscriptSegments(
      [
        segment(1, 4, 'host', { speaker: 'SPEAKER_00' }),
        segment(4.2, 7, 'guest', { speaker: 'SPEAKER_01' }),
        segment(7.1, 9, 'unlabelled'),
      ],
      options
    );

    expect(turns).toEqual([
      { start: 1, end: 4, versionId: CAM_A, speaker: 'SPEAKER_00', confidence: 1 },
      { start: 4.2, end: 9, versionId: CAM_A, speaker: 'SPEAKER_01', confidence: 1 },
    ]);
  });

  it('shifts onto the timeline and clamps to the clip', () => {
    const turns = turnsFromTranscriptSegments(
      [segment(-1, 2, 'early'), segment(8, 12, 'late'), segment(10.5, 11, 'beyond')],
      { ...options, offsetSeconds: 3, durationSeconds: 10 }
    );

    expect(turns).toEqual([
      { start: 3, end: 5, versionId: CAM_A, speaker: null, confidence: 1 },
      { start: 11, end: 13, versionId: CAM_A, speaker: null, confidence: 1 },
    ]);
  });

  it('drops empty segments before merging and sorts unsorted input', () => {
    const turns = turnsFromTranscriptSegments(
      [segment(5, 6, 'later'), segment(0, 2, 'first'), segment(2.5, 3, '   ')],
      options
    );

    expect(turns).toEqual([
      { start: 0, end: 2, versionId: CAM_A, speaker: null, confidence: 1 },
      { start: 5, end: 6, versionId: CAM_A, speaker: null, confidence: 1 },
    ]);
  });

  it('leaves the end unclamped when the clip length is unknown', () => {
    const turns = turnsFromTranscriptSegments([segment(0, 50, 'long')], {
      ...options,
      durationSeconds: 0,
    });

    expect(turns).toEqual([{ start: 0, end: 50, versionId: CAM_A, speaker: null, confidence: 1 }]);
  });
});

describe('assessTranscriptQuality', () => {
  it('measures the speech rate over speech time, not file time', () => {
    const quality = assessTranscriptQuality([
      segment(0, 10, words(25)),
      segment(3600, 3610, words(25)),
    ]);

    expect(quality).toEqual({
      weak: false,
      reasons: [],
      wordsPerSecond: 2.5,
      emptySegmentShare: 0,
    });
  });

  it('flags an implausible speech rate and accepts the boundaries', () => {
    expect(assessTranscriptQuality([segment(0, 10, words(70))])).toMatchObject({
      weak: true,
      reasons: ['speech-rate'],
      wordsPerSecond: 7,
    });
    expect(assessTranscriptQuality([segment(0, 10, words(4))])).toMatchObject({
      weak: true,
      reasons: ['speech-rate'],
    });
    expect(assessTranscriptQuality([segment(0, 10, words(60))]).weak).toBe(false);
    expect(assessTranscriptQuality([segment(0, 10, words(5))]).weak).toBe(false);
  });

  it('flags mostly empty segments and accepts the boundary', () => {
    const spoken = [segment(0, 2, words(5)), segment(2, 4, words(5)), segment(4, 6, words(5))];

    expect(
      assessTranscriptQuality([...spoken, segment(6, 7, ''), segment(7, 8, ' ')])
    ).toMatchObject({ weak: true, reasons: ['empty-segments'], emptySegmentShare: 0.4 });
    expect(
      assessTranscriptQuality([...spoken, segment(6, 8, words(5)), segment(8, 9, '')])
    ).toMatchObject({ weak: false, emptySegmentShare: 0.2 });
  });

  it('counts words from the word timings when a segment has them', () => {
    const timed = Array.from({ length: 30 }, (_, index) => ({
      start: index / 3,
      end: (index + 1) / 3,
      text: `w${index}`,
    }));

    expect(assessTranscriptQuality([segment(0, 10, 'one two')]).weak).toBe(true);
    expect(assessTranscriptQuality([segment(0, 10, 'one two', { words: timed })])).toMatchObject({
      weak: false,
      wordsPerSecond: 3,
    });
  });

  it('has nothing to measure without segments', () => {
    expect(assessTranscriptQuality([])).toEqual({
      weak: true,
      reasons: ['no-speech'],
      wordsPerSecond: null,
      emptySegmentShare: 0,
    });
  });
});

describe('warnings', () => {
  it('names the clips a run is waiting on', () => {
    expect(waitingForTranscriptWarning([])).toEqual({
      code: WAITING_FOR_TRANSCRIPT_WARNING,
      message: expect.stringContaining('Waiting for the transcript'),
    });
    expect(waitingForTranscriptWarning(['Cam A']).message).toContain('the transcript for Cam A');
    expect(waitingForTranscriptWarning(['Cam A', 'Cam B']).message).toContain('Cam A, Cam B');
  });

  it('says why the transcript was not used', () => {
    expect(transcriptFallbackWarning('failed', 'Cam A')).toEqual({
      code: WEAK_TRANSCRIPT_WARNING,
      message: expect.stringContaining('Transcription failed for Cam A'),
    });
    expect(transcriptFallbackWarning('timed-out').message).toContain('15 minutes');
    expect(transcriptFallbackWarning('empty').message).toContain('has no segments');
    expect(transcriptFallbackWarning('missing').message).toContain('No transcript exists');
  });

  it('describes a weak transcript with its measurements', () => {
    const warning = weakTranscriptWarning(
      {
        weak: true,
        reasons: ['speech-rate', 'empty-segments'],
        wordsPerSecond: 7.25,
        emptySegmentShare: 0.4,
      },
      'Cam A'
    );

    expect(warning.code).toBe(WEAK_TRANSCRIPT_WARNING);
    expect(warning.message).toContain('for Cam A');
    expect(warning.message).toContain('7.3 words/s');
    expect(warning.message).toContain('40% empty segments');
  });
});

describe('parseTranscriptRowStatus', () => {
  it('accepts the four statuses and nothing else', () => {
    expect(parseTranscriptRowStatus('READY')).toBe('READY');
    expect(parseTranscriptRowStatus('RUNNING')).toBe('RUNNING');
    expect(parseTranscriptRowStatus('ready')).toBeNull();
    expect(parseTranscriptRowStatus(null)).toBeNull();
  });
});
