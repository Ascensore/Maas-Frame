import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { isAuthError, loadVersionForUser, withApiAuth } from '@/lib/v1-auth';
import { logError } from '@/lib/logger';

type RouteParams = { params: Promise<{ commentId: string }> };

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'comment');
    if (limited) return limited;

    const authContext = await withApiAuth(request);
    if (isAuthError(authContext)) return authContext;

    const { commentId } = await params;
    const comment = await db.comment.findUnique({
      where: { id: commentId },
      select: { id: true, versionId: true, isResolved: true },
    });
    if (!comment) return apiErrors.notFound('Comment');

    const loaded = await loadVersionForUser(comment.versionId, authContext.userId);
    if ('error' in loaded) return loaded.error;
    if (!loaded.access.canEdit && !loaded.access.hasAccess) {
      return apiErrors.forbidden('Access denied');
    }

    const body = await request.json().catch(() => null);
    const data: { isResolved?: boolean; resolvedAt?: Date | null; content?: string } = {};

    if (typeof body?.isResolved === 'boolean') {
      data.isResolved = body.isResolved;
      data.resolvedAt = body.isResolved ? new Date() : null;
    }
    if (typeof body?.content === 'string') {
      data.content = body.content.trim();
    }

    if (Object.keys(data).length === 0) {
      return apiErrors.badRequest('Provide isResolved and/or content');
    }

    const updated = await db.comment.update({
      where: { id: commentId },
      data,
      select: {
        id: true,
        content: true,
        timestamp: true,
        timestampEnd: true,
        timestampFrame: true,
        isResolved: true,
        resolvedAt: true,
        parentId: true,
        updatedAt: true,
      },
    });

    return withCacheControl(successResponse({ comment: updated }), 'private, no-store');
  } catch (error) {
    logError('Error updating v1 comment:', error);
    return apiErrors.internalError('Failed to update comment');
  }
}
