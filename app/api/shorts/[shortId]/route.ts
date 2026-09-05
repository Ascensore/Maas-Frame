import { z } from 'zod';
import { NextRequest } from 'next/server';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { auth, checkProjectAccess } from '@/lib/auth';
import { db } from '@/lib/db';
import { isShortsFeatureEnabled } from '@/lib/feature-flags';
import { logError } from '@/lib/logger';
import { rateLimit } from '@/lib/rate-limit';
import {
  shortCaptionStyleSchema,
  shortFormBatchConfigSchema,
  snapShortRange,
} from '@/lib/short-form';
import { loadSourceTranscript, shortFormCandidateInclude } from '@/lib/short-form/store';

type RouteParams = { params: Promise<{ shortId: string }> };

const patchSchema = z
  .object({
    start: z.number().finite().nonnegative().optional(),
    end: z.number().finite().positive().optional(),
    cropMode: z.enum(['AUTO', 'MANUAL', 'PADDED']).optional(),
    focusX: z.number().min(0).max(1).nullable().optional(),
    focusY: z.number().min(0).max(1).nullable().optional(),
    captionStyle: shortCaptionStyleSchema.optional(),
    title: z.string().trim().min(1).max(120).optional(),
    socialCaption: z.string().trim().max(2200).optional(),
    hashtags: z
      .array(
        z
          .string()
          .trim()
          .regex(/^#[\p{L}\p{N}_]+$/u)
      )
      .max(30)
      .optional(),
    rejected: z.boolean().optional(),
  })
  .strict();

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;
    const session = await auth();
    if (!session?.user?.id) return apiErrors.unauthorized();
    if (!isShortsFeatureEnabled()) return apiErrors.notFound('Short-form editing');
    const { shortId } = await params;
    const candidate = await db.shortFormCandidate.findUnique({
      where: { id: shortId },
      include: {
        batch: {
          include: {
            roughCut: {
              include: {
                project: {
                  select: { id: true, ownerId: true, workspaceId: true, visibility: true },
                },
              },
            },
          },
        },
      },
    });
    if (!candidate) return apiErrors.notFound('Short');
    const access = await checkProjectAccess(candidate.batch.roughCut.project, session.user.id);
    if (!access.canEdit) return apiErrors.forbidden('Access denied');
    if (candidate.status === 'RENDERING' || candidate.status === 'READY') {
      return apiErrors.conflict('A rendered short cannot be edited');
    }
    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success)
      return apiErrors.validationError(parsed.error.issues[0]?.message ?? 'Invalid short');

    const start = parsed.data.start ?? candidate.sourceStartSec;
    const end = parsed.data.end ?? candidate.sourceEndSec;
    const config = shortFormBatchConfigSchema.parse(candidate.batch.config);
    if (end - start < config.minDurationSeconds || end - start > config.maxDurationSeconds) {
      return apiErrors.badRequest(
        `Short duration must be ${config.minDurationSeconds}–${config.maxDurationSeconds} seconds`
      );
    }
    const transcript = await loadSourceTranscript(candidate.batch.sourceVersionId);
    const snapped = snapShortRange(transcript, start, end);
    if (!snapped || Math.abs(snapped.start - start) > 0.02 || Math.abs(snapped.end - end) > 0.02) {
      return apiErrors.badRequest('Start and end must match transcript sentence boundaries');
    }
    const cropMode = parsed.data.cropMode ?? candidate.cropMode;
    const focusX = parsed.data.focusX === undefined ? candidate.focusX : parsed.data.focusX;
    const focusY = parsed.data.focusY === undefined ? candidate.focusY : parsed.data.focusY;
    if (cropMode === 'MANUAL' && (focusX === null || focusY === null)) {
      return apiErrors.badRequest('Manual crop requires normalized focusX and focusY');
    }
    const updated = await db.shortFormCandidate.update({
      where: { id: candidate.id },
      data: {
        sourceStartSec: start,
        sourceEndSec: end,
        cropMode,
        focusX,
        focusY,
        captionStyle: parsed.data.captionStyle,
        title: parsed.data.title,
        socialCaption: parsed.data.socialCaption,
        hashtags: parsed.data.hashtags,
        status:
          parsed.data.rejected === true
            ? 'REJECTED'
            : parsed.data.rejected === false
              ? 'PROPOSED'
              : undefined,
        error: null,
      },
      include: shortFormCandidateInclude,
    });
    return withCacheControl(successResponse({ candidate: updated }), 'private, no-store');
  } catch (error) {
    logError('Error updating short-form candidate:', error);
    return apiErrors.internalError('Failed to update short-form candidate');
  }
}
