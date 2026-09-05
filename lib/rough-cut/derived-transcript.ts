import type { Pool } from 'pg';
import { serializeWebVtt } from '../subtitle-validation';
import { upsertCaptionTrack } from './caption-track';
import type { TimedWord } from './text';
import type { TranscriptSegmentRow } from './transcript-source';
import type { EditDecision } from './types';

/**
 * The transcript of a rendered program, derived from the source transcripts
 * through the decision list: every word inside an edit moves by the edit's
 * shift, nothing is transcribed again. Pure apart from `persistDerivedTranscript`.
 */

export type DerivedWord = TimedWord;

export type DerivedSegment = {
  startSec: number;
  endSec: number;
  speaker: string | null;
  text: string;
  words: DerivedWord[];
};

export type SourceTranscript = { language: string | null; segments: TranscriptSegmentRow[] };

export const DERIVED_TRANSCRIPT_PROVIDER = 'rough-cut';
export const DERIVED_SEGMENT_MAX_SECONDS = 8;
export const DERIVED_SEGMENT_MAX_WORDS = 18;
const EPSILON = 1e-6;

type SourceWord = TimedWord & { speaker: string | null; segmentIndex: number };

/** An open segment, keyed by the edit and source segment its words came from. */
type OpenSegment = DerivedSegment & { key: string };

function isTimedWord(value: Partial<TimedWord>): value is TimedWord {
  return (
    typeof value.start === 'number' &&
    Number.isFinite(value.start) &&
    typeof value.end === 'number' &&
    Number.isFinite(value.end) &&
    typeof value.text === 'string' &&
    value.text.trim().length > 0
  );
}

