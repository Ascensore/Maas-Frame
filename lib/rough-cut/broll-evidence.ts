import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
export async function analyzeBroll(
  deps: {
    pool: Pool;
    run: (command: string, args: string[]) => Promise<{ code: number; stderr: string }>;
    downloadVersionMedia: (
      version: { providerId: string; videoId: string; originalUrl: string },
      dest: string
    ) => Promise<void>;
    uploadObject: (key: string, body: Buffer, contentType: string) => Promise<void>;
  },
  versionId: string
) {
  const { rows } = await deps.pool.query(
    'SELECT id,"providerId","videoId","originalUrl",duration FROM video_versions WHERE id=$1',
    [versionId]
  );
  const version = rows[0];
  if (!version || version.providerId !== 'r2' || !(version.duration > 0))
    throw new Error('Analyze an uploaded video with a known duration.');
  const dir = await mkdtemp(join(tmpdir(), 'of-broll-'));
  try {
    const source = join(dir, 'source.bin');
    await deps.downloadVersionMedia(version, source);
    const frames = [];
    const generation = randomUUID();
    for (const [index, fraction] of [0.1, 0.5, 0.9].entries()) {
      const seconds = Math.round(version.duration * fraction * 1000) / 1000;
      const file = join(dir, index + '.jpg');
      const run = await deps.run('ffmpeg', [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-ss',
        String(seconds),
        '-i',
        source,
        '-frames:v',
        '1',
        '-vf',
        'scale=640:360:force_original_aspect_ratio=decrease',
        '-q:v',
        '4',
        file,
      ]);
      if (run.code !== 0) throw new Error('Could not sample B-roll frames: ' + run.stderr);
      const bytes = await readFile(file);
      if (bytes.length > 262144 || bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216)
        throw new Error('Invalid or oversized B-roll image');
      const key = 'videos/broll-evidence/' + versionId + '/' + generation + '/' + index + '.jpg';
      await deps.uploadObject(key, bytes, 'image/jpeg');
      frames.push({ key, seconds });
    }
    await deps.pool.query('UPDATE video_versions SET visual_evidence=$2::jsonb WHERE id=$1', [
      versionId,
      JSON.stringify({ version: 1, frames }),
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
