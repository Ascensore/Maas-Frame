import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { z } from 'zod';
import { parseSubtitleCues, type SubtitleCue } from '../subtitle-validation';
import { wordsFromSegments } from './beats';
import { persistDerivedTranscript, type DerivedSegment } from './derived-transcript';
import { addOutputVersion } from './output-version';
import {
  buildAssDocument,
  burnInFfmpegArgs,
  burnInStyleSchema,
  regroupWordsIntoCues,
  scaleCueTimes,
  type BurnInStyle,
} from './subtitle-style';
import type { TimedWord } from './text';
import type { TranscriptSegmentRow } from './transcript-source';

/**
 * Burn subtitles into the picture. The words come from the version's own
 * transcript or from one of its caption tracks, are regrouped into the cues
 * the operator's style asks for, and are rendered by libass while ffmpeg
 * re-encodes. The result is another version of the same video, so comments and
 * share links stay where they are, and the transcript travels with it — re-timed
 * when the playback rate changed — so the burned copy stays searchable and
 * reviewable without being transcribed again.
 *
 * Lives here rather than in worker/src so it is type-checked and unit tested
 * with the app; the worker image copies this directory next to src.
 */

export const BURN_IN_PROVIDER = 'burn-in';

/** The default frame size when ffprobe cannot tell us; only the ASS scale depends on it. */
const FALLBACK_VIDEO = { width: 1920, height: 1080 };

export type BurnInSource =
  | { kind: 'transcript'; transcriptId: string | null }
  | { kind: 'subtitle'; subtitleId: string };

export type BurnInPayload = {
  style: BurnInStyle;
  source: BurnInSource;
  requestedById?: string;
};

export type BurnInDeps = {
  pool: Pool;
  run: (
    command: string,
    args: string[]
  ) => Promise<{ stdout: string; stderr: string; code: number }>;
  downloadObject: (key: string, dest: string) => Promise<void>;
  uploadObject: (key: string, body: Buffer, contentType: string) => Promise<void>;
  downloadVersionMedia: (
    version: { providerId: string; videoId: string; originalUrl: string },
    dest: string
  ) => Promise<void>;
  /** Reads the encoded file back; a test can hand in bytes without a filesystem. */
  readOutput?: (path: string) => Promise<Buffer>;
  /** Reads the downloaded caption file. */
  readText?: (path: string) => Promise<string>;
  /** Writes the ASS document ffmpeg renders from. */
  writeText?: (path: string, text: string) => Promise<void>;
};

const burnInSourceSchema = z.union([
  z
    .object({
      kind: z.literal('transcript'),
      // Absent means "whichever transcript this version has".
      transcriptId: z.string().nullable().default(null),
    })
    .strict(),
  z.object({ kind: z.literal('subtitle'), subtitleId: z.string().min(1) }).strict(),
]);

const burnInPayloadSchema = z
  .object({
    style: burnInStyleSchema,
    source: burnInSourceSchema,
    requestedById: z.string().optional(),
  })
  .strict();

