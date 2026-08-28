import { NextRequest } from 'next/server';
import { rateLimit } from '@/lib/rate-limit';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { isAuthError, loadVersionForUser, withApiAuth } from '@/lib/v1-auth';
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

    const { version } = loaded;
    return withCacheControl(
      successResponse({
        version: {
          id: version.id,
          versionNumber: version.versionNumber,
          versionLabel: version.versionLabel,
          providerId: version.providerId,
          duration: version.duration,
          frameRateNum: version.frameRateNum,
          frameRateDen: version.frameRateDen,
          dropFrame: version.dropFrame,
          startTimecode: version.startTimecode,
          durationFrames: version.durationFrames,
          isActive: version.isActive,
          video: {
            id: version.video.id,
            title: version.video.title,
            project: version.video.project,
          },
        },
      }),
      'private, no-store'
    );
  } catch (error) {
    logError('Error fetching v1 version:', error);
    return apiErrors.internalError('Failed to fetch version');
  }
}
