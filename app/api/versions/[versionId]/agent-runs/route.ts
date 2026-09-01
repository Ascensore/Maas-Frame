import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { auth, checkProjectAccess } from '@/lib/auth';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { isAgentsFeatureEnabled } from '@/lib/feature-flags';
import { logError } from '@/lib/logger';
import { enqueueAgentRun, serializeAgentRun } from '@/lib/agents/enqueue';
import { isAgentSlug } from '@/lib/agents/catalog';
import { refuseIfAgentRunLimited } from '@/lib/agents/limit';

type RouteParams = { params: Promise<{ versionId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await auth();
    if (!session?.user?.id) return apiErrors.unauthorized();
    if (!isAgentsFeatureEnabled()) return apiErrors.forbidden('Agents are disabled');

    const { versionId } = await params;
    const loaded = await loadVersionAccess(versionId, session.user.id);
    if ('error' in loaded) return loaded.error;

    const runs = await db.agentRun.findMany({
      where: { versionId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    return withCacheControl(
      successResponse({ runs: runs.map(serializeAgentRun) }),
      'private, no-store'
    );
  } catch (error) {
    logError('Error listing agent runs:', error);
    return apiErrors.internalError('Failed to list agent runs');
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await auth();
    if (!session?.user?.id) return apiErrors.unauthorized();
    if (!isAgentsFeatureEnabled()) return apiErrors.forbidden('Agents are disabled');

    const { versionId } = await params;
    const loaded = await loadVersionAccess(versionId, session.user.id);
    if ('error' in loaded) return loaded.error;

    const limited = await refuseIfAgentRunLimited(session.user.id, versionId);
    if (limited) return limited;

    const body = await request.json().catch(() => null);
    const agentSlug = typeof body?.agentSlug === 'string' ? body.agentSlug.trim() : undefined;
    if (agentSlug && !isAgentSlug(agentSlug)) {
      return apiErrors.badRequest('Unknown agentSlug');
    }
    const brief = typeof body?.brief === 'string' ? body.brief : undefined;

    const { run, created } = await enqueueAgentRun({
      versionId,
      triggeredById: session.user.id,
      agentSlug,
      brief,
    });

    if (!created) {
      return apiErrors.conflict('An agent run is already in progress for this version');
    }

    return withCacheControl(
      successResponse({ run: serializeAgentRun(run) }, 201),
      'private, no-store'
    );
  } catch (error) {
    logError('Error creating agent run:', error);
    return apiErrors.internalError('Failed to create agent run');
  }
}

async function loadVersionAccess(versionId: string, userId: string) {
  const version = await db.videoVersion.findUnique({
    where: { id: versionId },
    select: {
      id: true,
      video: {
        select: {
          project: {
            select: { id: true, ownerId: true, workspaceId: true, visibility: true },
          },
        },
      },
    },
  });
  if (!version) return { error: apiErrors.notFound('Version') };

  const access = await checkProjectAccess(version.video.project, userId);
  if (!access.hasAccess) {
    return { error: apiErrors.notFound('Version') };
  }

  return { version, access };
}