/** The job payload as the API route stored it; null when it is not one we can run. */
export function parseBurnInPayload(value: unknown): BurnInPayload | null {
  const parsed = burnInPayloadSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

type VersionRow = {
  providerId: string;
  videoId: string;
  originalUrl: string;
  videoParentId: string;
  duration: number | null;
  title: string | null;
};

/** What gets burned in, and what is copied onto the new version afterwards. */
type Material = {
  words: TimedWord[];
  language: string;
  /** The transcript lines to carry forward; null when the words came from a track. */
  segments: TranscriptSegmentRow[] | null;
};

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * A caption cue as timed words. A track only times whole lines, so the words
 * are spread evenly across the cue; the regrouping that follows needs a time
 * per word, and an even spread is the only honest guess available.
 */
export function cueWords(cue: SubtitleCue): TimedWord[] {
  const tokens = cue.text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const slice = Math.max(0, cue.end - cue.start) / tokens.length;
  return tokens.map((text, index) => ({
    start: round3(cue.start + index * slice),
    end: round3(index === tokens.length - 1 ? cue.end : cue.start + (index + 1) * slice),
    text,
  }));
}

function languageOf(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value : 'und';
}

/** The last path segment of a stored subtitle URL, which is its object name. */
function subtitleObjectKey(sourceUrl: string): string | null {
  const name = sourceUrl.split('/').filter(Boolean).pop();
  if (!name) return null;
  return `subtitles/${name}`;
}

async function captionTrackMaterial(
  deps: BurnInDeps,
  versionId: string,
  subtitleId: string,
  dir: string
): Promise<Material> {
  const trackRes = await deps.pool.query(
    `SELECT "sourceUrl", language FROM video_subtitles WHERE id = $1 AND "versionId" = $2`,
    [subtitleId, versionId]
  );
  const track = trackRes.rows[0];
  if (!track) return { words: [], language: 'und', segments: null };
  const key = typeof track.sourceUrl === 'string' ? subtitleObjectKey(track.sourceUrl) : null;
  if (!key) return { words: [], language: languageOf(track.language), segments: null };

  const dest = join(dir, 'source.vtt');
  await deps.downloadObject(key, dest);
  const readText = deps.readText ?? ((path: string) => readFile(path, 'utf8'));
  const cues = parseSubtitleCues(await readText(dest));
  return {
    words: cues.flatMap((cue) => cueWords(cue)),
    language: languageOf(track.language),
    segments: null,
  };
}

async function transcriptMaterial(
  deps: BurnInDeps,
  versionId: string,
  transcriptId: string | null
): Promise<Material> {
  // A specific transcript has to belong to this version: the id arrives in a
  // job payload, and burning another version's words into this picture would
  // be worse than refusing.
  const transcriptRes = transcriptId
    ? await deps.pool.query(
        `SELECT id, language FROM transcripts WHERE id = $1 AND version_id = $2 AND status = 'READY'`,
        [transcriptId, versionId]
      )
    : await deps.pool.query(
        `SELECT id, language FROM transcripts WHERE version_id = $1 AND status = 'READY'
         ORDER BY created_at ASC LIMIT 1`,
        [versionId]
      );
  const transcript = transcriptRes.rows[0];
  if (!transcript) return { words: [], language: 'und', segments: null };

  const segmentsRes = await deps.pool.query(
    `SELECT start_sec, end_sec, speaker, text, words FROM transcript_segments
     WHERE transcript_id = $1 ORDER BY position ASC`,
    [transcript.id]
  );
  const segments: TranscriptSegmentRow[] = segmentsRes.rows.map((row) => ({
    startSec: Number(row.start_sec),
    endSec: Number(row.end_sec),
    speaker: typeof row.speaker === 'string' && row.speaker.trim() ? row.speaker : null,
    text: typeof row.text === 'string' ? row.text : '',
    words: row.words,
  }));
  return {
    // No duration to clamp against here: the words are the whole of what the
    // transcript timed, and the burn keeps the picture end to end.
    words: wordsFromSegments(segments, 0),
    language: languageOf(transcript.language),
    segments,
  };
}

/** The frame size the ASS document is written against. */
async function probeVideoSize(
  deps: BurnInDeps,
  path: string
): Promise<{ width: number; height: number }> {
  const probed = await deps.run('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height',
    '-of',
    'json',
    path,
  ]);
  try {
    const parsed = JSON.parse(probed.stdout) as {
      streams?: Array<{ width?: unknown; height?: unknown }>;
    };
    const stream = parsed.streams?.[0];
    const width = Number(stream?.width);
    const height = Number(stream?.height);
    if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
      return { width, height };
    }
  } catch {
    // Not JSON, so ffprobe told us nothing usable.
  }
  return FALLBACK_VIDEO;
}

/** The source transcript at the new speed: every time divided by the rate. */
function retimedSegments(segments: TranscriptSegmentRow[], rate: number): DerivedSegment[] {
  return segments.map((segment) => ({
    startSec: round3(segment.startSec / rate),
    endSec: round3(segment.endSec / rate),
    speaker: segment.speaker,
    text: segment.text,
    // Through wordsFromSegments so a line without word timings still carries
    // one, the same way every other reader of these rows sees them.
    words: wordsFromSegments([segment], 0).map((word) => ({
      start: round3(word.start / rate),
      end: round3(word.end / rate),
      text: word.text,
    })),
  }));
}

/** The burned cues as transcript lines, for a version whose words came from a track. */
function segmentsFromCues(cues: SubtitleCue[]): DerivedSegment[] {
  return cues.map((cue) => ({
    startSec: cue.start,
    endSec: cue.end,
    speaker: null,
    text: cue.text,
    words: cueWords(cue),
  }));
}

