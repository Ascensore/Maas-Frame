import { secondsToFrames, type FrameRate } from '../timecode';
import { beatText, type Beat } from './beats';
import { endsSentence, excerpt, normalizeWord, primaryLanguage } from './text';
import type { CutIsland, EditDecision, Marker, MarkerKind, MarkerReasonCode } from './types';

/**
 * Placeholder markers: where an infographic or B-roll would go, decided by
 * rules over the transcript with no model call. Jargon (an acronym, a
 * figure with a currency symbol or percent, a capitalised multi-word term
 * away from a sentence start) suggests an infographic; a demonstrative cue
 * ("as you can see", "ecco") suggests B-roll. One marker per beat per kind,
 * at the first match, running to the end of the beat.
 *
 * Markers are found on source material and placed on the program only once
 * the edits are final, so a marker never lands on removed material.
 */

const EPSILON = 1e-6;

/** A marker on source material, before it is keyed and placed on the program. */
export type SourceMarker = {
  versionId: string;
  kind: MarkerKind;
  /** Source-local start of the matched word. */
  start: number;
  /** Source-local end of the beat. */
  end: number;
  title: string;
  reason: { code: MarkerReasonCode; summary: string };
};

const ILLUSTRATION_CUES: Record<string, readonly string[]> = {
  en: [
    'as you can see',
    'as you see',
    'you can see',
    'here is',
    'here are',
    "here's",
    'this is what',
    'this is how',
    'look at this',
    'take a look',
    'let me show you',
    "i'll show you",
    'i will show you',
  ],
  it: [
    'come vedete',
    'come vedi',
    'come potete vedere',
    'come puoi vedere',
    'ecco',
    'guardate',
    'guarda qui',
    'vi mostro',
    'ti mostro',
    'vi faccio vedere',
    'ti faccio vedere',
  ],
};

/** Demonstrative cues for a transcript language; empty for languages without a list. */
export function illustrationCuesFor(language: string | null | undefined): readonly string[] {
  return ILLUSTRATION_CUES[primaryLanguage(language)] ?? [];
}

/** Uppercase tokens that are everyday words rather than jargon. */
const ACRONYM_STOPLIST = new Set(['OK', 'AM', 'PM']);

const EDGE_PUNCTUATION = /^[^\p{L}\p{N}$€£¥%]+|[^\p{L}\p{N}$€£¥%]+$/gu;

function bare(token: string): string {
  return token.replace(EDGE_PUNCTUATION, '');
}

const ACRONYM = /^[A-Z]{2,5}s?$/;
const CURRENCY_LEADING = /^[$€£¥]\d[\d.,]*[kKmMbB]?$/;
const CURRENCY_TRAILING = /^\d[\d.,]*[kKmMbB]?[%$€£¥]$/;
const NUMBER = /^\d[\d.,]*[kKmMbB]?$/;
const SYMBOL = /^[%$€£¥]$/;
const CAPITALISED_FIRST = /^[A-Z][a-z]+$/;
const CAPITALISED_NEXT = /^[A-Z][a-z]*$/;

/** A capital that continues a term ("Series A"), as opposed to the pronoun. */
function continuesTerm(token: string): boolean {
  return CAPITALISED_NEXT.test(token) && token !== 'I';
}

type Token = { raw: string; text: string; wordIndex: number };

/**
 * Raw transcript words split to tokens that remember their word, so a
 * segment without word timings (one pseudo-word for the whole sentence)
 * is searched word by word like a timed one.
 */
function tokensOf(words: string[]): Token[] {
  const out: Token[] = [];
  words.forEach((word, wordIndex) => {
    for (const raw of word.split(/\s+/)) {
      const text = bare(raw);
      if (text) out.push({ raw, text, wordIndex });
    }
  });
  return out;
}

export type JargonMatch = { wordIndex: number; term: string };

/** The first jargon-like term in a list of raw transcript words, or null. */
export function findJargon(words: string[]): JargonMatch | null {
  const tokens = tokensOf(words);
  for (let index = 0; index < tokens.length; index += 1) {
    const { text: token, wordIndex } = tokens[index]!;
    if (ACRONYM.test(token) && !ACRONYM_STOPLIST.has(token)) {
      return { wordIndex, term: token };
    }
    if (CURRENCY_LEADING.test(token) || CURRENCY_TRAILING.test(token)) {
      return { wordIndex, term: token };
    }
    const next = tokens[index + 1]?.text;
    if (next !== undefined) {
      if (SYMBOL.test(token) && NUMBER.test(next)) {
        return { wordIndex, term: `${token}${next}` };
      }
      if (NUMBER.test(token) && SYMBOL.test(next)) {
        return { wordIndex, term: `${token}${next}` };
      }
    }
    if (!CAPITALISED_FIRST.test(token)) continue;
    let last = index;
    while (last + 1 < tokens.length && continuesTerm(tokens[last + 1]!.text)) last += 1;
    const atSentenceStart = index === 0 || endsSentence(tokens[index - 1]!.raw);
    if (atSentenceStart) {
      // "New York City is big." opens the sentence; skip the whole run.
      index = last;
      continue;
    }
    if (last > index) {
      return {
        wordIndex,
        term: tokens
          .slice(index, last + 1)
          .map((entry) => entry.text)
          .join(' '),
      };
    }
  }
  return null;
}

export type CueMatch = { wordIndex: number; cue: string };

/**
 * The first demonstrative cue in a list of raw transcript words, or null.
 * Fillers are skipped so "as, um, you can see" still matches.
 */
