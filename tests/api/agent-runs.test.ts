import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommentSource } from '@prisma/client';
import { db } from '@/lib/db';
import {
  GET as listAgentRuns,
  POST as createAgentRun,
} from '@/app/api/versions/[versionId]/agent-runs/route';
import {
  DELETE as deleteCommentRoute,
  PATCH as patchCommentRoute,
} from '@/app/api/comments/[commentId]/route';
import { executeAgentRun } from '@/lib/agents/run-review';
import { claimPendingAgentRuns } from '@/lib/agents/claim';
import { enqueueAgentRun } from '@/lib/agents/enqueue';
import { publishFindings } from '@/lib/agents/publish-findings';
import { GET as listComments } from '@/app/api/versions/[versionId]/comments/route';
import { apiRequest, callRoute, readData, readError } from '../helpers/request';
import { signedInAs, signedOut } from '../helpers/session';
import {
  addProjectMember,
  createCommentTag,
  createReadyTranscript,
  createUser,
  seedVersion,
} from '../factories';

function agentRunsUrl(versionId: string) {
  return `/api/versions/${versionId}/agent-runs`;
}

describe('POST /api/versions/[versionId]/agent-runs', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 401 to an anonymous caller', async () => {
    const scenario = await seedVersion();
    signedOut();

    const response = await callRoute(
      createAgentRun,
      apiRequest(agentRunsUrl(scenario.version.id), { method: 'POST', body: {} }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(401);
    expect(await db.agentRun.count()).toBe(0);
  });

  it('returns 403 when agents are disabled', async () => {
    const scenario = await seedVersion();
    signedInAs(scenario.owner);
    vi.stubEnv('OPENFRAME_ENABLE_AGENTS', 'false');

    const response = await callRoute(
      createAgentRun,
      apiRequest(agentRunsUrl(scenario.version.id), { method: 'POST', body: {} }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(403);
    expect(await db.agentRun.count()).toBe(0);
  });

  it('returns 404 to a signed-in stranger', async () => {
    const scenario = await seedVersion();
    const stranger = await createUser();
    signedInAs(stranger);
    vi.stubEnv('OPENFRAME_ENABLE_AGENTS', 'true');

    const response = await callRoute(
      createAgentRun,
      apiRequest(agentRunsUrl(scenario.version.id), { method: 'POST', body: {} }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(404);
    expect(await db.agentRun.count()).toBe(0);
  });

  it('enqueues a pending transcript-review run for the owner', async () => {
    const scenario = await seedVersion();
    signedInAs(scenario.owner);
    vi.stubEnv('OPENFRAME_ENABLE_AGENTS', 'true');
    vi.stubEnv('OPENFRAME_AGENT_MODEL', 'mock');

    const response = await callRoute(
      createAgentRun,
      apiRequest(agentRunsUrl(scenario.version.id), { method: 'POST', body: {} }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(201);
    const payload = await readData<{ run: { id: string; status: string; agentSlug: string } }>(
      response
    );
    expect(payload.run.status).toBe('PENDING');
    expect(payload.run.agentSlug).toBe('transcript-review');

    const stored = await db.agentRun.findUniqueOrThrow({ where: { id: payload.run.id } });
    expect(stored.triggeredById).toBe(scenario.owner.id);
    expect(stored.model).toBe('mock');
  });

  it('returns 400 for an unknown agent slug', async () => {
    const scenario = await seedVersion();
    signedInAs(scenario.owner);
    vi.stubEnv('OPENFRAME_ENABLE_AGENTS', 'true');

    const response = await callRoute(
      createAgentRun,
      apiRequest(agentRunsUrl(scenario.version.id), {
        method: 'POST',
        body: { agentSlug: 'not-a-real-agent' },
      }),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(400);
    expect(await db.agentRun.count()).toBe(0);
  });

  it('returns 409 when a run is already pending', async () => {
    const scenario = await seedVersion();
    signedInAs(scenario.owner);
    vi.stubEnv('OPENFRAME_ENABLE_AGENTS', 'true');

    const first = await callRoute(
      createAgentRun,
      apiRequest(agentRunsUrl(scenario.version.id), { method: 'POST', body: {} }),
      { versionId: scenario.version.id }
    );
    expect(first.status).toBe(201);

    const second = await callRoute(
      createAgentRun,
      apiRequest(agentRunsUrl(scenario.version.id), { method: 'POST', body: {} }),
      { versionId: scenario.version.id }
    );
    expect(second.status).toBe(409);
    expect(await db.agentRun.count()).toBe(1);
  });

  it('enqueues a new run after the previous one failed', async () => {
    const scenario = await seedVersion();
    signedInAs(scenario.owner);
    vi.stubEnv('OPENFRAME_ENABLE_AGENTS', 'true');

    const first = await callRoute(
      createAgentRun,
      apiRequest(agentRunsUrl(scenario.version.id), { method: 'POST', body: {} }),
      { versionId: scenario.version.id }
    );
    const { run } = await readData<{ run: { id: string } }>(first);
    await db.agentRun.update({
      where: { id: run.id },
      data: { status: 'FAILED', error: 'Transcript is not ready', finishedAt: new Date() },
    });

    const second = await callRoute(
      createAgentRun,
      apiRequest(agentRunsUrl(scenario.version.id), { method: 'POST', body: {} }),
      { versionId: scenario.version.id }
    );
    expect(second.status).toBe(201);
    expect(await db.agentRun.count()).toBe(2);
  });

  it('returns 429 after five runs on the same version in the window', async () => {
    const scenario = await seedVersion();
    signedInAs(scenario.owner);
    vi.stubEnv('OPENFRAME_ENABLE_AGENTS', 'true');
    vi.stubEnv('DISABLE_RATE_LIMIT', 'false');

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await callRoute(
        createAgentRun,
        apiRequest(agentRunsUrl(scenario.version.id), { method: 'POST', body: {} }),
        { versionId: scenario.version.id }
      );
      expect(response.status).toBe(201);
      const { run } = await readData<{ run: { id: string } }>(response);
      await db.agentRun.update({
        where: { id: run.id },
        data: { status: 'SUCCEEDED', finishedAt: new Date() },
      });
    }

    const blocked = await callRoute(
      createAgentRun,
      apiRequest(agentRunsUrl(scenario.version.id), { method: 'POST', body: {} }),
      { versionId: scenario.version.id }
    );
    expect(blocked.status).toBe(429);
    expect(await db.agentRun.count({ where: { versionId: scenario.version.id } })).toBe(5);
  });
});

describe('GET /api/versions/[versionId]/agent-runs', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 401 to an anonymous caller', async () => {
    const scenario = await seedVersion();
    signedOut();
    vi.stubEnv('OPENFRAME_ENABLE_AGENTS', 'true');

    const response = await callRoute(listAgentRuns, apiRequest(agentRunsUrl(scenario.version.id)), {
      versionId: scenario.version.id,
    });
    expect(response.status).toBe(401);
  });

  it('returns 404 to a signed-in stranger', async () => {
    const scenario = await seedVersion();
    const stranger = await createUser();
    signedInAs(stranger);
    vi.stubEnv('OPENFRAME_ENABLE_AGENTS', 'true');

    const response = await callRoute(listAgentRuns, apiRequest(agentRunsUrl(scenario.version.id)), {
      versionId: scenario.version.id,
    });
    expect(response.status).toBe(404);
  });

  it('returns 403 when agents are disabled', async () => {
    const scenario = await seedVersion();
    signedInAs(scenario.owner);
    vi.stubEnv('OPENFRAME_ENABLE_AGENTS', 'false');

    const response = await callRoute(listAgentRuns, apiRequest(agentRunsUrl(scenario.version.id)), {
      versionId: scenario.version.id,
    });
    expect(response.status).toBe(403);
  });

  it('lists recent runs for a member', async () => {
    const scenario = await seedVersion();
    signedInAs(scenario.owner);
    vi.stubEnv('OPENFRAME_ENABLE_AGENTS', 'true');

    await callRoute(
      createAgentRun,
      apiRequest(agentRunsUrl(scenario.version.id), { method: 'POST', body: {} }),
      { versionId: scenario.version.id }
    );

    const response = await callRoute(listAgentRuns, apiRequest(agentRunsUrl(scenario.version.id)), {
      versionId: scenario.version.id,
    });
    expect(response.status).toBe(200);
    const payload = await readData<{ runs: Array<{ agentSlug: string }> }>(response);
    expect(payload.runs).toHaveLength(1);
    expect(payload.runs[0]?.agentSlug).toBe('transcript-review');
  });
});

describe('executeAgentRun', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('posts agent comments from a mock transcript review and does not duplicate on retry', async () => {
    const scenario = await seedVersion({ duration: 60 });
    await createReadyTranscript({
      versionId: scenario.version.id,
      segments: [{ startSec: 2, endSec: 5, text: 'We open on the product' }],
    });
    signedInAs(scenario.owner);
    vi.stubEnv('OPENFRAME_ENABLE_AGENTS', 'true');
    vi.stubEnv('OPENFRAME_AGENT_MODEL', 'mock');

    const created = await callRoute(
      createAgentRun,
      apiRequest(agentRunsUrl(scenario.version.id), { method: 'POST', body: {} }),
      { versionId: scenario.version.id }
    );
    const { run } = await readData<{ run: { id: string } }>(created);

    await db.agentRun.update({
      where: { id: run.id },
      data: { status: 'RUNNING', attempts: 1 },
    });
    await executeAgentRun(run.id);

    const finished = await db.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(finished.status).toBe('SUCCEEDED');
    expect(finished.result).toMatchObject({ published: { posted: 2, skipped: 0 } });

    const comments = await db.comment.findMany({
      where: { versionId: scenario.version.id },
      orderBy: { timestamp: 'asc' },
    });
    expect(comments).toHaveLength(2);
    expect(comments.every((comment) => comment.source === CommentSource.AGENT)).toBe(true);
    expect(comments.every((comment) => comment.agentRunId === run.id)).toBe(true);
    expect(comments[0]?.timestamp).toBe(0);
    expect(comments[1]?.content).toContain('We open on the product');

    await db.agentRun.update({
      where: { id: run.id },
      data: { status: 'PENDING', finishedAt: null },
    });
    await db.agentRun.update({
      where: { id: run.id },
      data: { status: 'RUNNING' },
    });
    await executeAgentRun(run.id);

    expect(await db.comment.count({ where: { versionId: scenario.version.id } })).toBe(2);

    signedInAs(scenario.owner);
    const listed = await callRoute(
      listComments,
      apiRequest(`/api/versions/${scenario.version.id}/comments`),
      { versionId: scenario.version.id }
    );
    expect(listed.status).toBe(200);
    const payload = await readData<{
      comments: Array<{ source: string; agentSlug: string | null }>;
    }>(listed);
    expect(payload.comments).toHaveLength(2);
    expect(payload.comments.every((comment) => comment.source === 'AGENT')).toBe(true);
    expect(payload.comments.every((comment) => comment.agentSlug === 'transcript-review')).toBe(
      true
    );
  });

  it('skips a second publish of the same fingerprint without inserting another row', async () => {
    const scenario = await seedVersion({ duration: 30 });
    const { run } = await enqueueAgentRun({
      versionId: scenario.version.id,
      triggeredById: scenario.owner.id,
    });
    const finding = { timestamp: 4, timestampEnd: 8, body: 'Hold the product' };

    const first = await publishFindings({
      versionId: scenario.version.id,
      agentRunId: run.id,
      agentSlug: 'transcript-review',
      findings: [finding],
      duration: 30,
      frameRateNum: 24,
      frameRateDen: 1,
      projectId: scenario.project.id,
    });
    const second = await publishFindings({
      versionId: scenario.version.id,
      agentRunId: run.id,
      agentSlug: 'transcript-review',
      findings: [finding],
      duration: 30,
      frameRateNum: 24,
      frameRateDen: 1,
      projectId: scenario.project.id,
    });

    expect(first).toEqual({ posted: 1, skipped: 0 });
    expect(second).toEqual({ posted: 0, skipped: 1 });
    expect(await db.comment.count({ where: { versionId: scenario.version.id } })).toBe(1);
    const posted = await db.comment.findFirstOrThrow({
      where: { versionId: scenario.version.id },
    });
    expect(posted.source).toBe(CommentSource.AGENT);
  });

  it('maps a known tag name onto the project tag', async () => {
    const scenario = await seedVersion({ duration: 30 });
    const tag = await createCommentTag({
      projectId: scenario.project.id,
      name: 'Feedback',
    });
    const { run } = await enqueueAgentRun({
      versionId: scenario.version.id,
      triggeredById: scenario.owner.id,
    });

    await publishFindings({
      versionId: scenario.version.id,
      agentRunId: run.id,
      agentSlug: 'transcript-review',
      findings: [{ timestamp: 1, body: 'Tagged note', tagName: 'Feedback' }],
      duration: 30,
      frameRateNum: 24,
      frameRateDen: 1,
      projectId: scenario.project.id,
    });

    expect(
      (await db.comment.findFirstOrThrow({ where: { versionId: scenario.version.id } })).tagId
    ).toBe(tag.id);
  });

  it('stores an edit plan from the model and posts no comments', async () => {
    const scenario = await seedVersion({ duration: 40 });
    signedInAs(scenario.owner);
    vi.stubEnv('OPENFRAME_ENABLE_AGENTS', 'true');
    vi.stubEnv('OPENFRAME_AGENT_MODEL', 'mock');

    const created = await callRoute(
      createAgentRun,
      apiRequest(agentRunsUrl(scenario.version.id), {
        method: 'POST',
        body: { agentSlug: 'edit' },
      }),
      { versionId: scenario.version.id }
    );
    expect(created.status).toBe(201);
    const { run } = await readData<{ run: { id: string; kind: string } }>(created);
    expect(run.kind).toBe('EDIT');

    await db.agentRun.update({
      where: { id: run.id },
      data: { status: 'RUNNING', attempts: 1 },
    });
    await executeAgentRun(run.id);

    const stored = await db.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(stored.status).toBe('SUCCEEDED');
    expect(stored.result).toEqual({
      editPlan: { version: 1, operations: [{ op: 'keep', start: 0, end: 40 }] },
    });
    expect(await db.comment.count({ where: { versionId: scenario.version.id } })).toBe(0);
  });

  it('ignores a transcript that is not READY', async () => {
    const scenario = await seedVersion();
    await createReadyTranscript({
      versionId: scenario.version.id,
      status: 'PENDING',
      segments: [{ startSec: 0, endSec: 1, text: 'Not ready yet' }],
    });
    signedInAs(scenario.owner);
    vi.stubEnv('OPENFRAME_ENABLE_AGENTS', 'true');

    const created = await callRoute(
      createAgentRun,
      apiRequest(agentRunsUrl(scenario.version.id), { method: 'POST', body: {} }),
      { versionId: scenario.version.id }
    );
    const { run } = await readData<{ run: { id: string } }>(created);
    await db.agentRun.update({
      where: { id: run.id },
      data: { status: 'RUNNING', attempts: 1 },
    });

    await expect(executeAgentRun(run.id)).rejects.toThrow('Transcript is not ready');
    expect(await db.comment.count({ where: { versionId: scenario.version.id } })).toBe(0);
  });

  it('does not run a succeeded job again', async () => {
    const scenario = await seedVersion({ duration: 20 });
    await createReadyTranscript({
      versionId: scenario.version.id,
      segments: [{ startSec: 0, endSec: 1, text: 'Hi' }],
    });
    const { run } = await enqueueAgentRun({
      versionId: scenario.version.id,
      triggeredById: scenario.owner.id,
    });
    await db.agentRun.update({
      where: { id: run.id },
      data: { status: 'SUCCEEDED', finishedAt: new Date() },
    });

    await executeAgentRun(run.id);

    expect(await db.comment.count({ where: { versionId: scenario.version.id } })).toBe(0);
    expect((await db.agentRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe(
      'SUCCEEDED'
    );
  });

  it('fails the run when there is no transcript and writes no comments', async () => {
    const scenario = await seedVersion();
    signedInAs(scenario.owner);
    vi.stubEnv('OPENFRAME_ENABLE_AGENTS', 'true');

    const created = await callRoute(
      createAgentRun,
      apiRequest(agentRunsUrl(scenario.version.id), { method: 'POST', body: {} }),
      { versionId: scenario.version.id }
    );
    const { run } = await readData<{ run: { id: string } }>(created);
    await db.agentRun.update({
      where: { id: run.id },
      data: { status: 'RUNNING', attempts: 1 },
    });

    await expect(executeAgentRun(run.id)).rejects.toThrow('Transcript is not ready');

    const stored = await db.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(stored.status).toBe('FAILED');
    expect(stored.error).toBe('Transcript is not ready');
    expect(await db.comment.count({ where: { versionId: scenario.version.id } })).toBe(0);
  });

  it('claims a pending run and does not reclaim it', async () => {
    const scenario = await seedVersion();
    signedInAs(scenario.owner);
    vi.stubEnv('OPENFRAME_ENABLE_AGENTS', 'true');

    const created = await callRoute(
      createAgentRun,
      apiRequest(agentRunsUrl(scenario.version.id), { method: 'POST', body: {} }),
      { versionId: scenario.version.id }
    );
    const { run } = await readData<{ run: { id: string } }>(created);

    const claimed = await claimPendingAgentRuns(5);
    expect(claimed).toEqual([run.id]);
    const stored = await db.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(stored.status).toBe('RUNNING');
    expect(stored.attempts).toBe(1);
    expect(stored.startedAt).not.toBeNull();
    expect(await claimPendingAgentRuns(5)).toEqual([]);
  });
});

describe('agent comment permissions', () => {
  it('lets a COMMENTATOR resolve and delete an agent comment', async () => {
    const scenario = await seedVersion();
    const commentator = await createUser();
    await addProjectMember({
      projectId: scenario.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    const comment = await db.comment.create({
      data: {
        versionId: scenario.version.id,
        content: 'AI note',
        timestamp: 3,
        source: CommentSource.AGENT,
        agentSlug: 'transcript-review',
        agentFingerprint: 'abc',
      },
    });
    signedInAs(commentator);

    const resolved = await callRoute(
      patchCommentRoute,
      apiRequest(`/api/comments/${comment.id}`, {
        method: 'PATCH',
        body: { isResolved: true },
      }),
      { commentId: comment.id }
    );
    expect(resolved.status).toBe(200);
    expect((await db.comment.findUniqueOrThrow({ where: { id: comment.id } })).isResolved).toBe(
      true
    );

    const deleted = await callRoute(
      deleteCommentRoute,
      apiRequest(`/api/comments/${comment.id}`, { method: 'DELETE' }),
      { commentId: comment.id }
    );
    expect(deleted.status).toBe(200);
    expect(await db.comment.findUnique({ where: { id: comment.id } })).toBeNull();
  });

  it('does not let a COMMENTATOR rewrite agent comment content', async () => {
    const scenario = await seedVersion();
    const commentator = await createUser();
    await addProjectMember({
      projectId: scenario.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    const comment = await db.comment.create({
      data: {
        versionId: scenario.version.id,
        content: 'AI note',
        timestamp: 3,
        source: CommentSource.AGENT,
        agentSlug: 'transcript-review',
      },
    });
    signedInAs(commentator);

    const response = await callRoute(
      patchCommentRoute,
      apiRequest(`/api/comments/${comment.id}`, {
        method: 'PATCH',
        body: { content: 'rewritten' },
      }),
      { commentId: comment.id }
    );
    expect(response.status).toBe(403);
    expect(await readError(response)).toBe('Only the author can edit comment content');
    expect((await db.comment.findUniqueOrThrow({ where: { id: comment.id } })).content).toBe(
      'AI note'
    );
  });

  it('does not let a guest resolve or delete an agent comment on a public project', async () => {
    const scenario = await seedVersion({ visibility: 'PUBLIC' });
    const comment = await db.comment.create({
      data: {
        versionId: scenario.version.id,
        content: 'AI note',
        timestamp: 3,
        source: CommentSource.AGENT,
        agentSlug: 'transcript-review',
        agentFingerprint: 'guest-must-not-delete',
      },
    });
    signedOut();

    const resolved = await callRoute(
      patchCommentRoute,
      apiRequest(`/api/comments/${comment.id}`, {
        method: 'PATCH',
        body: { isResolved: true },
      }),
      { commentId: comment.id }
    );
    expect(resolved.status).toBe(403);
    expect((await db.comment.findUniqueOrThrow({ where: { id: comment.id } })).isResolved).toBe(
      false
    );

    const deleted = await callRoute(
      deleteCommentRoute,
      apiRequest(`/api/comments/${comment.id}`, { method: 'DELETE' }),
      { commentId: comment.id }
    );
    expect(deleted.status).toBe(403);
    expect(await db.comment.findUnique({ where: { id: comment.id } })).not.toBeNull();
  });

  it('does not let a signed-in stranger delete an agent comment on a public project', async () => {
    const scenario = await seedVersion({ visibility: 'PUBLIC' });
    const stranger = await createUser();
    const comment = await db.comment.create({
      data: {
        versionId: scenario.version.id,
        content: 'AI note',
        timestamp: 3,
        source: CommentSource.AGENT,
        agentSlug: 'transcript-review',
        agentFingerprint: 'public-stranger',
      },
    });
    signedInAs(stranger);

    const deleted = await callRoute(
      deleteCommentRoute,
      apiRequest(`/api/comments/${comment.id}`, { method: 'DELETE' }),
      { commentId: comment.id }
    );
    expect(deleted.status).toBe(403);
    expect(await db.comment.findUnique({ where: { id: comment.id } })).not.toBeNull();
  });
});
