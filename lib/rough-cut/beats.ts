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

export type BeatWord = TimedWord & { speaker: string | null; confidence?: number };

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
      const confidence = (word as Partial<BeatWord>).confidence;
      out.push({
        start,
        end,
        text: word.text,
        speaker,
        ...(typeof confidence === 'number' && Number.isFinite(confidence) ? { confidence } : {}),
      });
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
  options: {
    versionId: string;
    durationSeconds: number;
    policy: SilencePolicy;
    /** Local VAD speech islands. When supplied, automatic cuts never overlap them. */
    voiceActivity?: SpeechRun[];
  }
): SpeechAnalysis {
  const { versionId, policy } = options;
  const words = wordsFromSegments(segments, options.durationSeconds);
  const beats: Beat[] = [];
  const cuts: SourceCut[] = [];
  if (words.length === 0) return { beats, cuts, runs: [] };

  const first = words[0]!;
  const voiceActivity = options.voiceActivity
    ?.filter((run) => run.end > run.start + EPSILON)
    .sort((a, b) => a.start - b.start);
  const confirmedSilence = (start: number, end: number): SpeechRun[] => {
    if (!voiceActivity) return end > start + EPSILON ? [{ start, end }] : [];
    let cursor = start;
    const silence: SpeechRun[] = [];
    for (const speech of voiceActivity) {
      if (speech.end <= cursor + EPSILON) continue;
      if (speech.start >= end - EPSILON) break;
      if (speech.start > cursor + EPSILON) {
        silence.push({ start: cursor, end: Math.min(end, speech.start) });
      }
      cursor = Math.max(cursor, speech.end);
      if (cursor >= end - EPSILON) break;
    }
    if (cursor < end - EPSILON) silence.push({ start: cursor, end });
    return silence.filter((run) => run.end > run.start + EPSILON);
  };
  const compressedGap = (
    start: number,
    end: number,
    limit: number,
    retained: number
  ): SpeechRun[] => {
    if (end - start <= limit + EPSILON) return [];
    const keep = Math.min(retained, Math.max(0, end - start));
    return confirmedSilence(start + keep / 2, end - keep / 2);
  };

  const leading = compressedGap(0, first.start, policy.maxKeptGapBetweenBeatsSeconds, 0);
  cuts.push(
    ...leading.map((range) => deadAir(versionId, range.start, range.end, 'before the first word'))
  );

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
    const retained = afterTerminal
      ? policy.retainedGapBetweenBeatsSeconds
      : policy.retainedGapInsideBeatSeconds;
    const removed = compressedGap(previous.end, word.start, limit, retained);
    const cut = removed.length > 0;
    const endsBeat = speakerChange || pause > policy.maxKeptGapBetweenBeatsSeconds + EPSILON;

    cuts.push(
      ...removed.map((range) =>
        deadAir(
          versionId,
          range.start,
          range.end,
          (policy.detectNestedTakes ? afterTerminal : endsBeat || afterTerminal)
            ? 'between thoughts'
            : 'mid-sentence'
        )
      )
    );

    if (endsBeat) {
      if (cut) {
        beat.runs[beat.runs.length - 1]!.end = removed[0]!.start;
        for (let removedIndex = 1; removedIndex < removed.length; removedIndex += 1) {
          beat.runs.push({
            start: removed[removedIndex - 1]!.end,
            end: removed[removedIndex]!.start,
          });
        }
      }
      closeBeat();
      beat = {
        versionId,
        start: word.start,
        end: word.end,
        speaker: word.speaker,
        words: [word],
        runs: [{ start: cut ? removed[removed.length - 1]!.end : word.start, end: word.end }],
      };
      continue;
    }

    beat.words.push(word);
    beat.end = Math.max(beat.end, word.end);
    if (beat.speaker === null) beat.speaker = word.speaker;
    const run = beat.runs[beat.runs.length - 1]!;
    if (cut) {
      run.end = removed[0]!.start;
      for (let removedIndex = 1; removedIndex < removed.length; removedIndex += 1) {
        beat.runs.push({
          start: removed[removedIndex - 1]!.end,
          end: removed[removedIndex]!.start,
        });
      }
      beat.runs.push({ start: removed[removed.length - 1]!.end, end: word.end });
    } else {
      run.end = Math.max(run.end, word.end);
    }
  }
  closeBeat();

  const last = words[words.length - 1]!;
  if (Number.isFinite(options.durationSeconds)) {
    const trailing = compressedGap(
      last.end,
      options.durationSeconds,
      policy.maxKeptGapBetweenBeatsSeconds,
      0
    );
    cuts.push(
      ...trailing.map((range) => deadAir(versionId, range.start, range.end, 'after the last word'))
    );
  }

  return { beats, cuts, runs: beats.flatMap((entry) => entry.runs) };
}

