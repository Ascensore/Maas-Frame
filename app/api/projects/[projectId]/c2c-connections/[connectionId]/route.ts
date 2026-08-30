import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth, checkProjectAccess } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { logError } from '@/lib/logger';

type RouteParams = { params: Promise<{ projectId: string; connectionId: string }> };

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;

    const session = await auth();
    if (!session?.user?.id) return apiErrors.unauthorized();

    const { projectId, connectionId } = await params;
    const project = await db.project.findUnique({
      where: { id: projectId },
      select: { id: true, ownerId: true, workspaceId: true, visibility: true },
    });
    if (!project) return apiErrors.forbidden('Access denied');

    const access = await checkProjectAccess(project, session.user.id);
    if (!access.canEdit) return apiErrors.forbidden('Access denied');

    const updated = await db.c2cConnection.updateMany({
      where: { id: connectionId, projectId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    if (updated.count !== 1) {
      return apiErrors.notFound('Ingest connection');
    }

    return withCacheControl(successResponse({ ok: true }), 'private, no-store');
  } catch (error) {
    logError('Error revoking C2C connection:', error);
    return apiErrors.internalError('Failed to revoke ingest connection');
  }
}
