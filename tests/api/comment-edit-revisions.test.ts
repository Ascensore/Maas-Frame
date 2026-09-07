import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { db } from '@/lib/db';
import { POST } from '@/app/api/comments/[commentId]/edit-task/route';
import { GET, POST as batchPost } from '@/app/api/versions/[versionId]/edit-tasks/route';
import { executeAgentRun } from '@/lib/agents/run-review';
import { materializeRoughCut } from '@/lib/rough-cut/materialize-job';
import {
  addProjectMember,
  createComment,
  createRoughCut,
  createUser,
  createVideo,
  createVersion,
  seedVersion,
} from '../factories';
import { signedInAs, signedOut } from '../helpers/session';
import { apiRequest, callRoute } from '../helpers/request';

const { generateEditPlan } = vi.hoisted(() => ({ generateEditPlan: vi.fn() }));
vi.mock('@/lib/agents/model', () => ({ getAgentModel: () => ({ generateEditPlan }) }));
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
afterAll(() => pool.end());
beforeEach(() => {
  vi.stubEnv('OPENFRAME_ENABLE_AGENTS', 'true');
  generateEditPlan
    .mockReset()
    .mockResolvedValue({ version: 1, operations: [{ op: 'cut', start: 2, end: 3 }] });
});
async function seed() {
  const s = await seedVersion({ providerId: 'r2', duration: 10 });
  const sourceVideo = await createVideo({ projectId: s.project.id });
  const source = await createVersion({
    videoParentId: sourceVideo.id,
    providerId: 'r2',
    duration: 30,
  });
  const decisions = {
    version: 1,
    rate: { num: 25, den: 1, dropFrame: false },
    clips: [
      {
        versionId: source.id,
        videoId: sourceVideo.id,
        role: 'A',
        offsetSeconds: 0,
        durationSeconds: 30,
        track: 1,
        fileName: 'source.mp4',
        targetUrl: 'source.mp4',
      },
    ],
    edits: [
      {
        sourceVersionId: source.id,
        cameraRole: 'A',
        targetTrack: 1,
        inSeconds: 10,
        outSeconds: 20,
        timelineStartSeconds: 0,
        timelineEndSeconds: 10,
      },
    ],
  };
  const cut = await createRoughCut({
    projectId: s.project.id,
    requestedById: s.owner.id,
    status: 'READY',
    decisions,
    outputVideoId: s.video.id,
  });
  await db.roughCut.update({
    where: { id: cut.id },
    data: { renderedDecisions: decisions, renderedVersionId: s.version.id },
  });
  const comment = await createComment({
    versionId: s.version.id,
    authorId: s.owner.id,
    content: 'Remove the pause',
    timestamp: 2,
    timestampEnd: 4,
  });
  signedInAs(s.owner);
  return { ...s, source, cut, decisions, comment };
}
const task = (commentId: string) => db.commentEditTask.findUniqueOrThrow({ where: { commentId } });
const action = (commentId: string, action: string, options?: Record<string, unknown>) =>
  callRoute(
    POST,
    apiRequest(`/api/comments/${commentId}/edit-task`, {
      method: 'POST',
      body: { action, options },
    }),
    { commentId }
  );
const list = (versionId: string) =>
  callRoute(GET, apiRequest(`/api/versions/${versionId}/edit-tasks`), { versionId });
async function renderDraft(commentId: string) {
  await executeAgentRun((await task(commentId)).agentRunId!);
  const planned = await task(commentId);
  await materializeRoughCut(
    {
      pool,
      run: async () => ({ stdout: '', stderr: '', code: 0 }),
      downloadObject: async () => {},
      uploadObject: async () => {},
      objectKeyFromProvider: (v) => v.videoId,
      readOutput: async () => Buffer.from('rendered video'),
    },
    planned.roughCutId!
  );
  await db.mediaJob.update({ where: { id: planned.renderJobId! }, data: { status: 'SUCCEEDED' } });
  return task(commentId);
}
async function ready() {
  const s = await seed();
  expect((await action(s.comment.id, 'run')).status).toBe(200);
  const first = await renderDraft(s.comment.id);
  return { ...s, first };
}
async function batchReady() {
  const s = await seed();
  const second = await createComment({
    versionId: s.version.id,
    authorId: s.owner.id,
    content: 'Remove the second pause',
    timestamp: 6,
    timestampEnd: 8,
  });
  await action(s.comment.id, 'queue');
  await action(second.id, 'queue');
  generateEditPlan.mockImplementation(async ({ context }) => ({
    version: 1,
    operations: [
      { op: 'cut', start: context.comments[0].timestamp, end: context.comments[0].timestamp + 1 },
    ],
  }));
  const response = await callRoute(
    batchPost,
    apiRequest(`/api/versions/${s.version.id}/edit-tasks`, {
      method: 'POST',
      body: { commentIds: [s.comment.id, second.id] },
    }),
    { versionId: s.version.id }
  );
  expect(response.status).toBe(200);
  const first = await renderDraft(s.comment.id);
  return { ...s, second, first };
}

