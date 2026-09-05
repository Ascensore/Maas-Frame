import type { BriefRankingCriterion } from './brief';
import { beatDuration, beatText, type Beat, type SourceCut } from './beats';
import {
  containment,
  contentTokens,
  countFillers,
  countLongPauses,
  countRestarts,
  excerpt,
  jaccard,
  trigrams,
} from './text';

/**
 * Take selection: find beats that say the same thing, keep one, cut the rest.
 *
 * Two beats are the same take when their filler-free word trigrams overlap
 * enough and they sit within the window on the timeline. Overlap is Jaccard,
 * plus containment for the retake that only re-says a piece of a longer take,
 * which Jaccard scores far too low. Groups are the transitive closure of that
 * relation, so take one, two and three of a line end up together even if one
 * and three are only distantly similar.
 */

export const TAKE_SIMILARITY_THRESHOLD = 0.5;
export const TAKE_WINDOW_SECONDS = 10 * 60;
/** Shorter phrases repeat for legitimate reasons ("thank you"); they are never takes. */
export const TAKE_MIN_CONTENT_TOKENS = 4;
/** Share of the shorter take's trigrams that the longer one contains before they count as the same take. */
export const TAKE_CONTAINMENT_THRESHOLD = 0.6;
/** A contained retake needs this many content tokens; shorter phrases repeat for other reasons. */
export const TAKE_CONTAINMENT_MIN_TOKENS = 6;

export type TakeCandidate = {
  beat: Beat;
  /** Where the beat sits on the program timeline, for the window and the recency tiebreak. */
  timelineStart: number;
  /** Mean loudness of the beat, when the ranking asks for energy and audio is available. */
  energy: number | null;
  /** How well the beat matches the operator's script, 0–1, when there is one. */
  scriptMatch?: number | null;
};

export type TakeScores = {
  cleanliness: number;
  energy: number | null;
  recency: number;
  scriptMatch: number | null;
};

export type TakeDecision = {
  /** Indices into the candidate array, in timeline order. */
  group: number[];
  keptIndex: number;
  scores: Map<number, TakeScores>;
};

function find(parent: number[], index: number): number {
  let root = index;
  while (parent[root] !== root) root = parent[root]!;
  while (parent[index] !== root) {
    const next = parent[index]!;
    parent[index] = root;
    index = next;
  }
  return root;
}

export function groupTakes(
  candidates: TakeCandidate[],
  options: {
    fillers: ReadonlySet<string>;
    similarity?: number;
    windowSeconds?: number;
    /** Index groups a second signal found, unioned in as if their members matched. */
    alsoGroup?: number[][];
  }
): number[][] {
  const similarity = options.similarity ?? TAKE_SIMILARITY_THRESHOLD;
  const window = options.windowSeconds ?? TAKE_WINDOW_SECONDS;
  const shingles: Array<Set<string> | null> = [];
  const tokenCounts: number[] = [];
  for (const candidate of candidates) {
    const tokens = contentTokens(
      candidate.beat.words.map((word) => word.text),
      options.fillers
    );
    tokenCounts.push(tokens.length);
    shingles.push(tokens.length >= TAKE_MIN_CONTENT_TOKENS ? trigrams(tokens) : null);
  }
  const parent = candidates.map((_, index) => index);
  for (let a = 0; a < candidates.length; a += 1) {
    const left = shingles[a];
    if (!left) continue;
    for (let b = a + 1; b < candidates.length; b += 1) {
      const right = shingles[b];
      if (!right) continue;
      if (Math.abs(candidates[b]!.timelineStart - candidates[a]!.timelineStart) > window) continue;
      const contained =
        Math.min(tokenCounts[a]!, tokenCounts[b]!) >= TAKE_CONTAINMENT_MIN_TOKENS &&
        containment(left, right) >= TAKE_CONTAINMENT_THRESHOLD;
      if (jaccard(left, right) < similarity && !contained) continue;
      parent[find(parent, a)] = find(parent, b);
    }
  }
  for (const group of options.alsoGroup ?? []) {
    const first = group[0];
    if (first === undefined || !candidates[first]) continue;
    for (let index = 1; index < group.length; index += 1) {
      const member = group[index];
      if (member === undefined || !candidates[member]) continue;
      parent[find(parent, first)] = find(parent, member);
    }
  }
  const groups = new Map<number, number[]>();
  candidates.forEach((_, index) => {
    const root = find(parent, index);
    const list = groups.get(root) ?? [];
    list.push(index);
    groups.set(root, list);
  });
  return [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) =>
      group.sort((a, b) => candidates[a]!.timelineStart - candidates[b]!.timelineStart)
    )
    .sort((a, b) => candidates[a[0]!]!.timelineStart - candidates[b[0]!]!.timelineStart);
}

