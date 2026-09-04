import { NextRequest } from 'next/server';
import { Prisma, TranscriptStatus } from '@prisma/client';
import { db } from '@/lib/db';
import { auth, computeProjectAccess, projectAccessInclude } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { logError } from '@/lib/logger';
import {
  DEFAULT_TRANSLATION_LANGUAGE,
  normalizeDetectedLanguage,
} from '@/lib/transcription/language';
import { translateTranscriptTexts } from '@/lib/transcription/translate';
import { shapeTranscriptTranslation } from '@/lib/transcript-translation';

type RouteParams = { params: Promise<{ versionId: string }> };

export const maxDuration = 300;

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;

    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return apiErrors.unauthorized();

    const { versionId } = await params;
    const version = await db.videoVersion.findUnique({
      where: { id: versionId },
      include: {
        video: {
          include: {
            project: { include: projectAccessInclude(userId) },
          },
        },
      },
    });
    if (!version) return apiErrors.notFound('Version');

    const access = computeProjectAccess(version.video.project, userId);
    if (!access.canEdit) return apiErrors.forbidden('Access denied');

    const transcript = await db.transcript.findFirst({
      where: { versionId, status: TranscriptStatus.READY },
      orderBy: { createdAt: 'desc' },
      include: { segments: { orderBy: { position: 'asc' } } },
    });
    if (!transcript || transcript.segments.length === 0) {
      return apiErrors.badRequest('Transcribe this version before requesting a translation');
    }

    const body = await request.json().catch(() => null);
    const targetLanguage = normalizeDetectedLanguage(
      typeof body?.language === 'string' ? body.language : DEFAULT_TRANSLATION_LANGUAGE,
      DEFAULT_TRANSLATION_LANGUAGE
    );

    if (
      transcript.translationStatus === TranscriptStatus.READY &&
      transcript.translationLanguage === targetLanguage &&
      Array.isArray(transcript.translatedTexts) &&
      transcript.translatedTexts.length === transcript.segments.length
    ) {
      return withCacheControl(
        successResponse({
          translation: shapeTranscriptTranslation({
            translationLanguage: transcript.translationLanguage,
            translationStatus: transcript.translationStatus,
            translationError: transcript.translationError,
            translatedTexts: transcript.translatedTexts,
          }),
        }),
        'private, no-store'
      );
    }

    await db.transcript.update({
      where: { id: transcript.id },
      data: {
        translationLanguage: targetLanguage,
        translationStatus: TranscriptStatus.RUNNING,
        translationError: null,
      },
    });

    try {
      const texts = await translateTranscriptTexts({
        texts: transcript.segments.map((segment) => segment.text),
        sourceLanguage: transcript.language,
        targetLanguage,
      });

      const updated = await db.transcript.update({
        where: { id: transcript.id },
        data: {
          translationLanguage: targetLanguage,
          translationStatus: TranscriptStatus.READY,
          translationError: null,
          translatedTexts: texts,
        },
      });

      return withCacheControl(
        successResponse({
          translation: shapeTranscriptTranslation({
            translationLanguage: updated.translationLanguage,
            translationStatus: updated.translationStatus,
            translationError: updated.translationError,
            translatedTexts: updated.translatedTexts,
          }),
        }),
        'private, no-store'
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Translation failed';
      await db.transcript.update({
        where: { id: transcript.id },
        data: {
          translationStatus: TranscriptStatus.FAILED,
          translationError: message.slice(0, 500),
          translatedTexts: Prisma.DbNull,
        },
      });
      logError('Transcript translation failed:', error);
      return apiErrors.internalError('Failed to translate transcript');
    }
  } catch (error) {
    logError('Error translating transcript:', error);
    return apiErrors.internalError('Failed to translate transcript');
  }
}
