import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  parseSubtitleCues,
  stripCueMarkup,
  subtitleProxyPathToObjectKey,
  type SubtitleCue,
} from '../subtitle-validation';
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
const FALLBACK_SIZE = { width: 1920, height: 1080 };

/** What the render needs to know about the file it is about to re-encode. */
type ProbedVideo = { width: number; height: number; hasAudio: boolean };

type ProbedStream = {
  codec_type?: unknown;
  width?: unknown;
  height?: unknown;
  disposition?: { attached_pic?: unknown };
  side_data_list?: Array<{ side_data_type?: unknown; rotation?: unknown }>;
};

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
  /** Removes an object we uploaded, when the row that would own it never lands. */
  deleteObject: (key: string) => Promise<void>;
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
  /** Removes the working directory; a test can watch that it happens. */
  removeDir?: (path: string) => Promise<void>;
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

/**
 * What gets burned in, and what is copied onto the new version afterwards. The
 * two are not the same text: `words` is regrouped and possibly upper-cased for
 * the picture, while the carried-forward transcript comes from the source rows
 * (`segments`) or the track's own cues (`trackCues`), as the operator wrote
 * them.
 */
type Material = {
  words: TimedWord[];
  language: string;
  /** The transcript lines to carry forward; null when the words came from a track. */
  segments: TranscriptSegmentRow[] | null;
  /** The track's cues as parsed, before regrouping; null for a transcript source. */
  trackCues: SubtitleCue[] | null;
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
  if (!track) return { words: [], language: 'und', segments: null, trackCues: null };
  // Through the same validator the upload API writes with, so the object key
  // is one we could have written rather than whatever the column happens to
  // hold. A row that fails it points at nothing we can fetch.
  const key =
    typeof track.sourceUrl === 'string' ? subtitleProxyPathToObjectKey(track.sourceUrl) : null;
  if (!key) {
    throw new Error(`Caption track ${subtitleId} does not point at a subtitle file we can read`);
  }

  const dest = join(dir, 'source.vtt');
  await deps.downloadObject(key, dest);
  const readText = deps.readText ?? ((path: string) => readFile(path, 'utf8'));
  // `parseSubtitleCues` keeps `<i>`, `<v Alice>` and friends, and escapes stray
  // angle brackets to `&lt;` — right for a file a browser will parse, wrong for
  // one libass draws letter by letter.
  const cues = parseSubtitleCues(await readText(dest))
    .map((cue) => ({ ...cue, text: stripCueMarkup(cue.text) }))
    .filter((cue) => cue.text.length > 0);
  return {
    words: cues.flatMap((cue) => cueWords(cue)),
    language: languageOf(track.language),
    segments: null,
    trackCues: cues,
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
  if (!transcript) return { words: [], language: 'und', segments: null, trackCues: null };

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
  // No duration to clamp against here: the words are the whole of what the
  // transcript timed, and the burn keeps the picture end to end.
  const timed = wordsFromSegments(segments, 0);
  // Zero-length words go before the guard rather than into the cues: a
  // transcript that timed only part of itself — an imported file appended to a
  // recognised one, say — would otherwise scatter instant-long cues through
  // the picture, and what it did time is still worth burning.
  const words = timed.filter((word) => word.end > word.start);
  // A .txt or .docx transcript is stored READY with every segment 0-0 and no
  // word timings, so that filter takes all of them: every cue would start and
  // end at the same instant, libass would draw nothing, and the job would
  // report a successful render of an unchanged picture. Refuse it while the
  // operator can still be told why.
  if (timed.length > 0 && words.length === 0) {
    throw new Error("This version's transcript has no timings to burn in");
  }
  return {
    words,
    language: languageOf(transcript.language),
    segments,
    trackCues: null,
  };
}

/**
 * A display matrix turns a stored frame a quarter turn. Phones record
 * landscape and tag the rotation rather than transposing the pixels, so a
 * portrait clip is stored 1920x1080 with -90 in its side data.
 */
function displayRotation(stream: ProbedStream | undefined): number {
  const matrix = stream?.side_data_list?.find((entry) => entry.side_data_type === 'Display Matrix');
  // Older ffprobe builds write it as a string, and it is signed either way.
  const rotation = Number(matrix?.rotation);
  return Number.isFinite(rotation) ? rotation : 0;
}

/**
 * The frame the ASS document is written against, and whether there is any
 * audio to re-time with it.
 *
 * Every stream is listed rather than just the first video one. A re-timed
 * render names `[0:a:0]` in its filtergraph and doing that to a silent source
 * fails the encode; cover art in an MP4 is a second video stream, and picking
 * it would size the captions to the artwork; and a rotated clip has to be
 * measured the way ffmpeg's own autorotate will present it, or the ASS declares
 * a landscape frame for a portrait picture and libass stretches the text.
 */
async function probeVideo(deps: BurnInDeps, path: string): Promise<ProbedVideo> {
  const probed = await deps.run('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', path]);
  if (probed.code !== 0) throw new Error(probed.stderr || 'ffprobe failed');
  let parsed: { streams?: ProbedStream[] };
  try {
    parsed = JSON.parse(probed.stdout) as { streams?: ProbedStream[] };
  } catch {
    throw new Error('ffprobe returned output we could not read');
  }

  const streams = parsed.streams ?? [];
  const hasAudio = streams.some((stream) => stream.codec_type === 'audio');
  const videos = streams.filter((stream) => stream.codec_type === 'video');
  const video = videos.find((stream) => !stream.disposition?.attached_pic) ?? videos[0];
  const width = Number(video?.width);
  const height = Number(video?.height);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    // Valid JSON, no usable dimensions: the ASS scale is all that depends on
    // them, so a default beats refusing to render.
    return { ...FALLBACK_SIZE, hasAudio };
  }
  // ffmpeg's CLI autorotate transposes before the filter chain, so what reaches
  // the `ass` filter is already the right way up.
  const upright = Math.abs(displayRotation(video)) % 180 === 90;
  return upright ? { width: height, height: width, hasAudio } : { width, height, hasAudio };
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