const EXPLICIT_RESTARTS = new Set(['again', 'sorry', 'restart', 'actually']);
const REPEATED_OPENING_TOKENS = 5;

/**
 * Sentence/restart units used by the tight take detector. The regular beat
 * model remains unchanged, preserving old decision lists, while tight can
 * compare a repeated line nested inside one long transcript beat.
 */
export function takeUnitsFromBeats(beats: Beat[], fillers: ReadonlySet<string>): Beat[] {
  const units: Beat[] = [];
  for (const beat of beats) {
    if (beat.words.length < 2) {
      units.push(beat);
      continue;
    }
    const boundaries = new Set<number>([0, beat.words.length]);
    for (let index = 1; index < beat.words.length; index += 1) {
      const token = contentTokens([beat.words[index]!.text], fillers)[0] ?? '';
      if (endsSentence(beat.words[index - 1]!.text) || EXPLICIT_RESTARTS.has(token)) {
        boundaries.add(index);
      }
    }
    const tokens = beat.words.map((word) => contentTokens([word.text], fillers)[0] ?? '');
    for (let right = REPEATED_OPENING_TOKENS; right < tokens.length; right += 1) {
      if (!tokens[right]) continue;
      for (let left = 0; left + REPEATED_OPENING_TOKENS <= right; left += 1) {
        const repeated = Array.from(
          { length: REPEATED_OPENING_TOKENS },
          (_, offset) => offset
        ).every(
          (offset) => tokens[left + offset] && tokens[left + offset] === tokens[right + offset]
        );
        if (repeated) {
          boundaries.add(right);
          right += REPEATED_OPENING_TOKENS - 1;
          break;
        }
      }
    }
    const positions = [...boundaries].sort((a, b) => a - b);
    for (let index = 1; index < positions.length; index += 1) {
      const first = positions[index - 1]!;
      const last = positions[index]!;
      const words = beat.words.slice(first, last);
      if (words.length === 0) continue;
      const leftBoundary =
        first === 0
          ? (beat.runs[0]?.start ?? words[0]!.start)
          : (beat.words[first - 1]!.end + words[0]!.start) / 2;
      const rightBoundary =
        last === beat.words.length
          ? (beat.runs[beat.runs.length - 1]?.end ?? words[words.length - 1]!.end)
          : (words[words.length - 1]!.end + beat.words[last]!.start) / 2;
      const runs = beat.runs
        .map((run) => ({
          start: Math.max(run.start, leftBoundary),
          end: Math.min(run.end, rightBoundary),
        }))
        .filter((run) => run.end > run.start + EPSILON);
      units.push({
        ...beat,
        start: words[0]!.start,
        end: words[words.length - 1]!.end,
        speaker: words.find((word) => word.speaker)?.speaker ?? beat.speaker,
        words,
        runs,
      });
    }
  }
  return units;
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

/** A range `cutWordsFromBeat` took out, and which of the given spans asked for it. */
export type RemovedSpan = { span: number; start: number; end: number; text: string };

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
): { beat: Beat | null; removed: RemovedSpan[] } {
  const drop = new Set<number>();
  const removed: RemovedSpan[] = [];
  spans.forEach((span, position) => {
    const first = Math.max(0, span.wordStart);
    const last = Math.min(beat.words.length, span.wordEnd);
    if (last <= first) return;
    for (let index = first; index < last; index += 1) drop.add(index);
    const words = beat.words.slice(first, last);
    removed.push({
      span: position,
      start: words[0]!.start,
      end: words[words.length - 1]!.end,
      text: words.map((word) => word.text.trim()).join(' '),
    });
  });
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
