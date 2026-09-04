import type { Pool } from 'pg';
import {
  DriveImportError,
  downloadPublicDriveFile,
  importMetadata,
  looksLikeVideoBytes,
  readImportFileId,
} from '../lib/rough-cut/drive-import';

export type ImportDriveDeps = {
  pool: Pool;
  uploadObject: (key: string, body: Buffer, contentType: string) => Promise<void>;
  fetchImpl?: typeof fetch;
};

function transcriptionEnabled(): boolean {
  const raw = (process.env.OPENFRAME_ENABLE_TRANSCRIPTION || 'true').trim().toLowerCase();
  return raw !== 'false';
}

function maxUploadBytes(): number {
  const raw = process.env.OPENFRAME_MAX_VIDEO_UPLOAD_BYTES?.trim();
  if (!raw) return 5 * 1024 * 1024 * 1024;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5 * 1024 * 1024 * 1024;
}

async function markImport(
  pool: Pool,
  videoId: string,
  fileId: string,
  status: 'ready' | 'failed',
  error?: string
): Promise<void> {
  await pool.query(`UPDATE videos SET metadata = $2::jsonb, "updatedAt" = NOW() WHERE id = $1`, [
    videoId,
    JSON.stringify(importMetadata({ fileId, status, error })),
  ]);
}

export async function importDriveFile(deps: ImportDriveDeps, versionId: string): Promise<void> {
  const versionRes = await deps.pool.query(
    `SELECT vv.id, vv."videoId", vv."originalUrl", vv."videoParentId", v.metadata
     FROM video_versions vv
     JOIN videos v ON v.id = vv."videoParentId"
     WHERE vv.id = $1`,
    [versionId]
  );
  const row = versionRes.rows[0];
  if (!row) throw new Error('Version not found');

  const fileId = readImportFileId(row.metadata);
  if (!fileId) throw new Error('IMPORT_DRIVE payload is missing a Drive file id');

  const objectKey =
    typeof row.videoId === 'string' && row.videoId.startsWith('videos/')
      ? row.videoId
      : null;
  if (!objectKey) throw new Error('IMPORT_DRIVE version is missing an object key');

  try {
    const downloaded = await downloadPublicDriveFile(fileId, deps.fetchImpl ?? fetch);
    if (downloaded.bytes.byteLength > maxUploadBytes()) {
      throw new DriveImportError('That Drive file is larger than this host allows');
    }
    if (!looksLikeVideoBytes(downloaded.bytes)) {
      throw new DriveImportError('That Drive file is not a video this host can import');
    }

    const body = Buffer.from(downloaded.bytes);
    await deps.uploadObject(objectKey, body, downloaded.contentType || 'video/mp4');
    await deps.pool.query(`UPDATE video_versions SET size_bytes = $2 WHERE id = $1`, [
      versionId,
      body.byteLength,
    ]);
    await markImport(deps.pool, row.videoParentId, fileId, 'ready');

    await deps.pool.query(
      `INSERT INTO media_jobs (id, kind, status, version_id, attempts, created_at, updated_at)
       VALUES (gen_random_uuid()::text, 'PROBE_MEDIA', 'PENDING', $1, 0, NOW(), NOW())`,
      [versionId]
    );
    if (transcriptionEnabled()) {
      await deps.pool.query(
        `INSERT INTO media_jobs (id, kind, status, version_id, attempts, created_at, updated_at)
         VALUES (gen_random_uuid()::text, 'EXTRACT_AUDIO', 'PENDING', $1, 0, NOW(), NOW()),
                (gen_random_uuid()::text, 'TRANSCRIBE', 'PENDING', $1, 0, NOW(), NOW())`,
        [versionId]
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markImport(deps.pool, row.videoParentId, fileId, 'failed', message);
    throw error;
  }
}
