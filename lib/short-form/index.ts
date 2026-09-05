import { z } from 'zod';
import { burnInStyleSchema, type BurnInStyle } from '../rough-cut/subtitle-style';
import { endsSentence, normalizeWord, type TimedWord } from '../rough-cut/text';

export const SHORT_FORM_COUNT_MIN = 5;
export const SHORT_FORM_COUNT_MAX = 10;
export const SHORT_FORM_DURATION_MIN = 15;
export const SHORT_FORM_DURATION_MAX = 45;

export const DEFAULT_SHORT_CAPTION_STYLE: BurnInStyle = burnInStyleSchema.parse({
  fontSize: 64,
  maxWordsPerCue: 4,
  maxCueSeconds: 2.5,
  marginVertical: 280,
  position: 'bottom',
});

/** Shorts keep their selected source range at real time; caption playback rate is fixed at 1x. */
export const shortCaptionStyleSchema = burnInStyleSchema.refine(
  (style) => style.playbackRate === 1,
  'Short-form captions require 1x playback rate'
);

export const shortFormBatchConfigSchema = z
  .object({
    count: z.number().int().min(SHORT_FORM_COUNT_MIN).max(SHORT_FORM_COUNT_MAX).default(8),
    minDurationSeconds: z
      .number()
      .min(SHORT_FORM_DURATION_MIN)
      .max(SHORT_FORM_DURATION_MAX)
      .default(15),
    maxDurationSeconds: z
      .number()
      .min(SHORT_FORM_DURATION_MIN)
      .max(SHORT_FORM_DURATION_MAX)
      .default(45),
    useAi: z.boolean().default(false),
    captionStyle: shortCaptionStyleSchema.default(DEFAULT_SHORT_CAPTION_STYLE),
  })
  .strict()
  .refine((value) => value.maxDurationSeconds >= value.minDurationSeconds, {
    message: 'maxDurationSeconds must be at least minDurationSeconds',
    path: ['maxDurationSeconds'],
  });

export type ShortFormBatchConfig = z.infer<typeof shortFormBatchConfigSchema>;

export type ShortFormTranscriptSegment = {
  start: number;
  end: number;
  text: string;
  words?: TimedWord[];
};

export type ShortFormEvidence = {
  sceneCuts?: number[];
  faceCoverage?: Array<{ start: number; end: number; confidence: number }>;
};

export type ShortFormScores = {
  hook: number;
  completeness: number;
  speechDensity: number;
  salience: number;
  visualStability: number;
  total: number;
};

export type ShortFormCandidatePlan = {
  start: number;
  end: number;
  title: string;
  socialCaption: string;
  hashtags: string[];
  hook: string;
  rationale: string;
  scores: ShortFormScores;
};

type Sentence = { start: number; end: number; text: string; words: string[] };

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function sentencesFromTranscript(segments: ShortFormTranscriptSegment[]): Sentence[] {
  const words = segments
    .flatMap((segment) =>
      segment.words?.length
        ? segment.words
        : [{ start: segment.start, end: segment.end, text: segment.text }]
    )
    .filter((word) => word.end > word.start && word.text.trim())
    .sort((a, b) => a.start - b.start);
  const sentences: Sentence[] = [];
  let current: TimedWord[] = [];
  for (const word of words) {
    current.push(word);
    if (!endsSentence(word.text)) continue;
    sentences.push({
      start: current[0]!.start,
      end: current[current.length - 1]!.end,
      text: current.map((entry) => entry.text.trim()).join(' '),
      words: current
        .flatMap((entry) => entry.text.split(/\s+/))
        .map(normalizeWord)
        .filter(Boolean),
    });
    current = [];
  }
  if (current.length > 0) {
    sentences.push({
      start: current[0]!.start,
      end: current[current.length - 1]!.end,
      text: current.map((entry) => entry.text.trim()).join(' '),
      words: current
        .flatMap((entry) => entry.text.split(/\s+/))
        .map(normalizeWord)
        .filter(Boolean),
    });
  }
  return sentences;
}

export function sentenceBoundaries(segments: ShortFormTranscriptSegment[]): number[] {
  return [
    ...new Set(
      sentencesFromTranscript(segments).flatMap((sentence) => [sentence.start, sentence.end])
    ),
  ].sort((a, b) => a - b);
}

/** Transcript text inside a proposed source range, without loading or exposing media. */
export function transcriptTextForRange(
  segments: ShortFormTranscriptSegment[],
  start: number,
  end: number
): string {
  return segments
    .flatMap((segment) =>
      segment.words?.length
        ? segment.words
            .filter((word) => word.end > start && word.start < end)
            .map((word) => word.text)
        : segment.end > start && segment.start < end
          ? [segment.text]
          : []
    )
    .map((text) => text.trim())
    .filter(Boolean)
    .join(' ');
}

export function snapShortRange(
  segments: ShortFormTranscriptSegment[],
  start: number,
  end: number
): { start: number; end: number } | null {
  const sentences = sentencesFromTranscript(segments);
  const starts = sentences.map((sentence) => sentence.start);
  const ends = sentences.map((sentence) => sentence.end);
  const snappedStart = starts.reduce(
    (best, value) => (Math.abs(value - start) < Math.abs(best - start) ? value : best),
    starts[0] ?? Number.NaN
  );
  const snappedEnd = ends.reduce(
    (best, value) => (Math.abs(value - end) < Math.abs(best - end) ? value : best),
    ends[0] ?? Number.NaN
  );
  if (
    !Number.isFinite(snappedStart) ||
    !Number.isFinite(snappedEnd) ||
    snappedEnd <= snappedStart
  ) {
    return null;
  }
  return { start: snappedStart, end: snappedEnd };
}

