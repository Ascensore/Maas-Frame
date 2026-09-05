import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import { logError } from '@/lib/logger';
import { rateLimit } from '@/lib/rate-limit';
import {
  emptyOverrides,
  needsRender,
  overrideSummary,
  overridesEqual,
  parseRoughCutOverrides,
  validateOverridesForDecisions,
} from '@/lib/rough-cut/overrides';
import { loadRoughCutForEditor } from '@/lib/rough-cut/review';

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
    const loaded = await loadRoughCutForEditor(roughCutId, session.user.id, 'review');
    if ('error' in loaded) return loaded.error;
    const { row, decisions } = loaded;

    const body = await request.json().catch(() => null);
    const validated = validateOverridesForDecisions(body ?? {}, decisions);
    if (!validated.ok) return apiErrors.badRequest(validated.error);

    // A review that decided nothing is no review: stored as SQL NULL rather
    // than as an empty object, so `hasOverrides` and every "has this been
    // looked at" check read the same answer as they did before the save.
    const decided = !overridesEqual(validated.value, emptyOverrides());
    await db.roughCut.update({
      where: { id: roughCutId },
      data: {
        overrides: decided ? (validated.value as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
      },
    });

    const stored = decided ? validated.value : null;
    return withCacheControl(
      successResponse({
        overrides: stored,
        summary: overrideSummary(decisions, stored),
        needsRender: needsRender(decisions, stored, parseRoughCutOverrides(row.renderedOverrides)),
      }),
      'private, no-store'
    );
  } catch (error) {
    logError('Error saving rough cut overrides:', error);
    return apiErrors.internalError('Failed to save rough cut overrides');
  }
}