/** Timed words in source order; an untimed segment spreads its text evenly across its range. */
function flattenSource(segments: TranscriptSegmentRow[]): SourceWord[] {
  const out: SourceWord[] = [];
  segments.forEach((segment, segmentIndex) => {
    const speaker = segment.speaker && segment.speaker.trim() ? segment.speaker : null;
    const timed = Array.isArray(segment.words)
      ? (segment.words as Array<Partial<TimedWord>>).filter(isTimedWord)
      : [];
    if (timed.length > 0) {
      for (const word of timed) {
        out.push({
          start: word.start,
          end: Math.max(word.start, word.end),
          text: word.text.trim(),
          speaker,
          segmentIndex,
        });
      }
      return;
    }
    const tokens = segment.text.split(/\s+/).filter(Boolean);
    if (tokens.length === 0 || segment.endSec <= segment.startSec) return;
    const slice = (segment.endSec - segment.startSec) / tokens.length;
    tokens.forEach((text, index) => {
      out.push({
        start: segment.startSec + index * slice,
        end: index === tokens.length - 1 ? segment.endSec : segment.startSec + (index + 1) * slice,
        text,
        speaker,
        segmentIndex,
      });
    });
  });
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

/** Seconds of a word an edit keeps; zero or less when the edit misses it. */
function overlapSeconds(word: TimedWord, inSeconds: number, outSeconds: number): number {
  return Math.min(word.end, outSeconds) - Math.max(word.start, inSeconds);
}

/** A word belongs to an edit when at least half of it, or a full second of it, is inside. */
function wordInRange(word: TimedWord, overlap: number): boolean {
  if (overlap <= EPSILON) return false;
  const duration = Math.max(word.end - word.start, EPSILON);
  return overlap >= duration / 2 || overlap >= 1;
}

/**
 * The one edit each source word is spoken in. A word can reach far enough into
 * two edits either side of a cut to qualify for both, and emitting it twice
 * would stutter the caption and the transcript; the edit that keeps the most of
 * it wins, and an exact tie goes to the earlier position in the program.
 */
function ownersByWord(
  ordered: EditDecision[],
  wordsByVersion: Map<string, SourceWord[]>
): Map<string, number> {
  const owners = new Map<string, number>();
  const best = new Map<string, number>();
  ordered.forEach((edit, editIndex) => {
    const words = wordsByVersion.get(edit.sourceVersionId) ?? [];
    words.forEach((word, wordIndex) => {
      const overlap = overlapSeconds(word, edit.inSeconds, edit.outSeconds);
      if (!wordInRange(word, overlap)) return;
      const key = `${edit.sourceVersionId}#${wordIndex}`;
      const incumbent = best.get(key);
      if (incumbent !== undefined && overlap <= incumbent + EPSILON) return;
      best.set(key, overlap);
      owners.set(key, editIndex);
    });
  });
  return owners;
}

/**
 * The program's language: the one spoken for the longest, not whichever
 * transcript happens to come first. A source whose transcript never got a
 * language is passed over rather than making the whole program `und`.
 */
function programLanguage(
  ordered: EditDecision[],
  transcripts: Map<string, SourceTranscript>
): string {
  const seconds = new Map<string, number>();
  ordered.forEach((edit) => {
    const held = Math.max(0, edit.timelineEndSeconds - edit.timelineStartSeconds);
    seconds.set(edit.sourceVersionId, (seconds.get(edit.sourceVersionId) ?? 0) + held);
  });
  // Insertion order is program order, so a tie keeps the earliest edit's source.
  const ranked = [...seconds.entries()].sort((a, b) => b[1] - a[1]);
  for (const [versionId] of ranked) {
    const language = transcripts.get(versionId)?.language;
    if (language && language !== 'und') return language;
  }
  return 'und';
}

/**
 * A caption line stays readable: one source segment (so one speaker and one
 * sentence), inside one edit, and short enough to sit on screen at once.
 */
function shouldStartNewSegment(open: OpenSegment, key: string, endSec: number): boolean {
  return (
    open.key !== key ||
    open.words.length >= DERIVED_SEGMENT_MAX_WORDS ||
    endSec - open.startSec > DERIVED_SEGMENT_MAX_SECONDS
  );
}

export function deriveProgramTranscript(
  edits: EditDecision[],
  transcripts: Map<string, SourceTranscript>
): { language: string; segments: DerivedSegment[] } {
  const wordsByVersion = new Map<string, SourceWord[]>();
  for (const [versionId, transcript] of transcripts) {
    wordsByVersion.set(versionId, flattenSource(transcript.segments));
  }

  const segments: DerivedSegment[] = [];
  let open: OpenSegment | null = null;
  const close = (): void => {
    const finished = open;
    if (finished && finished.words.length > 0) {
      segments.push({
        startSec: finished.startSec,
        endSec: finished.endSec,
        speaker: finished.speaker,
        text: finished.text,
        words: finished.words,
      });
    }
    open = null;
  };

  const ordered = [...edits].sort((a, b) => a.timelineStartSeconds - b.timelineStartSeconds);
  const owners = ownersByWord(ordered, wordsByVersion);
  ordered.forEach((edit, editIndex) => {
    const shift = edit.timelineStartSeconds - edit.inSeconds;
    const words = wordsByVersion.get(edit.sourceVersionId) ?? [];
    words.forEach((word, wordIndex) => {
      if (owners.get(`${edit.sourceVersionId}#${wordIndex}`) !== editIndex) return;
      const start = Math.max(edit.timelineStartSeconds, word.start + shift);
      const end = Math.min(edit.timelineEndSeconds, Math.max(start, word.end + shift));
      const key = `${editIndex}:${word.segmentIndex}`;
      // A local copy: `open` is assigned inside `close`, which stops the
      // checker from narrowing it away from null after the branch below.
      let target = open;
      if (target === null || shouldStartNewSegment(target, key, end)) {
        close();
        target = { key, startSec: start, endSec: end, speaker: word.speaker, text: '', words: [] };
        open = target;
      }
      target.words.push({ start, end, text: word.text });
      target.endSec = Math.max(target.endSec, end);
      target.text = target.words.map((entry) => entry.text).join(' ');
    });
  });
  close();

  return { language: programLanguage(ordered, transcripts), segments };
}

export type DerivedTranscriptDeps = {
  pool: Pool;
  uploadObject: (key: string, body: Buffer, contentType: string) => Promise<void>;
};

/**
 * Write the derived transcript as the version's READY transcript, then its
 * caption track. The transcript and its segments go in one transaction: a
 * failure halfway through the segments would otherwise leave a READY row whose
 * text is half of the old transcript and half of the new one. The caption track
 * is written after the commit — it is a separate object in storage and a
 * separate row, and losing it is not a reason to throw the transcript away.
 */
export async function persistDerivedTranscript(
  deps: DerivedTranscriptDeps,
  options: { versionId: string; language: string; provider: string; segments: DerivedSegment[] }
): Promise<{ transcriptId: string }> {
  const searchText = options.segments.map((segment) => segment.text).join(' ');
  const client = await deps.pool.connect();
  let transcriptId: string;
  try {
    await client.query('BEGIN');
    const upsert = await client.query(
      `INSERT INTO transcripts (id, version_id, language, provider, status, search_text, error, created_at, updated_at)
       VALUES (gen_random_uuid()::text, $1, $2, $3, 'READY', $4, NULL, NOW(), NOW())
       ON CONFLICT (version_id, language)
       DO UPDATE SET provider = EXCLUDED.provider, status = 'READY', search_text = EXCLUDED.search_text, error = NULL,
         translation_language = NULL, translation_status = NULL, translation_error = NULL, translated_texts = NULL, updated_at = NOW()
       RETURNING id`,
      [options.versionId, options.language, options.provider, searchText]
    );
    const id = upsert.rows[0]?.id;
    if (typeof id !== 'string' || !id) {
      throw new Error('Could not store the derived transcript');
    }
    await client.query(`DELETE FROM transcript_segments WHERE transcript_id = $1`, [id]);
    if (options.segments.length > 0) {
      // One statement rather than a round trip per caption line: a
      // half-hour interview derives hundreds of them.
      await client.query(
        `INSERT INTO transcript_segments (id, transcript_id, start_sec, end_sec, speaker, text, words, position, created_at)
         SELECT gen_random_uuid()::text, $1, s.start_sec, s.end_sec, s.speaker, s.text, s.words::jsonb, s.position, NOW()
         FROM unnest($2::float8[], $3::float8[], $4::text[], $5::text[], $6::text[], $7::int[])
           AS s(start_sec, end_sec, speaker, text, words, position)`,
        [
          id,
          options.segments.map((segment) => segment.startSec),
          options.segments.map((segment) => segment.endSec),
          options.segments.map((segment) => segment.speaker),
          options.segments.map((segment) => segment.text),
          options.segments.map((segment) => JSON.stringify(segment.words)),
          options.segments.map((_segment, index) => index),
        ]
      );
    }
    await client.query('COMMIT');
    transcriptId = id;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  // The transcript rows keep every line, including one nobody timed — it is
  // still text to read and search. The caption track cannot: a cue written
  // `00:00:00.000 --> 00:00:00.000` is one a player never shows and some
  // parsers refuse outright. A burn-in carrying a partly-timed transcript
  // forward is where these arrive. The predicate is spelled out here rather
  // than imported: nothing under lib/rough-cut may reach for `@/` or for
  // lib/transcript-import.ts, because the worker image copies this directory
  // on its own.
  const cues = options.segments.filter((segment) => segment.endSec > segment.startSec);
  // Nothing timed at all: a `WEBVTT` header with no cues is a track the player
  // lists, offers in the menu and then shows nothing for. Leaving the version
  // without one says the same thing honestly.
  if (cues.length === 0) return { transcriptId };
  try {
    await upsertCaptionTrack(deps, {
      versionId: options.versionId,
      language: options.language,
      vtt: serializeWebVtt(
        cues.map((segment) => ({
          start: segment.startSec,
          end: segment.endSec,
          text: segment.text,
        }))
      ),
    });
  } catch (error) {
    console.error(`caption track for version ${options.versionId} failed`, error);
  }
  return { transcriptId };
}
