import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { isAuthError, withApiAuth } from '@/lib/v1-auth';
import { checkProjectAccess } from '@/lib/auth';
import { startTimecodeToSeconds } from '@/lib/timecode';
import { logError } from '@/lib/logger';

const NLE_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * Answers "which version is the sequence in front of me?" so a panel can bind
 * itself without the editor picking from a dropdown.
 *
 * Matching is on the host's own sequence id, never on the name: duplicating a
 * sequence copies its name and its markers but gets a fresh id, which is the one
 * case a name match would get wrong and silently sync a stale duplicate.
 */
export async function GET(request: NextRequest) {
  try {
    const limited = await rateLimit(request, 'api-v1');
    if (limited) return limited;

    const authContext = await withApiAuth(request);
    if (isAuthError(authContext)) return authContext;

    const { searchParams } = new URL(request.url);
    const nle = (searchParams.get('nle') ?? '').trim().toLowerCase();
    const sequenceId = (searchParams.get('sequenceId') ?? '').trim();

    if (!NLE_PATTERN.test(nle)) return apiErrors.badRequest('nle is required');
    if (!sequenceId) return apiErrors.badRequest('sequenceId is required');

    const rows = await db.sequenceLink.findMany({
      where: { userId: authContext.userId, nle, sequenceId },
      orderBy: { updatedAt: 'desc' },
      take: 10,
    });

    for (const row of rows) {
      const version = await db.videoVersion.findUnique({
        where: { id: row.versionId },
        select: {
          id: true,
          versionNumber: true,
          video: {
            select: {
              title: true,
              project: {
                select: {
                  id: true,
                  ownerId: true,
                  workspaceId: true,
                  visibility: true,
                  name: true,
                },
              },
            },
          },
        },
      });
      // A link outlives the access that created it. Re-check on every lookup so
      // a removed collaborator's stale row cannot name a version back to them.
      if (!version) continue;
      const access = await checkProjectAccess(version.video.project, authContext.userId);
      if (!access.hasAccess) continue;

      return withCacheControl(
        successResponse({
          link: {
            versionId: version.id,
            versionNumber: version.versionNumber,
            videoTitle: version.video.title,
            projectId: version.video.project.id,
            projectName: version.video.project.name,
            nle: row.nle,
            sequenceId: row.sequenceId,
            sequenceName: row.sequenceName,
            startTimecode: row.startTimecode,
            frameRateNum: row.frameRateNum,
            frameRateDen: row.frameRateDen,
            dropFrame: row.dropFrame,
            offsetSeconds: startTimecodeToSeconds(row.startTimecode, {
              num: row.frameRateNum,
              den: row.frameRateDen,
              dropFrame: row.dropFrame,
            }),
          },
        }),
        'private, no-store'
      );
    }

    return withCacheControl(successResponse({ link: null }), 'private, no-store');
  } catch (error) {
    logError('Error looking up sequence link:', error);
    return apiErrors.internalError('Failed to look up sequence link');
  }
}
