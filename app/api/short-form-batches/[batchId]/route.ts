import { NextRequest } from 'next/server';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { auth, checkProjectAccess } from '@/lib/auth';
import { db } from '@/lib/db';
import { isShortsFeatureEnabled } from '@/lib/feature-flags';
import { logError } from '@/lib/logger';
import { rateLimit } from '@/lib/rate-limit';
import {
  loadSourceTranscript,
  shapeShortFormBatch,
  shortFormCandidateInclude,
} from '@/lib/short-form/store';
import { sentenceBoundaries } from '@/lib/short-form';

type RouteParams = { params: Promise<{ batchId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'transcript-read');
    if (limited) return limited;
    const session = await auth();
    if (!session?.user?.id) return apiErrors.unauthorized();
    if (!isShortsFeatureEnabled()) return apiErrors.notFound('Short-form editing');
    const { batchId } = await params;
    const batch = await db.shortFormBatch.findUnique({
      where: { id: batchId },
      include: {
        candidates: { orderBy: { rank: 'asc' }, include: shortFormCandidateInclude },
        sourceVersion: { select: { originalUrl: true } },
        roughCut: {
          include: {
            project: { select: { id: true, ownerId: true, workspaceId: true, visibility: true } },
          },
        },
      },
    });
    if (!batch) return apiErrors.notFound('Short-form batch');
    const access = await checkProjectAccess(batch.roughCut.project, session.user.id);
    if (!access.hasAccess) return apiErrors.forbidden('Access denied');
    const transcript = await loadSourceTranscript(batch.sourceVersionId);
    return withCacheControl(
      successResponse({
        batch: shapeShortFormBatch(batch),
        canEdit: access.canEdit,
        sourceUrl: batch.sourceVersion.originalUrl,
        sentenceBoundaries: sentenceBoundaries(transcript),
      }),
      'private, no-store'
    );
  } catch (error) {
    logError('Error loading short-form batch:', error);
    return apiErrors.internalError('Failed to load short-form batch');
  }
}
