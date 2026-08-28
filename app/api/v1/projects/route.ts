import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { isAuthError, withApiAuth } from '@/lib/v1-auth';
import { logError } from '@/lib/logger';

export async function GET(request: NextRequest) {
  try {
    const limited = await rateLimit(request, 'api-v1');
    if (limited) return limited;

    const authContext = await withApiAuth(request);
    if (isAuthError(authContext)) return authContext;

    const memberships = await db.workspaceMember.findMany({
      where: { userId: authContext.userId },
      select: { workspaceId: true },
    });
    const memberWorkspaceIds = memberships.map((row) => row.workspaceId);

    const projects = await db.project.findMany({
      where: {
        OR: [
          { ownerId: authContext.userId },
          { members: { some: { userId: authContext.userId } } },
          { workspaceId: { in: memberWorkspaceIds } },
        ],
      },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        name: true,
        slug: true,
        workspaceId: true,
        updatedAt: true,
        _count: { select: { videos: true } },
      },
      take: 200,
    });

    return withCacheControl(successResponse({ projects }), 'private, no-store');
  } catch (error) {
    logError('Error listing v1 projects:', error);
    return apiErrors.internalError('Failed to list projects');
  }
}
