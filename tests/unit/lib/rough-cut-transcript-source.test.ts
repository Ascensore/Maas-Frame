import { describe, expect, it } from 'vitest';
import {
  assessTranscriptQuality,
  decideTranscriptSource,
  parseTranscriptRowStatus,
  transcriptFallbackWarning,
  transcriptRequiredError,
  WAITING_FOR_TRANSCRIPT_WARNING,
  waitingForTranscriptWarning,
  WEAK_TRANSCRIPT_WARNING,
  weakTranscriptWarning,
  type TranscriptRow,
  type TranscriptSegmentRow,
} from '@/lib/rough-cut/transcript-source';

const NOW = new Date('2026-09-04T12:00:00.000Z');
const ONE_MINUTE_AGO = new Date(NOW.getTime() - 60_000);
// The wait limit is fifteen minutes; written out so the test pins the policy.
const AT_THE_LIMIT = new Date(NOW.getTime() - 15 * 60 * 1000);
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

  it('waits past fifteen minutes when a longer limit is given', () => {
    const decision = decideTranscriptSource({
      rows: [row({ id: 't1', versionId: 'v1', status: 'RUNNING' })],
      candidateVersionIds: ['v1'],
      roughCutCreatedAt: new Date(NOW.getTime() - 20 * 60_000),
      now: NOW,
      waitLimitSeconds: 2 * 60 * 60,
    });

    expect(decision).toEqual({ kind: 'wait', transcriptId: 't1', versionId: 'v1' });
  });

  it('stops waiting once the run reaches the limit', () => {
    const decision = decideTranscriptSource({
      rows: [row({ id: 't-wide', versionId: WIDE, status: 'PENDING' })],
      candidateVersionIds: [WIDE],
      roughCutCreatedAt: AT_THE_LIMIT,
      now: NOW,
    });

    expect(decision).toEqual({ kind: 'fallback', reason: 'timed-out', versionId: WIDE });
  });

  it('treats an unreadable creation time as past the limit', () => {
    const decision = decideTranscriptSource({
      rows: [row({ id: 't-wide', versionId: WIDE, status: 'PENDING' })],
      candidateVersionIds: [WIDE],
      roughCutCreatedAt: 'not-a-date',
      now: NOW,
    });

    expect(decision).toEqual({ kind: 'fallback', reason: 'timed-out', versionId: WIDE });
  });

  it('reports a transcript that timed out ahead of one that failed', () => {
    const decision = decideTranscriptSource({
      rows: [
        row({ id: 't-en', versionId: WIDE, status: 'FAILED' }),
        row({ id: 't-it', versionId: WIDE, status: 'RUNNING' }),
      ],
      candidateVersionIds: [WIDE],
      roughCutCreatedAt: AT_THE_LIMIT,
      now: NOW,
    });

    expect(decision).toEqual({ kind: 'fallback', reason: 'timed-out', versionId: WIDE });
  });

  it('reports failed and missing transcripts separately and ignores other versions', () => {
    expect(
      decideTranscriptSource({
        rows: [row({ id: 't-wide', versionId: WIDE, status: 'FAILED' })],
        candidateVersionIds: [WIDE],
        roughCutCreatedAt: ONE_MINUTE_AGO,
        now: NOW,
      })
    ).toEqual({ kind: 'fallback', reason: 'failed', versionId: WIDE });
    expect(
      decideTranscriptSource({
        rows: [],
        candidateVersionIds: [WIDE],
        roughCutCreatedAt: ONE_MINUTE_AGO,
        now: NOW,
      })
    ).toEqual({ kind: 'fallback', reason: 'missing', versionId: null });
    expect(
      decideTranscriptSource({
        rows: [row({ id: 't-other', versionId: 'ver-other', status: 'READY' })],
        candidateVersionIds: [WIDE],
        roughCutCreatedAt: ONE_MINUTE_AGO,
        now: NOW,
      })
    ).toEqual({ kind: 'fallback', reason: 'missing', versionId: null });
  });

  it('names the candidate whose row failed, not the first candidate', () => {
    // The wide camera has no row at all; the failure is Cam A's, and only
    // Cam A's name helps the operator.
    const decision = decideTranscriptSource({
      rows: [row({ id: 't-a', versionId: CAM_A, status: 'FAILED' })],
      candidateVersionIds: [WIDE, CAM_A],
      roughCutCreatedAt: ONE_MINUTE_AGO,
      now: NOW,
    });

    expect(decision).toEqual({ kind: 'fallback', reason: 'failed', versionId: CAM_A });
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
    expect(transcriptFallbackWarning('empty').message).toContain('has no spoken segments');
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

describe('transcriptRequiredError', () => {
  it('tells the operator what to do for each reason', () => {
    expect(transcriptRequiredError('failed', 'Cam A')).toBe(
      'Transcription failed for Cam A; re-run or upload its transcript, then generate the cut again'
    );
    expect(transcriptRequiredError('timed-out', 'Cam A', 7200)).toBe(
      'The transcript for Cam A was still not ready after 2 hours; check the media worker, then generate the cut again'
    );
    expect(transcriptRequiredError('timed-out', 'Cam A', 3600)).toBe(
      'The transcript for Cam A was still not ready after 1 hour; check the media worker, then generate the cut again'
    );
    expect(transcriptRequiredError('missing', null)).toBe(
      'No transcript exists; transcribe the clip, then generate the cut again'
    );
    expect(transcriptRequiredError('empty', 'Cam A')).toBe(
      'The transcript for Cam A has no spoken words; check the audio or upload a transcript, then generate the cut again'
    );
  });
});

describe('parseTranscriptRowStatus', () => {
  it('accepts the four statuses and nothing else', () => {
    expect(parseTranscriptRowStatus('PENDING')).toBe('PENDING');
    expect(parseTranscriptRowStatus('RUNNING')).toBe('RUNNING');
    expect(parseTranscriptRowStatus('READY')).toBe('READY');
    expect(parseTranscriptRowStatus('FAILED')).toBe('FAILED');
    expect(parseTranscriptRowStatus('ready')).toBeNull();
    expect(parseTranscriptRowStatus(null)).toBeNull();
  });
});
