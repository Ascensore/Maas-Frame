import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { parseRoughCutDecisionList } from './decision-list';
import {
  DERIVED_TRANSCRIPT_PROVIDER,
  deriveProgramTranscript,
  persistDerivedTranscript,
  type SourceTranscript,
} from './derived-transcript';
import { materializeFfmpegArgs } from './materialize';
import { applyOverrides, parseRoughCutOverrides } from './overrides';
import type { RoughCutDecisionList } from './types';

/**
 * Render the program a run describes, after the reviewer's decisions, and
 * hang it off the project as a video the review page can play. A re-render
 * adds a version to the video the last render made rather than a second
 * video, so comments and share links stay where they are.
 *
 * Lives here rather than in worker/src so it is type-checked and unit tested
 * with the app; the worker image copies this directory next to src.
 */

export type MaterializeDeps = {
  pool: Pool;
  run: (
    command: string,
    args: string[]
  ) => Promise<{ stdout: string; stderr: string; code: number }>;
  downloadObject: (key: string, dest: string) => Promise<void>;
  uploadObject: (key: string, body: Buffer, contentType: string) => Promise<void>;
  objectKeyFromProvider: (version: {
    providerId: string;
    videoId: string;
    originalUrl: string;
  }) => string | null;
  /** Reads the encoded file back; a test can hand in bytes without a filesystem. */
  readOutput?: (path: string) => Promise<Buffer>;
};