describe('comment draft revisions', () => {
  it('refuses unauthorized adjustments and undo without changing comments, tasks, or history', async () => {
    const s = await ready();
    await action(s.comment.id, 'accept');
    const before = await task(s.comment.id);
    const opts = { expectedRunId: s.first.agentRunId, adjustment: 'Keep more of the pause' };
    signedOut();
    for (const value of ['revise', 'undo'])
      expect((await action(s.comment.id, value, opts)).status).toBe(401);
    const outsider = await createUser();
    signedInAs(outsider);
    for (const value of ['revise', 'undo'])
      expect((await action(s.comment.id, value, opts)).status).toBe(403);
    await addProjectMember({ projectId: s.project.id, userId: outsider.id, role: 'COMMENTATOR' });
    expect((await action(s.comment.id, 'revise', opts)).status).toBe(403);
    expect((await list(s.version.id)).status).toBe(403);
    expect(await task(s.comment.id)).toEqual(before);
    expect(await db.commentEditRevision.count()).toBe(0);
    expect((await db.comment.findUniqueOrThrow({ where: { id: s.comment.id } })).isResolved).toBe(
      true
    );
  });
  it('adjusts from original coordinates, preserves comment text and the exact previous output, then accepts and undoes', async () => {
    const s = await ready();
    expect(
      (await action(s.comment.id, 'accept', { expectedRunId: s.first.agentRunId })).status
    ).toBe(200);
    expect(
      (
        await action(s.comment.id, 'revise', {
          expectedRunId: s.first.agentRunId,
          adjustment: 'Remove half a second more',
        })
      ).status
    ).toBe(200);
    expect(await db.comment.findUniqueOrThrow({ where: { id: s.comment.id } })).toMatchObject({
      content: 'Remove the pause',
      isResolved: false,
      resolvedAt: null,
    });
    const history = await db.commentEditRevision.findMany();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      agentRunId: s.first.agentRunId,
      outputVersionId: s.first.outputVersionId,
      status: 'ACCEPTED',
    });
    generateEditPlan
      .mockClear()
      .mockResolvedValue({ version: 1, operations: [{ op: 'cut', start: 2, end: 3.52 }] });
    const revised = await renderDraft(s.comment.id);
    expect(revised.outputVersionId).not.toBe(s.first.outputVersionId);
    const input = generateEditPlan.mock.calls[0][0];
    expect(JSON.parse(input.context.brief)).toMatchObject({
      instruction: 'Remove the pause',
      revisionFeedback: ['Remove half a second more'],
      previousPlan: { version: 1, operations: [{ op: 'cut', start: 2, end: 3 }] },
      range: { start: 2, end: 4 },
    });
    expect(input.system).toContain('complete replacement plan');
    const run = await db.agentRun.findUniqueOrThrow({ where: { id: revised.agentRunId! } });
    expect((run.result as any).removedSeconds).toBeCloseTo(1.52);
    expect((run.result as any).decisions.edits.at(-1).timelineEndSeconds).toBeCloseTo(8.48);
    expect(
      (await db.roughCut.findUniqueOrThrow({ where: { id: s.cut.id } })).renderedDecisions
    ).toEqual(s.decisions);
    const response = await list(s.version.id);
    expect(response.status).toBe(200);
    const current = (await response.json()).data.tasks[0];
    expect(current.changes).toEqual([{ start: 2, end: 3.52, detail: 'Remove footage' }]);
    expect(current.revisions[0].previewUrl).toBe(
      (await db.videoVersion.findUniqueOrThrow({ where: { id: s.first.outputVersionId! } }))
        .originalUrl
    );
    expect((await action(s.comment.id, 'accept')).status).toBe(200);
    expect((await action(s.comment.id, 'undo', { expectedRunId: revised.agentRunId })).status).toBe(
      200
    );
    expect(await db.comment.findUniqueOrThrow({ where: { id: s.comment.id } })).toMatchObject({
      isResolved: false,
      resolvedAt: null,
    });
    expect(await task(s.comment.id)).toMatchObject({
      outputVersionId: revised.outputVersionId,
      status: 'RENDERING',
    });
    expect((await action(s.comment.id, 'accept')).status).toBe(200);
    expect(await db.agentRun.count()).toBe(2);
  });
  it('rejects stale or concurrent adjustments and malformed instructions without creating extra runs', async () => {
    const s = await ready();
    expect((await action(s.comment.id, 'accept', { expectedRunId: 'stale' })).status).toBe(409);
    expect((await db.comment.findUniqueOrThrow({ where: { id: s.comment.id } })).isResolved).toBe(
      false
    );
    for (const options of [
      { adjustment: 'Change it' },
      { expectedRunId: 'stale', adjustment: 'Change it' },
      { expectedRunId: s.first.agentRunId, adjustment: ' ' },
      { expectedRunId: s.first.agentRunId, adjustment: 'x'.repeat(2001) },
    ]) {
      expect([400, 409]).toContain((await action(s.comment.id, 'revise', options)).status);
    }
    expect(await db.agentRun.count()).toBe(1);
    expect(await db.commentEditRevision.count()).toBe(0);
    const options = { expectedRunId: s.first.agentRunId, adjustment: 'Keep more footage' };
    expect(
      (
        await Promise.all([
          action(s.comment.id, 'revise', options),
          action(s.comment.id, 'revise', options),
        ])
      )
        .map((r) => r.status)
        .sort()
    ).toEqual([200, 409]);
    expect(await db.agentRun.count()).toBe(2);
    expect(await db.commentEditRevision.count()).toBe(1);
  });
  it('carries successive adjustments in order with the latest plan and leaves the first archived output pinned', async () => {
    const s = await ready();
    expect(
      (
        await action(s.comment.id, 'revise', {
          expectedRunId: s.first.agentRunId,
          adjustment: 'Cut the later second',
        })
      ).status
    ).toBe(200);
    generateEditPlan.mockResolvedValue({
      version: 1,
      operations: [{ op: 'cut', start: 3, end: 4 }],
    });
    const second = await renderDraft(s.comment.id);
    const originalArchive = await db.commentEditRevision.findFirstOrThrow({
      where: { agentRunId: s.first.agentRunId! },
    });
    expect(
      (
        await action(s.comment.id, 'revise', {
          expectedRunId: second.agentRunId,
          adjustment: 'Now keep the ending and cut the middle half-second',
        })
      ).status
    ).toBe(200);
    generateEditPlan
      .mockReset()
      .mockResolvedValue({ version: 1, operations: [{ op: 'cut', start: 2.52, end: 3 }] });
    const third = await renderDraft(s.comment.id);
    expect(JSON.parse(generateEditPlan.mock.calls[0][0].context.brief)).toMatchObject({
      revisionFeedback: [
        'Cut the later second',
        'Now keep the ending and cut the middle half-second',
      ],
      previousPlan: { version: 1, operations: [{ op: 'cut', start: 3, end: 4 }] },
    });
    expect(await db.commentEditRevision.findUnique({ where: { id: originalArchive.id } })).toEqual(
      originalArchive
    );
    expect(originalArchive.outputVersionId).toBe(s.first.outputVersionId);
    expect(
      (await db.commentEditRevision.findFirstOrThrow({ where: { agentRunId: second.agentRunId! } }))
        .outputVersionId
    ).toBe(second.outputVersionId);
    const view = (await (await list(s.version.id)).json()).data.tasks[0];
    expect(view.revisions).toHaveLength(2);
    expect(view.revisions.find((r: any) => r.id === originalArchive.id).previewUrl).toBe(
      (await db.videoVersion.findUniqueOrThrow({ where: { id: s.first.outputVersionId! } }))
        .originalUrl
    );
    expect(third.outputVersionId).not.toBe(second.outputVersionId);
  });
  it('refuses a changed comment and disabled agents while leaving the ready draft intact', async () => {
    const s = await ready();
    const options = { expectedRunId: s.first.agentRunId, adjustment: 'Change it' };
    vi.stubEnv('OPENFRAME_ENABLE_AGENTS', 'false');
    expect((await action(s.comment.id, 'revise', options)).status).toBe(403);
    vi.stubEnv('OPENFRAME_ENABLE_AGENTS', 'true');
    await db.comment.update({
      where: { id: s.comment.id },
      data: { content: 'A different request' },
    });
    expect((await action(s.comment.id, 'revise', options)).status).toBe(409);
    expect(await task(s.comment.id)).toEqual(s.first);
    expect(await db.commentEditRevision.count()).toBe(0);
  });
  it('revises one batch comment, reuses the other plan, and undoes acceptance for the complete group', async () => {
    const s = await batchReady();
    expect(
      (
        await action(s.comment.id, 'revise', {
          expectedRunId: s.first.agentRunId,
          adjustment: 'Cut the later second instead',
        })
      ).status
    ).toBe(200);
    generateEditPlan
      .mockReset()
      .mockResolvedValue({ version: 1, operations: [{ op: 'cut', start: 3, end: 4 }] });
    const revised = await renderDraft(s.comment.id);
    expect(generateEditPlan).toHaveBeenCalledTimes(1);
    const run = await db.agentRun.findUniqueOrThrow({ where: { id: revised.agentRunId! } });
    expect((run.result as any).plansByCommentId).toEqual({
      [s.comment.id]: { version: 1, operations: [{ op: 'cut', start: 3, end: 4 }] },
      [s.second.id]: { version: 1, operations: [{ op: 'cut', start: 6, end: 7 }] },
    });
    expect(await task(s.second.id)).toMatchObject({
      agentRunId: revised.agentRunId,
      outputVersionId: revised.outputVersionId,
    });
    expect(await db.commentEditRevision.count()).toBe(2);
    await action(s.second.id, 'accept');
    expect((await action(s.comment.id, 'undo', { expectedRunId: revised.agentRunId })).status).toBe(
      200
    );
    expect(
      await db.comment.count({
        where: { id: { in: [s.comment.id, s.second.id] }, isResolved: true },
      })
    ).toBe(0);
    expect(
      await db.commentEditTask.count({
        where: { status: 'RENDERING', agentRunId: revised.agentRunId },
      })
    ).toBe(2);
  });
  it('retains both previous previews on planning failure and retries the adjusted batch as a group', async () => {
    const s = await batchReady();
    await action(s.comment.id, 'revise', {
      expectedRunId: s.first.agentRunId,
      adjustment: 'Use a shorter cut',
    });
    generateEditPlan.mockRejectedValueOnce(new Error('Model unavailable'));
    await expect(executeAgentRun((await task(s.comment.id)).agentRunId!)).rejects.toThrow(
      'Model unavailable'
    );
    const failed = (await (await list(s.version.id)).json()).data.tasks;
    expect(failed.map((t: any) => t.status)).toEqual(['FAILED', 'FAILED']);
    const originalPreview = (
      await db.videoVersion.findUniqueOrThrow({ where: { id: s.first.outputVersionId! } })
    ).originalUrl;
    expect(failed.map((t: any) => t.revisions[0].previewUrl)).toEqual([
      originalPreview,
      originalPreview,
    ]);
    expect((await action(s.comment.id, 'run')).status).toBe(200);
    const retry = await task(s.comment.id);
    expect(await task(s.second.id)).toMatchObject({
      agentRunId: retry.agentRunId,
      status: 'PLANNING',
    });
    generateEditPlan
      .mockReset()
      .mockResolvedValue({ version: 1, operations: [{ op: 'cut', start: 2, end: 2.52 }] });
    await renderDraft(s.comment.id);
    expect(generateEditPlan).toHaveBeenCalledTimes(1);
    expect(JSON.parse(generateEditPlan.mock.calls[0][0].context.brief).revisionFeedback).toEqual([
      'Use a shorter cut',
    ]);
    expect(await db.commentEditRevision.count()).toBe(4);
  });
  it('refuses stale undo and changed batch feedback without partially reopening or revising it', async () => {
    const s = await batchReady();
    await action(s.comment.id, 'accept');
    expect((await action(s.second.id, 'undo', { expectedRunId: 'old-run' })).status).toBe(409);
    await db.comment.update({ where: { id: s.second.id }, data: { timestampEnd: 9 } });
    expect(
      (
        await action(s.comment.id, 'revise', {
          expectedRunId: s.first.agentRunId,
          adjustment: 'Change first cut',
        })
      ).status
    ).toBe(409);
    expect(
      await db.comment.count({
        where: { id: { in: [s.comment.id, s.second.id] }, isResolved: true },
      })
    ).toBe(2);
    expect(
      await db.commentEditTask.count({
        where: { status: 'ACCEPTED', agentRunId: s.first.agentRunId },
      })
    ).toBe(2);
    expect(await db.commentEditRevision.count()).toBe(0);
  });
  it('keeps history through human handoff and hides previews moved to another project', async () => {
    const s = await ready();
    await action(s.comment.id, 'human');
    const previous = await db.videoVersion.findUniqueOrThrow({
      where: { id: s.first.outputVersionId! },
    });
    const other = await seedVersion();
    await db.video.update({
      where: { id: previous.videoParentId },
      data: { projectId: other.project.id },
    });
    const response = await list(s.version.id);
    const view = (await response.json()).data.tasks[0];
    expect(view.revisions).toHaveLength(1);
    expect(view.revisions[0]).toMatchObject({ previewUrl: null, outputHref: null });
    expect(await db.videoVersion.findUnique({ where: { id: previous.id } })).not.toBeNull();
    expect((await action(s.comment.id, 'run')).status).toBe(200);
  });
});
