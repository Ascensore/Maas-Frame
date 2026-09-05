import { describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { GET as v1LiveComments } from '@/app/api/v1/versions/[versionId]/comments/live/route';
import { POST as createCommentRoute } from '@/app/api/versions/[versionId]/comments/route';
import * as commentLive from '@/lib/comment-live';
import { generateApiToken } from '@/lib/api-token';
import { db } from '@/lib/db';
import { apiRequest, callRoute } from '../helpers/request';
import { signedInAs, signedOut } from '../helpers/session';
import { createUser, seedVersion } from '../factories';

function liveUrl(versionId: string): string {
  return `/api/v1/versions/${versionId}/comments/live`;
}

async function mintApiToken(userId: string): Promise<string> {
  const token = generateApiToken();
  await db.apiToken.create({
    data: { userId, name: 'v1-live-test', tokenHash: token.hash, tokenPrefix: token.prefix },
  });
  return token.raw;
}

async function liveListenerCount(versionId: string): Promise<number> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const result = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1`,
      [`ofc-live:${versionId}`]
    );
    return result.rows[0]?.n ?? 0;
  } finally {
    await client.end();
  }
}

function ssePayloads(buffer: string, eventName: string): unknown[] {
  const payloads: unknown[] = [];
  for (const frame of buffer.split('\n\n')) {
    const lines = frame.trim().split('\n');
    if (!lines.includes(`event: ${eventName}`)) continue;
    const dataLine = lines.find((line) => line.startsWith('data: '));
    if (!dataLine) continue;
    payloads.push(JSON.parse(dataLine.slice('data: '.length)));
  }
  return payloads;
}

function consumeSse(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('live response had no body');
  const decoder = new TextDecoder();
  let acc = '';
  void (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (value) acc += decoder.decode(value, { stream: true });
      if (done) break;
    }
  })();
  return { getBuffer: () => acc, cancel: () => reader.cancel().catch(() => undefined) };
}

async function waitForListenerCount(versionId: string, expected: number, timeoutMs = 4000) {
  const started = Date.now();
  let last = -1;
  while (Date.now() - started < timeoutMs) {
    last = await liveListenerCount(versionId);
    if (last === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `timed out waiting for ${expected} live listeners on ${versionId}; last count ${last}`
  );
}

async function waitFor(check: () => boolean, describeFailure: () => string, timeoutMs = 4000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out: ${describeFailure()}`);
}

function bearer(token: string) {
  return { headers: { authorization: `Bearer ${token}` } };
}

describe('GET /api/v1/versions/[versionId]/comments/live', () => {
  it('refuses a caller with no session and no token, and opens no listener', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    signedOut();
    const connect = vi.spyOn(commentLive, 'connectCommentLiveListener');

    const response = await callRoute(v1LiveComments, apiRequest(liveUrl(scenario.version.id)), {
      versionId: scenario.version.id,
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).not.toMatch(/text\/event-stream/);
    expect(connect).not.toHaveBeenCalled();
    expect(await liveListenerCount(scenario.version.id)).toBe(0);
    connect.mockRestore();
  });

  it('refuses an invalid bearer token', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    signedOut();
    const response = await callRoute(
      v1LiveComments,
      apiRequest(liveUrl(scenario.version.id), bearer('of_live_not_a_real_token')),
      { versionId: scenario.version.id }
    );
    expect(response.status).toBe(401);
    expect(await liveListenerCount(scenario.version.id)).toBe(0);
  });

  it('hides a version from a valid token belonging to somebody else', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    const stranger = await createUser();
    const token = await mintApiToken(stranger.id);
    signedOut();
    const connect = vi.spyOn(commentLive, 'connectCommentLiveListener');

    const response = await callRoute(
      v1LiveComments,
      apiRequest(liveUrl(scenario.version.id), bearer(token)),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(404);
    expect(connect).not.toHaveBeenCalled();
    expect(await liveListenerCount(scenario.version.id)).toBe(0);
    connect.mockRestore();
  });

  it('streams to a bearer token that owns the project and pushes on a new comment', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    const token = await mintApiToken(scenario.owner.id);
    signedOut();

    const live = await callRoute(
      v1LiveComments,
      apiRequest(liveUrl(scenario.version.id), bearer(token)),
      { versionId: scenario.version.id }
    );
    expect(live.status).toBe(200);
    expect(live.headers.get('content-type')).toMatch(/text\/event-stream/);

    const stream = consumeSse(live);
    try {
      await waitFor(
        () => stream.getBuffer().includes('event: ready'),
        () => `no ready event; got ${stream.getBuffer().slice(0, 200)}`
      );
      // The panel needs to know whether this deployment can actually push, so it
      // can keep polling rather than trusting a stream that will stay silent.
      expect(ssePayloads(stream.getBuffer(), 'ready')).toEqual([
        { versionId: scenario.version.id, listening: true },
      ]);
      expect(ssePayloads(stream.getBuffer(), 'comments')).toEqual([]);

      signedInAs(scenario.owner);
      const created = await callRoute(
        createCommentRoute,
        apiRequest(`/api/versions/${scenario.version.id}/comments`, {
          body: { content: 'live note', timestamp: 1.5 },
        }),
        { versionId: scenario.version.id }
      );
      expect(created.status).toBe(201);

      await waitFor(
        () => ssePayloads(stream.getBuffer(), 'comments').length >= 1,
        () => `no comments event; got ${stream.getBuffer().slice(0, 400)}`
      );
      expect(ssePayloads(stream.getBuffer(), 'comments')).toEqual([
        { versionId: scenario.version.id },
      ]);
    } finally {
      await stream.cancel();
    }

    // Cancelling the stream must release the LISTEN connection: a leaked one per
    // panel is what exhausted the session pooler before.
    await waitForListenerCount(scenario.version.id, 0);
  });

  it('tells the panel when the deployment cannot push, instead of a silent stream', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    const token = await mintApiToken(scenario.owner.id);
    signedOut();
    // Vercel disables LISTEN; the stream still opens but never pushes, and the
    // panel has to keep polling. Saying so is the difference between a working
    // fallback and comments that silently stop arriving.
    const listen = vi.spyOn(commentLive, 'shouldListenForCommentLive').mockReturnValue(false);
    const connect = vi.spyOn(commentLive, 'connectCommentLiveListener');

    const live = await callRoute(
      v1LiveComments,
      apiRequest(liveUrl(scenario.version.id), bearer(token)),
      { versionId: scenario.version.id }
    );
    expect(live.status).toBe(200);
    expect(connect).not.toHaveBeenCalled();

    const stream = consumeSse(live);
    try {
      await waitFor(
        () => stream.getBuffer().includes('event: ready'),
        () => `no ready event; got ${stream.getBuffer().slice(0, 200)}`
      );
      expect(ssePayloads(stream.getBuffer(), 'ready')).toEqual([
        { versionId: scenario.version.id, listening: false },
      ]);
      expect(await liveListenerCount(scenario.version.id)).toBe(0);
    } finally {
      await stream.cancel();
      listen.mockRestore();
      connect.mockRestore();
    }
  });
});
