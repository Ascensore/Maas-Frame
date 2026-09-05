import type { SilencePolicy } from './brief';
import { contentTokens, endsSentence, excerpt, type TimedWord } from './text';
import type { TranscriptSegmentRow } from './transcript-source';
import type { CutReasonCode as ProgramCutReasonCode } from './types';

/**
 * The material model's speech layer: transcript words become kept speech
 * runs, dead-air cuts, and beats.
 *
 * A pause is judged by where it falls. After terminal punctuation it sits
 * between thoughts and may run to the policy's between-beats limit; anywhere
 * else it is a stall and gets the tighter inside-a-beat limit. A pause over
 * its limit is cut as DEAD_AIR. Only a pause over the between-beats limit,
 * or a speaker change, ends a beat, so a stall inside a sentence never
 * splits the beat that take selection later compares.
 */

export type SpeechRun = { start: number; end: number };

export type BeatWord = TimedWord & { speaker: string | null };

export type Beat = {
  versionId: string;
  /** Source-local, first word start to last word end. */
  start: number;
  end: number;
  speaker: string | null;
  words: BeatWord[];
  /** Kept speech inside the beat, source-local, after dead-air cuts. */
  runs: SpeechRun[];
};

/**
 * The codes the assembler itself can write. Derived from the program's list
 * rather than repeated, so a code added there cannot quietly diverge; REVIEWER
 * is excluded because only the reviewer's own cuts ever wear it.
 */
export type CutReasonCode = Exclude<ProgramCutReasonCode, 'REVIEWER'>;

/** A removed source range, before it is keyed and placed on a run. */
export type SourceCut = {
  versionId: string;
  start: number;
  end: number;
  code: CutReasonCode;
  summary: string;
  text: string | null;
};

export type SpeechAnalysis = {
  beats: Beat[];
  cuts: SourceCut[];
  runs: SpeechRun[];
};

const EPSILON = 1e-6;

/**
 * Flatten segments to timed words. A segment without word timings becomes
 * one word spanning it, so an uploaded transcript still works. Words are
 * clamped to the clip and sorted; blank ones are dropped.
 */
