import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import {
  buildAssDocument,
  parseBurnInStyle,
  regroupWordsIntoCues,
} from '../rough-cut/subtitle-style';
import { createOutputVideo } from '../rough-cut/output-version';
import {
  persistDerivedTranscript,
  DERIVED_TRANSCRIPT_PROVIDER,
  type DerivedSegment,
} from '../rough-cut/derived-transcript';
import { shortLoudnessAnalysisArgs, shortRenderArgs, type LoudnessMeasurement } from './render';

export type RenderShortFormDeps = {
  pool: Pool;
  run: (
    command: string,
    args: string[]
  ) => Promise<{ stdout: string; stderr: string; code: number }>;
  downloadVersionMedia: (
    version: { providerId: string; videoId: string; originalUrl: string },
    dest: string
  ) => Promise<void>;
  uploadObject: (key: string, body: Buffer, contentType: string) => Promise<void>;
};

function jsonObject(text: string): Record<string, unknown> | null {
  const start = text.lastIndexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function parseLoudnessMeasurement(stderr: string): LoudnessMeasurement | null {
  const value = jsonObject(stderr);
  const number = (key: string) => Number(value?.[key]);
  const measurement = {
    inputI: number('input_i'),
    inputTp: number('input_tp'),
    inputLra: number('input_lra'),
    inputThresh: number('input_thresh'),
    targetOffset: number('target_offset'),
  };
  return Object.values(measurement).every(Number.isFinite) ? measurement : null;
}

function sourceWords(
  rows: Array<{ start_sec: unknown; end_sec: unknown; text: unknown; words: unknown }>,
  start: number,
  end: number
) {
  return rows
    .flatMap((row) => {
      if (Array.isArray(row.words)) return row.words;
      return [
        { start: Number(row.start_sec), end: Number(row.end_sec), text: String(row.text ?? '') },
      ];
    })
    .filter(
      (word): word is { start: number; end: number; text: string; speaker?: string } =>
        typeof word === 'object' &&
        word !== null &&
        Number.isFinite(Number((word as { start?: unknown }).start)) &&
        Number.isFinite(Number((word as { end?: unknown }).end)) &&
        typeof (word as { text?: unknown }).text === 'string'
    )
    .map((word) => ({
      start: Number(word.start),
      end: Number(word.end),
      text: word.text,
      speaker: word.speaker,
    }))
    .filter((word) => word.end > start && word.start < end)
    .map((word) => ({
      ...word,
      start: Math.max(0, word.start - start),
      end: Math.min(end - start, word.end - start),
    }));
}

function derivedSegmentFromWords(words: ReturnType<typeof sourceWords>): DerivedSegment[] {
  if (words.length === 0) return [];
  return [
    {
      startSec: words[0]!.start,
      endSec: words[words.length - 1]!.end,
      speaker: null,
      text: words.map((word) => word.text).join(' '),
      words,
    },
  ];
}

async function enqueueProbeOnce(deps: RenderShortFormDeps, versionId: string): Promise<void> {
  await deps.pool.query(
    `INSERT INTO media_jobs (id, kind, status, version_id, attempts, created_at, updated_at)
     SELECT gen_random_uuid()::text, 'PROBE_MEDIA', 'PENDING', $1, 0, NOW(), NOW()
     WHERE NOT EXISTS (
       SELECT 1 FROM media_jobs
       WHERE version_id = $1 AND kind = 'PROBE_MEDIA' AND status IN ('PENDING', 'QUEUED', 'RUNNING', 'SUCCEEDED')
     )`,
    [versionId]
  );
}

export async function renderShortFormCandidate(
  deps: RenderShortFormDeps,
  candidateId: string
): Promise<void> {
  const startedAt = Date.now();
  const res = await deps.pool.query(
    `SELECT c.*, b.source_version_id, rc.project_id, rc.folder_id,
            vv."providerId", vv."videoId", vv."originalUrl", vv.frame_rate_num, vv.frame_rate_den,
            v.title AS source_title
     FROM short_form_candidates c
     JOIN short_form_batches b ON b.id = c.batch_id
     JOIN rough_cuts rc ON rc.id = b.rough_cut_id
     JOIN video_versions vv ON vv.id = b.source_version_id
     JOIN videos v ON v.id = vv."videoParentId"
     WHERE c.id = $1`,
    [candidateId]
  );
  const candidate = res.rows[0];
  if (!candidate) throw new Error('Short-form candidate not found');
  if (candidate.status === 'READY' && candidate.output_video_id) return;
  if (!['APPROVED', 'FAILED', 'RENDERING'].includes(String(candidate.status))) {
    throw new Error('Short-form candidate is not approved');
  }
  await deps.pool.query(
    `UPDATE short_form_candidates SET status = 'RENDERING', error = NULL, updated_at = NOW() WHERE id = $1`,
    [candidateId]
  );
  let dir: string | null = null;
  try {
    const segments = await deps.pool.query(
      `SELECT t.language, ts.start_sec, ts.end_sec, ts.text, ts.words
     FROM transcripts t JOIN transcript_segments ts ON ts.transcript_id = t.id
     WHERE t.version_id = $1 AND t.status = 'READY'
       AND t.created_at = (SELECT MIN(t2.created_at) FROM transcripts t2 WHERE t2.version_id = $1 AND t2.status = 'READY')
     ORDER BY ts.position ASC`,
      [candidate.source_version_id]
    );
    const start = Number(candidate.source_start_sec);
    const end = Number(candidate.source_end_sec);
    const words = sourceWords(segments.rows, start, end);
    const language =
      typeof segments.rows[0]?.language === 'string' && segments.rows[0].language
        ? segments.rows[0].language
        : 'und';
    const derived = derivedSegmentFromWords(words);
    if (candidate.output_video_id) {
      const existing = await deps.pool.query(
        `SELECT id FROM video_versions WHERE "videoParentId" = $1 AND "isActive" = true ORDER BY "versionNumber" DESC LIMIT 1`,
        [candidate.output_video_id]
      );
      const versionId = existing.rows[0]?.id;
      if (typeof versionId === 'string' && versionId) {
        if (derived.length > 0) {
          await persistDerivedTranscript(deps, {
            versionId,
            language,
            provider: `${DERIVED_TRANSCRIPT_PROVIDER}-short`,
            segments: derived,
          });
        }
        await enqueueProbeOnce(deps, versionId);
        await deps.pool.query(
          `UPDATE short_form_candidates SET status = 'READY', error = NULL, updated_at = NOW() WHERE id = $1`,
          [candidateId]
        );
        return;
      }
    }
    dir = await mkdtemp(join(tmpdir(), 'of-short-render-'));
    const sourcePath = join(dir, 'source.mp4');
    const outputPath = join(dir, 'short.mp4');
    const assPath = join(dir, 'captions.ass');
    await deps.downloadVersionMedia(
      {
        providerId: String(candidate.providerId),
        videoId: String(candidate.videoId),
        originalUrl: String(candidate.originalUrl),
      },
      sourcePath
    );
    const probe = await deps.run('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height,r_frame_rate',
      '-of',
      'json',
      sourcePath,
    ]);
    if (probe.code !== 0) throw new Error(probe.stderr || 'Could not probe short source');
    const stream = (
      JSON.parse(probe.stdout) as {
        streams?: Array<{ width?: number; height?: number; r_frame_rate?: string }>;
      }
    ).streams?.[0];
    if (!stream?.width || !stream.height) throw new Error('Short source has no video stream');
    const [fpsNum, fpsDen] = (stream.r_frame_rate ?? '30/1').split('/').map(Number);
    const fps = fpsNum && fpsDen ? fpsNum / fpsDen : 30;
    const style = parseBurnInStyle(candidate.caption_style);
    if (!style.ok) throw new Error(style.error);
    const cues = regroupWordsIntoCues(words, style.value);
    await writeFile(
      assPath,
      buildAssDocument(cues, style.value, { width: 1080, height: 1920 }),
      'utf8'
    );

    const analyzed = await deps.run('ffmpeg', shortLoudnessAnalysisArgs(sourcePath, start, end));
    const loudness = parseLoudnessMeasurement(analyzed.stderr);
    if (analyzed.code !== 0 || !loudness)
      throw new Error(analyzed.stderr || 'Loudness analysis failed');
    const encoded = await deps.run(
      'ffmpeg',
      shortRenderArgs({
        inputPath: sourcePath,
        outputPath,
        assPath,
        start,
        end,
        sourceWidth: Number(stream.width),
        sourceHeight: Number(stream.height),
        sourceFps: fps,
        focusX: candidate.crop_mode === 'MANUAL' ? Number(candidate.focus_x) : null,
        focusY: candidate.crop_mode === 'MANUAL' ? Number(candidate.focus_y) : null,
        cropMode: candidate.crop_mode,
        cropTrack: Array.isArray(candidate.crop_track) ? candidate.crop_track : undefined,
        loudness,
      })
    );
    if (encoded.code !== 0) throw new Error(encoded.stderr || 'Short render failed');
    const body = await readFile(outputPath);
    const filename = `${randomUUID()}.mp4`;
    await deps.uploadObject(`videos/${filename}`, body, 'video/mp4');
    const output = await createOutputVideo(deps, {
      projectId: String(candidate.project_id),
      folderId: typeof candidate.folder_id === 'string' ? candidate.folder_id : null,
      objectKey: `videos/${filename}`,
      originalUrl: `/api/upload/video/${filename}`,
      sizeBytes: body.byteLength,
      title: String(candidate.title),
      duration: Math.ceil(end - start),
      metadata: {
        shortForm: {
          candidateId,
          title: String(candidate.title),
          socialCaption: String(candidate.social_caption ?? ''),
          hashtags: candidate.hashtags,
        },
      },
      onCreated: async (client, created) => {
        const linked = await client.query(
          `UPDATE short_form_candidates
           SET output_video_id = $2, updated_at = NOW()
           WHERE id = $1 AND output_video_id IS NULL`,
          [candidateId, created.videoId]
        );
        if (linked.rowCount !== 1) throw new Error('Short output was already linked');
      },
    });
    if (derived.length > 0) {
      await persistDerivedTranscript(deps, {
        versionId: output.versionId,
        language,
        provider: `${DERIVED_TRANSCRIPT_PROVIDER}-short`,
        segments: derived,
      });
    }
    await deps.pool.query(
      `UPDATE short_form_candidates SET status = 'READY', output_video_id = $2, error = NULL, updated_at = NOW() WHERE id = $1`,
      [candidateId, output.videoId]
    );
    await enqueueProbeOnce(deps, output.versionId);
    console.info(
      JSON.stringify({
        event: 'short_form_render_complete',
        candidateId,
        cropMode: candidate.crop_mode,
        durationMs: Date.now() - startedAt,
        outputVersionId: output.versionId,
      })
    );
  } catch (error) {
    await deps.pool.query(
      `UPDATE short_form_candidates SET status = 'FAILED', error = $2, updated_at = NOW() WHERE id = $1`,
      [candidateId, error instanceof Error ? error.message : String(error)]
    );
    throw error;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}
