import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { MediaJobKind, Prisma, TranscriptStatus } from '@prisma/client';
import { rateLimit } from '@/lib/rate-limit';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { isAuthError, loadVersionForUser, withApiAuth } from '@/lib/v1-auth';
import { enqueueMediaJob } from '@/lib/media-jobs';
import { getTranscriptionProviderName, isTranscriptionFeatureEnabled } from '@/lib/feature-flags';
import { logError } from '@/lib/logger';
import { saveFailedTranscript, saveReadyTranscript } from '@/lib/transcript-persist';
import { fetchYoutubeTranscript, YOUTUBE_TRANSCRIPT_PROVIDER } from '@/lib/transcription/youtube';
import {
  importTranscriptFile,
  MAX_TRANSCRIPT_FILE_SIZE,
  TRANSCRIPT_UPLOAD_PROVIDER,
} from '@/lib/transcript-import';
import { normalizeSubtitleLanguage } from '@/lib/subtitle-validation';

type RouteParams = { params: Promise<{ versionId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'api-v1');
    if (limited) return limited;

    const authContext = await withApiAuth(request);
    if (isAuthError(authContext)) return authContext;

    const { versionId } = await params;
    const loaded = await loadVersionForUser(versionId, authContext.userId);
    if ('error' in loaded) return loaded.error;

    const { searchParams } = new URL(request.url);
    const q = searchParams.get('q')?.trim() ?? '';

    const transcript = await db.transcript.findFirst({
      where: { versionId },
      orderBy: { createdAt: 'desc' },
      include: {
        segments: { orderBy: { position: 'asc' } },
      },
    });

    if (!transcript) {
      return withCacheControl(successResponse({ transcript: null }), 'private, no-store');
    }

    let segments = transcript.segments;
    if (q) {
      const lowered = q.toLowerCase();
      segments = segments.filter((segment) => segment.text.toLowerCase().includes(lowered));
    }

    return withCacheControl(
      successResponse({
        transcript: {
          id: transcript.id,
          versionId: transcript.versionId,
          language: transcript.language,
          provider: transcript.provider,
          status: transcript.status,
          error: transcript.error,
          segments: segments.map((segment) => ({
            id: segment.id,
            startSec: segment.startSec,
            endSec: segment.endSec,
            speaker: segment.speaker,
            text: segment.text,
            words: segment.words,
            position: segment.position,
          })),
        },
      }),
      'private, no-store'
    );
  } catch (error) {
    logError('Error fetching v1 transcript:', error);
    return apiErrors.internalError('Failed to fetch transcript');
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;

    const authContext = await withApiAuth(request);
    if (isAuthError(authContext)) return authContext;

    const { versionId } = await params;
    const loaded = await loadVersionForUser(versionId, authContext.userId);
    if ('error' in loaded) return loaded.error;
    if (!loaded.access.canEdit) return apiErrors.forbidden('Access denied');

    if (!isTranscriptionFeatureEnabled()) {
      return apiErrors.badRequest('Transcription is disabled on this host');
    }

    const body = await request.json().catch(() => null);
    const language = typeof body?.language === 'string' ? body.language.trim().toLowerCase() : 'en';

    if (loaded.version.providerId === 'youtube') {
      const imported = await fetchYoutubeTranscript(loaded.version.videoId, language);
      if (!imported.ok) {
        await saveFailedTranscript({
          versionId,
          language,
          provider: YOUTUBE_TRANSCRIPT_PROVIDER,
          error: imported.error,
        });
        return apiErrors.badRequest(imported.error);
      }

      const transcript = await saveReadyTranscript({
        versionId,
        language,
        provider: YOUTUBE_TRANSCRIPT_PROVIDER,
        segments: imported.segments,
      });
      return withCacheControl(
        successResponse({ transcript: shapeTranscript(transcript) }),
        'private, no-store'
      );
    }

    const transcript = await db.transcript.upsert({
      where: { versionId_language: { versionId, language } },
      create: {
        versionId,
        language,
        provider: getTranscriptionProviderName(),
        status: TranscriptStatus.PENDING,
      },
      update: {
        status: TranscriptStatus.PENDING,
        error: null,
        provider: getTranscriptionProviderName(),
      },
    });

    await enqueueMediaJob(versionId, MediaJobKind.EXTRACT_AUDIO);
    await enqueueMediaJob(versionId, MediaJobKind.TRANSCRIBE, {
      language,
      transcriptId: transcript.id,
    });

    return withCacheControl(successResponse({ transcript }, 202), 'private, no-store');
  } catch (error) {
    logError('Error enqueueing transcript:', error);
    return apiErrors.internalError('Failed to enqueue transcription');
  }
}