/**
 * Cleanliness is a rate, so a long take is not punished for having had more
 * chances to stumble. Fillers count once, restarts twice, stalls once.
 */
export function cleanlinessScore(
  beat: Beat,
  fillers: ReadonlySet<string>,
  longPauseSeconds: number
): number {
  const minutes = Math.max(beatDuration(beat), 1) / 60;
  const penalty =
    countFillers(beat.words, fillers) / minutes +
    (2 * countRestarts(beat.words)) / minutes +
    countLongPauses(beat.words, longPauseSeconds) / minutes;
  return penalty === 0 ? 0 : -penalty;
}

function compareBy(
  ranking: BriefRankingCriterion[],
  scores: Map<number, TakeScores>
): (a: number, b: number) => number {
  return (a, b) => {
    const left = scores.get(a)!;
    const right = scores.get(b)!;
    for (const criterion of ranking) {
      if (criterion === 'script_match') {
        // A take with no script match at all loses to one that has any.
        const l = left.scriptMatch ?? -1;
        const r = right.scriptMatch ?? -1;
        if (l !== r) return r - l;
      }
      if (criterion === 'cleanliness' && left.cleanliness !== right.cleanliness) {
        return right.cleanliness - left.cleanliness;
      }
      if (criterion === 'energy') {
        const l = left.energy ?? 0;
        const r = right.energy ?? 0;
        if (l !== r) return r - l;
      }
    }
    // The most recent take is the editor's convention and makes this deterministic.
    return right.recency - left.recency;
  };
}

export function selectTakes(
  candidates: TakeCandidate[],
  options: {
    fillers: ReadonlySet<string>;
    ranking: BriefRankingCriterion[];
    longPauseSeconds: number;
    similarity?: number;
    windowSeconds?: number;
    alsoGroup?: number[][];
  }
): TakeDecision[] {
  const groups = groupTakes(candidates, options);
  return groups.map((group) => {
    const scores = new Map<number, TakeScores>();
    for (const index of group) {
      const candidate = candidates[index]!;
      scores.set(index, {
        cleanliness: cleanlinessScore(candidate.beat, options.fillers, options.longPauseSeconds),
        energy: candidate.energy,
        recency: candidate.timelineStart,
        scriptMatch: candidate.scriptMatch ?? null,
      });
    }
    const ordered = [...group].sort(compareBy(options.ranking, scores));
    return { group, keptIndex: ordered[0]!, scores };
  });
}

/** The cuts a take decision produces: every member of the group except the kept one. */
export function rejectedTakeCuts(candidates: TakeCandidate[], decision: TakeDecision): SourceCut[] {
  const kept = candidates[decision.keptIndex]!;
  const position = decision.group.indexOf(decision.keptIndex) + 1;
  return decision.group
    .filter((index) => index !== decision.keptIndex)
    .map((index) => {
      const beat = candidates[index]!.beat;
      return {
        versionId: beat.versionId,
        start: beat.start,
        end: beat.end,
        code: 'REJECTED_TAKE' as const,
        summary: `Take ${decision.group.indexOf(index) + 1} of ${decision.group.length}; kept take ${position} (“${excerpt(beatText(kept.beat), 60)}”)`,
        text: excerpt(beatText(beat)),
      };
    });
}
