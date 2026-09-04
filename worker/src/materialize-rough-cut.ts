import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { parseRoughCutDecisionList } from '../lib/rough-cut/decision-list';
import { materializeFfmpegArgs } from '../lib/rough-cut/materialize';

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
};

export async function materializeRoughCut(deps: MaterializeDeps, roughCutId: string): Promise<void> {
  const cutRes = await deps.pool.query(
    `SELECT id, project_id, folder_id, decisions FROM rough_cuts WHERE id = $1`,
    [roughCutId]
  );
  const cut = cutRes.rows[0];
  if (!cut) throw new Error('Rough cut not found');

  const decisions = parseRoughCutDecisionList(cut.decisions);
  if (!decisions || decisions.edits.length === 0) return;

  const versionIds = [...new Set(decisions.edits.map((edit) => edit.sourceVersionId))];
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

    const segments = decisions.edits.map((edit) => {
      const inputPath = localByVersion.get(edit.sourceVersionId);
      if (!inputPath) throw new Error(`Missing source file for ${edit.sourceVersionId}`);
      return {
        inputPath,
        inSeconds: edit.inSeconds,
        outSeconds: edit.outSeconds,
      };
    });

    const output = join(dir, 'rough-cut.mp4');
    const encoded = await deps.run('ffmpeg', materializeFfmpegArgs(segments, output));
    if (encoded.code !== 0) throw new Error(encoded.stderr || 'ffmpeg concat failed');

    const body = await readFile(output);
    const filename = `${randomUUID()}.mp4`;
    const objectKey = `videos/${filename}`;
    await deps.uploadObject(objectKey, body, 'video/mp4');
    const originalUrl = `/api/upload/video/${filename}`;

    let title = 'Rough cut';
    if (typeof cut.folder_id === 'string' && cut.folder_id) {
      const folderRes = await deps.pool.query(`SELECT name FROM folders WHERE id = $1`, [
        cut.folder_id,
      ]);
      const folderName = folderRes.rows[0]?.name;
      if (typeof folderName === 'string' && folderName.trim()) {
        title = `Rough cut — ${folderName.trim()}`;
      }
    }

    const last = await deps.pool.query(
      `SELECT position FROM videos WHERE "projectId" = $1 ORDER BY position DESC LIMIT 1`,
      [cut.project_id]
    );
    const nextPosition = (typeof last.rows[0]?.position === 'number' ? last.rows[0].position : -1) + 1;

    const videoId = randomUUID();
    const versionRowId = randomUUID();
    await deps.pool.query(
      `INSERT INTO videos (id, title, position, folder_id, kind, metadata, "projectId", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, 'VIDEO', '{}'::jsonb, $5, NOW(), NOW())`,
      [videoId, title, nextPosition, cut.folder_id, cut.project_id]
    );
    await deps.pool.query(
      `INSERT INTO video_versions (
         id, "versionNumber", "providerId", "videoId", "originalUrl", title, "thumbnailUrl",
         size_bytes, "isActive", "videoParentId", "createdAt", proxy_status
       ) VALUES ($1, 1, 'r2', $2, $3, $4, '/placeholder-video-thumbnail.png', $5, true, $6, NOW(), 'SKIPPED')`,
      [versionRowId, objectKey, originalUrl, title, body.byteLength, videoId]
    );
    await deps.pool.query(
      `UPDATE rough_cuts SET output_video_id = $2, updated_at = NOW() WHERE id = $1`,
      [roughCutId, videoId]
    );
    await deps.pool.query(
      `INSERT INTO media_jobs (id, kind, status, version_id, attempts, created_at, updated_at)
       VALUES (gen_random_uuid()::text, 'PROBE_MEDIA', 'PENDING', $1, 0, NOW(), NOW())`,
      [versionRowId]
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
