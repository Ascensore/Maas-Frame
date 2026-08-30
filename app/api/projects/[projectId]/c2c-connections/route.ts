import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth, checkProjectAccess } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { generateC2cToken } from '@/lib/c2c-token';
import { logError } from '@/lib/logger';

type RouteParams = { params: Promise<{ projectId: string }> };

const MAX_CONNECTIONS_PER_PROJECT = 20;
const MAX_NAME_LENGTH = 60;

async function getEditableProject(projectId: string, userId: string) {
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { id: true, ownerId: true, workspaceId: true, visibility: true },
  });
  if (!project) return null;
  const access = await checkProjectAccess(project, userId);
  if (!access.canEdit) return null;
  return project;
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const session = await auth();
    if (!session?.user?.id) return apiErrors.unauthorized();

    const { projectId } = await params;
    const project = await getEditableProject(projectId, session.user.id);
    if (!project) return apiErrors.forbidden('Access denied');

    const connections = await db.c2cConnection.findMany({
      where: { projectId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        folderId: true,
        tokenPrefix: true,
        lastUsedAt: true,
        createdAt: true,
      },
    });

    return withCacheControl(successResponse({ connections }), 'private, no-store');
  } catch (error) {
    logError('Error listing C2C connections:', error);
    return apiErrors.internalError('Failed to list ingest connections');
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;

    const session = await auth();
    if (!session?.user?.id) return apiErrors.unauthorized();

    const { projectId } = await params;
    const project = await getEditableProject(projectId, session.user.id);
    if (!project) return apiErrors.forbidden('Access denied');

    const body = await request.json().catch(() => null);
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > MAX_NAME_LENGTH) {
      return apiErrors.badRequest(
        `Name is required and must be at most ${MAX_NAME_LENGTH} characters`
      );
    }

    let folderId: string | null = null;
    if (body?.folderId !== undefined && body?.folderId !== null) {
      if (typeof body.folderId !== 'string') {
        return apiErrors.badRequest('folderId must be a folder id or null');
      }
      const folder = await db.folder.findFirst({
        where: { id: body.folderId, projectId },
        select: { id: true },
      });
      if (!folder) return apiErrors.badRequest('folder was not found in this project');
      folderId = folder.id;
    }

    const existing = await db.c2cConnection.count({
      where: { projectId, revokedAt: null },
    });
    if (existing >= MAX_CONNECTIONS_PER_PROJECT) {
      return apiErrors.badRequest(
        `At most ${MAX_CONNECTIONS_PER_PROJECT} active ingest connections per project`
      );
    }

    const generated = generateC2cToken();
    const row = await db.c2cConnection.create({
      data: {
        projectId,
        folderId,
        createdById: session.user.id,
        name,
        tokenHash: generated.hash,
        tokenPrefix: generated.prefix,
      },
      select: { id: true, name: true, folderId: true, tokenPrefix: true, createdAt: true },
    });

    return withCacheControl(
      successResponse({ connection: { ...row, secret: generated.raw } }, 201),
      'private, no-store'
    );
  } catch (error) {
    logError('Error creating C2C connection:', error);
    return apiErrors.internalError('Failed to create ingest connection');
  }
}
