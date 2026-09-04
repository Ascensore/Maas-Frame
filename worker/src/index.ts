import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import PgBoss from 'pg-boss';
import pg from 'pg';
import { shouldTranscodeReviewProxy, reviewProxyBurnInLabel, reviewProxyFfmpegArgs } from './review-proxy';
import { assembleRoughCut, fillTranscriptSpeakers } from './assemble-rough-cut';

const { Pool } = pg;

function parseFrameRateString(value: string): { num: number; den: number } | null {
  const match = /^(\d+)\s*\/\s*(\d+)$/.exec(value.trim());
  if (!match) return null;
  const num = Number(match[1]);
  const den = Number(match[2]);
  if (!Number.isInteger(num) || !Number.isInteger(den) || num <= 0 || den <= 0) return null;
  let x = num;
  let y = den;
  while (y !== 0) {
    const next = x % y;
    x = y;
    y = next;
  }
  const divisor = x === 0 ? 1 : x;
  return { num: num / divisor, den: den / divisor };
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME ?? '';
const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID ?? '';
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY ?? '';

function s3Endpoint(): string {
  if (R2_ENDPOINT) return R2_ENDPOINT.replace(/\/+$/, '');
  if (!R2_ACCOUNT_ID) throw new Error('Missing R2_ENDPOINT or R2_ACCOUNT_ID');
  return `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
}

const s3 = new S3Client({
  region: 'auto',
  endpoint: s3Endpoint(),
  forcePathStyle: Boolean(R2_ENDPOINT),
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

function run(command: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 1 }));
  });
}

async function downloadObject(key: string, dest: string): Promise<void> {
  const response = await s3.send(new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));
  if (!response.Body) throw new Error(`Empty object ${key}`);
  const bytes = await response.Body.transformToByteArray();
  await writeFile(dest, bytes);
}

async function uploadObject(key: string, body: Buffer, contentType: string): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );
}

function objectKeyFromProvider(version: { providerId: string; videoId: string; originalUrl: string }): string | null {
  if (version.providerId === 'r2') {
    if (version.videoId.startsWith('videos/')) return version.videoId;
    const match = /\/api\/upload\/video\/([^/?]+)$/.exec(version.originalUrl);
    if (match) return `videos/${match[1]}`;
  }
  return null;
}

async function probeMedia(versionId: string): Promise<void> {
  const versionRes = await pool.query(
    `SELECT id, "providerId", "videoId", "originalUrl" FROM video_versions WHERE id = $1`,
    [versionId]
  );
  const version = versionRes.rows[0];
  if (!version) throw new Error('Version not found');
  const key = objectKeyFromProvider(version);
  if (!key) throw new Error('Version has no probeable file');

  const dir = await mkdtemp(join(tmpdir(), 'of-probe-'));
  const filePath = join(dir, 'source.bin');
  try {
    await downloadObject(key, filePath);
    const probed = await run('ffprobe', [
      '-v',
      'error',
      '-show_format',
      '-show_streams',
      '-of',
      'json',
      filePath,
    ]);
    if (probed.code !== 0) throw new Error(probed.stderr || 'ffprobe failed');
    const parsed = JSON.parse(probed.stdout) as {
      format?: { format_name?: string; duration?: string; tags?: Record<string, string | undefined> };
      streams?: Array<{
        codec_type?: string;
        codec_name?: string;
        codec_tag_string?: string;
        r_frame_rate?: string;
        avg_frame_rate?: string;
        duration?: string;
        nb_frames?: string;
        tags?: Record<string, string | undefined>;
      }>;
    };
    const videoStream = parsed.streams?.find((stream) => stream.codec_type === 'video');
    const audioStream = parsed.streams?.find((stream) => stream.codec_type === 'audio');
    const rate = parseFrameRateString(videoStream?.r_frame_rate || videoStream?.avg_frame_rate || '');
    const duration = videoStream?.duration
      ? Number(videoStream.duration)
      : parsed.format?.duration
        ? Number(parsed.format.duration)
        : null;
    const durationFrames = rate && duration ? Math.round((duration * rate.num) / rate.den) : null;
    const dropFrame = Boolean(rate && ((rate.num === 30000 && rate.den === 1001) || (rate.num === 60000 && rate.den === 1001)));
    const { readEmbeddedTimecode, readEmbeddedCreationTime } = await import('../lib/rough-cut/probe-timecode');
    const startTimecode = readEmbeddedTimecode(parsed);
    const recordedAt = readEmbeddedCreationTime(parsed);

    await pool.query(
      `UPDATE video_versions
       SET frame_rate_num = $2, frame_rate_den = $3, drop_frame = $4, duration_frames = $5,
           duration = COALESCE(duration, $6), start_timecode = COALESCE($7, start_timecode),
           recorded_at = COALESCE($8, recorded_at)
       WHERE id = $1`,
      [
        versionId,
        rate?.num ?? null,
        rate?.den ?? null,
        dropFrame,
        durationFrames,
        duration ? Math.round(duration) : null,
        startTimecode,
        recordedAt,
      ]
    );

    await maybeEnqueueReviewProxy(versionId, {
      videoCodec: videoStream?.codec_name ?? null,
      audioCodec: audioStream?.codec_name ?? null,
      formatName: parsed.format?.format_name ?? null,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function isProxyTranscodeEnabled(): boolean {
  const raw = (process.env.OPENFRAME_ENABLE_PROXY_TRANSCODE || 'true').trim().toLowerCase();
  return raw !== 'false';
}

async function maybeEnqueueReviewProxy(
  versionId: string,
  probe: { videoCodec: string | null; audioCodec: string | null; formatName: string | null }
): Promise<void> {
  if (!isProxyTranscodeEnabled()) return;

  const kindRes = await pool.query(
    `SELECT v.kind, p."watermarkReviews" AS watermark_reviews, p.name AS project_name
     FROM video_versions vv
     JOIN videos v ON v.id = vv."videoParentId"
     JOIN projects p ON p.id = v."projectId"
     WHERE vv.id = $1`,
    [versionId]
  );
  const kind = kindRes.rows[0]?.kind as string | undefined;
  const watermarkReviews = Boolean(kindRes.rows[0]?.watermark_reviews);
  if (kind && kind !== 'VIDEO') {
    await pool.query(
      `UPDATE video_versions SET proxy_status = 'SKIPPED' WHERE id = $1 AND proxy_status IN ('NONE', 'PENDING')`,
      [versionId]
    );
    return;
  }

  if (!shouldTranscodeReviewProxy(probe, { kind, watermarkReviews })) {
    await pool.query(
      `UPDATE video_versions SET proxy_status = 'SKIPPED' WHERE id = $1 AND proxy_status = 'NONE'`,
      [versionId]
    );
    return;
  }

  const existing = await pool.query(
    `SELECT id FROM media_jobs
     WHERE version_id = $1 AND kind = 'TRANSCODE_PROXY' AND status IN ('PENDING', 'QUEUED', 'RUNNING')
     LIMIT 1`,
    [versionId]
  );
  if (existing.rows[0]) return;

  await pool.query(
    `UPDATE video_versions SET proxy_status = 'PENDING' WHERE id = $1`,
    [versionId]
  );
  await pool.query(
    `INSERT INTO media_jobs (id, kind, status, version_id, attempts, created_at, updated_at)
     VALUES (gen_random_uuid()::text, 'TRANSCODE_PROXY', 'PENDING', $1, 0, NOW(), NOW())`,
    [versionId]
  );
}

async function transcodeProxy(versionId: string): Promise<void> {
  const versionRes = await pool.query(
    `SELECT vv.id, vv."providerId", vv."videoId", vv."originalUrl",
            p."watermarkReviews" AS watermark_reviews, p.name AS project_name
     FROM video_versions vv
     JOIN videos v ON v.id = vv."videoParentId"
     JOIN projects p ON p.id = v."projectId"
     WHERE vv.id = $1`,
    [versionId]
  );
  const version = versionRes.rows[0];
  if (!version) throw new Error('Version not found');
  const key = objectKeyFromProvider(version);
  if (!key) throw new Error('Version has no transcodable file');

  const dir = await mkdtemp(join(tmpdir(), 'of-proxy-'));
  const source = join(dir, 'source.bin');
  const output = join(dir, 'proxy.mp4');
  try {
    await pool.query(`UPDATE video_versions SET proxy_status = 'RUNNING' WHERE id = $1`, [versionId]);
    await downloadObject(key, source);
    const burnIn = version.watermark_reviews
      ? reviewProxyBurnInLabel(version.project_name ?? '')
      : null;
    const encoded = await run('ffmpeg', reviewProxyFfmpegArgs(source, output, burnIn));
    if (encoded.code !== 0) throw new Error(encoded.stderr || 'ffmpeg proxy encode failed');
    const body = await readFile(output);
    const filename = `${randomUUID()}.mp4`;
    await uploadObject(`videos/${filename}`, body, 'video/mp4');
    const proxyUrl = `/api/upload/video/${filename}`;
    await pool.query(
      `UPDATE video_versions SET proxy_status = 'READY', proxy_url = $2 WHERE id = $1`,
      [versionId, proxyUrl]
    );
  } catch (error) {
    await pool.query(`UPDATE video_versions SET proxy_status = 'FAILED' WHERE id = $1`, [versionId]);
    throw error;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function extractAudio(versionId: string): Promise<void> {
  const versionRes = await pool.query(
    `SELECT id, "providerId", "videoId", "originalUrl" FROM video_versions WHERE id = $1`,
    [versionId]
  );
  const version = versionRes.rows[0];
  if (!version) throw new Error('Version not found');
  const key = objectKeyFromProvider(version);
  if (!key) throw new Error('Version has no extractable file');

  const dir = await mkdtemp(join(tmpdir(), 'of-audio-'));
  const source = join(dir, 'source.bin');
  const wav = join(dir, 'audio.wav');
  try {
    await downloadObject(key, source);
    const extracted = await run('ffmpeg', ['-y', '-i', source, '-vn', '-ac', '1', '-ar', '16000', wav]);
    if (extracted.code !== 0) throw new Error(extracted.stderr || 'ffmpeg failed');
    const audio = await readFile(wav);
    await uploadObject(`audio/${versionId}.wav`, audio, 'audio/wav');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function toVttTime(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const secs = Math.floor(clamped % 60);
  const millis = Math.round((clamped - Math.floor(clamped)) * 1000);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

function serializeWebVtt(
  segments: Array<{ start: number; end: number; text: string }>
): string {
  const body = segments
    .map((segment) => `${toVttTime(segment.start)} --> ${toVttTime(segment.end)}\n${segment.text}`)
    .join('\n\n');
  return `WEBVTT\n\n${body}\n`;
}

async function upsertCaptionTrack(
  versionId: string,
  language: string,
  vtt: string
): Promise<void> {
  const owner = await pool.query(
    `SELECT p."ownerId" AS owner_id
     FROM video_versions vv
     JOIN videos v ON v.id = vv."videoParentId"
     JOIN projects p ON p.id = v."projectId"
     WHERE vv.id = $1`,
    [versionId]
  );
  const billedUserId = owner.rows[0]?.owner_id as string | undefined;
  if (!billedUserId) return;

  const filename = `${randomUUID()}.vtt`;
  const sourceUrl = `/api/upload/subtitle/${filename}`;
  const body = Buffer.from(vtt, 'utf8');
  await uploadObject(`subtitles/${filename}`, body, 'text/vtt');

  const existing = await pool.query(
    `SELECT id FROM video_subtitles WHERE "versionId" = $1 AND language = $2`,
    [versionId, language]
  );
  const label = `Transcript (${language})`;
  if (existing.rows[0]) {
    await pool.query(
      `UPDATE video_subtitles
       SET "sourceUrl" = $2, size_bytes = $3, label = $4, "updatedAt" = NOW()
       WHERE id = $1`,
      [existing.rows[0].id, sourceUrl, body.length, label]
    );
    return;
  }
  await pool.query(
    `INSERT INTO video_subtitles
       (id, "versionId", language, label, "sourceUrl", size_bytes, "billedUserId", "createdAt", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, NOW(), NOW())`,
    [versionId, language, label, sourceUrl, body.length, billedUserId]
  );
}

async function markTranscriptFailed(
  versionId: string,
  payload: { language?: string; transcriptId?: string } | null,
  error: string
): Promise<void> {
  const message = error.slice(0, 2000);
  if (payload?.transcriptId) {
    await pool.query(
      `UPDATE transcripts SET status = 'FAILED', error = $2, updated_at = NOW() WHERE id = $1`,
      [payload.transcriptId, message]
    );
    return;
  }
  await pool.query(
    `UPDATE transcripts
     SET status = 'FAILED', error = $2, updated_at = NOW()
     WHERE version_id = $1 AND language = $3 AND status IN ('PENDING', 'RUNNING')`,
    [versionId, message, payload?.language || 'en']
  );
}

async function transcribe(versionId: string, payload: { language?: string; transcriptId?: string } | null): Promise<void> {
  const provider = (process.env.OPENFRAME_TRANSCRIPTION_PROVIDER || 'whisper-local').trim().toLowerCase();
  const language = payload?.language || 'en';

  const audioKey = `audio/${versionId}.wav`;
  const dir = await mkdtemp(join(tmpdir(), 'of-tr-'));
  const wav = join(dir, 'audio.wav');
  try {
    try {
      await downloadObject(audioKey, wav);
    } catch {
      await extractAudio(versionId);
      await downloadObject(audioKey, wav);
    }

    let result: { language: string; segments: Array<{ start: number; end: number; text: string; words: unknown }> };
    if (provider === 'whisper-local') {
      const script = join(import.meta.dir, '..', 'whisper_local.py');
      const ran = await run('python3', [script, wav, language]);
      if (ran.code !== 0) throw new Error(ran.stderr || 'faster-whisper failed');
      result = JSON.parse(ran.stdout);
    } else {
      throw new Error(`Provider ${provider} must be run through the app process; worker only supports whisper-local`);
    }

    const searchText = result.segments.map((segment) => segment.text).join(' ');
    const upsert = await pool.query(
      `INSERT INTO transcripts (id, version_id, language, provider, status, search_text, error, created_at, updated_at)
       VALUES (gen_random_uuid()::text, $1, $2, $3, 'READY', $4, NULL, NOW(), NOW())
       ON CONFLICT (version_id, language)
       DO UPDATE SET provider = EXCLUDED.provider, status = 'READY', search_text = EXCLUDED.search_text, error = NULL, updated_at = NOW()
       RETURNING id`,
      [versionId, result.language || language, provider, searchText]
    );
    const transcriptId = upsert.rows[0].id as string;
    await pool.query(`DELETE FROM transcript_segments WHERE transcript_id = $1`, [transcriptId]);
    for (let index = 0; index < result.segments.length; index += 1) {
      const segment = result.segments[index];
      await pool.query(
        `INSERT INTO transcript_segments (id, transcript_id, start_sec, end_sec, speaker, text, words, position, created_at)
         VALUES (gen_random_uuid()::text, $1, $2, $3, NULL, $4, $5::jsonb, $6, NOW())`,
        [transcriptId, segment.start, segment.end, segment.text, JSON.stringify(segment.words ?? []), index]
      );
    }

    try {
      await upsertCaptionTrack(versionId, result.language || language, serializeWebVtt(result.segments));
    } catch (error) {
      console.error('caption upsert failed', error);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markTranscriptFailed(versionId, payload, message);
    throw error;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const QUEUE = {
  PROBE_MEDIA: 'probe-media',
  EXTRACT_AUDIO: 'extract-audio',
  TRANSCRIBE: 'transcribe',
  TRANSCODE_PROXY: 'transcode-proxy',
  DIARIZE: 'diarize',
  ASSEMBLE_ROUGH_CUT: 'assemble-rough-cut',
} as const;

type MediaJobData = {
  mediaJobId: string;
  versionId: string;
  payload: unknown;
};

function queueForKind(kind: string): string {
  if (kind === 'PROBE_MEDIA') return QUEUE.PROBE_MEDIA;
  if (kind === 'EXTRACT_AUDIO') return QUEUE.EXTRACT_AUDIO;
  if (kind === 'TRANSCRIBE') return QUEUE.TRANSCRIBE;
  if (kind === 'TRANSCODE_PROXY') return QUEUE.TRANSCODE_PROXY;
  if (kind === 'DIARIZE') return QUEUE.DIARIZE;
  if (kind === 'ASSEMBLE_ROUGH_CUT') return QUEUE.ASSEMBLE_ROUGH_CUT;
  throw new Error(`Unknown job kind ${kind}`);
}

async function markJob(id: string, status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED', error?: string) {
  if (status === 'QUEUED') {
    await pool.query(`UPDATE media_jobs SET status = 'QUEUED', updated_at = NOW() WHERE id = $1`, [id]);
    return;
  }
  if (status === 'RUNNING') {
    await pool.query(
      `UPDATE media_jobs
       SET status = 'RUNNING', attempts = attempts + 1, started_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [id]
    );
    return;
  }
  await pool.query(
    `UPDATE media_jobs
     SET status = $2, error = $3, finished_at = NOW(), updated_at = NOW()
     WHERE id = $1`,
    [id, status, error ?? null]
  );
}

