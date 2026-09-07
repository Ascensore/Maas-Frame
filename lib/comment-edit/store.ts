import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { checkProjectAccess } from '@/lib/auth';
import { lockResourceInTransaction } from '@/lib/advisory-lock';
import { getAgentModelId, isAgentsFeatureEnabled } from '@/lib/feature-flags';
import { parseRoughCutDecisionList } from '@/lib/rough-cut/decision-list';
import { findActiveMaterializeJob } from '@/lib/rough-cut/review';
import {
  commentEditSnapshotSchema,
  validateBatchSnapshots,
  type CommentEditSnapshot,
  type EditOptions,
} from './plan';
import { listEditAssets, listEditPresets } from './library';
import type { CommentEditAction, CommentEditView } from './types';
import { previousCommentPlan, describeCommentPlan } from './revisions';

export class CommentEditError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

export const commentEditTaskInclude = {
  agentRun: true,
  comment: { include: { version: { select: { video: { select: { projectId: true } } } } } },
  outputVersion: { include: { video: true } },
  revisions: {
    orderBy: { createdAt: 'desc' },
    take: 20,
    include: { outputVersion: { include: { video: true } } },
  },
} satisfies Prisma.CommentEditTaskInclude;
const taskInclude = commentEditTaskInclude;
type Task = Prisma.CommentEditTaskGetPayload<{ include: typeof taskInclude }>;

export async function loadCommentEditAccess(versionId: string, userId: string) {
  const version = await db.videoVersion.findUnique({
    where: { id: versionId },
    include: { video: { include: { project: true } } },
  });
  if (!version) throw new CommentEditError('Version not found', 404);
  const access = await checkProjectAccess(version.video.project, userId);
  if (!access.canEdit) throw new CommentEditError('Editing permission is required', 403);
  return version;
}

export async function serializeCommentEdit(
  task: Task,
  client: Pick<typeof db, 'mediaJob'> = db
): Promise<CommentEditView> {
  let status: CommentEditView['status'] = task.status;
  let error = task.error;
  if (
    status === 'PLANNING' &&
    (!task.agentRun || ['FAILED', 'CANCELED'].includes(task.agentRun.status))
  ) {
    status = 'FAILED';
    error = task.agentRun?.error ?? 'The AI run is no longer available.';
  }
  if (status === 'RENDERING') {
    const job = task.renderJobId
      ? await client.mediaJob.findUnique({ where: { id: task.renderJobId } })
      : null;
    if (!job || job.status === 'FAILED') {
      status = 'FAILED';
      error = job?.error ?? 'The render is no longer available.';
    } else if (job.status === 'SUCCEEDED') {
      status = task.outputVersion ? 'READY' : 'FAILED';
      if (status === 'FAILED') error = 'The rendered draft is no longer available.';
    }
  }
  const snapshot = commentEditSnapshotSchema.safeParse(task.snapshot);
  const result = task.agentRun?.result;
  const removedSeconds =
    result &&
    typeof result === 'object' &&
    !Array.isArray(result) &&
    typeof result.removedSeconds === 'number'
      ? result.removedSeconds
      : null;
  const projectId = task.comment.version.video.projectId;
  const preview = task.outputVersion?.video.projectId === projectId ? task.outputVersion : null;
  const output = preview?.video;
  return {
    commentId: task.commentId,
    status,
    runId: task.agentRunId,
    adjustment: snapshot.success ? (snapshot.data.revision?.feedback.at(-1) ?? null) : null,
    changes: describeCommentPlan(
      previousCommentPlan(result, task.commentId),
      snapshot.success ? snapshot.data : null
    ),
    revisions: task.revisions
      .filter(
        (revision) =>
          revision.agentRunId !== task.agentRunId || !['READY', 'ACCEPTED'].includes(status)
      )
      .map((revision) => {
        const output =
          revision.outputVersion?.video.projectId === projectId ? revision.outputVersion : null;
        return {
          id: revision.id,
          status: revision.status,
          createdAt: revision.createdAt.toISOString(),
          adjustment: revision.adjustment,
          error: revision.error,
          previewUrl: output?.originalUrl ?? null,
          outputHref: output
            ? `/projects/${output.video.projectId}/videos/${output.video.id}`
            : null,
        };
      }),
    error,
    instruction: snapshot.success ? snapshot.data.content : null,
    removedSeconds,
    previewUrl: ['READY', 'ACCEPTED'].includes(status) ? (preview?.originalUrl ?? null) : null,
    outputHref:
      output && preview && ['READY', 'ACCEPTED'].includes(status)
        ? `/projects/${output.projectId}/videos/${output.id}`
        : null,
  };
}