function faceScore(start: number, end: number, evidence: ShortFormEvidence): number {
  const ranges = evidence.faceCoverage ?? [];
  if (ranges.length === 0) return 0.5;
  let weighted = 0;
  let covered = 0;
  for (const range of ranges) {
    const overlap = Math.max(0, Math.min(end, range.end) - Math.max(start, range.start));
    weighted += overlap * clamp01(range.confidence);
    covered += overlap;
  }
  return clamp01(weighted / Math.max(end - start, covered, 0.001));
}

function proposalScore(sentences: Sentence[], evidence: ShortFormEvidence): ShortFormScores {
  const text = sentences.map((sentence) => sentence.text).join(' ');
  const words = sentences.flatMap((sentence) => sentence.words);
  const duration = sentences[sentences.length - 1]!.end - sentences[0]!.start;
  const opening = sentences[0]!.text.toLowerCase();
  const hook = clamp01(
    0.35 +
      (/\?|\bhow\b|\bwhy\b|\bnever\b|\bmistake\b|\bsecret\b|\byou\b|\d/.test(opening) ? 0.45 : 0) +
      (opening.length <= 120 ? 0.2 : 0)
  );
  const completeness = clamp01(
    (endsSentence(sentences[sentences.length - 1]!.text) ? 0.7 : 0.35) +
      (sentences.length >= 2 ? 0.3 : 0)
  );
  const speechDensity = clamp01(words.length / Math.max(1, duration * 2.5));
  const unique = new Set(words.filter((word) => word.length > 3));
  const salience = clamp01(unique.size / Math.max(8, words.length * 0.55));
  const visualStability = faceScore(
    sentences[0]!.start,
    sentences[sentences.length - 1]!.end,
    evidence
  );
  const total =
    hook * 0.25 +
    completeness * 0.25 +
    speechDensity * 0.2 +
    salience * 0.2 +
    visualStability * 0.1;
  void text;
  return { hook, completeness, speechDensity, salience, visualStability, total };
}

function overlapFraction(a: ShortFormCandidatePlan, b: ShortFormCandidatePlan): number {
  const overlap = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  return overlap / Math.min(a.end - a.start, b.end - b.start);
}

function lexicalSimilarity(a: ShortFormCandidatePlan, b: ShortFormCandidatePlan): number {
  const left = new Set(a.hook.split(/\s+/).map(normalizeWord).filter(Boolean));
  const right = new Set(b.hook.split(/\s+/).map(normalizeWord).filter(Boolean));
  const shared = [...left].filter((word) => right.has(word)).length;
  return shared / Math.max(1, new Set([...left, ...right]).size);
}

/** Maximal-marginal-relevance selection with a hard source-overlap ceiling. */
export function selectDiverseCandidates(
  proposals: ShortFormCandidatePlan[],
  count: number
): ShortFormCandidatePlan[] {
  const selected: ShortFormCandidatePlan[] = [];
  while (selected.length < count) {
    let best: { candidate: ShortFormCandidatePlan; mmr: number } | null = null;
    for (const candidate of proposals) {
      if (selected.includes(candidate)) continue;
      if (selected.some((chosen) => overlapFraction(candidate, chosen) > 0.2)) continue;
      const redundancy = Math.max(
        0,
        ...selected.map((chosen) => lexicalSimilarity(candidate, chosen))
      );
      const mmr = candidate.scores.total * 0.75 - redundancy * 0.25;
      if (!best || mmr > best.mmr) best = { candidate, mmr };
    }
    if (!best) break;
    selected.push(best.candidate);
  }
  return selected;
}

/** Pure candidate generation; storage, AI reranking, frame analysis and rendering are adapters. */
export function planShortFormCandidates(options: {
  transcript: ShortFormTranscriptSegment[];
  evidence?: ShortFormEvidence;
  config: ShortFormBatchConfig;
}): { candidates: ShortFormCandidatePlan[]; warnings: string[] } {
  const sentences = sentencesFromTranscript(options.transcript);
  const evidence = options.evidence ?? {};
  const proposals: ShortFormCandidatePlan[] = [];
  for (let start = 0; start < sentences.length; start += 1) {
    for (let end = start; end < sentences.length; end += 1) {
      const selected = sentences.slice(start, end + 1);
      const duration = selected[selected.length - 1]!.end - selected[0]!.start;
      if (duration < options.config.minDurationSeconds) continue;
      if (duration > options.config.maxDurationSeconds) break;
      const text = selected.map((sentence) => sentence.text).join(' ');
      const scores = proposalScore(selected, evidence);
      if (scores.total < 0.45) continue;
      proposals.push({
        start: selected[0]!.start,
        end: selected[selected.length - 1]!.end,
        title: selected[0]!.text.replace(/[.!?…]+$/u, '').slice(0, 80),
        socialCaption: text.slice(0, 300),
        hashtags: [],
        hook: selected[0]!.text,
        rationale: `Strong ${scores.hook >= 0.7 ? 'hook' : 'opening'} with a complete, speech-dense payoff.`,
        scores,
      });
    }
  }
  proposals.sort((a, b) => b.scores.total - a.scores.total || a.start - b.start);

  const selected = selectDiverseCandidates(proposals, options.config.count);
  const warnings =
    selected.length < options.config.count
      ? [`Only ${selected.length} qualified, non-overlapping short-form candidates were found.`]
      : [];
  return { candidates: selected, warnings };
}
