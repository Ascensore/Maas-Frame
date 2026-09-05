import { NextRequest } from 'next/server';
import { TranscriptStatus } from '@prisma/client';
import { db } from '@/lib/db';
import { auth, checkProjectAccess } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { logError } from '@/lib/logger';
import { syncCaptionTrackFromTranscript } from '@/lib/transcript-caption';

type RouteParams = { params: Promise<{ versionId: string }> };

/**
 * Build the caption track from the transcript this version already has. The
 * audio is never sent off to be transcribed again: a version with a READY
 * transcript already holds every word and every timing a subtitle file needs.
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

    const transcript = await db.transcript.findFirst({
      where: { versionId, status: TranscriptStatus.READY },
      orderBy: { createdAt: 'asc' },
      select: { id: true, language: true },
    });
    if (!transcript) return apiErrors.badRequest('This version has no transcript yet');

    let result: 'updated' | 'skipped' | 'empty';
    try {
      result = await syncCaptionTrackFromTranscript({
        transcriptId: transcript.id,
        billedUserId: version.video.project.workspace.ownerId,
        uploadedByUserId: userId,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'storage-quota') {
        return apiErrors.badRequest('Storage quota exceeded');
      }
      throw error;
    }

    if (result === 'empty') {
      return apiErrors.badRequest('The transcript has no timed lines to caption');
    }
    if (result === 'skipped') {
      return apiErrors.badRequest(
        'This version already holds the maximum number of subtitle tracks'
      );
    }

    const subtitle = await db.videoSubtitle.findUniqueOrThrow({
      where: { versionId_language: { versionId, language: transcript.language } },
      select: { id: true, language: true, label: true, sourceUrl: true },
    });

    return withCacheControl(
      successResponse(
        {
          subtitle: {
            id: subtitle.id,
            language: subtitle.language,
            label: subtitle.label,
            url: subtitle.sourceUrl,
          },
        },
        201
      ),
      'private, no-store'
    );
  } catch (error) {
    logError('Error building captions from the transcript:', error);
    return apiErrors.internalError('Failed to build captions from the transcript');
  }
}
