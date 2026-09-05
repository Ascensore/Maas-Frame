import { NextRequest } from 'next/server';
import { TranscriptStatus } from '@prisma/client';
import { db } from '@/lib/db';
import { auth, checkProjectAccess } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { logError } from '@/lib/logger';
import { normalizeSubtitleLanguage } from '@/lib/subtitle-validation';
import { StorageQuotaError, syncCaptionTrackFromTranscript } from '@/lib/transcript-caption';

type RouteParams = { params: Promise<{ versionId: string }> };

/**
 * Build the caption track from the transcript this version already has. The
 * audio is never sent off to be transcribed again: a version with a READY
 * transcript already holds every word and every timing a subtitle file needs.
 *
 * An explicit `language` picks the transcript to caption. Without one the
 * newest READY transcript wins, which is the same one the pane's GET shows, so
 * the button captions what the reader is looking at.
 */
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
      select: {
        video: {
          select: {
            project: {
              select: {
                id: true,
                ownerId: true,
                workspaceId: true,
                visibility: true,
                workspace: { select: { ownerId: true } },
              },
            },
          },
        },
      },
    });
    if (!version) return apiErrors.notFound('Version');

    const access = await checkProjectAccess(version.video.project, userId);
    if (!access.hasAccess || !access.canEdit) return apiErrors.forbidden('Access denied');

    const body = await request.json().catch(() => null);
    const requested = body?.language;
    let language: string | null = null;
    if (requested !== undefined && requested !== null && requested !== '') {
      language = normalizeSubtitleLanguage(requested);
      if (!language) {
        return apiErrors.badRequest('language must be a BCP-47 tag such as "tr" or "en-US"');
      }
    }

    const transcript = language
      ? await db.transcript.findUnique({
          where: { versionId_language: { versionId, language } },
          select: { id: true, status: true },
        })
      : await db.transcript.findFirst({
          where: { versionId, status: TranscriptStatus.READY },
          orderBy: { createdAt: 'desc' },
          select: { id: true, status: true },
        });

    if (!transcript || transcript.status !== TranscriptStatus.READY) {
      return apiErrors.badRequest(
        language ? 'No ready transcript in that language' : 'This version has no transcript yet'
      );
    }

    let result;
    try {
      result = await syncCaptionTrackFromTranscript({
        transcriptId: transcript.id,
        billedUserId: version.video.project.workspace.ownerId,
        uploadedByUserId: userId,
      });
    } catch (error) {
      if (error instanceof StorageQuotaError) {
        return apiErrors.badRequest('Storage quota exceeded');
      }
      throw error;
    }

    if (result.status === 'empty') {
      return apiErrors.badRequest('The transcript has no timed lines to caption');
    }
    if (result.status === 'skipped') {
      return apiErrors.badRequest(
        'This version already holds the maximum number of subtitle tracks'
      );
    }

    return withCacheControl(
      successResponse({ subtitle: result.subtitle }, result.created ? 201 : 200),
      'private, no-store'
    );
  } catch (error) {
    logError('Error building captions from the transcript:', error);
    return apiErrors.internalError('Failed to build captions from the transcript');
  }
}
