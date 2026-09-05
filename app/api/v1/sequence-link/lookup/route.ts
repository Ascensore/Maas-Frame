import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { isAuthError, withApiAuth } from '@/lib/v1-auth';
import { computeProjectAccess, projectAccessInclude } from '@/lib/auth';
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
      // updatedAt alone is not a total order: two rows written in the same
      // millisecond would come back in an arbitrary order on each call.
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: 10,
    });
    if (rows.length === 0) {
      return withCacheControl(successResponse({ link: null }), 'private, no-store');
    }

    // One query for the versions rather than one per row, with the access
    // relations included so the check below is in-memory.
    const versions = await db.videoVersion.findMany({
      where: { id: { in: rows.map((row) => row.versionId) } },
      select: {
        id: true,
        versionNumber: true,
        video: {
          select: {
            title: true,
            project: { include: projectAccessInclude(authContext.userId) },
          },
        },
      },
    });
    const byId = new Map(versions.map((version) => [version.id, version]));

    for (const row of rows) {
      const version = byId.get(row.versionId);
      // A link outlives the access that created it, and the row is written by
      // the caller. Re-check on every read so a stale row cannot name a version
      // back to somebody who can no longer reach it.
      if (!version) continue;
      if (!computeProjectAccess(version.video.project, authContext.userId).hasAccess) continue;

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
