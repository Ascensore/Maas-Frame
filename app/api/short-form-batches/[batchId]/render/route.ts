import { z } from 'zod';
import { NextRequest } from 'next/server';
import { lockResourceInTransaction } from '@/lib/advisory-lock';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { auth, checkProjectAccess } from '@/lib/auth';
import { db } from '@/lib/db';
import { isShortsFeatureEnabled } from '@/lib/feature-flags';
import { logError } from '@/lib/logger';
import { rateLimit } from '@/lib/rate-limit';

type RouteParams = { params: Promise<{ batchId: string }> };
const bodySchema = z.object({ candidateIds: z.array(z.string().min(1)).min(1).max(10) }).strict();

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;
    const session = await auth();
    if (!session?.user?.id) return apiErrors.unauthorized();
    if (!isShortsFeatureEnabled()) return apiErrors.notFound('Short-form editing');
    const { batchId } = await params;
    const body = bodySchema.safeParse(await request.json().catch(() => null));
    if (!body.success)
      return apiErrors.validationError(body.error.issues[0]?.message ?? 'Invalid render request');
    const ids = [...new Set(body.data.candidateIds)];
    if (ids.length !== body.data.candidateIds.length)
      return apiErrors.badRequest('Candidate IDs must be unique');
    const batch = await db.shortFormBatch.findUnique({
      where: { id: batchId },
      include: {
        roughCut: {
          include: {
            project: { select: { id: true, ownerId: true, workspaceId: true, visibility: true } },
          },
        },
      },
    });
    if (!batch) return apiErrors.notFound('Short-form batch');
    const access = await checkProjectAccess(batch.roughCut.project, session.user.id);
    if (!access.canEdit) return apiErrors.forbidden('Access denied');
    if (batch.status !== 'READY') return apiErrors.conflict('Candidate analysis is not ready');

    const jobs = await db.$transaction(async (tx) => {
      await lockResourceInTransaction(tx, batchId);
      const candidates = await tx.shortFormCandidate.findMany({
        where: { id: { in: ids }, batchId },
      });
      if (candidates.length !== ids.length) throw new Error('CROSS_BATCH_CANDIDATE');
      if (
        candidates.some(
          (candidate) => !['PROPOSED', 'APPROVED', 'FAILED'].includes(candidate.status)
        )
      ) {
        throw new Error('CANDIDATE_NOT_RENDERABLE');
      }
      await tx.shortFormCandidate.updateMany({
        where: { id: { in: ids }, batchId },
        data: { status: 'APPROVED', error: null },
      });
      return Promise.all(
        ids.map((candidateId) =>
          tx.mediaJob.create({
            data: {
              versionId: batch.sourceVersionId,
              kind: 'RENDER_SHORT_FORM',
              payload: { batchId, candidateId },
            },
            select: { id: true, status: true },
          })
        )
      );
    });
    return withCacheControl(successResponse({ jobs }, 202), 'private, no-store');
  } catch (error) {
    if (error instanceof Error && error.message === 'CROSS_BATCH_CANDIDATE') {
      return apiErrors.badRequest('Every selected candidate must belong to this batch');
    }
    if (error instanceof Error && error.message === 'CANDIDATE_NOT_RENDERABLE') {
      return apiErrors.conflict('One or more selected candidates cannot be rendered');
    }
    logError('Error queueing short-form renders:', error);
    return apiErrors.internalError('Failed to queue short-form renders');
  }
}
