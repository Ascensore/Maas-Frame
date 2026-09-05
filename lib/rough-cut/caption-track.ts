import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

/**
 * The caption track a job writes for a version, taken out of the worker so
 * both the transcribe job and rough cut materialization write it the same way.
 */

export type CaptionTrackDeps = {
  pool: Pool;
  uploadObject: (key: string, body: Buffer, contentType: string) => Promise<void>;
};

/**
 * Store a WebVTT file for a version's language, replacing the track that was
 * there. Billed to the project owner, as the transcribe job does; the label
 * says the captions came from the transcript.
 */
export async function upsertCaptionTrack(
  deps: CaptionTrackDeps,
  options: { versionId: string; language: string; vtt: string }
): Promise<void> {
  const owner = await deps.pool.query(
    `SELECT p."ownerId" AS owner_id
     FROM video_versions vv
     JOIN videos v ON v.id = vv."videoParentId"
     JOIN projects p ON p.id = v."projectId"
     WHERE vv.id = $1`,
    [options.versionId]
  );
  const billedUserId = owner.rows[0]?.owner_id as string | undefined;
  if (!billedUserId) return;

  const filename = `${randomUUID()}.vtt`;
  const sourceUrl = `/api/upload/subtitle/${filename}`;
  const body = Buffer.from(options.vtt, 'utf8');
  await deps.uploadObject(`subtitles/${filename}`, body, 'text/vtt');

  const existing = await deps.pool.query(
    `SELECT id FROM video_subtitles WHERE "versionId" = $1 AND language = $2`,
    [options.versionId, options.language]
  );
  const label = `Transcript (${options.language})`;
  if (existing.rows[0]) {
    await deps.pool.query(
      `UPDATE video_subtitles
       SET "sourceUrl" = $2, size_bytes = $3, label = $4, "updatedAt" = NOW()
       WHERE id = $1`,
      [existing.rows[0].id, sourceUrl, body.length, label]
    );
    return;
  }
  await deps.pool.query(
    `INSERT INTO video_subtitles
       (id, "versionId", language, label, "sourceUrl", size_bytes, "billedUserId", "createdAt", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, NOW(), NOW())`,
    [options.versionId, options.language, label, sourceUrl, body.length, billedUserId]
  );
}
