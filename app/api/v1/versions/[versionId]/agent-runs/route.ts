import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { isAuthError, loadVersionForUser, withApiAuth } from '@/lib/v1-auth';
import { isAgentsFeatureEnabled } from '@/lib/feature-flags';
import { logError } from '@/lib/logger';
import { enqueueAgentRun, serializeAgentRun } from '@/lib/agents/enqueue';
import { isAgentSlug } from '@/lib/agents/catalog';
import { refuseIfAgentRunLimited } from '@/lib/agents/limit';

type RouteParams = { params: Promise<{ versionId: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'api-v1');
    if (limited) return limited;

    const authContext = await withApiAuth(request);
    if (isAuthError(authContext)) return authContext;
    if (!isAgentsFeatureEnabled()) return apiErrors.forbidden('Agents are disabled');

    const { versionId } = await params;
    const loaded = await loadVersionForUser(versionId, authContext.userId);
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
    logError('Error listing v1 agent runs:', error);
    return apiErrors.internalError('Failed to list agent runs');
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'api-v1');
    if (limited) return limited;

    const authContext = await withApiAuth(request);
    if (isAuthError(authContext)) return authContext;
    if (!isAgentsFeatureEnabled()) return apiErrors.forbidden('Agents are disabled');

    const { versionId } = await params;
    const loaded = await loadVersionForUser(versionId, authContext.userId);
    if ('error' in loaded) return loaded.error;

    const runLimited = await refuseIfAgentRunLimited(authContext.userId, versionId);
    if (runLimited) return runLimited;

    const body = await request.json().catch(() => null);
    const agentSlug = typeof body?.agentSlug === 'string' ? body.agentSlug.trim() : undefined;
    if (agentSlug && !isAgentSlug(agentSlug)) {
      return apiErrors.badRequest('Unknown agentSlug');
    }
    const brief = typeof body?.brief === 'string' ? body.brief : undefined;

    const { run, created } = await enqueueAgentRun({
      versionId,
      triggeredById: authContext.userId,
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
    logError('Error creating v1 agent run:', error);
    return apiErrors.internalError('Failed to create agent run');
  }
}
