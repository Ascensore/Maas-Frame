import { Prisma } from '@prisma/client';
import { NextRequest } from 'next/server';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { auth, checkProjectAccess } from '@/lib/auth';
import { db } from '@/lib/db';
import { isAgentsFeatureEnabled, isShortsFeatureEnabled } from '@/lib/feature-flags';
import { logError } from '@/lib/logger';
import { rateLimit } from '@/lib/rate-limit';
import { shortFormBatchConfigSchema } from '@/lib/short-form';
import { shapeShortFormBatch } from '@/lib/short-form/store';

type RouteParams = { params: Promise<{ roughCutId: string }> };

async function loadRoughCut(roughCutId: string) {
  return db.roughCut.findUnique({
    where: { id: roughCutId },
    include: {
      project: { select: { id: true, ownerId: true, workspaceId: true, visibility: true } },
      outputVideo: {
        include: {
          versions: {
            where: { isActive: true },
            take: 1,
            select: { id: true },
          },
        },
      },
    },
  });
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'transcript-read');
    if (limited) return limited;
    const session = await auth();
    if (!session?.user?.id) return apiErrors.unauthorized();
    if (!isShortsFeatureEnabled()) return apiErrors.notFound('Short-form editing');
    const { roughCutId } = await params;
    const cut = await loadRoughCut(roughCutId);
    if (!cut) return apiErrors.notFound('Rough cut');
    const access = await checkProjectAccess(cut.project, session.user.id);
    if (!access.hasAccess) return apiErrors.forbidden('Access denied');
    const batches = await db.shortFormBatch.findMany({
      where: { roughCutId },
      orderBy: { createdAt: 'desc' },
    });
    return withCacheControl(
      successResponse({ batches: batches.map(shapeShortFormBatch), canEdit: access.canEdit }),
      'private, no-store'
    );
  } catch (error) {
    logError('Error listing short-form batches:', error);
    return apiErrors.internalError('Failed to list short-form batches');
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;
    const session = await auth();
    if (!session?.user?.id) return apiErrors.unauthorized();
    if (!isShortsFeatureEnabled()) return apiErrors.notFound('Short-form editing');
    const { roughCutId } = await params;
    const cut = await loadRoughCut(roughCutId);
    if (!cut) return apiErrors.notFound('Rough cut');
    const access = await checkProjectAccess(cut.project, session.user.id);
    if (!access.canEdit) return apiErrors.forbidden('Access denied');
    const sourceVersionId = cut.outputVideo?.versions[0]?.id;
    if (cut.status !== 'READY' || !sourceVersionId) {
      return apiErrors.badRequest('Shorts require a completed, rendered rough cut');
    }
    const body = await request.json().catch(() => null);
    const parsed = shortFormBatchConfigSchema.safeParse(body ?? {});
    if (!parsed.success)
      return apiErrors.validationError(parsed.error.issues[0]?.message ?? 'Invalid batch');
    const warnings =
      parsed.data.useAi && !isAgentsFeatureEnabled()
        ? ['AI reranking is unavailable; deterministic ranking will be used.']
        : [];
    try {
      const batch = await db.$transaction(async (tx) => {
        const created = await tx.shortFormBatch.create({
          data: {
            roughCutId,
            sourceVersionId,
            requestedById: session.user.id,
            config: parsed.data,
            warnings,
          },
        });
        await tx.mediaJob.create({
          data: {
            versionId: sourceVersionId,
            kind: 'ANALYZE_SHORT_FORM',
            payload: { batchId: created.id },
          },
        });
        return created;
      });
      return withCacheControl(
        successResponse({ batch: shapeShortFormBatch(batch) }, 202),
        'private, no-store'
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return apiErrors.conflict(
          'A short-form batch is already active for this rough-cut version'
        );
      }
      throw error;
    }
  } catch (error) {
    logError('Error creating short-form batch:', error);
    return apiErrors.internalError('Failed to create short-form batch');
  }
}
