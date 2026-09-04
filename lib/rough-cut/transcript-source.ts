import type { AttributedTurn, RoughCutWarning } from './types';

/**
 * How the assembler gets speech from the transcript that already exists per
 * version, and what it does while that transcript is still being written.
 *
 * Everything here is pure so the media worker can import it (the worker image
 * copies lib/rough-cut wholesale) and so the rules are testable without a
 * database or a wav file.
 */

/** A run waits this long, from its creation, for a transcript before it falls back to VAD. */
export const TRANSCRIPT_WAIT_LIMIT_SECONDS = 15 * 60;

/** Delay before a waiting assemble job is looked at again. */
export const TRANSCRIPT_RETRY_DELAY_SECONDS = 60;

/**
 * Pauses up to this long stay in the program; longer ones are cut. This is the
 * "medium" inside-a-beat value from the editorial brief design and becomes
 * brief-driven once briefs exist.
 */
export const TRANSCRIPT_MAX_KEPT_GAP_SECONDS = 0.8;

/** Words per second over speech time, outside which the transcript is suspect. */
export const TRANSCRIPT_MIN_WORDS_PER_SECOND = 0.5;
export const TRANSCRIPT_MAX_WORDS_PER_SECOND = 6;

/** Share of segments with no text above which the transcript is suspect. */
export const TRANSCRIPT_MAX_EMPTY_SEGMENT_SHARE = 0.2;

export const WAITING_FOR_TRANSCRIPT_WARNING = 'waiting-for-transcript';
export const WEAK_TRANSCRIPT_WARNING = 'weak-transcript';

const EPSILON = 1e-6;

export const TRANSCRIPT_ROW_STATUSES = ['PENDING', 'RUNNING', 'READY', 'FAILED'] as const;
export type TranscriptRowStatus = (typeof TRANSCRIPT_ROW_STATUSES)[number];

export type TranscriptRow = {
  id: string;
  versionId: string;
  status: TranscriptRowStatus;
  createdAt: Date | string;
};

export type TranscriptSegmentRow = {
  startSec: number;
  endSec: number;
  speaker: string | null;
  text: string;
  words: unknown;
};

export type TranscriptFallbackReason = 'missing' | 'failed' | 'timed-out' | 'empty';

export type TranscriptSourceDecision =
  | { kind: 'use'; transcriptId: string; versionId: string }
  | { kind: 'wait'; transcriptId: string; versionId: string }
  | { kind: 'fallback'; reason: Exclude<TranscriptFallbackReason, 'empty'> };

export function parseTranscriptRowStatus(value: unknown): TranscriptRowStatus | null {
  return TRANSCRIPT_ROW_STATUSES.includes(value as TranscriptRowStatus)
    ? (value as TranscriptRowStatus)
    : null;
}

function timeMs(value: Date | string): number {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : Number.NaN;
}

function isInProgress(status: TranscriptRowStatus): boolean {
  return status === 'PENDING' || status === 'RUNNING';
}

/**
 * Pick the transcript a run should read, in candidate order (the wide camera
 * first for multicam; a single clip for linear layouts).
 *
 * - The first candidate with a READY transcript wins. Among several READY rows
 *   for one version (one per language) the oldest is the original.
 * - With nothing READY, an in-progress transcript is worth waiting for while
 *   the run is younger than the wait limit. The worker that runs this job is
 *   the worker that will finish the transcript, so a long queue is not a
 *   reason to give up early; a stuck job is caught by the limit.
 * - Otherwise fall back, saying why, so the warning can be specific.
 */
export function decideTranscriptSource(options: {
  rows: TranscriptRow[];
  candidateVersionIds: string[];
  roughCutCreatedAt: Date | string;
  now: Date;
}): TranscriptSourceDecision {
  const byVersion = new Map<string, TranscriptRow[]>();
  for (const row of options.rows) {
    const list = byVersion.get(row.versionId) ?? [];
    list.push(row);
    byVersion.set(row.versionId, list);
  }

  for (const versionId of options.candidateVersionIds) {
    const ready = (byVersion.get(versionId) ?? [])
      .filter((row) => row.status === 'READY')
      .sort((a, b) => timeMs(a.createdAt) - timeMs(b.createdAt));
    const first = ready[0];
    if (first) return { kind: 'use', transcriptId: first.id, versionId };
  }

  const createdMs = timeMs(options.roughCutCreatedAt);
  const ageSeconds = Number.isFinite(createdMs)
    ? (options.now.getTime() - createdMs) / 1000
    : Number.POSITIVE_INFINITY;
  const canWait = ageSeconds < TRANSCRIPT_WAIT_LIMIT_SECONDS;

  let sawInProgress = false;
  let sawFailed = false;
  for (const versionId of options.candidateVersionIds) {
    for (const row of byVersion.get(versionId) ?? []) {
      if (isInProgress(row.status)) {
        if (canWait) return { kind: 'wait', transcriptId: row.id, versionId };
        sawInProgress = true;
      } else if (row.status === 'FAILED') {
        sawFailed = true;
      }
    }
  }

  if (sawInProgress) return { kind: 'fallback', reason: 'timed-out' };
  if (sawFailed) return { kind: 'fallback', reason: 'failed' };
  return { kind: 'fallback', reason: 'missing' };
}

function wordCount(segment: TranscriptSegmentRow): number {
  if (Array.isArray(segment.words) && segment.words.length > 0) return segment.words.length;
  return segment.text
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0).length;
}

function hasText(segment: TranscriptSegmentRow): boolean {
  return segment.text.trim().length > 0;
}

