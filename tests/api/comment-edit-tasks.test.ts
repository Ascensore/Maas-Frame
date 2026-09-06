import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { db } from '@/lib/db';
import { POST } from '@/app/api/comments/[commentId]/edit-task/route';
import { GET } from '@/app/api/versions/[versionId]/edit-tasks/route';
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
import { apiRequest, callRoute, readData } from '../helpers/request';
import type { CommentEditView } from '@/lib/comment-edit/types';

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
  return { ...s, comment, cut, decisions, source };
}
function action(commentId: string, value: string) {
  return callRoute(
    POST,
    apiRequest(`/api/comments/${commentId}/edit-task`, { method: 'POST', body: { action: value } }),
    { commentId }
  );
}
function list(versionId: string) {
  return callRoute(GET, apiRequest(`/api/versions/${versionId}/edit-tasks`), { versionId });
}
async function renderDraft(commentId: string) {
  const task = await db.commentEditTask.findUniqueOrThrow({ where: { commentId } });
  await executeAgentRun(task.agentRunId!);
  const planned = await db.commentEditTask.findUniqueOrThrow({ where: { commentId } });
  const encoder = vi.fn(async () => ({ stdout: '', stderr: '', code: 0 }));
  await materializeRoughCut(
    {
      pool,
      run: encoder,
      downloadObject: async () => {},
      uploadObject: async () => {},
      objectKeyFromProvider: (v) => v.videoId,
      readOutput: async () => Buffer.from('rendered video'),
    },
    planned.roughCutId!
  );
  await db.mediaJob.update({ where: { id: planned.renderJobId! }, data: { status: 'SUCCEEDED' } });
  return { planned, encoder };
}