async function archiveCommentEdit(tx: Prisma.TransactionClient, task: Task, view: CommentEditView) {
  if (!task.agentRunId || !['READY', 'ACCEPTED', 'FAILED'].includes(view.status)) return;
  const data = {
    status: view.status as 'READY' | 'ACCEPTED' | 'FAILED',
    instruction: view.instruction,
    adjustment: view.adjustment ?? null,
    changes: (view.changes ?? []) as unknown as Prisma.InputJsonValue,
    removedSeconds: view.removedSeconds,
    outputVersionId: task.outputVersionId,
    error: view.error,
  };
  await tx.commentEditRevision.upsert({
    where: { taskId_agentRunId: { taskId: task.id, agentRunId: task.agentRunId } },
    create: { taskId: task.id, agentRunId: task.agentRunId, ...data },
    update: data,
  });
}

function requireUnchangedComment(
  comment: { content: string | null; timestamp: number; timestampEnd: number | null },
  snapshot: CommentEditSnapshot
) {
  const fps = snapshot.decisions.rate.num / snapshot.decisions.rate.den;
  if (
    comment.content?.trim() !== snapshot.content ||
    Math.abs(comment.timestamp - snapshot.start) > 1 / fps ||
    comment.timestampEnd === null ||
    Math.abs(comment.timestampEnd - snapshot.end) > 1 / fps
  )
    throw new CommentEditError(
      'The comment changed after this draft was requested. Review the new feedback before running it again.',
      409
    );
}

export async function listCommentEdits(versionId: string) {
  const tasks = await db.commentEditTask.findMany({
    where: { comment: { versionId } },
    include: taskInclude,
  });
  return Promise.all(
    tasks.map(async (task) => ({
      ...(await serializeCommentEdit(task)),
      batchSize: task.agentRunId ? tasks.filter((t) => t.agentRunId === task.agentRunId).length : 1,
    }))
  );
}

export async function runCommentEditBatch(versionId: string, userId: string, ids: string[]) {
  await loadCommentEditAccess(versionId, userId);
  if (!isAgentsFeatureEnabled()) throw new CommentEditError('AI agents are disabled', 403);
  const commentIds = [...new Set(ids)].sort();
  if (commentIds.length !== ids.length || ids.length < 2 || ids.length > 20)
    throw new CommentEditError('Choose between 2 and 20 distinct queued comments.');
  await db.$transaction(
    async (tx) => {
      for (const id of commentIds) await lockResourceInTransaction(tx, `comment-edit:${id}`);
      const tasks = await tx.commentEditTask.findMany({
        where: { commentId: { in: commentIds } },
        include: { comment: true },
        orderBy: { commentId: 'asc' },
      });
      if (
        tasks.length !== ids.length ||
        tasks.some(
          (t) =>
            t.status !== 'QUEUED' ||
            t.comment.versionId !== versionId ||
            t.comment.isResolved ||
            t.comment.parentId
        )
      )
        throw new CommentEditError(
          'Every batch comment must be queued, unresolved and on this version.',
          409
        );
      const snapshots = tasks.map((t) => commentEditSnapshotSchema.parse(t.snapshot));
      try {
        validateBatchSnapshots(snapshots);
      } catch (error) {
        throw new CommentEditError(error instanceof Error ? error.message : 'Invalid batch', 409);
      }
      const run = await tx.agentRun.create({
        data: {
          versionId,
          kind: 'EDIT',
          agentSlug: 'edit',
          model: getAgentModelId(),
          triggeredById: userId,
          payload: { commentIds },
        },
      });
      await tx.commentEditTask.updateMany({
        where: { commentId: { in: commentIds } },
        data: {
          status: 'PLANNING',
          agentRunId: run.id,
          roughCutId: null,
          renderJobId: null,
          outputVersionId: null,
          error: null,
        },
      });
    },
    { timeout: 15000 }
  );
  return listCommentEdits(versionId);
}

