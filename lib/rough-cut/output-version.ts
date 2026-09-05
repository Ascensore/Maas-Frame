import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

/**
 * Where a render puts its file: another version of a video that is already
 * there, or a new video at the end of the project. Shared by the jobs that
 * produce a video — the rough cut materializer and the subtitle burn-in — so
 * both flip the active version the same way.
 */

export type OutputVersionDeps = { pool: Pool };

export type AddOutputVersionOptions = {
  /** The video the new version is added to. */
  videoId: string;
  objectKey: string;
  originalUrl: string;
  sizeBytes: number;
  /** Defaults to `Re-render <n>`, counting renders after the first. */
  label?: string;
  /** Defaults to `Rough cut v<n>`; pass null to leave it unset. */
  title?: string | null;
  /** Seconds. Null when the render does not know, and a probe will fill it in. */
  duration?: number | null;
};

export type CreateOutputVideoOptions = {
  projectId: string;
  folderId: string | null;
  objectKey: string;
  originalUrl: string;
  sizeBytes: number;
};

/**
 * Another version of a video that already exists. Reading the highest version
 * number, deactivating the versions that are there and inserting the new one
 * belongs in one transaction behind a row lock on the video: two renders that
 * overlap would otherwise pick the same number and fail the unique index, or
 * both mark themselves active. The caller owns the transaction — it usually
 * has more to write in it — and is handed null when the video is gone, so a
 * render that has somewhere else to put the file can fall back to it.
 */
export async function addOutputVersion(
  client: PoolClient,
  options: AddOutputVersionOptions
): Promise<{ videoId: string; versionId: string } | null> {
  const versionRowId = randomUUID();
  const locked = await client.query(`SELECT id FROM videos WHERE id = $1 FOR UPDATE`, [
    options.videoId,
  ]);
  if (!locked.rows[0]) return null;
  const videoId = String(locked.rows[0].id);
  const max = await client.query(
    `SELECT COALESCE(MAX("versionNumber"), 0) AS max FROM video_versions WHERE "videoParentId" = $1`,
    [videoId]
  );
  const next = Number(max.rows[0]?.max ?? 0) + 1;
  await client.query(`UPDATE video_versions SET "isActive" = false WHERE "videoParentId" = $1`, [
    videoId,
  ]);
  await client.query(
    `INSERT INTO video_versions (
       id, "versionNumber", "versionLabel", "providerId", "videoId", "originalUrl", title,
       "thumbnailUrl", size_bytes, "isActive", "videoParentId", "createdAt", proxy_status, duration
     ) VALUES ($1, $2, $3, 'r2', $4, $5, $6, '/placeholder-video-thumbnail.png', $7, true, $8, NOW(), 'SKIPPED', $9)`,
    [
      versionRowId,
      next,
      options.label ?? `Re-render ${next - 1}`,
      options.objectKey,
      options.originalUrl,
      options.title === undefined ? `Rough cut v${next}` : options.title,
      options.sizeBytes,
      videoId,
      options.duration ?? null,
    ]
  );
  return { videoId, versionId: versionRowId };
}

/** The name a first render gives the output video, from the folder it came out of. */
async function outputTitle(deps: OutputVersionDeps, folderId: string | null): Promise<string> {
  if (!folderId) return 'Rough cut';
  const folderRes = await deps.pool.query(`SELECT name FROM folders WHERE id = $1`, [folderId]);
  const folderName = folderRes.rows[0]?.name;
  if (typeof folderName === 'string' && folderName.trim()) {
    return `Rough cut — ${folderName.trim()}`;
  }
  return 'Rough cut';
}

/**
 * The first render: a video of its own, at the end of the project. The video
 * and its first version go in together, because a video row with no version is
 * a row the project page renders as a broken card and nothing ever repairs.
 */
export async function createOutputVideo(
  deps: OutputVersionDeps,
  options: CreateOutputVideoOptions
): Promise<{ videoId: string; versionId: string }> {
  const versionRowId = randomUUID();
  const title = await outputTitle(deps, options.folderId);
  const last = await deps.pool.query(
    `SELECT position FROM videos WHERE "projectId" = $1 ORDER BY position DESC LIMIT 1`,
    [options.projectId]
  );
  const nextPosition =
    (typeof last.rows[0]?.position === 'number' ? last.rows[0].position : -1) + 1;
  const videoId = randomUUID();
  const client = await deps.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO videos (id, title, position, folder_id, kind, metadata, "projectId", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, 'VIDEO', '{}'::jsonb, $5, NOW(), NOW())`,
      [videoId, title, nextPosition, options.folderId, options.projectId]
    );
    await client.query(
      `INSERT INTO video_versions (
         id, "versionNumber", "providerId", "videoId", "originalUrl", title, "thumbnailUrl",
         size_bytes, "isActive", "videoParentId", "createdAt", proxy_status
       ) VALUES ($1, 1, 'r2', $2, $3, $4, '/placeholder-video-thumbnail.png', $5, true, $6, NOW(), 'SKIPPED')`,
      [versionRowId, options.objectKey, options.originalUrl, title, options.sizeBytes, videoId]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return { videoId, versionId: versionRowId };
}
