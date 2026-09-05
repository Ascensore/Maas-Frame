import type { Beat } from './beats';
import type { BriefRankingCriterion } from './brief';
import { contentTokens, excerpt, tokenize, trigrams } from './text';
import type { RoughCutWarning } from './types';

/**
 * The operator's script as an editorial guide. Lines are the units a take is
 * matched against; a beat that reads a line is a take of that line, and the
 * take that reads it most faithfully wins. Pure, so the worker can import it.
 */

export const SCRIPT_MAX_CHARS = 20_000;
/** A script line counts as covered by a beat when this share of its trigrams occurs in the beat. */
export const SCRIPT_LINE_COVERAGE = 0.5;
/** Below this share of on-script trigrams a kept beat is reported as off-script. */
export const SCRIPT_OFF_SCRIPT_THRESHOLD = 0.2;
export const SCRIPT_LINE_MIN_TOKENS = 3;

export type ScriptLine = { index: number; text: string; tokens: string[]; shingles: Set<string> };

/**
 * A newline, or the space after a sentence end. The lookbehind spares full
 * stops that do not end a sentence: the common abbreviations, and an initial
 * (a single capital letter and a period, as in "Dr. J. Smith").
 */
const SENTENCE_BREAK =
  /\n+|(?<!\b(?:e\.g|i\.e|etc|vs|Mr|Mrs|Dr|St|[A-Z])\.)(?<=[.!?…]["'»”)\]]*)\s+(?=\S)/u;

/** Lines and sentences of the script, in order, blank lines dropped. */
export function splitScriptLines(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(SENTENCE_BREAK)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * The script as the assembler uses it: the lines a take can be matched
 * against, plus the trigrams of the whole script read end to end. The latter
 * is what a beat's on-script score is measured against, so a verbatim read of
 * two consecutive lines is fully on script even though the trigrams straddling
 * the line break belong to no single line.
 */
export type ParsedScript = { lines: ScriptLine[]; shingles: Set<string> };

export function parseScript(text: string, fillers: ReadonlySet<string>): ParsedScript {
  const lines: ScriptLine[] = [];
  const whole: string[] = [];
  for (const raw of splitScriptLines(text)) {
    const tokens = contentTokens(tokenize(raw), fillers);
    whole.push(...tokens);
    if (tokens.length < SCRIPT_LINE_MIN_TOKENS) continue;
    lines.push({ index: lines.length, text: raw, tokens, shingles: trigrams(tokens) });
  }
  return { lines, shingles: trigrams(whole) };
}

export type ScriptAlignment = {
  /** Script lines this beat covers, in script order. */
  lines: number[];
  /** Share of the beat's trigrams found anywhere in the script: 1 is fully on script. */
  score: number;
};

export function alignBeatToScript(
  beat: Beat,
  script: ParsedScript,
  fillers: ReadonlySet<string>
): ScriptAlignment {
  const shingles = trigrams(
    contentTokens(
      beat.words.map((word) => word.text),
      fillers
    )
  );
  if (shingles.size === 0 || script.lines.length === 0) return { lines: [], score: 0 };
  const covered: number[] = [];
  for (const line of script.lines) {
    let shared = 0;
    for (const shingle of line.shingles) {
      if (shingles.has(shingle)) shared += 1;
    }
    if (line.shingles.size > 0 && shared / line.shingles.size >= SCRIPT_LINE_COVERAGE) {
      covered.push(line.index);
    }
  }
  let onScript = 0;
  for (const shingle of shingles) {
    if (script.shingles.has(shingle)) onScript += 1;
  }
  return { lines: covered, score: onScript / shingles.size };
}

/**
 * Beats that cover the same script line are takes of that line, whatever
 * their wording. The window applies between consecutive readings, not across
 * the group: a chain breaks only where two neighbouring readings are further
 * apart than the window, so a run of closely spaced readings can span more
 * than the window from end to end. Readings separated by a longer gap are
 * different deliveries of a repeated line, not retakes.
 */
export function scriptTakeGroups(
  candidates: ReadonlyArray<{ timelineStart: number }>,
  alignments: ScriptAlignment[],
  windowSeconds: number
): number[][] {
  const byLine = new Map<number, number[]>();
  alignments.forEach((alignment, index) => {
    for (const line of alignment.lines) {
      const list = byLine.get(line) ?? [];
      list.push(index);
      byLine.set(line, list);
    }
  });
  const groups: number[][] = [];
  for (const members of byLine.values()) {
    if (members.length < 2) continue;
    const sorted = [...members].sort(
      (a, b) => candidates[a]!.timelineStart - candidates[b]!.timelineStart
    );
    let current: number[] = [sorted[0]!];
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1]!;
      const next = sorted[index]!;
      if (candidates[next]!.timelineStart - candidates[previous]!.timelineStart > windowSeconds) {
        if (current.length > 1) groups.push(current);
        current = [next];
      } else {
        current.push(next);
      }
    }
    if (current.length > 1) groups.push(current);
  }
  return groups.sort((a, b) => candidates[a[0]!]!.timelineStart - candidates[b[0]!]!.timelineStart);
}

/** After take selection: lines nobody read cleanly, and kept beats the script does not contain. */
export function scriptCoverageWarnings(
  lines: ScriptLine[],
  kept: Array<{ alignment: ScriptAlignment; text: string }>
): RoughCutWarning[] {
  const warnings: RoughCutWarning[] = [];
  const covered = new Set(kept.flatMap((entry) => entry.alignment.lines));
  const missing = lines.filter((line) => !covered.has(line.index));
  const sampleOf = (texts: string[]) =>
    texts
      .slice(0, 3)
      .map((text) => `“${excerpt(text, 60)}”`)
      .join(', ');
  if (missing.length > 0) {
    // Judged on the selected takes, before shot packing decides what fits.
    warnings.push({
      code: 'script-lines-missing',
      message: `${missing.length} of ${lines.length} script lines have no matching take among the selected takes: ${sampleOf(missing.map((line) => line.text))}`,
    });
  }
  const offScript = kept.filter((entry) => entry.alignment.score < SCRIPT_OFF_SCRIPT_THRESHOLD);
  if (offScript.length > 0) {
    const sample = sampleOf(offScript.map((entry) => entry.text));
    warnings.push({
      code: 'off-script-beats',
      message:
        offScript.length === 1
          ? `1 kept beat is not in the script; review whether it belongs in the cut: ${sample}`
          : `${offScript.length} kept beats are not in the script; review whether they belong in the cut: ${sample}`,
    });
  }
  return warnings;
}

/** With a script, the take that matches it wins before anything else the brief ranks by. */
export function rankingWithScript(ranking: BriefRankingCriterion[]): BriefRankingCriterion[] {
  return ['script_match', ...ranking.filter((criterion) => criterion !== 'script_match')];
}
