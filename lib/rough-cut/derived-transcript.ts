import type { Pool } from 'pg';
import { upsertCaptionTrack } from './caption-track';
import type { TimedWord } from './text';
import type { TranscriptSegmentRow } from './transcript-source';
import type { EditDecision } from './types';
import { serializeWebVtt } from './vtt';

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

/** A word belongs to an edit when at least half of it, or a full second of it, is inside. */
function wordInRange(word: TimedWord, inSeconds: number, outSeconds: number): boolean {
  const overlap = Math.min(word.end, outSeconds) - Math.max(word.start, inSeconds);
  if (overlap <= EPSILON) return false;
  const duration = Math.max(word.end - word.start, EPSILON);
  return overlap >= duration / 2 || overlap >= 1;
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
  ordered.forEach((edit, editIndex) => {
    const shift = edit.timelineStartSeconds - edit.inSeconds;
    for (const word of wordsByVersion.get(edit.sourceVersionId) ?? []) {
      if (!wordInRange(word, edit.inSeconds, edit.outSeconds)) continue;
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
    }
  });
  close();

  const languages = [...transcripts.values()].map((transcript) => transcript.language);
  const language = languages.find((entry) => entry && entry !== 'und') ?? languages[0] ?? 'und';
  return { language: language || 'und', segments };
}

export type DerivedTranscriptDeps = {
  pool: Pool;
  uploadObject: (key: string, body: Buffer, contentType: string) => Promise<void>;
};

/** Write the derived transcript as the version's READY transcript and its caption track. */
export async function persistDerivedTranscript(
  deps: DerivedTranscriptDeps,
  options: { versionId: string; language: string; provider: string; segments: DerivedSegment[] }
): Promise<{ transcriptId: string }> {
  const searchText = options.segments.map((segment) => segment.text).join(' ');
  const upsert = await deps.pool.query(
    `INSERT INTO transcripts (id, version_id, language, provider, status, search_text, error, created_at, updated_at)
     VALUES (gen_random_uuid()::text, $1, $2, $3, 'READY', $4, NULL, NOW(), NOW())
     ON CONFLICT (version_id, language)
     DO UPDATE SET provider = EXCLUDED.provider, status = 'READY', search_text = EXCLUDED.search_text, error = NULL,
       translation_language = NULL, translation_status = NULL, translation_error = NULL, translated_texts = NULL, updated_at = NOW()
     RETURNING id`,
    [options.versionId, options.language, options.provider, searchText]
  );
  const transcriptId = upsert.rows[0]?.id;
  if (typeof transcriptId !== 'string' || !transcriptId) {
    throw new Error('Could not store the derived transcript');
  }
  await deps.pool.query(`DELETE FROM transcript_segments WHERE transcript_id = $1`, [transcriptId]);
  for (let index = 0; index < options.segments.length; index += 1) {
    const segment = options.segments[index]!;
    await deps.pool.query(
      `INSERT INTO transcript_segments (id, transcript_id, start_sec, end_sec, speaker, text, words, position, created_at)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6::jsonb, $7, NOW())`,
      [
        transcriptId,
        segment.startSec,
        segment.endSec,
        segment.speaker,
        segment.text,
        JSON.stringify(segment.words),
        index,
      ]
    );
  }
  await upsertCaptionTrack(deps, {
    versionId: options.versionId,
    language: options.language,
    vtt: serializeWebVtt(
      options.segments.map((segment) => ({
        start: segment.startSec,
        end: segment.endSec,
        text: segment.text,
      }))
    ),
  });
  return { transcriptId };
}
