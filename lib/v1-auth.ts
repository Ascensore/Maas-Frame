import { NextRequest } from 'next/server';
import { auth, checkProjectAccess, checkWorkspaceAccess } from '@/lib/auth';
import { extractBearerToken, resolveApiToken } from '@/lib/api-token';
import { apiErrors } from '@/lib/api-response';
import { db } from '@/lib/db';

export type ApiAuthContext = {
  userId: string;
  tokenId: string | null;
};

/**
 * Resolves the caller to a user id. A Bearer API token wins; a NextAuth
 * session is accepted so the same v1 routes can be used from the browser
 * during development without minting a token.
 */
export async function withApiAuth(
  request: NextRequest
): Promise<ApiAuthContext | ReturnType<typeof apiErrors.unauthorized>> {
  const bearer = extractBearerToken(request.headers.get('authorization'));
  if (bearer) {
    const resolved = await resolveApiToken(bearer);
    if (!resolved) return apiErrors.unauthorized('Invalid API token');
    return resolved;
  }

  const session = await auth();
  if (!session?.user?.id) {
    return apiErrors.unauthorized();
  }
  return { userId: session.user.id, tokenId: null };
}

export function isAuthError(
  value: ApiAuthContext | ReturnType<typeof apiErrors.unauthorized>
): value is ReturnType<typeof apiErrors.unauthorized> {
  return !('userId' in value);
}

export async function loadVersionForUser(versionId: string, userId: string) {
  const version = await db.videoVersion.findUnique({
    where: { id: versionId },
    include: {
      video: {
        include: {
          project: {
            select: {
              id: true,
              ownerId: true,
              workspaceId: true,
              visibility: true,
              name: true,
            },
          },
        },
      },
    },
  });

  if (!version)
    return { error: apiErrors.notFound('Version') as ReturnType<typeof apiErrors.notFound> };

  const access = await checkProjectAccess(version.video.project, userId);
  if (!access.hasAccess) {
    return { error: apiErrors.notFound('Version') as ReturnType<typeof apiErrors.notFound> };
  }

  return { version, access };
}

export async function loadProjectForUser(projectId: string, userId: string) {
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      ownerId: true,
      workspaceId: true,
      visibility: true,
      name: true,
      slug: true,
    },
  });

  if (!project)
    return { error: apiErrors.notFound('Project') as ReturnType<typeof apiErrors.notFound> };

  const access = await checkProjectAccess(project, userId);
  if (!access.hasAccess) {
    return { error: apiErrors.notFound('Project') as ReturnType<typeof apiErrors.notFound> };
  }

  return { project, access };
}

export { checkProjectAccess, checkWorkspaceAccess };