export async function materializeRoughCut(
  deps: MaterializeDeps,
  roughCutId: string
): Promise<void> {
  const cutRes = await deps.pool.query(
    `SELECT id, project_id, folder_id, decisions, overrides, output_video_id
     FROM rough_cuts WHERE id = $1`,
    [roughCutId]
  );
  const cut = cutRes.rows[0];
  if (!cut) throw new Error('Rough cut not found');

  const decisions = parseRoughCutDecisionList(cut.decisions);
  if (!decisions || decisions.edits.length === 0) return;

  // The render is of the program the reviewer approved, not of the one the
  // assembler proposed; the review API re-enqueues this job after every save.
  const overrides = parseRoughCutOverrides(cut.overrides);
  const effective = applyOverrides(decisions, overrides);
  if (effective.edits.length === 0) {
    throw new Error('Nothing is left in the program after the reviewer’s cuts');
  }

  const versionIds = [...new Set(effective.edits.map((edit) => edit.sourceVersionId))];
  const versionsRes = await deps.pool.query(
    `SELECT id, "providerId", "videoId", "originalUrl" FROM video_versions WHERE id = ANY($1::text[])`,
    [versionIds]
  );
  const versions = new Map(
    versionsRes.rows.map((row) => [
      row.id as string,
      {
        providerId: row.providerId as string,
        videoId: row.videoId as string,
        originalUrl: row.originalUrl as string,
      },
    ])
  );

  const dir = await mkdtemp(join(tmpdir(), 'of-materialize-'));
  try {
    const localByVersion = new Map<string, string>();
    for (const versionId of versionIds) {
      const version = versions.get(versionId);
      if (!version) throw new Error(`Missing source version ${versionId}`);
      const key = deps.objectKeyFromProvider(version);
      if (!key) throw new Error(`Version ${versionId} has no file to concatenate`);
      const dest = join(dir, `${versionId}.bin`);
      await deps.downloadObject(key, dest);
      localByVersion.set(versionId, dest);
    }

    const segments = effective.edits.map((edit) => {
      const inputPath = localByVersion.get(edit.sourceVersionId);
      if (!inputPath) throw new Error(`Missing source file for ${edit.sourceVersionId}`);
      return {
        inputPath,
        inSeconds: edit.inSeconds,
        outSeconds: edit.outSeconds,
      };
    });

    const outputPath = join(dir, 'rough-cut.mp4');
    const encoded = await deps.run('ffmpeg', materializeFfmpegArgs(segments, outputPath));
    if (encoded.code !== 0) throw new Error(encoded.stderr || 'ffmpeg concat failed');

    const readOutput = deps.readOutput ?? ((path: string) => readFile(path));
    const body = await readOutput(outputPath);
    const filename = `${randomUUID()}.mp4`;
    const objectKey = `videos/${filename}`;
    await deps.uploadObject(objectKey, body, 'video/mp4');
    const originalUrl = `/api/upload/video/${filename}`;

    const output = await createOutputVersion(deps, {
      projectId: String(cut.project_id),
      folderId: typeof cut.folder_id === 'string' && cut.folder_id ? cut.folder_id : null,
      existingVideoId:
        typeof cut.output_video_id === 'string' && cut.output_video_id ? cut.output_video_id : null,
      objectKey,
      originalUrl,
      sizeBytes: body.byteLength,
    });

    await deps.pool.query(
      `UPDATE rough_cuts
       SET output_video_id = $2, rendered_overrides = $3::jsonb, rendered_decisions = $4::jsonb, updated_at = NOW()
       WHERE id = $1`,
      [
        roughCutId,
        output.videoId,
        overrides ? JSON.stringify(overrides) : null,
        JSON.stringify(effective),
      ]
    );

    // The render is what the operator asked for; a transcript that could not
    // be derived is a missing convenience, not a failed render.
    try {
      await writeDerivedTranscript(deps, effective, output.versionId);
    } catch (error) {
      console.error(`derived transcript failed for rough cut ${roughCutId}`, error);
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

/** The name a first render gives the output video, from the folder it came out of. */
async function outputTitle(deps: MaterializeDeps, folderId: string | null): Promise<string> {
  if (!folderId) return 'Rough cut';
  const folderRes = await deps.pool.query(`SELECT name FROM folders WHERE id = $1`, [folderId]);
  const folderName = folderRes.rows[0]?.name;
  if (typeof folderName === 'string' && folderName.trim()) {
    return `Rough cut — ${folderName.trim()}`;
  }
  return 'Rough cut';
}

/**
 * Where the rendered file goes: a new version of the run's output video when
 * it already has one, so the re-render is a version the reviewer can compare
 * against; a new video in the project otherwise.
 */
async function createOutputVersion(
  deps: MaterializeDeps,
  options: {
    projectId: string;
    folderId: string | null;
    existingVideoId: string | null;
    objectKey: string;
    originalUrl: string;
    sizeBytes: number;
  }
): Promise<{ videoId: string; versionId: string }> {
  const existing = options.existingVideoId
    ? await deps.pool.query(`SELECT id FROM videos WHERE id = $1`, [options.existingVideoId])
    : null;
  const versionRowId = randomUUID();

  if (existing?.rows[0]) {
    const videoId = String(existing.rows[0].id);
    const max = await deps.pool.query(
      `SELECT COALESCE(MAX("versionNumber"), 0) AS max FROM video_versions WHERE "videoParentId" = $1`,
      [videoId]
    );
    const next = Number(max.rows[0]?.max ?? 0) + 1;
    await deps.pool.query(
      `UPDATE video_versions SET "isActive" = false WHERE "videoParentId" = $1`,
      [videoId]
    );
    await deps.pool.query(
      `INSERT INTO video_versions (
         id, "versionNumber", "versionLabel", "providerId", "videoId", "originalUrl", title,
         "thumbnailUrl", size_bytes, "isActive", "videoParentId", "createdAt", proxy_status
       ) VALUES ($1, $2, $3, 'r2', $4, $5, $6, '/placeholder-video-thumbnail.png', $7, true, $8, NOW(), 'SKIPPED')`,
      [
        versionRowId,
        next,
        `Re-render ${next - 1}`,
        options.objectKey,
        options.originalUrl,
        `Rough cut v${next}`,
        options.sizeBytes,
        videoId,
      ]
    );
    return { videoId, versionId: versionRowId };
  }

  const title = await outputTitle(deps, options.folderId);
  const last = await deps.pool.query(
    `SELECT position FROM videos WHERE "projectId" = $1 ORDER BY position DESC LIMIT 1`,
    [options.projectId]
  );
  const nextPosition =
    (typeof last.rows[0]?.position === 'number' ? last.rows[0].position : -1) + 1;
  const videoId = randomUUID();
  await deps.pool.query(
    `INSERT INTO videos (id, title, position, folder_id, kind, metadata, "projectId", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, 'VIDEO', '{}'::jsonb, $5, NOW(), NOW())`,
    [videoId, title, nextPosition, options.folderId, options.projectId]
  );
  await deps.pool.query(
    `INSERT INTO video_versions (
       id, "versionNumber", "providerId", "videoId", "originalUrl", title, "thumbnailUrl",
       size_bytes, "isActive", "videoParentId", "createdAt", proxy_status
     ) VALUES ($1, 1, 'r2', $2, $3, $4, '/placeholder-video-thumbnail.png', $5, true, $6, NOW(), 'SKIPPED')`,
    [versionRowId, options.objectKey, options.originalUrl, title, options.sizeBytes, videoId]
  );
  return { videoId, versionId: versionRowId };
}

/**
 * The program's own transcript, mapped word by word out of the source
 * transcripts through the edits, stored on the new version with a caption
 * track to match. Nothing is sent to a transcription provider: every word of
 * the output was already timed in a source.
 */
async function writeDerivedTranscript(
  deps: MaterializeDeps,
  effective: RoughCutDecisionList,
  versionId: string
): Promise<void> {
  const versionIds = [...new Set(effective.edits.map((edit) => edit.sourceVersionId))];
  const rows = await deps.pool.query(
    `SELECT DISTINCT ON (version_id) id, version_id, language
     FROM transcripts WHERE version_id = ANY($1::text[]) AND status = 'READY'
     ORDER BY version_id, created_at ASC`,
    [versionIds]
  );
  const transcripts = new Map<string, SourceTranscript>();
  for (const row of rows.rows) {
    const segments = await deps.pool.query(
      `SELECT start_sec, end_sec, speaker, text, words FROM transcript_segments WHERE transcript_id = $1 ORDER BY position ASC`,
      [row.id]
    );
    transcripts.set(String(row.version_id), {
      language: typeof row.language === 'string' ? row.language : null,
      segments: segments.rows.map((segment) => ({
        startSec: Number(segment.start_sec),
        endSec: Number(segment.end_sec),
        speaker:
          typeof segment.speaker === 'string' && segment.speaker.trim() ? segment.speaker : null,
        text: typeof segment.text === 'string' ? segment.text : '',
        words: segment.words,
      })),
    });
  }
  if (transcripts.size === 0) return;

  const derived = deriveProgramTranscript(effective.edits, transcripts);
  if (derived.segments.length === 0) return;
  await persistDerivedTranscript(deps, {
    versionId,
    language: derived.language,
    provider: DERIVED_TRANSCRIPT_PROVIDER,
    segments: derived.segments,
  });
}
