import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import PgBoss from 'pg-boss';
import pg from 'pg';
import { shouldTranscodeReviewProxy, reviewProxyBurnInLabel, reviewProxyFfmpegArgs } from './review-proxy';
import { assembleRoughCut, fillTranscriptSpeakers } from './assemble-rough-cut';
import { burnInSubtitles, parseBurnInPayload } from './burn-in';
import {
  claimDueMediaJobs,
  publishClaimedJobs,
  UnknownJobKindError,
} from '../lib/media-job-queue';
import { upsertCaptionTrack } from '../lib/rough-cut/caption-track';
import { serializeWebVtt } from '../lib/subtitle-validation';
import { importDriveFile } from './import-drive';
import { materializeRoughCut } from './materialize-rough-cut';
import {
  createWhisperLocalProvider,
  getWorkerTranscriptionProvider,
  mergeChunkTranscriptions,
  openaiChunkOffsets,
  OPENAI_CHUNK_OVERLAP_SECONDS,
  OPENAI_WAV_CHUNK_SECONDS,
  shouldSplitForOpenAI,
  type TranscriptionProvider,
  type TranscriptionResult,
} from './transcription';

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

// Cap both pools. The worker shares the Supabase session pooler (15 clients)
// with Vercel; node-pg and pg-boss default to 10 each and starve the app.
const WORKER_POOL_MAX = 2;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: WORKER_POOL_MAX,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 5000,
});

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

function s3Region(): string {
  const fromEnv = (process.env.AWS_REGION || process.env.S3_REGION || '').trim();
  if (fromEnv) return fromEnv;
  const endpoint = (R2_ENDPOINT ?? '').replace(/\/+$/, '');
  // Cloudflare R2 accepts region "auto". Supabase/MinIO S3 need a real region or
  // SigV4 is sent to Amazon and fails with "Access Key Id does not exist".
  if (endpoint && !endpoint.includes('r2.cloudflarestorage.com')) {
    return 'eu-west-1';
  }
  return 'auto';
}

const s3 = new S3Client({
  region: s3Region(),
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

async function deleteObject(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));
}

function objectKeyFromProvider(version: { providerId: string; videoId: string; originalUrl: string }): string | null {
  if (version.providerId === 'r2') {
    if (version.videoId.startsWith('videos/')) return version.videoId;
    const match = /\/api\/upload\/video\/([^/?]+)$/.exec(version.originalUrl);
    if (match) return `videos/${match[1]}`;
  }
  return null;
}

const BUNNY_FALLBACK_HEIGHTS = [2160, 1440, 1080, 720, 480, 360, 240];
const BUNNY_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Keep in lockstep with lib/bunny-cdn.ts. The worker image cannot import
 * from the app tree (Docker context is ./worker).
 */
function normalizeBunnyCdnHostname(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    return parsed.hostname || null;
  } catch {
    return trimmed.replace(/^https?:\/\//, '').replace(/\/+$/, '') || null;
  }
}

function bunnyCdnHostname(): string | null {
  return normalizeBunnyCdnHostname(process.env.BUNNY_CDN_URL || process.env.NEXT_PUBLIC_BUNNY_CDN_URL);
}

async function tryDownloadHttp(url: string, dest: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(BUNNY_DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) return false;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) return false;
    await writeFile(dest, bytes);
    return true;
  } catch {
    return false;
  }
}

async function downloadVersionFile(
  version: { providerId: string; videoId: string; originalUrl: string },
  dest: string
): Promise<void> {
  if (version.providerId === 'r2') {
    const key = objectKeyFromProvider(version);
    if (!key) throw new Error('Version has no extractable file');
    await downloadObject(key, dest);
    return;
  }

  if (version.providerId === 'bunny') {
    const hostname = bunnyCdnHostname();
    if (!hostname) throw new Error('Version has no extractable file');
    if (await tryDownloadHttp(`https://${hostname}/${version.videoId}/original`, dest)) return;
    for (const height of BUNNY_FALLBACK_HEIGHTS) {
      if (await tryDownloadHttp(`https://${hostname}/${version.videoId}/play_${height}p.mp4`, dest)) {
        return;
      }
    }
    throw new Error('Version has no extractable file');
  }

  throw new Error('Version has no extractable file');
}