export function wordsFromSegments(
  segments: TranscriptSegmentRow[],
  durationSeconds: number
): BeatWord[] {
  const clampEnd = durationSeconds > EPSILON ? durationSeconds : Number.POSITIVE_INFINITY;
  const out: BeatWord[] = [];
  for (const segment of segments) {
    const speaker = segment.speaker && segment.speaker.trim() ? segment.speaker : null;
    const timed = Array.isArray(segment.words)
      ? (segment.words as Array<Partial<TimedWord>>).filter(
          (word): word is TimedWord =>
            typeof word.start === 'number' &&
            Number.isFinite(word.start) &&
            typeof word.end === 'number' &&
            Number.isFinite(word.end) &&
            typeof word.text === 'string'
        )
      : [];
    const source: TimedWord[] =
      timed.length > 0
        ? timed
        : [{ start: segment.startSec, end: segment.endSec, text: segment.text }];
    for (const word of source) {
      if (!word.text.trim()) continue;
      const start = Math.max(0, Math.min(clampEnd, word.start));
      const end = Math.max(start, Math.min(clampEnd, word.end));
      if (start >= clampEnd) continue;
      out.push({ start, end, text: word.text, speaker });
    }
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

function deadAir(
  versionId: string,
  start: number,
  end: number,
  where: 'between thoughts' | 'mid-sentence' | 'before the first word' | 'after the last word'
): SourceCut {
  return {
    versionId,
    start,
    end,
    code: 'DEAD_AIR',
    summary: `${(end - start).toFixed(1)}s of dead air ${where}`,
    text: null,
  };
}

export function analyseSpeech(
  segments: TranscriptSegmentRow[],
  options: { versionId: string; durationSeconds: number; policy: SilencePolicy }
): SpeechAnalysis {
  const { versionId, policy } = options;
  const words = wordsFromSegments(segments, options.durationSeconds);
  const beats: Beat[] = [];
  const cuts: SourceCut[] = [];
  if (words.length === 0) return { beats, cuts, runs: [] };

  const first = words[0]!;
  if (first.start > policy.maxKeptGapBetweenBeatsSeconds + EPSILON) {
    cuts.push(deadAir(versionId, 0, first.start, 'before the first word'));
  }

  let beat: Beat = {
    versionId,
    start: first.start,
    end: first.end,
    speaker: first.speaker,
    words: [first],
    runs: [{ start: first.start, end: first.end }],
  };
  const closeBeat = () => {
    beats.push(beat);
  };

  for (let index = 1; index < words.length; index += 1) {
    const previous = words[index - 1]!;
    const word = words[index]!;
    const pause = word.start - previous.end;
    const speakerChange =
      previous.speaker !== null && word.speaker !== null && previous.speaker !== word.speaker;
    const afterTerminal = endsSentence(previous.text);
    const limit = afterTerminal
      ? policy.maxKeptGapBetweenBeatsSeconds
      : policy.maxKeptGapInsideBeatSeconds;
    const cut = pause > limit + EPSILON;
    const endsBeat = speakerChange || pause > policy.maxKeptGapBetweenBeatsSeconds + EPSILON;

    if (cut) {
      cuts.push(
        deadAir(versionId, previous.end, word.start, endsBeat ? 'between thoughts' : 'mid-sentence')
      );
    }

    if (endsBeat) {
      closeBeat();
      beat = {
        versionId,
        start: word.start,
        end: word.end,
        speaker: word.speaker,
        words: [word],
        runs: [{ start: word.start, end: word.end }],
      };
      continue;
    }

    beat.words.push(word);
    beat.end = Math.max(beat.end, word.end);
    if (beat.speaker === null) beat.speaker = word.speaker;
    const run = beat.runs[beat.runs.length - 1]!;
    if (cut) {
      beat.runs.push({ start: word.start, end: word.end });
    } else {
      run.end = Math.max(run.end, word.end);
    }
  }
  closeBeat();

  const last = words[words.length - 1]!;
  if (
    Number.isFinite(options.durationSeconds) &&
    options.durationSeconds - last.end > policy.maxKeptGapBetweenBeatsSeconds + EPSILON
  ) {
    cuts.push(deadAir(versionId, last.end, options.durationSeconds, 'after the last word'));
  }

  return { beats, cuts, runs: beats.flatMap((entry) => entry.runs) };
}

export function beatText(beat: Beat): string {
  return beat.words.map((word) => word.text.trim()).join(' ');
}

export function beatDuration(beat: Beat): number {
  return Math.max(0, beat.end - beat.start);
}

const FALSE_START_MAX_SECONDS = 4;
const FALSE_START_MIN_WORDS = 3;

/**
 * A short beat whose opening words are the opening of the next surviving
 * beat is a false start: the speaker stopped and began again. Compared
 * against the next survivor so a chain of restarts collapses to the final
 * take. Only beats on the same clip and by the same speaker compare.
 */
export function detectFalseStarts(
  beats: Beat[],
  fillers: ReadonlySet<string>
): { beats: Beat[]; cuts: SourceCut[] } {
  const keep: boolean[] = beats.map(() => true);
  const cuts: SourceCut[] = [];
  let nextSurvivor: Beat | null = null;
  for (let index = beats.length - 1; index >= 0; index -= 1) {
    const beat: Beat = beats[index]!;
    const next: Beat | null = nextSurvivor;
    nextSurvivor = beat;
    if (!next) continue;
    if (next.versionId !== beat.versionId) continue;
    if (beat.speaker !== null && next.speaker !== null && beat.speaker !== next.speaker) continue;
    if (beatDuration(beat) >= FALSE_START_MAX_SECONDS) continue;
    const opening = contentTokens(
      beat.words.map((word) => word.text),
      fillers
    );
    if (opening.length < FALSE_START_MIN_WORDS) continue;
    const retake = contentTokens(
      next.words.map((word) => word.text),
      fillers
    );
    if (retake.length <= opening.length) continue;
    const isPrefix = opening.every((token, position) => retake[position] === token);
    if (!isPrefix) continue;
    keep[index] = false;
    nextSurvivor = next;
    cuts.push({
      versionId: beat.versionId,
      start: beat.start,
      end: beat.end,
      code: 'FALSE_START',
      summary: `False start of “${excerpt(beatText(next), 60)}”`,
      text: excerpt(beatText(beat)),
    });
  }
  return { beats: beats.filter((_, index) => keep[index]), cuts: cuts.reverse() };
}

export type WordSpan = { wordStart: number; wordEnd: number };

/**
 * Remove word spans (index ranges, end exclusive) from a beat: the words go,
 * the kept runs are cut around the removed time ranges, and the beat's
 * extent shrinks to the words that remain. Each surviving run is clamped to
 * the words still inside it, so the program stops on the last kept word
 * rather than running into the removed span's silence. Null when nothing
 * remains.
 */
export function cutWordsFromBeat(
  beat: Beat,
  spans: WordSpan[]
): { beat: Beat | null; removed: Array<{ start: number; end: number; text: string }> } {
  const drop = new Set<number>();
  const removed: Array<{ start: number; end: number; text: string }> = [];
  for (const span of spans) {
    const first = Math.max(0, span.wordStart);
    const last = Math.min(beat.words.length, span.wordEnd);
    if (last <= first) continue;
    for (let index = first; index < last; index += 1) drop.add(index);
    const words = beat.words.slice(first, last);
    removed.push({
      start: words[0]!.start,
      end: words[words.length - 1]!.end,
      text: words.map((word) => word.text.trim()).join(' '),
    });
  }
  const words = beat.words.filter((_, index) => !drop.has(index));
  if (words.length === 0) return { beat: null, removed };
  let runs = beat.runs.map((run) => ({ ...run }));
  for (const range of [...removed].sort((a, b) => a.start - b.start)) {
    const next: SpeechRun[] = [];
    for (const run of runs) {
      if (range.end <= run.start + EPSILON || range.start >= run.end - EPSILON) {
        next.push(run);
        continue;
      }
      if (range.start > run.start + EPSILON) next.push({ start: run.start, end: range.start });
      if (range.end < run.end - EPSILON) next.push({ start: range.end, end: run.end });
    }
    runs = next;
  }
  const kept: SpeechRun[] = [];
  for (const run of runs) {
    const inside = words.filter(
      (word) => word.end > run.start + EPSILON && word.start < run.end - EPSILON
    );
    if (inside.length === 0) continue;
    const start = Math.max(run.start, inside[0]!.start);
    const end = Math.min(run.end, inside[inside.length - 1]!.end);
    if (end - start > EPSILON) kept.push({ start, end });
  }
  return {
    beat: {
      ...beat,
      words,
      start: words[0]!.start,
      end: words[words.length - 1]!.end,
      runs: kept,
    },
    removed,
  };
}