/**
 * Turn transcript segments into speech turns the decision functions accept.
 *
 * Segments are file-local; `offsetSeconds` moves them onto the timeline (0
 * for linear layouts, the sync offset for multicam). Pauses no longer than
 * `maxGapSeconds` are absorbed so the program keeps natural breathing room;
 * a speaker change is never absorbed, so camera attribution can switch there.
 */
export function turnsFromTranscriptSegments(
  segments: TranscriptSegmentRow[],
  options: {
    versionId: string;
    offsetSeconds: number;
    durationSeconds: number;
    maxGapSeconds: number;
  }
): AttributedTurn[] {
  const clampEnd = options.durationSeconds > EPSILON ? options.durationSeconds : null;
  const usable = segments
    .filter(hasText)
    .map((segment) => {
      const start = Math.max(0, segment.startSec);
      const end = clampEnd === null ? segment.endSec : Math.min(clampEnd, segment.endSec);
      return { start, end, speaker: segment.speaker };
    })
    .filter((segment) => segment.end - segment.start > EPSILON)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged: Array<{ start: number; end: number; speaker: string | null }> = [];
  for (const segment of usable) {
    const last = merged[merged.length - 1];
    const sameSpeaker =
      !last ||
      last.speaker === null ||
      segment.speaker === null ||
      last.speaker === segment.speaker;
    if (last && sameSpeaker && segment.start - last.end <= options.maxGapSeconds + EPSILON) {
      last.end = Math.max(last.end, segment.end);
      if (last.speaker === null) last.speaker = segment.speaker;
      continue;
    }
    merged.push({ ...segment });
  }

  return merged.map((segment) => ({
    start: segment.start + options.offsetSeconds,
    end: segment.end + options.offsetSeconds,
    versionId: options.versionId,
    speaker: segment.speaker,
    confidence: 1,
  }));
}

export type TranscriptQualityReason = 'no-speech' | 'speech-rate' | 'empty-segments';

export type TranscriptQuality = {
  weak: boolean;
  reasons: TranscriptQualityReason[];
  wordsPerSecond: number | null;
  emptySegmentShare: number;
};

/**
 * Providers do not hand back a confidence we store, so "weak" is judged on
 * what the rows do carry: a speech rate no human produces, or a transcript
 * that is mostly empty segments. Speech rate is measured over speech time,
 * not file time, so a long recording with little talking is not penalised.
 */
export function assessTranscriptQuality(segments: TranscriptSegmentRow[]): TranscriptQuality {
  if (segments.length === 0) {
    return { weak: true, reasons: ['no-speech'], wordsPerSecond: null, emptySegmentShare: 0 };
  }

  let speechSeconds = 0;
  let words = 0;
  let empty = 0;
  for (const segment of segments) {
    if (!hasText(segment)) {
      empty += 1;
      continue;
    }
    speechSeconds += Math.max(0, segment.endSec - segment.startSec);
    words += wordCount(segment);
  }

  const reasons: TranscriptQualityReason[] = [];
  const wordsPerSecond = speechSeconds > EPSILON ? words / speechSeconds : null;
  if (
    wordsPerSecond !== null &&
    (wordsPerSecond < TRANSCRIPT_MIN_WORDS_PER_SECOND ||
      wordsPerSecond > TRANSCRIPT_MAX_WORDS_PER_SECOND)
  ) {
    reasons.push('speech-rate');
  }
  const emptySegmentShare = empty / segments.length;
  if (emptySegmentShare > TRANSCRIPT_MAX_EMPTY_SEGMENT_SHARE) {
    reasons.push('empty-segments');
  }

  return { weak: reasons.length > 0, reasons, wordsPerSecond, emptySegmentShare };
}

function clipLabel(clipTitle: string | null | undefined): string {
  return clipTitle && clipTitle.trim() ? ` for ${clipTitle.trim()}` : '';
}

export function waitingForTranscriptWarning(clipTitles: string[]): RoughCutWarning {
  const named = clipTitles.filter((title) => title.trim().length > 0);
  const subject =
    named.length === 0
      ? 'the transcript'
      : named.length === 1
        ? `the transcript for ${named[0]}`
        : `transcripts for ${named.join(', ')}`;
  return {
    code: WAITING_FOR_TRANSCRIPT_WARNING,
    message: `Waiting for ${subject} before assembling; the cut will continue automatically`,
  };
}

export function transcriptFallbackWarning(
  reason: TranscriptFallbackReason,
  clipTitle?: string | null
): RoughCutWarning {
  const label = clipLabel(clipTitle);
  const cause =
    reason === 'failed'
      ? `Transcription failed${label}`
      : reason === 'timed-out'
        ? `The transcript${label} was still running after ${Math.round(
            TRANSCRIPT_WAIT_LIMIT_SECONDS / 60
          )} minutes`
        : reason === 'empty'
          ? `The transcript${label} has no segments`
          : `No transcript exists${label}`;
  return {
    code: WEAK_TRANSCRIPT_WARNING,
    message: `${cause}; speech was detected from audio energy instead — review the cuts carefully`,
  };
}

export function weakTranscriptWarning(
  quality: TranscriptQuality,
  clipTitle?: string | null
): RoughCutWarning {
  const label = clipLabel(clipTitle);
  const details = quality.reasons.map((reason) => {
    if (reason === 'speech-rate') {
      const rate = quality.wordsPerSecond === null ? '?' : quality.wordsPerSecond.toFixed(1);
      return `an implausible speech rate (${rate} words/s)`;
    }
    if (reason === 'empty-segments') {
      return `${Math.round(quality.emptySegmentShare * 100)}% empty segments`;
    }
    return 'no speech';
  });
  return {
    code: WEAK_TRANSCRIPT_WARNING,
    message: `The transcript${label} looks weak (${details.join(', ')}); review the cuts carefully`,
  };
}