async function probeMedia(versionId: string): Promise<void> {
  const versionRes = await pool.query(
    `SELECT vv.id, vv."providerId", vv."videoId", vv."originalUrl",
            v.id AS video_id, v.title, v.metadata
     FROM video_versions vv
     JOIN videos v ON v.id = vv."videoParentId"
     WHERE vv.id = $1`,
    [versionId]
  );
  const version = versionRes.rows[0];
  if (!version) throw new Error('Version not found');
  const dir = await mkdtemp(join(tmpdir(), 'of-probe-'));
  const filePath = join(dir, 'source.bin');
  try {
    await downloadVersionFile(version, filePath);
    const probed = await run('ffprobe', [
      '-v',
      'error',
      '-analyzeduration',
      '50M',
      '-probesize',
      '50M',
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
    const {
      readEmbeddedTimecode,
      readEmbeddedCreationTime,
      readEmbeddedCameraLabel,
    } = await import('../lib/rough-cut/probe-timecode');
    const { metadataStringRecord, upsertMetadataField } = await import('../lib/rough-cut/camera-roles');
    const startTimecode = readEmbeddedTimecode(parsed);
    const recordedAt = readEmbeddedCreationTime(
      parsed,
      typeof version.title === 'string' ? version.title : null
    );
    const cameraLabel = readEmbeddedCameraLabel(parsed);

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
        recordedAt ? recordedAt.toISOString() : null,
      ]
    );

    if (cameraLabel) {
      const existing = metadataStringRecord(version.metadata);
      const alreadyNamed = Object.entries(existing).some(
        ([key, value]) => key.toLowerCase() === 'camera' && value.trim()
      );
      if (!alreadyNamed) {
        const next = upsertMetadataField(existing, 'camera', cameraLabel);
        await pool.query(
          `UPDATE videos SET metadata = $2::jsonb, "updatedAt" = NOW() WHERE id = $1`,
          [version.video_id, JSON.stringify(next)]
        );
      }
    }

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
  const dir = await mkdtemp(join(tmpdir(), 'of-proxy-'));
  const source = join(dir, 'source.bin');
  const output = join(dir, 'proxy.mp4');
  try {
    await pool.query(`UPDATE video_versions SET proxy_status = 'RUNNING' WHERE id = $1`, [versionId]);
    await downloadVersionFile(version, source);
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

  const dir = await mkdtemp(join(tmpdir(), 'of-audio-'));
  const source = join(dir, 'source.bin');
  const wav = join(dir, 'audio.wav');
  try {
    await downloadVersionFile(version, source);
    const extracted = await run('ffmpeg', ['-y', '-i', source, '-vn', '-ac', '1', '-ar', '16000', wav]);
    if (extracted.code !== 0) throw new Error(extracted.stderr || 'ffmpeg failed');
    const audio = await readFile(wav);
    await uploadObject(`audio/${versionId}.wav`, audio, 'audio/wav');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function probeDurationSeconds(wavPath: string): Promise<number> {
  const probed = await run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    wavPath,
  ]);
  if (probed.code !== 0) throw new Error(probed.stderr || 'ffprobe failed');
  const duration = Number(probed.stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('Could not read audio duration');
  }
  return duration;
}

async function splitWavForOpenAI(
  wavPath: string,
  dir: string,
  durationSeconds: number
): Promise<Array<{ path: string; offsetSeconds: number; overlapSeconds: number }>> {
  const offsets = openaiChunkOffsets(durationSeconds);
  const chunks: Array<{ path: string; offsetSeconds: number; overlapSeconds: number }> = [];
  for (let index = 0; index < offsets.length; index += 1) {
    const offset = offsets[index] ?? 0;
    const chunkPath = join(dir, `chunk-${index}.wav`);
    const extracted = await run('ffmpeg', [
      '-y',
      '-ss',
      String(offset),
      '-t',
      String(OPENAI_WAV_CHUNK_SECONDS),
      '-i',
      wavPath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      chunkPath,
    ]);
    if (extracted.code !== 0) throw new Error(extracted.stderr || 'ffmpeg chunk failed');
    chunks.push({
      path: chunkPath,
      offsetSeconds: offset,
      overlapSeconds: index === 0 ? 0 : OPENAI_CHUNK_OVERLAP_SECONDS,
    });
  }
  return chunks;
}

async function transcribeOpenAiAudio(
  provider: TranscriptionProvider,
  wavPath: string,
  languageHint?: string
): Promise<TranscriptionResult> {
  const fileStat = await stat(wavPath);
  if (!shouldSplitForOpenAI(fileStat.size)) {
    return provider.transcribe({
      audioPath: wavPath,
      ...(languageHint ? { language: languageHint } : {}),
    });
  }

  const duration = await probeDurationSeconds(wavPath);
  const dir = await mkdtemp(join(tmpdir(), 'of-tr-chunks-'));
  try {
    const chunks = await splitWavForOpenAI(wavPath, dir, duration);
    const results: Array<{
      offsetSeconds: number;
      overlapSeconds: number;
      result: TranscriptionResult;
    }> = [];
    let detectedLanguage = languageHint;
    for (const chunk of chunks) {
      const result = await provider.transcribe({
        audioPath: chunk.path,
        ...(detectedLanguage ? { language: detectedLanguage } : {}),
      });
      if (!detectedLanguage && result.language && result.language !== 'und') {
        detectedLanguage = result.language;
      }
      results.push({
        offsetSeconds: chunk.offsetSeconds,
        overlapSeconds: chunk.overlapSeconds,
        result,
      });
    }
    return mergeChunkTranscriptions(results);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function setTranscriptStatus(options: {
  transcriptId?: string;
  versionId: string;
  language: string;
  status: 'RUNNING' | 'FAILED';
  error?: string;
}): Promise<void> {
  if (options.transcriptId) {
    await pool.query(
      `UPDATE transcripts SET status = $2, error = $3, updated_at = NOW() WHERE id = $1`,
      [options.transcriptId, options.status, options.error ?? null]
    );
    return;
  }
  await pool.query(
    `UPDATE transcripts
     SET status = $3, error = $4, updated_at = NOW()
     WHERE version_id = $1 AND language = $2`,
    [options.versionId, options.language, options.status, options.error ?? null]
  );
}

async function transcribeLocalWhisper(audioPath: string, language: string): Promise<TranscriptionResult> {
  const script = join(import.meta.dir, '..', 'whisper_local.py');
  const ran = await run('python3', [script, audioPath, language]);
  if (ran.code !== 0) throw new Error(ran.stderr || 'faster-whisper failed');
  return JSON.parse(ran.stdout) as TranscriptionResult;
}

async function transcribe(versionId: string, payload: { language?: string; transcriptId?: string } | null): Promise<void> {
  const providerName = (process.env.OPENFRAME_TRANSCRIPTION_PROVIDER || 'whisper-local').trim().toLowerCase();
  const requested = payload?.language?.trim() || '';
  const autoDetect = !requested || requested === 'und' || requested === 'auto';
  const languageHint = autoDetect ? undefined : requested.split('-')[0];
  const language = requested || 'und';
  const provider = getWorkerTranscriptionProvider(
    providerName,
    createWhisperLocalProvider(transcribeLocalWhisper)
  );

  await setTranscriptStatus({
    transcriptId: payload?.transcriptId,
    versionId,
    language,
    status: 'RUNNING',
  });

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

    const result =
      provider.name === 'openai'
        ? await transcribeOpenAiAudio(provider, wav, languageHint)
        : await provider.transcribe({
            audioPath: wav,
            ...(languageHint ? { language: languageHint } : {}),
          });

    const searchText = result.segments.map((segment) => segment.text).join(' ');
    const detected = result.language || (autoDetect ? 'und' : language);
    let transcriptId = payload?.transcriptId;
    if (transcriptId) {
      await pool.query(
        `UPDATE transcripts
         SET language = $2,
             provider = $3,
             status = 'READY',
             search_text = $4,
             error = NULL,
             translation_language = NULL,
             translation_status = NULL,
             translation_error = NULL,
             translated_texts = NULL,
             updated_at = NOW()
         WHERE id = $1`,
        [transcriptId, detected, provider.name, searchText]
      );
    } else {
      const upsert = await pool.query(
        `INSERT INTO transcripts (id, version_id, language, provider, status, search_text, error, created_at, updated_at)
         VALUES (gen_random_uuid()::text, $1, $2, $3, 'READY', $4, NULL, NOW(), NOW())
         ON CONFLICT (version_id, language)
         DO UPDATE SET provider = EXCLUDED.provider, status = 'READY', search_text = EXCLUDED.search_text, error = NULL,
           translation_language = NULL, translation_status = NULL, translation_error = NULL, translated_texts = NULL, updated_at = NOW()
         RETURNING id`,
        [versionId, detected, provider.name, searchText]
      );
      transcriptId = upsert.rows[0].id as string;
    }
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
      await upsertCaptionTrack(
        { pool, uploadObject },
        { versionId, language: detected, vtt: serializeWebVtt(result.segments) }
      );
    } catch (error) {
      console.error('caption upsert failed', error);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await setTranscriptStatus({
      transcriptId: payload?.transcriptId,
      versionId,
      language,
      status: 'FAILED',
      error: message,
    });
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
  IMPORT_DRIVE: 'import-drive',
  MATERIALIZE_ROUGH_CUT: 'materialize-rough-cut',
  BURN_SUBTITLES: 'burn-subtitles',
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
  if (kind === 'IMPORT_DRIVE') return QUEUE.IMPORT_DRIVE;
  if (kind === 'MATERIALIZE_ROUGH_CUT') return QUEUE.MATERIALIZE_ROUGH_CUT;
  if (kind === 'BURN_SUBTITLES') return QUEUE.BURN_SUBTITLES;
  // Typed, so publishClaimedJobs can skip this one job instead of abandoning
  // the rest of the batch the way a real queue failure has to.
  throw new UnknownJobKindError(kind);
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
    } else if (kind === 'IMPORT_DRIVE') {
      await importDriveFile({ pool, uploadObject }, data.versionId);
    } else if (kind === 'MATERIALIZE_ROUGH_CUT') {
      const roughCutId =
        data.payload && typeof data.payload === 'object' && 'roughCutId' in data.payload
          ? String((data.payload as { roughCutId?: unknown }).roughCutId ?? '')
          : '';
      if (!roughCutId) throw new Error('MATERIALIZE_ROUGH_CUT payload is missing roughCutId');
      await materializeRoughCut(
        {
          pool,
          run,
          downloadObject,
          uploadObject,
          objectKeyFromProvider,
        },
        roughCutId
      );
    } else if (kind === 'BURN_SUBTITLES') {
      const payload = parseBurnInPayload(data.payload);
      if (!payload) throw new Error('BURN_SUBTITLES payload is invalid');
      await burnInSubtitles(
        {
          pool,
          run,
          downloadObject,
          uploadObject,
          deleteObject,
          downloadVersionMedia: downloadVersionFile,
        },
        data.versionId,
        payload
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
    const jobs = await claimDueMediaJobs(client);
    await client.query('COMMIT');
    await publishClaimedJobs(
      jobs,
      async (job) => {
        await boss.send(queueForKind(job.kind), {
          mediaJobId: job.id,
          versionId: job.versionId,
          payload: job.payload,
        } satisfies MediaJobData);
      },
      async (id) => {
        await pool.query(
          `UPDATE media_jobs SET status = 'PENDING', updated_at = NOW() WHERE id = $1 AND status = 'QUEUED'`,
          [id]
        );
      }
    );
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

  const boss = new PgBoss({
    connectionString: process.env.DATABASE_URL,
    max: WORKER_POOL_MAX,
    application_name: 'of-media-worker',
  });
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
  await boss.work(QUEUE.IMPORT_DRIVE, async (jobs) => {
    for (const job of jobs) {
      await runMediaJob(job.data as MediaJobData, 'IMPORT_DRIVE');
    }
  });
  await boss.work(QUEUE.MATERIALIZE_ROUGH_CUT, async (jobs) => {
    for (const job of jobs) {
      await runMediaJob(job.data as MediaJobData, 'MATERIALIZE_ROUGH_CUT');
    }
  });
  await boss.work(QUEUE.BURN_SUBTITLES, async (jobs) => {
    for (const job of jobs) {
      await runMediaJob(job.data as MediaJobData, 'BURN_SUBTITLES');
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
