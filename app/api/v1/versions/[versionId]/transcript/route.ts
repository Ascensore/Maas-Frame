import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { MediaJobKind, TranscriptStatus } from '@prisma/client';
import { rateLimit } from '@/lib/rate-limit';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { isAuthError, loadVersionForUser, withApiAuth } from '@/lib/v1-auth';
import { enqueueMediaJob } from '@/lib/media-jobs';
import { getTranscriptionProviderName, isTranscriptionFeatureEnabled } from '@/lib/feature-flags';
import { logError } from '@/lib/logger';

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
