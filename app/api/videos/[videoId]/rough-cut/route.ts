import { NextRequest } from 'next/server';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { db } from '@/lib/db';
import { logError } from '@/lib/logger';
import { rateLimit } from '@/lib/rate-limit';
import { loadRoughCutReview } from '@/lib/rough-cut/review';
import { shapeRoughCut } from '@/lib/rough-cut/serialize';
import { getVideoAssetAccessContext } from '@/lib/video-assets';

type RouteParams = { params: Promise<{ videoId: string }> };

/**
 * The run behind a delivered cut, from the video the reviewer is watching.
 * Answers `{ roughCut: null }` for an ordinary video rather than 404: the pane
 * asks this of every video it opens, and "not a rough cut" is an answer, not an
 * error.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'transcript-read');
    if (limited) return limited;

    const { videoId } = await params;
    const context = await getVideoAssetAccessContext(request, videoId, 'VIEW');
    if (!context) return apiErrors.notFound('Video');
    if (!context.hasViewAccess) return apiErrors.forbidden('Access denied');

    const row = await db.roughCut.findFirst({
      where: { outputVideoId: videoId },
      orderBy: { createdAt: 'desc' },
    });
    if (!row) {
      return withCacheControl(successResponse({ roughCut: null }), 'private, no-store');
    }

    const canEdit = context.canManageAssets;
    return withCacheControl(
      successResponse({
        roughCut: shapeRoughCut(row),
        review: await loadRoughCutReview(row, { canEdit }),
        canEdit,
      }),
      'private, no-store'
    );
  } catch (error) {
    logError('Error loading the rough cut behind a video:', error);
    return apiErrors.internalError('Failed to load the rough cut');
  }
}
