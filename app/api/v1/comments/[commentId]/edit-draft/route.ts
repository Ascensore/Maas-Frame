import { z } from 'zod';
import { refuseIfAgentRunLimited } from '@/lib/agents/limit';
import { actOnCommentEdit } from '@/lib/comment-edit/store';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { isAuthError, withApiAuth } from '@/lib/v1-auth';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { rateLimit } from '@/lib/rate-limit';
import {
  CommentEditError,
  loadCommentEditAccess,
  serializeCommentEdit,
  commentEditTaskInclude,
} from '@/lib/comment-edit/store';
import { parseRoughCutDecisionList } from '@/lib/rough-cut/decision-list';
import { applyCommentEditPlan, commentEditSnapshotSchema } from '@/lib/comment-edit/plan';
import { buildNativeEditPackage } from '@/lib/comment-edit/native';
import { r2ObjectKeyFromVersion } from '@/lib/transcription/source';
import { proxyR2MediaObject } from '@/lib/r2-media-proxy';
import { logError } from '@/lib/logger';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ commentId: string }> }
) {
  try {
    const caller = await withApiAuth(request);
    if (isAuthError(caller)) return caller;
    const limited = await rateLimit(request, 'api-v1');
    if (limited) return limited;
    const { commentId } = await params;
    const task = await db.commentEditTask.findUnique({
      where: { commentId },
      include: commentEditTaskInclude,
    });
    if (!task) return apiErrors.notFound('Editing task');
    const original = await loadCommentEditAccess(task.comment.versionId, caller.userId);
    const view = await serializeCommentEdit(task);
    if (request.nextUrl.searchParams.get('status') === '1')
      return withCacheControl(successResponse({ task: view }), 'private, no-store');
    if (!['READY', 'ACCEPTED'].includes(view.status) || !task.outputVersion || !task.agentRun)
      return apiErrors.conflict('Render and review the draft before importing it into an editor.');
    const result = task.agentRun.result as Record<string, unknown> | null;
    const decisions =
      parseRoughCutDecisionList(result?.decisions) ??
      applyCommentEditPlan(commentEditSnapshotSchema.parse(task.snapshot), result?.editPlan)
        .decisions;
    const sourceIds = [
      ...new Set([
        ...decisions.edits.map((e) => e.sourceVersionId),
        ...(decisions.effects ?? []).flatMap((e) =>
          e.kind === 'broll' ? [e.sourceVersionId] : []
        ),
        task.outputVersion.id,
      ]),
    ];
    const versions = await db.videoVersion.findMany({
      where: {
        id: { in: sourceIds },
        providerId: 'r2',
        video: { projectId: original.video.projectId },
      },
      include: { video: { select: { title: true } } },
    });
    if (versions.length !== sourceIds.length)
      return apiErrors.conflict('Some draft sources are no longer available in this project.');
    const requestedSource = request.nextUrl.searchParams.get('source');
    if (requestedSource) {
      const version = versions.find((v) => v.id === requestedSource);
      if (!version) return apiErrors.forbidden('This source is not part of the reviewed draft.');
      const key = r2ObjectKeyFromVersion(version);
      if (!key) return apiErrors.conflict('The source has no downloadable file.');
      return proxyR2MediaObject({
        request,
        key,
        fallbackContentType: 'application/octet-stream',
        cacheControl: 'private, no-store',
        internalErrorMessage: 'Could not download the editing source',
      });
    }
    const route = `/api/v1/comments/${encodeURIComponent(commentId)}/edit-draft`;
    const native = buildNativeEditPackage({
      id: task.agentRun.id,
      name: `AI draft — ${original.video.title}`,
      decisions,
      outputVersionId: task.outputVersion.id,
      media: versions.map((v) => ({
        versionId: v.id,
        title: v.video.title,
        frameRateNum: v.frameRateNum ?? decisions.rate.num,
        frameRateDen: v.frameRateDen ?? decisions.rate.den,
        duration:
          (v.durationFrames && v.frameRateNum && v.frameRateDen
            ? (v.durationFrames * v.frameRateDen) / v.frameRateNum
            : null) ??
          v.duration ??
          decisions.clips.find((c) => c.versionId === v.id)?.durationSeconds ??
          decisions.edits.at(-1)!.timelineEndSeconds,
        fileName: `${v.id}.${
          r2ObjectKeyFromVersion(v)
            ?.split('.')
            .at(-1)
            ?.replace(/[^a-zA-Z0-9]/g, '') || 'mp4'
        }`,
        downloadPath: `${route}?source=${encodeURIComponent(v.id)}`,
      })),
    });
    if (request.nextUrl.searchParams.get('format') === 'xml')
      return new Response(native.xml, {
        headers: {
          'Content-Type': 'application/xml',
          'Content-Disposition': 'attachment; filename="openframe-ai-draft.xml"',
          'Cache-Control': 'private, no-store',
        },
      });
    return withCacheControl(successResponse({ draft: native }), 'private, no-store');
  } catch (error) {
    if (error instanceof CommentEditError)
      return error.status === 403
        ? apiErrors.forbidden(error.message)
        : apiErrors.notFound('Version');
    logError('Native draft export failed', error);
    return apiErrors.internalError('Could not prepare the native editing draft');
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ commentId: string }> }
) {
  try {
    const caller = await withApiAuth(request);
    if (isAuthError(caller)) return caller;
    const { commentId } = await params;
    const comment = await db.comment.findUnique({ where: { id: commentId } });
    if (!comment) return apiErrors.notFound('Comment');
    await loadCommentEditAccess(comment.versionId, caller.userId);
    const body = z
      .object({
        nle: z.enum(['resolve', 'premiere']),
        sequenceId: z.string().trim().min(1).max(200),
      })
      .safeParse(await request.json().catch(() => null));
    if (!body.success) return apiErrors.badRequest('A linked native sequence is required.');
    const link = await db.sequenceLink.findUnique({
      where: {
        userId_versionId_nle: {
          userId: caller.userId,
          versionId: comment.versionId,
          nle: body.data.nle,
        },
      },
    });
    if (!link?.sequenceId || link.sequenceId !== body.data.sequenceId)
      return apiErrors.conflict(
        'Sync this timeline to the reviewed version before running feedback.'
      );
    const limited =
      (await rateLimit(request, 'mutate')) ??
      (await refuseIfAgentRunLimited(caller.userId, comment.versionId));
    if (limited) return limited;
    return withCacheControl(
      successResponse({ task: await actOnCommentEdit(commentId, caller.userId, 'run') }),
      'private, no-store'
    );
  } catch (error) {
    if (error instanceof CommentEditError) {
      if (error.status === 403) return apiErrors.forbidden(error.message);
      if (error.status === 404) return apiErrors.notFound('Comment');
      if (error.status === 409) return apiErrors.conflict(error.message);
      return apiErrors.badRequest(error.message);
    }
    logError('Native feedback execution failed', error);
    return apiErrors.internalError('Could not run the feedback');
  }
}
