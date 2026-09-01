import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommentSource } from '@prisma/client';
import { db } from '@/lib/db';
import {
  POST as createV1AgentRun,
  GET as listV1AgentRuns,
} from '@/app/api/v1/versions/[versionId]/agent-runs/route';
import { generateApiToken } from '@/lib/api-token';
import { executeAgentRun } from '@/lib/agents/run-review';
import { apiRequest, callRoute, readData } from '../helpers/request';
import { signedOut } from '../helpers/session';
import { createReadyTranscript, createUser, seedVersion } from '../factories';

async function tokenFor(userId: string): Promise<string> {
  const token = generateApiToken();
  await db.apiToken.create({
    data: {
      userId,
      name: 'panel',
      tokenHash: token.hash,
      tokenPrefix: token.prefix,
    },
  });
  return token.raw;
}

describe('POST /api/v1/versions/[versionId]/agent-runs', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('refuses a missing bearer token', async () => {
    const scenario = await seedVersion();
    signedOut();
    vi.stubEnv('OPENFRAME_ENABLE_AGENTS', 'true');

    const response = await callRoute(
      createV1AgentRun,
      apiRequest(`/api/v1/versions/${scenario.version.id}/agent-runs`, {
        method: 'POST',
        body: {},
      }),
      { versionId: scenario.version.id }
    );
    expect(response.status).toBe(401);
    expect(await db.agentRun.count()).toBe(0);
  });

  it('lets a project token enqueue a run whose mock execution posts agent comments', async () => {
    const scenario = await seedVersion({ duration: 30 });
    await createReadyTranscript({
      versionId: scenario.version.id,
      segments: [{ startSec: 0.5, endSec: 2, text: 'Action' }],
    });
    const secret = await tokenFor(scenario.owner.id);
    signedOut();
    vi.stubEnv('OPENFRAME_ENABLE_AGENTS', 'true');
    vi.stubEnv('OPENFRAME_AGENT_MODEL', 'mock');

    const created = await callRoute(
      createV1AgentRun,
      apiRequest(`/api/v1/versions/${scenario.version.id}/agent-runs`, {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}` },
        body: { agentSlug: 'transcript-review' },
      }),
      { versionId: scenario.version.id }
    );
    expect(created.status).toBe(201);
    const { run } = await readData<{ run: { id: string } }>(created);

    await db.agentRun.update({
      where: { id: run.id },
      data: { status: 'RUNNING', attempts: 1 },
    });
    await executeAgentRun(run.id);

    const stored = await db.agentRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(stored.status).toBe('SUCCEEDED');

    const comments = await db.comment.findMany({
      where: { versionId: scenario.version.id },
      orderBy: { timestamp: 'asc' },
    });
    expect(comments).toHaveLength(2);
    expect(comments.every((comment) => comment.source === CommentSource.AGENT)).toBe(true);
    expect(comments.every((comment) => comment.authorId === null)).toBe(true);
    expect(comments.every((comment) => comment.agentRunId === run.id)).toBe(true);
    expect(comments[1]?.content).toContain('Action');

    const listed = await callRoute(
      listV1AgentRuns,
      apiRequest(`/api/v1/versions/${scenario.version.id}/agent-runs`, {
        headers: { authorization: `Bearer ${secret}` },
      }),
      { versionId: scenario.version.id }
    );
    expect(listed.status).toBe(200);
    const payload = await readData<{ runs: Array<{ id: string; status: string }> }>(listed);
    expect(payload.runs).toHaveLength(1);
    expect(payload.runs[0]?.id).toBe(run.id);
    expect(payload.runs[0]?.status).toBe('SUCCEEDED');
  });

  it('returns 404 for a token whose user cannot see the version', async () => {
    const scenario = await seedVersion();
    const stranger = await createUser();
    const secret = await tokenFor(stranger.id);
    signedOut();
    vi.stubEnv('OPENFRAME_ENABLE_AGENTS', 'true');

    const response = await callRoute(
      createV1AgentRun,
      apiRequest(`/api/v1/versions/${scenario.version.id}/agent-runs`, {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}` },
        body: {},
      }),
      { versionId: scenario.version.id }
    );
    expect(response.status).toBe(404);
    expect(await db.agentRun.count()).toBe(0);
  });

  it('returns 403 when agents are disabled', async () => {
    const scenario = await seedVersion();
    const secret = await tokenFor(scenario.owner.id);
    signedOut();
    vi.stubEnv('OPENFRAME_ENABLE_AGENTS', 'false');

    const response = await callRoute(
      createV1AgentRun,
      apiRequest(`/api/v1/versions/${scenario.version.id}/agent-runs`, {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}` },
        body: {},
      }),
      { versionId: scenario.version.id }
    );
    expect(response.status).toBe(403);
    expect(await db.agentRun.count()).toBe(0);
  });
});