export async function burnInSubtitles(
  deps: BurnInDeps,
  versionId: string,
  payload: BurnInPayload
): Promise<void> {
  const versionRes = await deps.pool.query(
    `SELECT vv.id, vv."providerId", vv."videoId", vv."originalUrl", vv."videoParentId", vv.duration, vv.title
     FROM video_versions vv WHERE vv.id = $1`,
    [versionId]
  );
  const row = versionRes.rows[0];
  if (!row) throw new Error('Version not found');
  const version: VersionRow = {
    providerId: String(row.providerId),
    videoId: String(row.videoId),
    originalUrl: String(row.originalUrl),
    videoParentId: String(row.videoParentId),
    duration: typeof row.duration === 'number' ? row.duration : null,
    title: typeof row.title === 'string' ? row.title : null,
  };

  const style = payload.style;
  const rate = style.playbackRate;
  const dir = await mkdtemp(join(tmpdir(), 'of-burn-in-'));
  try {
    // Every row this job reads is read before the master is downloaded: a
    // version with nothing to burn should fail in a second, not after pulling
    // a camera file across the network.
    const material =
      payload.source.kind === 'subtitle'
        ? await captionTrackMaterial(deps, versionId, payload.source.subtitleId, dir)
        : await transcriptMaterial(deps, versionId, payload.source.transcriptId);
    if (material.words.length === 0) {
      throw new Error('This version has no transcript or caption track to burn in');
    }

    const cues = scaleCueTimes(regroupWordsIntoCues(material.words, style), rate);

    const sourcePath = join(dir, 'source.bin');
    await deps.downloadVersionMedia(
      {
        providerId: version.providerId,
        videoId: version.videoId,
        originalUrl: version.originalUrl,
      },
      sourcePath
    );
    const size = await probeVideoSize(deps, sourcePath);

    const assPath = join(dir, 'subtitles.ass');
    const writeText =
      deps.writeText ?? ((path: string, text: string) => writeFile(path, text, 'utf8'));
    await writeText(assPath, buildAssDocument(cues, style, size));

    const outputPath = join(dir, 'burned-in.mp4');
    const encoded = await deps.run(
      'ffmpeg',
      burnInFfmpegArgs(sourcePath, assPath, outputPath, style)
    );
    if (encoded.code !== 0) throw new Error(`ffmpeg burn-in failed: ${encoded.stderr}`);
    const readOutput = deps.readOutput ?? ((path: string) => readFile(path));
    const body = await readOutput(outputPath);

    const filename = `${randomUUID()}.mp4`;
    const objectKey = `videos/${filename}`;
    await deps.uploadObject(objectKey, body, 'video/mp4');

    const client = await deps.pool.connect();
    let output: { videoId: string; versionId: string } | null = null;
    try {
      await client.query('BEGIN');
      output = await addOutputVersion(client, {
        videoId: version.videoParentId,
        objectKey,
        originalUrl: `/api/upload/video/${filename}`,
        sizeBytes: body.byteLength,
        label: rate === 1 ? 'Subtitled' : `Subtitled ${rate}x`,
        title: version.title,
        // The picture is as long as the source unless it was re-timed.
        duration: version.duration != null ? Math.round(version.duration / rate) : null,
      });
      await client.query(output ? 'COMMIT' : 'ROLLBACK');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    if (!output) throw new Error('The video this version belongs to is gone');

    // The burn is what the operator asked for; a transcript that could not be
    // copied over is a missing convenience, not a failed render.
    try {
      await persistDerivedTranscript(deps, {
        versionId: output.versionId,
        language: material.language,
        provider: BURN_IN_PROVIDER,
        segments: material.segments
          ? retimedSegments(material.segments, rate)
          : segmentsFromCues(cues),
      });
    } catch (error) {
      console.error(`burn-in transcript for version ${output.versionId} failed`, error);
    }

    await deps.pool.query(
      `INSERT INTO media_jobs (id, kind, status, version_id, attempts, created_at, updated_at)
       VALUES (gen_random_uuid()::text, 'PROBE_MEDIA', 'PENDING', $1, 0, NOW(), NOW())`,
      [output.versionId]
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