export async function snapshotComment(
  tx: Prisma.TransactionClient,
  comment: {
    content: string | null;
    timestamp: number;
    timestampEnd: number | null;
    versionId: string;
  },
  options: EditOptions = {}
): Promise<CommentEditSnapshot> {
  if (
    !comment.content?.trim() ||
    comment.timestampEnd === null ||
    comment.timestampEnd <= comment.timestamp
  ) {
    throw new CommentEditError('AI cuts need text feedback and an In/Out range.');
  }
  const version = await tx.videoVersion.findUniqueOrThrow({
    where: { id: comment.versionId },
    include: { video: true },
  });
  if (!version.isActive)
    throw new CommentEditError('Use the current rendered version to start a new AI edit.', 409);
  const found = await tx.roughCut.findFirst({
    where: { outputVideoId: version.video.id, status: 'READY' },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  if (!found)
    throw new CommentEditError('AI cuts currently work on rendered OpenFrame rough cuts.');
  await lockResourceInTransaction(tx, found.id);
  if (await findActiveMaterializeJob(found.id, tx))
    throw new CommentEditError(
      'Wait for the current render to finish before starting an AI edit.',
      409
    );
  const source = await tx.roughCut.findUniqueOrThrow({ where: { id: found.id } });
  const decisions = parseRoughCutDecisionList(source.renderedDecisions);
  if (!decisions || source.renderedVersionId !== version.id)
    throw new CommentEditError(
      'Re-render this OpenFrame rough cut before using AI edits. This version has no matching source map.',
      409
    );
  const sourceIds = [
    ...new Set([
      ...decisions.edits.map((edit) => edit.sourceVersionId),
      ...(decisions.effects ?? []).flatMap((e) => (e.kind === 'broll' ? [e.sourceVersionId] : [])),
    ]),
  ];
  const sources = await tx.videoVersion.count({
    where: {
      id: { in: sourceIds },
      providerId: 'r2',
      video: { projectId: version.video.projectId },
    },
  });
  if (sources !== sourceIds.length)
    throw new CommentEditError(
      'This cut needs accessible uploaded source files in the same project.'
    );
  const fps = decisions.rate.num / decisions.rate.den;
  const start = Math.ceil(comment.timestamp * fps - 1e-6) / fps;
  const end = Math.floor(comment.timestampEnd * fps + 1e-6) / fps;
  const duration = decisions.edits.at(-1)?.timelineEndSeconds ?? 0;
  if (end <= start || end > duration + 1e-6)
    throw new CommentEditError('Mark a range of at least one frame inside the rendered video.');
  const assets = await listEditAssets(version.video.projectId, tx, options.assetVersionId, true);
  if (options.assetVersionId && !assets.some((a) => a.versionId === options.assetVersionId))
    throw new CommentEditError(
      'The selected B-roll must be an active uploaded video in this project.'
    );
  const presets = await listEditPresets(version.video.projectId, tx);
  if (options.presetId && !presets.some((p) => p.id === options.presetId))
    throw new CommentEditError('The selected preset is no longer available in this workspace.');
  return {
    versionId: comment.versionId,
    content: comment.content.trim(),
    start,
    end,
    decisions,
    presets: presets
      .filter((p) => !options.presetId || p.id === options.presetId)
      .map((p) => ({
        ...p,
        ...(options.accent ? { accent: options.accent } : {}),
      })),
    assets,
  };
}

export async function actOnCommentEdit(
  commentId: string,
  userId: string,
  action: CommentEditAction,
  options: EditOptions = {}
) {
  const original = await db.comment.findUnique({ where: { id: commentId } });
  if (!original) throw new CommentEditError('Comment not found', 404);
  await loadCommentEditAccess(original.versionId, userId);
  if (['queue', 'run', 'revise'].includes(action) && !isAgentsFeatureEnabled())
    throw new CommentEditError('AI agents are disabled', 403);
  return db.$transaction(
    async (tx) => {
      // Batch acceptance/handoff locks the complete group in the same order as execution.
      const before = await tx.commentEditTask.findUnique({ where: { commentId } });
      const retryingRevision =
        action === 'run' &&
        Boolean(commentEditSnapshotSchema.safeParse(before?.snapshot).data?.revision) &&
        ['PLANNING', 'RENDERING', 'FAILED'].includes(before?.status ?? '');
      const group =
        before?.agentRunId &&
        (['accept', 'human', 'revise', 'undo'].includes(action) || retryingRevision)
          ? await tx.commentEditTask.findMany({
              where: { agentRunId: before.agentRunId },
              orderBy: { commentId: 'asc' },
            })
          : [];
      const groupIds = group.length ? group.map((t) => t.commentId) : [commentId];
      for (const id of groupIds) await lockResourceInTransaction(tx, `comment-edit:${id}`);
      if (
        group.length &&
        (await tx.commentEditTask.count({
          where: { commentId: { in: groupIds }, agentRunId: before!.agentRunId },
        })) !== group.length
      )
        throw new CommentEditError('The shared assignment changed. Refresh and try again.', 409);
      const comment = await tx.comment.findUniqueOrThrow({ where: { id: commentId } });
      if (comment.parentId)
        throw new CommentEditError('Start an AI edit from a timeline comment, not a reply.');
      const existing = await tx.commentEditTask.findUnique({
        where: { commentId },
        include: taskInclude,
      });
      const view = existing ? await serializeCommentEdit(existing, tx) : null;
      if (before?.agentRunId !== existing?.agentRunId)
        throw new CommentEditError('The assignment changed. Refresh and try again.', 409);
      if (view && ['PLANNING', 'RENDERING'].includes(view.status))
        throw new CommentEditError(
          'This edit is still running. Wait for its result before changing assignment.',
          409
        );
      if (
        ['revise', 'undo'].includes(action) &&
        (!options.expectedRunId || options.expectedRunId !== existing?.agentRunId)
      )
        throw new CommentEditError('The draft changed. Refresh and review it again.', 409);
      if (action === 'undo') {
        const members = await tx.commentEditTask.findMany({
          where: { commentId: { in: groupIds } },
        });
        if (
          !existing ||
          members.some(
            (member) =>
              member.status !== 'ACCEPTED' || member.outputVersionId !== existing.outputVersionId
          )
        )
          throw new CommentEditError('Only an accepted draft can have its acceptance undone.', 409);
        await tx.comment.updateMany({
          where: { id: { in: groupIds } },
          data: { isResolved: false, resolvedAt: null },
        });
        await tx.commentEditTask.updateMany({
          where: { commentId: { in: groupIds } },
          data: { status: 'RENDERING' },
        });
        return serializeCommentEdit(
          await tx.commentEditTask.findUniqueOrThrow({
            where: { commentId },
            include: taskInclude,
          }),
          tx
        );
      }
      if (action === 'revise' || retryingRevision) {
        const adjustment = options.adjustment?.trim();
        if (!retryingRevision && (!adjustment || adjustment.length > 2000))
          throw new CommentEditError('Describe the adjustment in 1–2000 characters.');
        if (
          !existing ||
          !(retryingRevision
            ? view?.status === 'FAILED'
            : ['READY', 'ACCEPTED'].includes(view?.status ?? ''))
        )
          throw new CommentEditError('Review a rendered draft before adjusting it.', 409);
        const members = await tx.commentEditTask.findMany({
          where: { commentId: { in: groupIds } },
          include: taskInclude,
          orderBy: { commentId: 'asc' },
        });
        const snapshots = [];
        const views = [];
        for (const member of members) {
          const memberView = await serializeCommentEdit(member, tx);
          if (
            retryingRevision
              ? memberView.status !== 'FAILED'
              : !['READY', 'ACCEPTED'].includes(memberView.status) ||
                member.outputVersionId !== existing.outputVersionId ||
                !memberView.previewUrl
          )
            throw new CommentEditError(
              'Every shared draft must be available before adjusting it.',
              409
            );
          const snapshot = commentEditSnapshotSchema.parse(member.snapshot);
          requireUnchangedComment(member.comment, snapshot);
          if (retryingRevision) {
            snapshots.push(snapshot);
            views.push(memberView);
            continue;
          }
          const previousPlan = previousCommentPlan(
            member.agentRun?.result,
            member.commentId,
            groupIds
          );
          if (!previousPlan)
            throw new CommentEditError(
              'The previous edit plan is unavailable. Hand this feedback to an editor and run it again.',
              409
            );
          const feedback = [...(snapshot.revision?.feedback ?? [])];
          if (member.commentId === commentId) feedback.push(adjustment!);
          if (feedback.length > 10)
            throw new CommentEditError(
              'This draft has reached ten adjustments. Open the draft to start fresh feedback.',
              409
            );
          snapshots.push(
            commentEditSnapshotSchema.parse({
              ...snapshot,
              revision: { feedback, previousPlan, reusePlan: member.commentId !== commentId },
            })
          );
          views.push(memberView);
        }
        const run = await tx.agentRun.create({
          data: {
            versionId: comment.versionId,
            kind: 'EDIT',
            agentSlug: 'edit',
            model: getAgentModelId(),
            triggeredById: userId,
            payload: {
              commentIds: groupIds,
              revisedCommentId: commentId,
              previousRunId: existing.agentRunId,
            },
          },
        });
        for (let i = 0; i < members.length; i++) {
          await archiveCommentEdit(tx, members[i], views[i]);
          await tx.commentEditTask.update({
            where: { id: members[i].id },
            data: {
              status: 'PLANNING',
              agentRunId: run.id,
              snapshot: snapshots[i] as unknown as Prisma.InputJsonValue,
              roughCutId: null,
              renderJobId: null,
              outputVersionId: null,
              error: null,
            },
          });
        }
        await tx.comment.updateMany({
          where: { id: { in: groupIds } },
          data: { isResolved: false, resolvedAt: null },
        });
        return serializeCommentEdit(
          await tx.commentEditTask.findUniqueOrThrow({
            where: { commentId },
            include: taskInclude,
          }),
          tx
        );
      }
      if (action === 'accept') {
        if (options.expectedRunId && options.expectedRunId !== existing?.agentRunId)
          throw new CommentEditError('The draft changed. Refresh and review it again.', 409);
        if (view?.status !== 'READY' || !existing)
          throw new CommentEditError('A rendered draft is required before accepting.', 409);
        const members = await tx.commentEditTask.findMany({
          where: { commentId: { in: groupIds } },
          include: { comment: true },
        });
        for (const member of members) {
          if (
            member.agentRunId !== existing.agentRunId ||
            member.status !== 'RENDERING' ||
            member.outputVersionId !== existing.outputVersionId
          )
            throw new CommentEditError(
              'The shared draft changed. Refresh and review it again.',
              409
            );
          const comment = member.comment;
          const snapshot = commentEditSnapshotSchema.parse(member.snapshot);
          requireUnchangedComment(comment, snapshot);
        }
        await tx.comment.updateMany({
          where: { id: { in: groupIds } },
          data: { isResolved: true, resolvedAt: new Date() },
        });
        await tx.commentEditTask.updateMany({
          where: { commentId: { in: groupIds } },
          data: { status: 'ACCEPTED' },
        });
        return serializeCommentEdit(
          await tx.commentEditTask.update({
            where: { commentId },
            data: { status: 'ACCEPTED' },
            include: taskInclude,
          }),
          tx
        );
      }
      if (action === 'human') {
        const members = await tx.commentEditTask.findMany({
          where: { commentId: { in: groupIds } },
          include: taskInclude,
        });
        for (const member of members)
          await archiveCommentEdit(tx, member, await serializeCommentEdit(member, tx));
        await tx.comment.updateMany({
          where: { id: { in: groupIds } },
          data: { isResolved: false, resolvedAt: null },
        });
        await tx.commentEditTask.updateMany({
          where: { commentId: { in: groupIds } },
          data: { status: 'HUMAN', error: null },
        });
        const task = await tx.commentEditTask.upsert({
          where: { commentId },
          create: { commentId },
          update: { status: 'HUMAN', error: null },
          include: taskInclude,
        });
        return serializeCommentEdit(task, tx);
      }
      if (comment.isResolved)
        throw new CommentEditError('Reopen this comment before requesting another AI edit.', 409);
      if (view?.status === 'READY')
        throw new CommentEditError(
          'Accept this draft or hand it to an editor before starting again.',
          409
        );
      const snapshot =
        action === 'run' &&
        existing &&
        (existing.status === 'QUEUED' ||
          (view?.status === 'FAILED' &&
            commentEditSnapshotSchema.safeParse(existing.snapshot).data?.revision))
          ? commentEditSnapshotSchema.parse(existing.snapshot)
          : await snapshotComment(tx, comment, options);
      if (existing && view) await archiveCommentEdit(tx, existing, view);
      const run =
        action === 'run'
          ? await tx.agentRun.create({
              data: {
                versionId: comment.versionId,
                kind: 'EDIT',
                agentSlug: 'edit',
                model: getAgentModelId(),
                triggeredById: userId,
                payload: { commentId, snapshot: snapshot as unknown as Prisma.InputJsonValue },
              },
            })
          : null;
      const data = {
        status: action === 'run' ? ('PLANNING' as const) : ('QUEUED' as const),
        snapshot: snapshot as unknown as Prisma.InputJsonValue,
        agentRunId: run?.id ?? null,
        roughCutId: null,
        renderJobId: null,
        outputVersionId: null,
        error: null,
      };
      const task = await tx.commentEditTask.upsert({
        where: { commentId },
        create: { commentId, ...data },
        update: data,
        include: taskInclude,
      });
      return serializeCommentEdit(task, tx);
    },
    { timeout: 15000 }
  );
}