export function findIllustrationCue(
  words: string[],
  cues: readonly string[],
  fillers: ReadonlySet<string>
): CueMatch | null {
  if (cues.length === 0) return null;
  const tokens: Array<{ token: string; wordIndex: number }> = [];
  words.forEach((word, wordIndex) => {
    for (const piece of word.split(/\s+/)) {
      const token = normalizeWord(piece.replace(/[’‘]/g, "'"));
      if (!token || fillers.has(token)) continue;
      tokens.push({ token, wordIndex });
    }
  });
  const sequences = cues.map((cue) => ({ cue, parts: cue.split(' ') }));
  for (let index = 0; index < tokens.length; index += 1) {
    for (const { cue, parts } of sequences) {
      if (index + parts.length > tokens.length) continue;
      const matches = parts.every((part, offset) => tokens[index + offset]!.token === part);
      if (matches) return { wordIndex: tokens[index]!.wordIndex, cue };
    }
  }
  return null;
}

export type MarkerRules = {
  infographicOnJargon: boolean;
  brollOnIllustration: boolean;
};

/** Marker candidates on one beat, per the brief's rules. */
export function markersForBeat(
  beat: Beat,
  options: { rules: MarkerRules; cues: readonly string[]; fillers: ReadonlySet<string> }
): SourceMarker[] {
  const out: SourceMarker[] = [];
  const words = beat.words.map((word) => word.text);
  const context = excerpt(beatText(beat), 60);
  if (options.rules.infographicOnJargon) {
    const jargon = findJargon(words);
    if (jargon) {
      out.push({
        versionId: beat.versionId,
        kind: 'INFOGRAPHIC',
        start: beat.words[jargon.wordIndex]!.start,
        end: beat.end,
        title: `Infographic: ${jargon.term}`,
        reason: { code: 'MARKER_JARGON', summary: `“${jargon.term}” in “${context}”` },
      });
    }
  }
  if (options.rules.brollOnIllustration) {
    const cue = findIllustrationCue(words, options.cues, options.fillers);
    if (cue) {
      out.push({
        versionId: beat.versionId,
        kind: 'BROLL',
        start: beat.words[cue.wordIndex]!.start,
        end: beat.end,
        title: `B-roll: ${cue.cue}`,
        reason: { code: 'MARKER_ILLUSTRATION', summary: `“${cue.cue}” in “${context}”` },
      });
    }
  }
  return out;
}

export function markerKey(marker: SourceMarker, rate: FrameRate): string {
  return `${marker.versionId}:${marker.kind}:${secondsToFrames(marker.start, rate)}`;
}

/**
 * Where an edit sits on the continuous timeline: a source point plus its
 * clip's offset. Multicam edits are straight offsets from their clip and
 * linear clips are laid end to end, so this is one consistent axis across
 * cameras for both layouts, unlike the packed timeline.
 */
type OffsetOf = (versionId: string) => number;

function continuousRange(edit: EditDecision, offsetOf: OffsetOf): { start: number; end: number } {
  const offset = offsetOf(edit.sourceVersionId);
  return { start: edit.inSeconds + offset, end: edit.outSeconds + offset };
}

/**
 * Place source markers on the final program. A marker whose word was
 * removed is dropped; one that survives runs to the end of its beat or of
 * the edit it sits in, whichever comes first.
 */
export function placeMarkers(
  markers: SourceMarker[],
  edits: EditDecision[],
  offsetOf: OffsetOf,
  rate: FrameRate
): Marker[] {
  const placed: Marker[] = [];
  for (const marker of markers) {
    const offset = offsetOf(marker.versionId);
    const at = marker.start + offset;
    const until = marker.end + offset;
    for (const edit of edits) {
      const range = continuousRange(edit, offsetOf);
      if (at < range.start - EPSILON || at >= range.end - EPSILON) continue;
      const timelineSeconds = edit.timelineStartSeconds + (at - range.start);
      const duration = Math.min(until, range.end) - at;
      placed.push({
        key: markerKey(marker, rate),
        kind: marker.kind,
        timelineSeconds,
        durationSeconds: duration > EPSILON ? duration : null,
        title: marker.title,
        reason: marker.reason,
      });
      break;
    }
  }
  return placed.sort(
    (a, b) => a.timelineSeconds - b.timelineSeconds || a.kind.localeCompare(b.kind)
  );
}

/**
 * The program point where a removed range used to be: the start of the
 * first edit after it on the continuous timeline, else the end of the last
 * edit before it. Null when no edit sits on either side.
 */
export function cutMarkerPoint(
  cut: CutIsland,
  edits: EditDecision[],
  offsetOf: OffsetOf
): number | null {
  const offset = offsetOf(cut.sourceVersionId);
  const cutStart = cut.inSeconds + offset;
  const cutEnd = cut.outSeconds + offset;
  let following: { start: number; at: number } | null = null;
  let preceding: { end: number; at: number } | null = null;
  for (const edit of edits) {
    const range = continuousRange(edit, offsetOf);
    if (range.start >= cutEnd - EPSILON && (!following || range.start < following.start)) {
      following = { start: range.start, at: edit.timelineStartSeconds };
    }
    if (range.end <= cutStart + EPSILON && (!preceding || range.end > preceding.end)) {
      preceding = { end: range.end, at: edit.timelineEndSeconds };
    }
  }
  return following?.at ?? preceding?.at ?? null;
}