/**
 * The track's own cues as transcript lines, at the new speed. Taken from the
 * parsed cues rather than the ones that were burned in: those have been
 * regrouped to the operator's words-per-cue and possibly upper-cased, and
 * neither belongs in a transcript people read and search.
 */
function retimedCues(cues: SubtitleCue[], rate: number): DerivedSegment[] {
  return cues.map((cue) => {
    const scaled = { start: round3(cue.start / rate), end: round3(cue.end / rate), text: cue.text };
    return {
      startSec: scaled.start,
      endSec: scaled.end,
      speaker: null,
      text: scaled.text,
      words: cueWords(scaled),
    };
  });
}

/**
 * Take back an object nothing ended up pointing at. Best effort by design: the
 * render has already failed, and the reason it failed is what the job should
 * report — a storage error on top of it would only hide that.
 */
async function discardUpload(deps: BurnInDeps, key: string): Promise<void> {
  try {
    await deps.deleteObject(key);
  } catch (error) {
    console.error(`burn-in could not remove the orphaned object ${key}`, error);
  }
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
    const probed = await probeVideo(deps, sourcePath);

    const assPath = join(dir, 'subtitles.ass');
    const writeText =
      deps.writeText ?? ((path: string, text: string) => writeFile(path, text, 'utf8'));
    await writeText(assPath, buildAssDocument(cues, style, probed));

    const outputPath = join(dir, 'burned-in.mp4');
    const encoded = await deps.run(
      'ffmpeg',
      burnInFfmpegArgs(sourcePath, assPath, outputPath, style, probed.hasAudio)
    );
    if (encoded.code !== 0) throw new Error(`ffmpeg burn-in failed: ${encoded.stderr}`);
    const readOutput = deps.readOutput ?? ((path: string) => readFile(path));
    const body = await readOutput(outputPath);

    const filename = `${randomUUID()}.mp4`;
    const objectKey = `videos/${filename}`;
    await deps.uploadObject(objectKey, body, 'video/mp4');

    let output: { videoId: string; versionId: string } | null = null;
    let client: PoolClient | null = null;
    try {
      // Taking the connection inside this try, not before it: a pool that
      // cannot hand one out after the upload leaves exactly the same orphaned
      // object as a failed INSERT does, and the catch below is what removes it.
      client = await deps.pool.connect();
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
      await client?.query('ROLLBACK').catch(() => undefined);
      // The file is uploaded but no row will ever name it, and pg-boss will
      // retry the whole render into a fresh key.
      await discardUpload(deps, objectKey);
      throw error;
    } finally {
      client?.release();
    }
    if (!output) {
      await discardUpload(deps, objectKey);
      throw new Error('The video this version belongs to is gone');
    }

    // The burn is what the operator asked for; a transcript that could not be
    // copied over is a missing convenience, not a failed render.
    try {
      await persistDerivedTranscript(deps, {
        versionId: output.versionId,
        language: material.language,
        provider: BURN_IN_PROVIDER,
        segments: material.segments
          ? retimedSegments(material.segments, rate)
          : retimedCues(material.trackCues ?? [], rate),
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
    const removeDir =
      deps.removeDir ?? ((path: string) => rm(path, { recursive: true, force: true }));
    await removeDir(dir);
  }
}
