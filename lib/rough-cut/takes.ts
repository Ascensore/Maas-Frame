import type { BriefRankingCriterion } from './brief';
import {
  beatDuration,
  beatText,
  cutWordsFromBeat,
  type Beat,
  type SourceCut,
  type WordSpan,
} from './beats';
import type { ScriptAlignment, ScriptLine } from './script';
import {
  containment,
  contentTokens,
  countFillers,
  countLongPauses,
  countRestarts,
  excerpt,
  jaccard,
  normalizeWord,
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
/**
 * How much longer the containing take may be. A stock phrase ("at the end of
 * the day") sits inside plenty of long beats without being a take of them.
 */
export const TAKE_CONTAINMENT_MAX_RATIO = 3;

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
  /** One take says a piece of the other, and the two are of comparable length. */
  const contained = (a: number, b: number): boolean => {
    const smaller = Math.min(tokenCounts[a]!, tokenCounts[b]!);
    const larger = Math.max(tokenCounts[a]!, tokenCounts[b]!);
    if (smaller < TAKE_CONTAINMENT_MIN_TOKENS) return false;
    if (larger > smaller * TAKE_CONTAINMENT_MAX_RATIO) return false;
    return containment(shingles[a]!, shingles[b]!) >= TAKE_CONTAINMENT_THRESHOLD;
  };
  const parent = candidates.map((_, index) => index);
  for (let a = 0; a < candidates.length; a += 1) {
    const left = shingles[a];
    if (!left) continue;
    for (let b = a + 1; b < candidates.length; b += 1) {
      const right = shingles[b];
      if (!right) continue;
      if (Math.abs(candidates[b]!.timelineStart - candidates[a]!.timelineStart) > window) continue;
      // Containment is the expensive fallback, so it only runs when Jaccard fails.
      if (jaccard(left, right) < similarity && !contained(a, b)) continue;
      parent[find(parent, a)] = find(parent, b);
    }
  }
  for (const group of options.alsoGroup ?? []) {
    // An index nobody supplied a candidate for drops out; the rest still union.
    const members = group.filter((index) => candidates[index] !== undefined);
    for (let index = 1; index < members.length; index += 1) {
      parent[find(parent, members[0]!)] = find(parent, members[index]!);
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

/**
 * A beat's content tokens with the word each came from (one token per word;
 * fillers and punctuation-only words skipped).
 */
export function beatTokens(
  beat: Beat,
  fillers: ReadonlySet<string>
): Array<{ token: string; wordIndex: number }> {
  const out: Array<{ token: string; wordIndex: number }> = [];
  beat.words.forEach((word, wordIndex) => {
    const token = normalizeWord(word.text);
    if (!token || fillers.has(token)) return;
    out.push({ token, wordIndex });
  });
  return out;
}

export type Coverage = { fraction: number; first: number | null; last: number | null };

/** Which of a beat's tokens a reference already says: every token inside a trigram the reference contains. */
export function coverageOf(tokens: string[], reference: ReadonlySet<string>): Coverage {
  const marked = new Array<boolean>(tokens.length).fill(false);
  for (let index = 0; index + 2 < tokens.length; index += 1) {
    if (!reference.has(`${tokens[index]} ${tokens[index + 1]} ${tokens[index + 2]}`)) continue;
    marked[index] = marked[index + 1] = marked[index + 2] = true;
  }
  if (tokens.length < 3 && tokens.length > 0 && reference.has(tokens.join(' '))) marked.fill(true);
  const count = marked.filter(Boolean).length;
  return {
    fraction: tokens.length === 0 ? 0 : count / tokens.length,
    first: count === 0 ? null : marked.indexOf(true),
    last: count === 0 ? null : marked.lastIndexOf(true),
  };
}

/** Share of a beat the reference must say before the beat counts as already covered. */
export const TAKE_COVERED_WHOLE = 0.8;
/** Below this share of a beat, an overlap is noise, not a shared line. */
export const TAKE_COVERED_NONE = 0.2;
/**
 * What a spliced take has to be left with. The assembler drops a shot shorter
 * than its `minShotSeconds` (1.5 by default) without saying so, so a splice
 * that would leave a fragment that short is refused instead.
 */
export const TAKE_MIN_SURVIVING_SECONDS = 1.5;

export type SpliceCut = WordSpan & { coveredBy: number };
export type TakeResolution = {
  group: number[];
  kept: Array<{ index: number; cuts: SpliceCut[] }>;
  rejected: Array<{ index: number; coveredBy: number }>;
  scores: Map<number, TakeScores>;
  /** Lines said twice because the overlap sat in the middle of both takes; the caller warns. */
  duplicatesKept: number;
};

export type ResolveTakesOptions = {
  fillers: ReadonlySet<string>;
  ranking: BriefRankingCriterion[];
  longPauseSeconds: number;
  similarity?: number;
  windowSeconds?: number;
  alsoGroup?: number[][];
  /** The operator's script, when there is one; index-aligned alignments come with it. */
  scriptLines?: ScriptLine[];
  alignments?: ScriptAlignment[];
};

/**
 * Resolve every take group so each line survives exactly once, in source
 * order. The longest take anchors its group; a shorter take that says
 * something the anchor already says either replaces that span (when it ranks
 * better, the span sits at an edge, and the replacement sits on the same side
 * of the anchor on the timeline, so the program keeps the source order) or is
 * rejected. An overlap at the edge of two adjacent takes is trimmed off the
 * lower-ranked one. An overlap in the middle of both can only be kept twice,
 * and is counted so the caller can warn.
 */
export function resolveTakes(
  candidates: TakeCandidate[],
  options: ResolveTakesOptions
): TakeResolution[] {
  const groups = groupTakes(candidates, options);
  const scriptLines = options.scriptLines ?? [];
  const useScript = scriptLines.length > 0;
  const tokenCache = new Map<number, Array<{ token: string; wordIndex: number }>>();
  const referenceCache = new Map<number, Set<string>>();

  const entriesOf = (index: number) => {
    const cached = tokenCache.get(index);
    if (cached) return cached;
    const entries = beatTokens(candidates[index]!.beat, options.fillers);
    tokenCache.set(index, entries);
    return entries;
  };
  const tokensOf = (index: number) => entriesOf(index).map((entry) => entry.token);
  /** What a member says: its own trigrams, plus the script lines it reads. */
  const referenceOf = (index: number) => {
    const cached = referenceCache.get(index);
    if (cached) return cached;
    const reference = trigrams(tokensOf(index));
    if (useScript) {
      for (const line of options.alignments?.[index]?.lines ?? []) {
        for (const shingle of scriptLines[line]?.shingles ?? []) reference.add(shingle);
      }
    }
    referenceCache.set(index, reference);
    return reference;
  };
  const sizeOf = (index: number) =>
    useScript
      ? options.alignments?.[index]?.lines.length || entriesOf(index).length
      : entriesOf(index).length;
  const startOf = (index: number) => candidates[index]!.timelineStart;
  /** Tokens outside the covered span; the covered region is read as contiguous. */
  const uncoveredCount = (coverage: Coverage, total: number) =>
    coverage.first === null || coverage.last === null
      ? total
      : total - (coverage.last - coverage.first + 1);

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
    const rank = compareBy(options.ranking, scores);
    const order = [...group].sort((a, b) => sizeOf(b) - sizeOf(a) || rank(a, b));

    const kept: Array<{ index: number; cuts: SpliceCut[] }> = [];
    const rejected: Array<{ index: number; coveredBy: number }> = [];
    let duplicatesKept = 0;

    /** The kept member that says the most of these trigrams; ties go to the earliest kept. */
    const closestKept = (shingles: ReadonlySet<string>) => {
      let best = kept[0]!.index;
      let bestShared = -1;
      for (const entry of kept) {
        const reference = referenceOf(entry.index);
        let shared = 0;
        for (const shingle of shingles) if (reference.has(shingle)) shared += 1;
        if (shared > bestShared) {
          best = entry.index;
          bestShared = shared;
        }
      }
      return best;
    };

    /**
     * The span `target` can give up to `coveredBy`: a partial coverage at one
     * of its edges, leaving enough of its own material behind, on the side
     * `coveredBy` sits on so the program stays in source order.
     */
    const spliceOf = (target: number, coveredBy: number): SpliceCut | null => {
      const entries = entriesOf(target);
      const back = coverageOf(
        entries.map((entry) => entry.token),
        referenceOf(coveredBy)
      );
      if (back.first === null || back.last === null) return null;
      if (back.fraction < TAKE_COVERED_NONE || back.fraction >= TAKE_COVERED_WHOLE) return null;
      const atStart = back.first === 0;
      const atEnd = back.last === entries.length - 1;
      if (atStart === atEnd) return null;
      if (uncoveredCount(back, entries.length) < TAKE_MIN_CONTENT_TOKENS) return null;
      // A tail may only be replaced by a later take, a head only by an earlier one.
      if (atEnd && startOf(coveredBy) <= startOf(target)) return null;
      if (atStart && startOf(coveredBy) >= startOf(target)) return null;
      const beat = candidates[target]!.beat;
      const span = {
        wordStart: atStart ? 0 : entries[back.first]!.wordIndex,
        wordEnd: atEnd ? beat.words.length : entries[back.last]!.wordIndex + 1,
        coveredBy,
      };
      const existing = kept.find((entry) => entry.index === target)?.cuts ?? [];
      // Two cuts over the same words would report the same removal twice.
      if (existing.some((cut) => cut.wordStart < span.wordEnd && span.wordStart < cut.wordEnd)) {
        return null;
      }
      // Every earlier splice counts: a head cut and a tail cut are each
      // survivable on their own and can still leave nothing between them.
      const survivor = cutWordsFromBeat(beat, [...existing, span]).beat;
      if (!survivor) return null;
      if (beatTokens(survivor, options.fillers).length < TAKE_MIN_CONTENT_TOKENS) return null;
      // Per run, because that is the shot the assembler measures.
      const longestRun = survivor.runs.reduce(
        (longest, run) => Math.max(longest, run.end - run.start),
        0
      );
      if (longestRun < TAKE_MIN_SURVIVING_SECONDS) return null;
      return span;
    };
    const spliceInto = (target: number, span: SpliceCut) => {
      kept.find((entry) => entry.index === target)?.cuts.push(span);
    };
    /**
     * The kept take this member overlaps, and the span that take can hand back
     * when the member outranks it. A null span leaves the decision to the
     * caller: reject the member, or trim the member instead.
     */
    const anchorFor = (member: number, shingles: ReadonlySet<string>) => {
      const anchor = closestKept(shingles);
      return { anchor, span: rank(member, anchor) < 0 ? spliceOf(anchor, member) : null };
    };

    for (const member of order) {
      if (kept.length === 0) {
        kept.push({ index: member, cuts: [] });
        continue;
      }
      const entries = entriesOf(member);
      const tokens = entries.map((entry) => entry.token);
      const reference = new Set<string>();
      for (const entry of kept)
        for (const shingle of referenceOf(entry.index)) reference.add(shingle);
      const coverage = coverageOf(tokens, reference);
      const uncovered = uncoveredCount(coverage, tokens.length);

      // Nothing in common: a new line, kept whole.
      if (coverage.fraction < TAKE_COVERED_NONE) {
        kept.push({ index: member, cuts: [] });
        continue;
      }

      // Already said: this take adds nothing of its own, so either it replaces
      // an edge of the take that says it, or it goes.
      if (coverage.fraction >= TAKE_COVERED_WHOLE || uncovered < TAKE_MIN_CONTENT_TOKENS) {
        const { anchor, span } = anchorFor(member, trigrams(tokens));
        if (span) {
          spliceInto(anchor, span);
          kept.push({ index: member, cuts: [] });
          continue;
        }
        rejected.push({ index: member, coveredBy: anchor });
        continue;
      }

      const first = coverage.first!;
      const last = coverage.last!;
      const atStart = first === 0;
      const atEnd = last === tokens.length - 1;
      // Shared at one edge: the lower-ranked take gives that edge up. Shared at
      // both edges is not a trim at all — the whole beat is a duplicate, and
      // the branch above has already taken it, since nothing would be left.
      if (atStart !== atEnd) {
        // The kept take is spliced when this member outranks it; otherwise
        // this member trims its own overlapping edge.
        const { anchor, span } = anchorFor(member, trigrams(tokens.slice(first, last + 1)));
        if (span) {
          spliceInto(anchor, span);
          kept.push({ index: member, cuts: [] });
          continue;
        }
        const trimmable = atEnd
          ? startOf(anchor) > startOf(member)
          : startOf(anchor) < startOf(member);
        if (trimmable) {
          const beat = candidates[member]!.beat;
          kept.push({
            index: member,
            cuts: [
              {
                wordStart: atStart ? 0 : entries[first]!.wordIndex,
                wordEnd: atEnd ? beat.words.length : entries[last]!.wordIndex + 1,
                coveredBy: anchor,
              },
            ],
          });
          continue;
        }
        kept.push({ index: member, cuts: [] });
        duplicatesKept += 1;
        continue;
      }

      // Shared in the middle of this take: nothing can be trimmed at an edge.
      const anchor = closestKept(trigrams(tokens));
      const back = coverageOf(tokensOf(anchor), trigrams(tokens));
      // Un-keeping an anchor another member already gave a span up to, or was
      // rejected in favour of, would leave those cuts naming a take that is no
      // longer in the cut, and a trimmed remainder playing before the line it
      // was trimmed to follow. The duplicate is the lesser evil.
      const reliedOn =
        kept.some((entry) => entry.cuts.some((cut) => cut.coveredBy === anchor)) ||
        rejected.some((entry) => entry.coveredBy === anchor);
      if (back.fraction >= TAKE_COVERED_WHOLE && !reliedOn) {
        const position = kept.findIndex((entry) => entry.index === anchor);
        if (position >= 0) kept.splice(position, 1);
        rejected.push({ index: anchor, coveredBy: member });
        kept.push({ index: member, cuts: [] });
        continue;
      }
      kept.push({ index: member, cuts: [] });
      duplicatesKept += 1;
    }

    return {
      group,
      kept: kept.sort((a, b) => startOf(a.index) - startOf(b.index)),
      rejected,
      scores,
      duplicatesKept,
    };
  });
}

/** The cut a spliced-out span leaves behind: the take that re-said it is named. */
export function replacedTakeCut(
  candidates: TakeCandidate[],
  index: number,
  coveredBy: number,
  removed: { start: number; end: number; text: string }
): SourceCut {
  const replacement = candidates[coveredBy]!;
  return {
    versionId: candidates[index]!.beat.versionId,
    start: removed.start,
    end: removed.end,
    code: 'REJECTED_TAKE',
    summary: `Replaced by the take at ${replacement.timelineStart.toFixed(1)}s (“${excerpt(beatText(replacement.beat), 60)}”)`,
    text: removed.text,
  };
}

/** The cut a whole rejected take leaves behind: its position in the group and the take that covers it. */
export function rejectedTakeCut(
  candidates: TakeCandidate[],
  index: number,
  coveredBy: number,
  resolution: Pick<TakeResolution, 'group'>
): SourceCut {
  const beat = candidates[index]!.beat;
  const position = resolution.group.indexOf(coveredBy) + 1;
  return {
    versionId: beat.versionId,
    start: beat.start,
    end: beat.end,
    code: 'REJECTED_TAKE',
    summary: `Take ${resolution.group.indexOf(index) + 1} of ${resolution.group.length}; kept take ${position} (“${excerpt(beatText(candidates[coveredBy]!.beat), 60)}”)`,
    text: excerpt(beatText(beat)),
  };
}
