import { NextRequest } from 'next/server';
import { auth, checkProjectAccess } from '@/lib/auth';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { db } from '@/lib/db';
import { logCleanupWarnings } from '@/lib/cleanup-warnings';
import { logError } from '@/lib/logger';
import { rateLimit } from '@/lib/rate-limit';
import { deleteProjectVideosWithCleanup, VideoStorageCleanupError } from '@/lib/video-delete';

type RouteParams = { params: Promise<{ projectId: string }> };

const MAX_BULK_DELETE = 50;

// POST /api/projects/[projectId]/videos/bulk-delete
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;

    const session = await auth();
    const { projectId } = await params;

    if (!session?.user?.id) {
      return apiErrors.unauthorized();
    }

    const project = await db.project.findUnique({
      where: { id: projectId },
      select: { id: true, ownerId: true, workspaceId: true, visibility: true },
    });
    if (!project) {
      return apiErrors.notFound('Project');
    }

    const access = await checkProjectAccess(project, session.user.id);
    if (!access.canEdit) {
      return apiErrors.forbidden('Only project owner or admin can delete videos');
    }

    const body = await request.json();
    const { videoIds } = body as { videoIds?: unknown };

    if (!Array.isArray(videoIds) || videoIds.length === 0) {
      return apiErrors.badRequest('videoIds must be a non-empty array');
    }
    if (videoIds.length > MAX_BULK_DELETE) {
      return apiErrors.badRequest(`You can delete at most ${MAX_BULK_DELETE} videos at once`);
    }
    if (!videoIds.every((id) => typeof id === 'string' && id.trim().length > 0)) {
      return apiErrors.badRequest('Each video id must be a non-empty string');
    }

    const normalizedIds = [...new Set(videoIds.map((id) => id.trim()))];

    let result;
    try {
      result = await deleteProjectVideosWithCleanup(projectId, normalizedIds);
    } catch (error) {
      if (error instanceof Error && error.message === 'VIDEO_NOT_FOUND') {
        return apiErrors.badRequest('One or more selected videos do not belong to this project');
      }
      // Storage refused a delete, so nothing was removed and the videos are still there.
      // Saying so lets the caller retry, which is the whole point of leaving the rows.
      if (error instanceof VideoStorageCleanupError) {
        logCleanupWarnings(
          { entityType: 'video', entityId: `bulk:${normalizedIds.join(',')}` },
          error.cleanupInput
        );
        return apiErrors.internalError(
          'Could not delete the stored media for these videos. Nothing was deleted; please try again.'
        );
      }
      throw error;
    }

    if (result.cleanupWarnings) {
      logCleanupWarnings(
        { entityType: 'video', entityId: `bulk:${normalizedIds.join(',')}` },
        result.cleanupInput
      );
    }

    const response = successResponse({
      message: `${result.deletedCount} video${result.deletedCount === 1 ? '' : 's'} deleted`,
      deletedCount: result.deletedCount,
      ...(result.cleanupWarnings ? { cleanupWarnings: result.cleanupWarnings } : {}),
    });
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error bulk deleting videos:', error);
    return apiErrors.internalError('Failed to delete selected videos');
  }
}
