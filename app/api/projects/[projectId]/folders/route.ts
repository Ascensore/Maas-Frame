import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth, checkProjectAccess } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { logError } from '@/lib/logger';
import { FOLDER_DEPTH_MAX, depthAfterMove, parseFolderName } from '@/lib/folders';

type RouteParams = { params: Promise<{ projectId: string }> };

function shape(folder: {
  id: string;
  name: string;
  position: number;
  parentId: string | null;
  roughCutProfileId: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: folder.id,
    name: folder.name,
    position: folder.position,
    parentId: folder.parentId,
    roughCutProfileId: folder.roughCutProfileId,
    createdAt: folder.createdAt,
    updatedAt: folder.updatedAt,
  };
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await auth();
    const { projectId } = await params;

    const project = await db.project.findUnique({
      where: { id: projectId },
      select: { id: true, ownerId: true, workspaceId: true, visibility: true },
    });
    if (!project) return apiErrors.notFound('Project');

    const access = await checkProjectAccess(project, session?.user?.id);
    if (!access.hasAccess) return apiErrors.forbidden('Access denied');

    const folders = await db.folder.findMany({
      where: { projectId },
      orderBy: [{ position: 'asc' }, { name: 'asc' }],
    });

    return withCacheControl(
      successResponse({ folders: folders.map(shape) }),
      'private, max-age=30, stale-while-revalidate=60'
    );
  } catch (error) {
    logError('Error fetching folders:', error);
    return apiErrors.internalError('Failed to fetch folders');
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;

    const session = await auth();
    if (!session?.user?.id) return apiErrors.unauthorized();

    const { projectId } = await params;
    const project = await db.project.findUnique({
      where: { id: projectId },
      select: { id: true, ownerId: true, workspaceId: true, visibility: true },
    });
    if (!project) return apiErrors.notFound('Project');

    const access = await checkProjectAccess(project, session.user.id);
    if (!access.canEdit) return apiErrors.forbidden('Access denied');

    const body = await request.json().catch(() => null);
    const name = parseFolderName(body?.name);
    if (!name) return apiErrors.badRequest('name is required and must be at most 100 characters');

    let parentId: string | null = null;
    if (body?.parentId !== undefined && body?.parentId !== null) {
      if (typeof body.parentId !== 'string') {
        return apiErrors.badRequest('parentId must be a folder id or null');
      }
      const parent = await db.folder.findFirst({
        where: { id: body.parentId, projectId },
        select: { id: true },
      });
      if (!parent) return apiErrors.badRequest('parent folder was not found in this project');
      parentId = parent.id;
    }

    const siblings = await db.folder.findMany({
      where: { projectId },
      select: { id: true, parentId: true },
    });
    if (depthAfterMove(parentId, siblings) > FOLDER_DEPTH_MAX) {
      return apiErrors.badRequest('Folder nesting cannot exceed 32 levels');
    }

    const last = await db.folder.findFirst({
      where: { projectId, parentId },
      orderBy: { position: 'desc' },
      select: { position: true },
    });

    const folder = await db.folder.create({
      data: {
        projectId,
        parentId,
        name,
        position: (last?.position ?? -1) + 1,
      },
    });

    return withCacheControl(successResponse({ folder: shape(folder) }), 'private, no-store');
  } catch (error) {
    logError('Error creating folder:', error);
    return apiErrors.internalError('Failed to create folder');
  }
}
