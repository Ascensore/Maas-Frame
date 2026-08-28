import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { isAuthError, loadProjectForUser, withApiAuth } from '@/lib/v1-auth';
import { logError } from '@/lib/logger';

type RouteParams = { params: Promise<{ projectId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'api-v1');
    if (limited) return limited;

    const authContext = await withApiAuth(request);
    if (isAuthError(authContext)) return authContext;

    const { projectId } = await params;
    const loaded = await loadProjectForUser(projectId, authContext.userId);
    if ('error' in loaded) return loaded.error;

    const videos = await db.video.findMany({
      where: { projectId },
      orderBy: { position: 'asc' },
      select: {
        id: true,
        title: true,
        position: true,
        updatedAt: true,
        versions: {
          orderBy: { versionNumber: 'desc' },
          select: {
            id: true,
            versionNumber: true,
            versionLabel: true,
            isActive: true,
            duration: true,
            frameRateNum: true,
            frameRateDen: true,
            dropFrame: true,
            startTimecode: true,
            durationFrames: true,
          },
        },
      },
    });

    return withCacheControl(successResponse({ videos }), 'private, no-store');
  } catch (error) {
    logError('Error listing v1 videos:', error);
    return apiErrors.internalError('Failed to list videos');
  }
}
