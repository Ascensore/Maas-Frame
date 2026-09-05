import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth, checkProjectAccess } from '@/lib/auth';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { logError } from '@/lib/logger';
import { rateLimit } from '@/lib/rate-limit';
import { loadRoughCutReview } from '@/lib/rough-cut/review';
import { shapeRoughCut } from '@/lib/rough-cut/serialize';

type RouteParams = { params: Promise<{ roughCutId: string }> };

async function loadCutForUser(roughCutId: string, userId: string | undefined) {
  const row = await db.roughCut.findUnique({
    where: { id: roughCutId },
    include: {
      project: {
        select: {
          id: true,
          ownerId: true,
          workspaceId: true,
          visibility: true,
          allowDownloads: true,
        },
      },
    },
  });
  if (!row) return null;
  const access = await checkProjectAccess(row.project, userId);
  return { row, access };
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'transcript-read');
    if (limited) return limited;

    const session = await auth();
    if (!session?.user?.id) return apiErrors.unauthorized();

    const { roughCutId } = await params;
    const loaded = await loadCutForUser(roughCutId, session.user.id);
    if (!loaded) return apiErrors.notFound('Rough cut');
    if (!loaded.access.hasAccess) return apiErrors.forbidden('Access denied');

    // The review payload is several joins wider than the row, so the pane asks
    // for it and every other caller keeps the cheap answer. It is an editing
    // payload throughout — the script, the reviewer's decisions and the clips
    // behind the program — so a caller who may only comment asking for it gets
    // `review: null` rather than a hollowed out one.
    const includeReview = request.nextUrl.searchParams.get('include') === 'review';
    const canEdit = loaded.access.canEdit;

    return withCacheControl(
      successResponse({
        roughCut: shapeRoughCut(loaded.row, { includeScript: canEdit }),
        ...(includeReview ? { review: await loadRoughCutReview(loaded.row, { canEdit }) } : {}),
      }),
      'private, no-store'
    );
  } catch (error) {
    logError('Error fetching rough cut:', error);
    return apiErrors.internalError('Failed to fetch rough cut');
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;

    const session = await auth();
    if (!session?.user?.id) return apiErrors.unauthorized();

    const { roughCutId } = await params;
    const loaded = await loadCutForUser(roughCutId, session.user.id);
    if (!loaded) return apiErrors.notFound('Rough cut');
    if (!loaded.access.canEdit) return apiErrors.forbidden('Access denied');

    await db.roughCut.delete({ where: { id: roughCutId } });
    return withCacheControl(successResponse({ deleted: true }), 'private, no-store');
  } catch (error) {
    logError('Error deleting rough cut:', error);
    return apiErrors.internalError('Failed to delete rough cut');
  }
}
