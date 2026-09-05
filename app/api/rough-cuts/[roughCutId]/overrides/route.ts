import { NextRequest } from 'next/server';
import type { Prisma } from '@prisma/client';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { auth, checkProjectAccess } from '@/lib/auth';
import { db } from '@/lib/db';
import { logError } from '@/lib/logger';
import { rateLimit } from '@/lib/rate-limit';
import { parseRoughCutDecisionList } from '@/lib/rough-cut/decision-list';
import {
  overrideSummary,
  overridesEqual,
  parseRoughCutOverrides,
  validateOverridesForDecisions,
} from '@/lib/rough-cut/overrides';

type RouteParams = { params: Promise<{ roughCutId: string }> };

/**
 * The reviewer's decisions on a run: which cut islands go back in, and which
 * extra ranges come out. Saving them changes nothing on the delivered video —
 * POST .../render is what re-cuts it — so the pane can save as often as it
 * likes and render once.
 */
export async function PUT(request: NextRequest, { params }: RouteParams) {
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
      return apiErrors.badRequest('Rough cut is not ready to review');
    }

    const decisions = parseRoughCutDecisionList(row.decisions);
    if (!decisions) {
      return apiErrors.badRequest('Rough cut has no decisions to review');
    }

    const body = await request.json().catch(() => null);
    const validated = validateOverridesForDecisions(body ?? {}, decisions);
    if (!validated.ok) return apiErrors.badRequest(validated.error);

    await db.roughCut.update({
      where: { id: roughCutId },
      data: { overrides: validated.value as unknown as Prisma.InputJsonValue },
    });

    return withCacheControl(
      successResponse({
        overrides: validated.value,
        summary: overrideSummary(decisions, validated.value),
        needsRender: !overridesEqual(
          validated.value,
          parseRoughCutOverrides(row.renderedOverrides)
        ),
      }),
      'private, no-store'
    );
  } catch (error) {
    logError('Error saving rough cut overrides:', error);
    return apiErrors.internalError('Failed to save rough cut overrides');
  }
}