async function runMediaJob(data: MediaJobData, kind: string): Promise<void> {
  await markJob(data.mediaJobId, 'RUNNING');
  try {
    if (kind === 'PROBE_MEDIA') {
      await probeMedia(data.versionId);
    } else if (kind === 'EXTRACT_AUDIO') {
      await extractAudio(data.versionId);
    } else if (kind === 'TRANSCRIBE') {
      await transcribe(data.versionId, (data.payload as { language?: string; transcriptId?: string } | null) ?? null);
    } else if (kind === 'TRANSCODE_PROXY') {
      await transcodeProxy(data.versionId);
    } else if (kind === 'DIARIZE') {
      await fillTranscriptSpeakers(
        {
          pool,
          run,
          downloadObject,
          objectKeyFromProvider,
          extractAudio,
          scriptDir: join(import.meta.dir, '..'),
        },
        data.versionId
      );
    } else if (kind === 'ASSEMBLE_ROUGH_CUT') {
      const roughCutId =
        data.payload && typeof data.payload === 'object' && 'roughCutId' in data.payload
          ? String((data.payload as { roughCutId?: unknown }).roughCutId ?? '')
          : '';
      if (!roughCutId) throw new Error('ASSEMBLE_ROUGH_CUT payload is missing roughCutId');
      await assembleRoughCut(
        {
          pool,
          run,
          downloadObject,
          objectKeyFromProvider,
          extractAudio,
          scriptDir: join(import.meta.dir, '..'),
        },
        roughCutId
      );
    } else {
      throw new Error(`Unknown job kind ${kind}`);
    }
    await markJob(data.mediaJobId, 'SUCCEEDED');
    console.log(`job ${data.mediaJobId} ${kind} succeeded`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markJob(data.mediaJobId, 'FAILED', message);
    console.error(`job ${data.mediaJobId} failed: ${message}`);
    throw error;
  }
}

async function publishPending(boss: PgBoss): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT id, kind, version_id, payload
       FROM media_jobs
       WHERE status = 'PENDING'
       ORDER BY created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 20`
    );
    for (const row of result.rows) {
      await client.query(`UPDATE media_jobs SET status = 'QUEUED', updated_at = NOW() WHERE id = $1`, [row.id]);
    }
    await client.query('COMMIT');
    for (const row of result.rows) {
      try {
        await boss.send(queueForKind(row.kind), {
          mediaJobId: row.id,
          versionId: row.version_id,
          payload: row.payload,
        } satisfies MediaJobData);
      } catch (error) {
        await pool.query(
          `UPDATE media_jobs SET status = 'PENDING', updated_at = NOW() WHERE id = $1 AND status = 'QUEUED'`,
          [row.id]
        );
        throw error;
      }
    }
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // already committed
    }
    throw error;
  } finally {
    client.release();
  }
}

async function start(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }
  await mkdir(tmpdir(), { recursive: true });

  const boss = new PgBoss({ connectionString: process.env.DATABASE_URL });
  boss.on('error', (error) => {
    console.error('pg-boss error', error);
  });
  await boss.start();

  for (const name of Object.values(QUEUE)) {
    await boss.createQueue(name);
  }

  await boss.work(QUEUE.PROBE_MEDIA, async (jobs) => {
    for (const job of jobs) {
      await runMediaJob(job.data as MediaJobData, 'PROBE_MEDIA');
    }
  });
  await boss.work(QUEUE.EXTRACT_AUDIO, async (jobs) => {
    for (const job of jobs) {
      await runMediaJob(job.data as MediaJobData, 'EXTRACT_AUDIO');
    }
  });
  await boss.work(QUEUE.TRANSCRIBE, async (jobs) => {
    for (const job of jobs) {
      await runMediaJob(job.data as MediaJobData, 'TRANSCRIBE');
    }
  });
  await boss.work(QUEUE.TRANSCODE_PROXY, async (jobs) => {
    for (const job of jobs) {
      await runMediaJob(job.data as MediaJobData, 'TRANSCODE_PROXY');
    }
  });
  await boss.work(QUEUE.DIARIZE, async (jobs) => {
    for (const job of jobs) {
      await runMediaJob(job.data as MediaJobData, 'DIARIZE');
    }
  });
  await boss.work(QUEUE.ASSEMBLE_ROUGH_CUT, async (jobs) => {
    for (const job of jobs) {
      await runMediaJob(job.data as MediaJobData, 'ASSEMBLE_ROUGH_CUT');
    }
  });

  console.log('media worker started (pg-boss)');
  for (;;) {
    try {
      await publishPending(boss);
    } catch (error) {
      console.error('worker publish error', error);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

void start();