describe('comment editing tasks', () => {
  it('refuses anonymous actions and listing without creating a task or resolving the comment', async () => {
    const s = await seed();
    signedOut();
    expect((await action(s.comment.id, 'run')).status).toBe(401);
    expect((await list(s.version.id)).status).toBe(401);
    expect(await db.commentEditTask.count()).toBe(0);
    expect(await db.agentRun.count()).toBe(0);
    expect((await db.comment.findUniqueOrThrow({ where: { id: s.comment.id } })).isResolved).toBe(
      false
    );
  });
  it('refuses a signed-in stranger even on a public project', async () => {
    const s = await seed();
    await db.project.update({ where: { id: s.project.id }, data: { visibility: 'PUBLIC' } });
    signedInAs(await createUser());
    expect((await action(s.comment.id, 'run')).status).toBe(403);
    expect((await action(s.comment.id, 'human')).status).toBe(403);
    expect((await list(s.version.id)).status).toBe(403);
    expect(await db.commentEditTask.count()).toBe(0);
    expect(await db.agentRun.count()).toBe(0);
    expect((await db.comment.findUniqueOrThrow({ where: { id: s.comment.id } })).isResolved).toBe(
      false
    );
  });
  it('queues without running, retains a source snapshot, and hands back to a human', async () => {
    const s = await seed();
    expect((await action(s.comment.id, 'queue')).status).toBe(200);
    const task = await db.commentEditTask.findUniqueOrThrow({ where: { commentId: s.comment.id } });
    expect(task.status).toBe('QUEUED');
    expect(task.snapshot).toEqual(
      expect.objectContaining({
        content: 'Remove the pause',
        versionId: s.version.id,
        start: 2,
        end: 4,
        decisions: s.decisions,
      })
    );
    expect(await db.agentRun.count()).toBe(0);
    expect(
      (await readData<{ tasks: CommentEditView[] }>(await list(s.version.id))).tasks[0].status
    ).toBe('QUEUED');
    expect((await action(s.comment.id, 'human')).status).toBe(200);
    expect((await db.commentEditTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe(
      'HUMAN'
    );
  });
  it('executes queued feedback against its saved version even after the source review changes', async () => {
    const s = await seed();
    await action(s.comment.id, 'queue');
    await db.roughCut.update({ where: { id: s.cut.id }, data: { renderedDecisions: {} } });
    await db.videoVersion.update({ where: { id: s.version.id }, data: { isActive: false } });
    await db.comment.update({
      where: { id: s.comment.id },
      data: { content: 'Add motion graphics' },
    });
    expect((await action(s.comment.id, 'run')).status).toBe(200);
    const task = await db.commentEditTask.findUniqueOrThrow({ where: { commentId: s.comment.id } });
    await executeAgentRun(task.agentRunId!);
    expect(generateEditPlan.mock.calls[0][0].context.comments).toEqual([
      expect.objectContaining({ content: 'Remove the pause', timestamp: 2, timestampEnd: 4 }),
    ]);
    const done = await db.commentEditTask.findUniqueOrThrow({
      where: { id: task.id },
      include: { roughCut: true },
    });
    expect(done.status).toBe('RENDERING');
    expect(done.roughCut?.decisions).toEqual(
      expect.objectContaining({
        edits: [
          expect.objectContaining({
            sourceVersionId: s.source.id,
            inSeconds: 10,
            outSeconds: 12,
            timelineStartSeconds: 0,
            timelineEndSeconds: 2,
          }),
          expect.objectContaining({
            sourceVersionId: s.source.id,
            inSeconds: 13,
            outSeconds: 20,
            timelineStartSeconds: 2,
            timelineEndSeconds: 9,
          }),
        ],
      })
    );
  });
  it('allows one concurrent execution per comment and does not let handoff race rendering', async () => {
    const s = await seed();
    const responses = await Promise.all([action(s.comment.id, 'run'), action(s.comment.id, 'run')]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await db.agentRun.count()).toBe(1);
    expect(await db.commentEditTask.count()).toBe(1);
    expect((await action(s.comment.id, 'human')).status).toBe(409);
    const task = await db.commentEditTask.findUniqueOrThrow({ where: { commentId: s.comment.id } });
    await executeAgentRun(task.agentRunId!);
    await executeAgentRun(task.agentRunId!);
    expect(await db.mediaJob.count({ where: { kind: 'MATERIALIZE_ROUGH_CUT' } })).toBe(1);
  });
  it('renders an isolated draft and only resolves the comment when accepted', async () => {
    const s = await seed();
    await createComment({
      versionId: s.version.id,
      content: 'Delete the entire video',
      timestamp: 0,
      timestampEnd: 10,
    });
    await action(s.comment.id, 'run');
    expect((await action(s.comment.id, 'accept')).status).toBe(409);
    const { planned, encoder } = await renderDraft(s.comment.id);
    expect(generateEditPlan.mock.calls[0][0].context.comments).toHaveLength(1);
    const args = encoder.mock.calls[0] as unknown as [string, string[]];
    expect(args[0]).toBe('ffmpeg');
    expect(args[1].slice(4, 16)).toEqual([
      '-ss',
      '10.000',
      '-t',
      '2.000',
      '-i',
      expect.stringContaining(`${s.source.id}.bin`),
      '-ss',
      '13.000',
      '-t',
      '7.000',
      '-i',
      expect.stringContaining(`${s.source.id}.bin`),
    ]);
    const stored = await db.commentEditTask.findUniqueOrThrow({
      where: { id: planned.id },
      include: { outputVersion: { include: { video: true } } },
    });
    expect(stored.outputVersion?.video.title).toBe(`AI draft — ${s.video.title}`);
    expect(stored.outputVersion?.videoParentId).not.toBe(s.video.id);
    expect(
      (await db.videoVersion.findUniqueOrThrow({ where: { id: s.version.id } })).isActive
    ).toBe(true);
    expect((await db.roughCut.findUniqueOrThrow({ where: { id: s.cut.id } })).decisions).toEqual(
      s.decisions
    );
    expect((await db.comment.findUniqueOrThrow({ where: { id: s.comment.id } })).isResolved).toBe(
      false
    );
    const tasks = (await readData<{ tasks: CommentEditView[] }>(await list(s.version.id))).tasks;
    expect(tasks[0]).toEqual(
      expect.objectContaining({
        status: 'READY',
        removedSeconds: 1,
        previewUrl: stored.outputVersion?.originalUrl,
      })
    );
    expect((await action(s.comment.id, 'accept')).status).toBe(200);
    expect((await db.comment.findUniqueOrThrow({ where: { id: s.comment.id } })).isResolved).toBe(
      true
    );
    expect((await db.commentEditTask.findUniqueOrThrow({ where: { id: planned.id } })).status).toBe(
      'ACCEPTED'
    );
    expect((await action(s.comment.id, 'human')).status).toBe(200);
    expect((await db.comment.findUniqueOrThrow({ where: { id: s.comment.id } })).isResolved).toBe(
      false
    );
  });
  it('does not accept feedback that was changed after the draft was requested', async () => {
    const s = await seed();
    await action(s.comment.id, 'run');
    await renderDraft(s.comment.id);
    await db.comment.update({
      where: { id: s.comment.id },
      data: { content: 'Actually keep the pause' },
    });
    expect((await action(s.comment.id, 'accept')).status).toBe(409);
    expect((await db.comment.findUniqueOrThrow({ where: { id: s.comment.id } })).isResolved).toBe(
      false
    );
  });
  it('rejects a plan outside the selected range and leaves the original untouched', async () => {
    const s = await seed();
    await action(s.comment.id, 'run');
    generateEditPlan.mockResolvedValue({
      version: 1,
      operations: [{ op: 'cut', start: 0, end: 6 }],
    });
    const task = await db.commentEditTask.findUniqueOrThrow({ where: { commentId: s.comment.id } });
    await expect(executeAgentRun(task.agentRunId!)).rejects.toThrow('outside');
    expect(
      (await readData<{ tasks: CommentEditView[] }>(await list(s.version.id))).tasks[0].status
    ).toBe('FAILED');
    expect(await db.mediaJob.count()).toBe(0);
    expect(await db.roughCut.count()).toBe(1);
    expect((await db.comment.findUniqueOrThrow({ where: { id: s.comment.id } })).isResolved).toBe(
      false
    );
    expect((await action(s.comment.id, 'human')).status).toBe(200);
  });
  it('surfaces render failure and allows retry without resolving feedback', async () => {
    const s = await seed();
    await action(s.comment.id, 'run');
    const task = await db.commentEditTask.findUniqueOrThrow({ where: { commentId: s.comment.id } });
    await executeAgentRun(task.agentRunId!);
    const planned = await db.commentEditTask.findUniqueOrThrow({ where: { id: task.id } });
    await db.mediaJob.update({
      where: { id: planned.renderJobId! },
      data: { status: 'FAILED', error: 'Encoder failed' },
    });
    expect(
      (await readData<{ tasks: CommentEditView[] }>(await list(s.version.id))).tasks[0]
    ).toEqual(expect.objectContaining({ status: 'FAILED', error: 'Encoder failed' }));
    expect((await action(s.comment.id, 'accept')).status).toBe(409);
    expect((await action(s.comment.id, 'run')).status).toBe(200);
    expect((await db.comment.findUniqueOrThrow({ where: { id: s.comment.id } })).isResolved).toBe(
      false
    );
    expect(await db.agentRun.count()).toBe(2);
  });
  it('rechecks edit permission when the queued worker starts', async () => {
    const s = await seed();
    await action(s.comment.id, 'run');
    const task = await db.commentEditTask.findUniqueOrThrow({ where: { commentId: s.comment.id } });
    await db.agentRun.update({
      where: { id: task.agentRunId! },
      data: { triggeredById: (await createUser()).id },
    });
    await expect(executeAgentRun(task.agentRunId!)).rejects.toThrow('permission');
    expect(generateEditPlan).not.toHaveBeenCalled();
    expect(await db.mediaJob.count()).toBe(0);
  });
  it('requires enabled agents, a range, and a rendered rough-cut source', async () => {
    const s = await seed();
    vi.stubEnv('OPENFRAME_ENABLE_AGENTS', 'false');
    expect((await action(s.comment.id, 'run')).status).toBe(403);
    vi.stubEnv('OPENFRAME_ENABLE_AGENTS', 'true');
    await db.comment.update({ where: { id: s.comment.id }, data: { timestampEnd: null } });
    expect((await action(s.comment.id, 'queue')).status).toBe(400);
    await db.comment.update({ where: { id: s.comment.id }, data: { timestampEnd: 4 } });
    await db.roughCut.delete({ where: { id: s.cut.id } });
    expect((await action(s.comment.id, 'run')).status).toBe(400);
    expect(await db.commentEditTask.count()).toBe(0);
    expect(await db.agentRun.count()).toBe(0);
  });
  it('refuses to use a previous render’s source map for an uploaded replacement version', async () => {
    const s = await seed();
    await db.videoVersion.update({ where: { id: s.version.id }, data: { isActive: false } });
    const replacement = await createVersion({
      videoParentId: s.video.id,
      versionNumber: 2,
      providerId: 'r2',
      duration: 10,
      isActive: true,
    });
    const comment = await createComment({
      versionId: replacement.id,
      timestamp: 2,
      timestampEnd: 4,
      content: 'Remove this section',
    });
    expect((await action(comment.id, 'run')).status).toBe(409);
    expect(await db.commentEditTask.count()).toBe(0);
    expect(await db.agentRun.count()).toBe(0);
    expect((await db.comment.findUniqueOrThrow({ where: { id: comment.id } })).isResolved).toBe(
      false
    );
  });
  it('refuses snapshots of an older version reactivated after a newer render', async () => {
    const s = await seed();
    const newer = await createVersion({
      videoParentId: s.video.id,
      versionNumber: 2,
      providerId: 'r2',
      isActive: false,
    });
    await db.roughCut.update({ where: { id: s.cut.id }, data: { renderedVersionId: newer.id } });
    expect((await action(s.comment.id, 'queue')).status).toBe(409);
    expect(await db.commentEditTask.count()).toBe(0);
  });
  it('does not queue a render when editing access is revoked during model execution', async () => {
    const s = await seed();
    const editor = await createUser();
    const membership = await addProjectMember({
      projectId: s.project.id,
      userId: editor.id,
      role: 'ADMIN',
    });
    signedInAs(editor);
    expect((await action(s.comment.id, 'run')).status).toBe(200);
    const task = await db.commentEditTask.findUniqueOrThrow({ where: { commentId: s.comment.id } });
    generateEditPlan.mockImplementationOnce(async () => {
      await db.projectMember.delete({ where: { id: membership.id } });
      return { version: 1, operations: [{ op: 'cut', start: 2, end: 3 }] };
    });
    await expect(executeAgentRun(task.agentRunId!)).rejects.toThrow('permission');
    expect(generateEditPlan).toHaveBeenCalledOnce();
    expect(await db.roughCut.count()).toBe(1);
    expect(await db.mediaJob.count()).toBe(0);
    expect((await db.comment.findUniqueOrThrow({ where: { id: s.comment.id } })).isResolved).toBe(
      false
    );
  });
  it('pins the first output version even if the draft is re-rendered later', async () => {
    const s = await seed();
    await action(s.comment.id, 'run');
    const { planned } = await renderDraft(s.comment.id);
    const first = await db.commentEditTask.findUniqueOrThrow({
      where: { id: planned.id },
      include: { outputVersion: true },
    });
    await renderDraft(s.comment.id);
    const second = await db.commentEditTask.findUniqueOrThrow({
      where: { id: planned.id },
      include: { outputVersion: true, roughCut: true },
    });
    expect(second.outputVersionId).toBe(first.outputVersionId);
    expect(second.outputVersion?.originalUrl).toBe(first.outputVersion?.originalUrl);
    expect(second.outputVersion?.isActive).toBe(false);
    expect(second.roughCut?.renderedVersionId).not.toBe(first.outputVersionId);
    expect(second.roughCut?.renderedVersionId).not.toBeNull();
    expect(
      (await readData<{ tasks: CommentEditView[] }>(await list(s.version.id))).tasks[0].previewUrl
    ).toBe(first.outputVersion?.originalUrl);
  });
});
