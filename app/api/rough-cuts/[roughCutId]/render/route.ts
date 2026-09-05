import { NextRequest } from 'next/server';
import { MediaJobKind } from '@prisma/client';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { auth, checkProjectAccess } from '@/lib/auth';
import { db } from '@/lib/db';
import { logError } from '@/lib/logger';
import { enqueueMediaJob } from '@/lib/media-jobs';
import { rateLimit } from '@/lib/rate-limit';
import { parseRoughCutDecisionList } from '@/lib/rough-cut/decision-list';
import { findActiveMaterializeJob } from '@/lib/rough-cut/review';

type RouteParams = { params: Promise<{ roughCutId: string }> };

/**
 * Re-cut the delivered video from the saved overrides. The work is a media job,
 * so this answers 202 and the pane follows the render state on the review
 * payload. One render at a time per run: a second one would race the first for
 * the output video's next version.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;

    const session = await auth();
    if (!session?.user?.id) return apiErrors.unauthorized();

    const { roughCutId } = await params;
    const row = await db.roughCut.findUnique({
      where: { id: roughCutId },
      include: {
        project: {
          select: { id: true, ownerId: true, workspaceId: true, visibility: true },
        },
      },
    });
    if (!row) return apiErrors.notFound('Rough cut');

    const access = await checkProjectAccess(row.project, session.user.id);
    if (!access.canEdit) return apiErrors.forbidden('Access denied');

    if (row.status !== 'READY') {
      return apiErrors.badRequest('Rough cut is not ready to render');
    }

    const decisions = parseRoughCutDecisionList(row.decisions);
    const firstEdit = decisions?.edits[0];
    if (!firstEdit) {
      return apiErrors.badRequest('Rough cut has nothing to render');
    }

    const active = await findActiveMaterializeJob(roughCutId);
    if (active) {
      return apiErrors.conflict('A render is already running for this cut');
    }

    // The job is leased through a version, and every clip of the run belongs to
    // the same project, so the first edit's source is as good an anchor as any.
    const jobId = await enqueueMediaJob(
      firstEdit.sourceVersionId,
      MediaJobKind.MATERIALIZE_ROUGH_CUT,
      { roughCutId }
    );

    return withCacheControl(
      successResponse({ job: { id: jobId, status: 'PENDING' } }, 202),
      'private, no-store'
    );
  } catch (error) {
    logError('Error queueing a rough cut render:', error);
    return apiErrors.internalError('Failed to queue the rough cut render');
  }
}