function shapeTranscript(transcript: {
  id: string;
  versionId: string;
  language: string;
  provider: string;
  status: TranscriptStatus;
  error: string | null;
  segments: Array<{
    id: string;
    startSec: number;
    endSec: number;
    speaker: string | null;
    text: string;
    words: unknown;
    position: number;
  }>;
}) {
  return {
    id: transcript.id,
    versionId: transcript.versionId,
    language: transcript.language,
    provider: transcript.provider,
    status: transcript.status,
    error: transcript.error,
    segments: transcript.segments.map((segment) => ({
      id: segment.id,
      startSec: segment.startSec,
      endSec: segment.endSec,
      speaker: segment.speaker,
      text: segment.text,
      words: segment.words,
      position: segment.position,
    })),
  };
}

/**
 * Replace the version's transcript with an uploaded SRT or WebVTT. This is a
 * write, not a transcribe job: it does not depend on the transcription worker.
 */
export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;

    const authContext = await withApiAuth(request);
    if (isAuthError(authContext)) return authContext;

    const { versionId } = await params;
    const loaded = await loadVersionForUser(versionId, authContext.userId);
    if ('error' in loaded) return loaded.error;
    if (!loaded.access.canEdit) return apiErrors.forbidden('Access denied');

    const form = await request.formData().catch(() => null);
    const file = form?.get('file');
    if (!(file instanceof File)) {
      return apiErrors.badRequest('Upload an .srt, .vtt, .txt, or .docx file');
    }
    if (file.size > MAX_TRANSCRIPT_FILE_SIZE) {
      return apiErrors.badRequest('Transcript file is too large');
    }

    const language = normalizeSubtitleLanguage(form?.get('language')) ?? 'en';

    const bytes = new Uint8Array(await file.arrayBuffer());
    const imported = await importTranscriptFile({ fileName: file.name, buffer: bytes });
    if (!imported.ok) return apiErrors.badRequest(imported.error);

    const searchText = imported.segments.map((segment) => segment.text).join(' ');

    const transcript = await db.$transaction(async (tx) => {
      const row = await tx.transcript.upsert({
        where: { versionId_language: { versionId, language } },
        create: {
          versionId,
          language,
          provider: TRANSCRIPT_UPLOAD_PROVIDER,
          status: TranscriptStatus.READY,
          searchText,
          error: null,
        },
        update: {
          provider: TRANSCRIPT_UPLOAD_PROVIDER,
          status: TranscriptStatus.READY,
          searchText,
          error: null,
        },
      });

      await tx.transcriptSegment.deleteMany({ where: { transcriptId: row.id } });
      await tx.transcriptSegment.createMany({
        data: imported.segments.map((segment, position) => ({
          transcriptId: row.id,
          startSec: segment.startSec,
          endSec: segment.endSec,
          text: segment.text,
          words: segment.words as Prisma.InputJsonValue,
          position,
        })),
      });

      return tx.transcript.findUniqueOrThrow({
        where: { id: row.id },
        include: { segments: { orderBy: { position: 'asc' } } },
      });
    });

    return withCacheControl(
      successResponse({ transcript: shapeTranscript(transcript) }),
      'private, no-store'
    );
  } catch (error) {
    logError('Error uploading transcript:', error);
    return apiErrors.internalError('Failed to upload transcript');
  }
}
