/**
 * Text helpers for the editorial assembler: normalising transcript words,
 * filler lists per language, shingles for take matching, and restart
 * detection. Pure, and copied into the worker image with the rest of
 * lib/rough-cut.
 */

export type TimedWord = { start: number; end: number; text: string };

/**
 * Hesitation sounds, not real words. Kept deliberately short: a word that is
 * sometimes a filler and sometimes content ("like", "cioè", "allora") stays
 * content, because stripping it would change what two takes have in common.
 */
const FILLERS: Record<string, ReadonlySet<string>> = {
  en: new Set(['um', 'umm', 'uh', 'uhm', 'uhh', 'er', 'erm', 'ah', 'hmm', 'mm', 'mhm']),
  it: new Set(['ehm', 'ehmm', 'eh', 'mh', 'mmh', 'em', 'uhm']),
};

const EMPTY: ReadonlySet<string> = new Set();

export function primaryLanguage(language: string | null | undefined): string {
  if (typeof language !== 'string') return 'und';
  const trimmed = language.trim().toLowerCase();
  if (!trimmed) return 'und';
  return trimmed.split('-')[0] ?? 'und';
}

/** The filler list for a transcript language; empty for languages without one. */
export function fillerWordsFor(language: string | null | undefined): ReadonlySet<string> {
  return FILLERS[primaryLanguage(language)] ?? EMPTY;
}

const STRIP = /[^\p{L}\p{N}']+/gu;

/** Lowercase, punctuation and quotes removed; empty for a token that was only punctuation. */
export function normalizeWord(text: string): string {
  return text.toLowerCase().replace(STRIP, '');
}

export function tokenize(text: string): string[] {
  return text
    .split(/\s+/)
    .map(normalizeWord)
    .filter((token) => token.length > 0);
}

export function isFiller(token: string, fillers: ReadonlySet<string>): boolean {
  return fillers.has(token);
}

/** Normalised words with fillers removed: what two takes are compared on. */
export function contentTokens(words: string[], fillers: ReadonlySet<string>): string[] {
  return words
    .flatMap((word) => word.split(/\s+/))
    .map(normalizeWord)
    .filter((token) => token.length > 0 && !fillers.has(token));
}

/**
 * Word trigrams as a set. Fewer than three tokens make one shingle of the
 * whole phrase, so two identical short lines still match and two different
 * ones still do not.
 */
export function trigrams(tokens: string[]): Set<string> {
  const out = new Set<string>();
  if (tokens.length === 0) return out;
  if (tokens.length < 3) {
    out.add(tokens.join(' '));
    return out;
  }
  for (let index = 0; index + 2 < tokens.length; index += 1) {
    out.add(`${tokens[index]} ${tokens[index + 1]} ${tokens[index + 2]}`);
  }
  return out;
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let shared = 0;
  for (const entry of a) if (b.has(entry)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/**
 * Share of the smaller set found in the larger one. 1 when one take is a
 * piece of the other, which Jaccard punishes because the larger take's
 * extra shingles count against it.
 */
export function containment(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  const smaller = a.size <= b.size ? a : b;
  const larger = smaller === a ? b : a;
  if (smaller.size === 0) return 0;
  let shared = 0;
  for (const entry of smaller) if (larger.has(entry)) shared += 1;
  return shared / smaller.size;
}

/** Terminal punctuation, allowing a closing quote or bracket after it. */
export function endsSentence(text: string): boolean {
  return /[.!?…]["'»”)\]]*$/.test(text.trim());
}

/**
 * A restart is a word pair said again within `windowSeconds` of the first
 * time ("so the, so the market"). Each repeat counts once.
 */
export function countRestarts(words: TimedWord[], windowSeconds = 3): number {
  const seen = new Map<string, number[]>();
  let restarts = 0;
  let skipUntil = -1;
  for (let index = 0; index + 1 < words.length; index += 1) {
    const first = normalizeWord(words[index]!.text);
    const second = normalizeWord(words[index + 1]!.text);
    if (!first || !second) continue;
    const key = `${first} ${second}`;
    const start = words[index]!.start;
    const earlier = seen.get(key) ?? [];
    const repeated = earlier.some((time) => start - time <= windowSeconds && start - time > 0);
    if (repeated && index > skipUntil) {
      restarts += 1;
      // The pair after a counted repeat is the same restart continuing.
      skipUntil = index + 1;
    }
    earlier.push(start);
    seen.set(key, earlier);
  }
  return restarts;
}

export function countFillers(words: TimedWord[], fillers: ReadonlySet<string>): number {
  let count = 0;
  for (const word of words) {
    for (const token of word.text.split(/\s+/)) {
      if (fillers.has(normalizeWord(token))) count += 1;
    }
  }
  return count;
}

/** Pauses between consecutive words longer than the threshold. */
export function countLongPauses(words: TimedWord[], longerThanSeconds: number): number {
  let count = 0;
  for (let index = 1; index < words.length; index += 1) {
    if (words[index]!.start - words[index - 1]!.end > longerThanSeconds) count += 1;
  }
  return count;
}

export function excerpt(text: string, max = 160): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}
