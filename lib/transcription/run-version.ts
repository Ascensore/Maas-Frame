import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaJobKind, MediaJobStatus, Prisma, TranscriptStatus } from '@prisma/client';
import { db } from '@/lib/db';
import { logError } from '@/lib/logger';
import { canAutoTranscribe } from '@/lib/review-kind';
import { transcribeWithCloudFallback } from '@/lib/transcription/fallback';
import {
  AUTO_DETECT_TRANSCRIPT_LANGUAGE,
  isAutoDetectLanguage,
  languageForProvider,
  normalizeDetectedLanguage,
} from '@/lib/transcription/language';
import { downloadVersionMedia, sourceFileExtension } from '@/lib/transcription/source';

const TERMINAL_JOB_KINDS: MediaJobKind[] = [MediaJobKind.EXTRACT_AUDIO, MediaJobKind.TRANSCRIBE];

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Transcription failed';
  return message.slice(0, 500);
}

async function markJobs(
  versionId: string,
  status: typeof MediaJobStatus.SUCCEEDED | typeof MediaJobStatus.FAILED,
  error?: string
): Promise<void> {
  await db.mediaJob.updateMany({
    where: {
      versionId,
      kind: { in: TERMINAL_JOB_KINDS },
      status: {
        in: [MediaJobStatus.PENDING, MediaJobStatus.QUEUED, MediaJobStatus.RUNNING],
      },
    },
    data: {
      status,
      finishedAt: new Date(),
      error: error ?? null,
    },
  });
}

async function findTranscript(options: {
  versionId: string;
  language?: string;
  transcriptId?: string;
}) {
  if (options.transcriptId) {
    return db.transcript.findUnique({
      where: { id: options.transcriptId },
      select: { id: true, status: true, language: true },
    });
  }

  if (options.language && !isAutoDetectLanguage(options.language)) {
    return db.transcript.findUnique({
      where: { versionId_language: { versionId: options.versionId, language: options.language } },
      select: { id: true, status: true, language: true },
    });
  }

  return db.transcript.findFirst({
    where: { versionId: options.versionId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, status: true, language: true },
  });
}

/**
 * Transcribe a file-backed version inside the Next.js process. The media worker
 * is the long-term home for whisper-local; until one is attached to this
 * database, a PENDING row would poll forever. Cloud providers (and whisper-local
 * falling back to OpenAI) can finish here.
 */
export async function runTranscriptionForVersion(options: {
  versionId: string;
  language?: string;
  transcriptId?: string;
}): Promise<void> {
  const requestedLanguage =
    options.language?.trim().toLowerCase() || AUTO_DETECT_TRANSCRIPT_LANGUAGE;
  const version = await db.videoVersion.findUnique({
    where: { id: options.versionId },
    select: {
      id: true,
      providerId: true,
      videoId: true,
      originalUrl: true,
      video: { select: { kind: true } },
    },
  });
  if (!version) return;

  const transcript = await findTranscript({
    versionId: version.id,
    language: requestedLanguage,
    transcriptId: options.transcriptId,
  });
  if (!transcript) return;

  if (!canAutoTranscribe(version.video.kind, version.providerId)) {
    await db.transcript.update({
      where: { id: transcript.id },
      data: {
        status: TranscriptStatus.FAILED,
        error:
          'This version cannot be transcribed automatically. Upload a transcript file instead.',
      },
    });
    await markJobs(
      version.id,
      MediaJobStatus.FAILED,
      'This version cannot be transcribed automatically.'
    );
    return;
  }

  const claimed = await db.transcript.updateMany({
    where: {
      id: transcript.id,
      status: { in: [TranscriptStatus.PENDING, TranscriptStatus.FAILED] },
    },
    data: { status: TranscriptStatus.RUNNING, error: null },
  });
  if (claimed.count === 0) return;

  const dir = await mkdtemp(join(tmpdir(), 'of-inline-tr-'));
  try {
    const media = await downloadVersionMedia(version);
    const audioPath = join(dir, `source${sourceFileExtension(media.fileName)}`);
    await writeFile(audioPath, media.bytes);

    const providerLanguage = languageForProvider(requestedLanguage);
    const { provider, result } = await transcribeWithCloudFallback({
      audioPath,
      ...(providerLanguage ? { language: providerLanguage } : {}),
    });

    const detectedLanguage = normalizeDetectedLanguage(
      result.language,
      providerLanguage ?? AUTO_DETECT_TRANSCRIPT_LANGUAGE
    );
    const searchText = result.segments.map((segment) => segment.text).join(' ');
    await db.$transaction(async (tx) => {
      await tx.transcript.update({
        where: { id: transcript.id },
        data: {
          status: TranscriptStatus.READY,
          provider,
          language: detectedLanguage,
          searchText,
          error: null,
          translationLanguage: null,
          translationStatus: null,
          translationError: null,
          translatedTexts: Prisma.DbNull,
        },
      });
      await tx.transcriptSegment.deleteMany({ where: { transcriptId: transcript.id } });
      if (result.segments.length === 0) return;
      await tx.transcriptSegment.createMany({
        data: result.segments.map((segment, position) => ({
          transcriptId: transcript.id,
          startSec: segment.start,
          endSec: segment.end,
          speaker: segment.speaker ?? null,
          text: segment.text,
          words: segment.words as Prisma.InputJsonValue,
          position,
        })),
      });
    });

    await markJobs(version.id, MediaJobStatus.SUCCEEDED);
  } catch (error) {
    const message = errorMessage(error);
    logError('Inline transcription failed:', error);
    await db.transcript.update({
      where: { id: transcript.id },
      data: {
        status: TranscriptStatus.FAILED,
        error: message,
      },
    });
    await markJobs(version.id, MediaJobStatus.FAILED, message);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
