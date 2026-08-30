import { describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { GET as liveComments } from '@/app/api/versions/[versionId]/comments/live/route';
import { POST as createCommentRoute } from '@/app/api/versions/[versionId]/comments/route';
import {
  DELETE as deleteCommentRoute,
  PATCH as patchCommentRoute,
} from '@/app/api/comments/[commentId]/route';
import { POST as createV1Comment } from '@/app/api/v1/versions/[versionId]/comments/route';
import { PATCH as patchV1Comment } from '@/app/api/v1/comments/[commentId]/route';
import * as commentLive from '@/lib/comment-live';
import { generateApiToken } from '@/lib/api-token';
import { db } from '@/lib/db';
import { apiRequest, callRoute } from '../helpers/request';
import { signedInAs, signedOut } from '../helpers/session';
import { createComment, createUser, createVersion, createVideo, seedVersion } from '../factories';

function liveUrl(versionId: string): string {
  return `/api/versions/${versionId}/comments/live`;
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

async function mintApiToken(userId: string): Promise<string> {
  const token = generateApiToken();
  await db.apiToken.create({
    data: {
      userId,
      name: 'live-test',
      tokenHash: token.hash,
      tokenPrefix: token.prefix,
    },
  });
  return token.raw;
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

async function waitForCommentEvents(getBuffer: () => string, count = 1): Promise<unknown[]> {
  const started = Date.now();
  while (Date.now() - started < 4000) {
    const payloads = ssePayloads(getBuffer(), 'comments');
    if (payloads.length >= count) return payloads;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `timed out waiting for ${count} comments events; got ${getBuffer().slice(0, 400)}`
  );
}

async function waitForNeedle(getBuffer: () => string, needle: string, timeoutMs = 4000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (getBuffer().includes(needle)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `timed out waiting for ${JSON.stringify(needle)}; got ${getBuffer().slice(0, 400)}`
  );
}

async function waitForListenerCount(versionId: string, expected: number, timeoutMs = 4000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if ((await liveListenerCount(versionId)) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `timed out waiting for ${expected} live listeners on ${versionId}; last count ${await liveListenerCount(versionId)}`
  );
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
  return {
    getBuffer: () => acc,
    cancel: () => reader.cancel().catch(() => undefined),
  };
}

async function openOwnerStream(versionId: string) {
  const live = await callRoute(liveComments, apiRequest(liveUrl(versionId)), { versionId });
  expect(live.status).toBe(200);
  expect(live.headers.get('content-type')).toMatch(/text\/event-stream/);
  const stream = consumeSse(live);
  await waitForNeedle(stream.getBuffer, 'event: ready');
  expect(ssePayloads(stream.getBuffer(), 'comments')).toEqual([]);
  return stream;
}

describe('GET /api/versions/[versionId]/comments/live', () => {
  it('returns 403 to an anonymous caller on a PRIVATE project', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    signedOut();
    const connect = vi.spyOn(commentLive, 'connectCommentLiveListener');

    const response = await callRoute(liveComments, apiRequest(liveUrl(scenario.version.id)), {
      versionId: scenario.version.id,
    });

    expect(response.status).toBe(403);
    expect(connect).not.toHaveBeenCalled();
    expect(await liveListenerCount(scenario.version.id)).toBe(0);
    connect.mockRestore();
  });

  it('returns 403 to a signed-in stranger and does not open a stream', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    const stranger = await createUser();
    signedInAs(stranger);
    const connect = vi.spyOn(commentLive, 'connectCommentLiveListener');

    const response = await callRoute(liveComments, apiRequest(liveUrl(scenario.version.id)), {
      versionId: scenario.version.id,
    });

    expect(response.status).toBe(403);
    expect(response.headers.get('content-type')).not.toMatch(/text\/event-stream/);
    expect(connect).not.toHaveBeenCalled();
    expect(await liveListenerCount(scenario.version.id)).toBe(0);
    connect.mockRestore();
  });

  it('lets the owner open the stream and pushes an event when a comment is created', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    signedInAs(scenario.owner);
    const connect = vi.spyOn(commentLive, 'connectCommentLiveListener');

    const stream = await openOwnerStream(scenario.version.id);
    expect(connect).toHaveBeenCalledWith(scenario.version.id);
    connect.mockRestore();
    expect(await liveListenerCount(scenario.version.id)).toBeGreaterThanOrEqual(1);

    try {
      const created = await callRoute(
        createCommentRoute,
        apiRequest(`/api/versions/${scenario.version.id}/comments`, {
          body: { content: 'live note', timestamp: 1.5 },
        }),
        { versionId: scenario.version.id }
      );
      expect(created.status).toBe(201);

      expect(await waitForCommentEvents(stream.getBuffer)).toEqual([
        { versionId: scenario.version.id },
      ]);
    } finally {
      await stream.cancel();
    }
  });

  it('pushes an event when an existing comment is patched', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    const comment = await createComment({
      versionId: scenario.version.id,
      authorId: scenario.owner.id,
      content: 'original',
    });
    signedInAs(scenario.owner);
    const stream = await openOwnerStream(scenario.version.id);

    try {
      const patched = await callRoute(
        patchCommentRoute,
        apiRequest(`/api/comments/${comment.id}`, {
          method: 'PATCH',
          body: { content: 'edited live' },
        }),
        { commentId: comment.id }
      );
      expect(patched.status).toBe(200);

      expect(await waitForCommentEvents(stream.getBuffer)).toEqual([
        { versionId: scenario.version.id },
      ]);
    } finally {
      await stream.cancel();
    }
  });

  it('pushes an event when a comment is deleted', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    const comment = await createComment({
      versionId: scenario.version.id,
      authorId: scenario.owner.id,
      content: 'to delete',
    });
    signedInAs(scenario.owner);
    const stream = await openOwnerStream(scenario.version.id);

    try {
      const deleted = await callRoute(
        deleteCommentRoute,
        apiRequest(`/api/comments/${comment.id}`, { method: 'DELETE' }),
        { commentId: comment.id }
      );
      expect(deleted.status).toBe(200);

      expect(await waitForCommentEvents(stream.getBuffer)).toEqual([
        { versionId: scenario.version.id },
      ]);
    } finally {
      await stream.cancel();
    }
  });

  it('pushes an event when a v1 comment is created', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    const secret = await mintApiToken(scenario.owner.id);
    signedInAs(scenario.owner);
    const stream = await openOwnerStream(scenario.version.id);

    try {
      const created = await callRoute(
        createV1Comment,
        apiRequest(`/api/v1/versions/${scenario.version.id}/comments`, {
          method: 'POST',
          headers: { authorization: `Bearer ${secret}` },
          body: { content: 'From the panel', timestamp: 1.25 },
        }),
        { versionId: scenario.version.id }
      );
      expect(created.status).toBe(201);

      expect(await waitForCommentEvents(stream.getBuffer)).toEqual([
        { versionId: scenario.version.id },
      ]);
    } finally {
      await stream.cancel();
    }
  });

  it('pushes an event when a v1 comment is patched', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    const comment = await createComment({
      versionId: scenario.version.id,
      authorId: scenario.owner.id,
      content: 'original',
    });
    const secret = await mintApiToken(scenario.owner.id);
    signedInAs(scenario.owner);
    const stream = await openOwnerStream(scenario.version.id);

    try {
      const patched = await callRoute(
        patchV1Comment,
        apiRequest(`/api/v1/comments/${comment.id}`, {
          method: 'PATCH',
          headers: { authorization: `Bearer ${secret}` },
          body: { content: 'panel edit' },
        }),
        { commentId: comment.id }
      );
      expect(patched.status).toBe(200);

      expect(await waitForCommentEvents(stream.getBuffer)).toEqual([
        { versionId: scenario.version.id },
      ]);
    } finally {
      await stream.cancel();
    }
  });

  it('does not push events onto a different version stream', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    const otherVideo = await createVideo({ projectId: scenario.project.id });
    const otherVersion = await createVersion({ videoParentId: otherVideo.id });
    signedInAs(scenario.owner);

    const streamA = await openOwnerStream(scenario.version.id);
    const streamB = await openOwnerStream(otherVersion.id);

    try {
      const created = await callRoute(
        createCommentRoute,
        apiRequest(`/api/versions/${scenario.version.id}/comments`, {
          body: { content: 'only on A', timestamp: 1 },
        }),
        { versionId: scenario.version.id }
      );
      expect(created.status).toBe(201);

      expect(await waitForCommentEvents(streamA.getBuffer)).toEqual([
        { versionId: scenario.version.id },
      ]);
      expect(ssePayloads(streamB.getBuffer(), 'comments')).toEqual([]);
    } finally {
      await streamA.cancel();
      await streamB.cancel();
    }
  });

  it('drops the postgres listener when the stream is cancelled', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    signedInAs(scenario.owner);

    const stream = await openOwnerStream(scenario.version.id);
    expect(await liveListenerCount(scenario.version.id)).toBeGreaterThanOrEqual(1);

    await stream.cancel();
    await waitForListenerCount(scenario.version.id, 0);
  });

  it('does not push an event when creating a comment is refused', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    signedInAs(scenario.owner);
    const stream = await openOwnerStream(scenario.version.id);

    try {
      const refused = await callRoute(
        createCommentRoute,
        apiRequest(`/api/versions/${scenario.version.id}/comments`, {
          body: { content: '', timestamp: 1 },
        }),
        { versionId: scenario.version.id }
      );
      expect(refused.status).toBe(400);

      const created = await callRoute(
        createCommentRoute,
        apiRequest(`/api/versions/${scenario.version.id}/comments`, {
          body: { content: 'ok after refuse', timestamp: 1 },
        }),
        { versionId: scenario.version.id }
      );
      expect(created.status).toBe(201);

      expect(await waitForCommentEvents(stream.getBuffer, 1)).toEqual([
        { versionId: scenario.version.id },
      ]);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(ssePayloads(stream.getBuffer(), 'comments')).toHaveLength(1);
    } finally {
      await stream.cancel();
    }
  });

  it('pushes an event when a comment is resolved', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    const comment = await createComment({
      versionId: scenario.version.id,
      authorId: scenario.owner.id,
      content: 'needs a look',
    });
    signedInAs(scenario.owner);
    const stream = await openOwnerStream(scenario.version.id);

    try {
      const patched = await callRoute(
        patchCommentRoute,
        apiRequest(`/api/comments/${comment.id}`, {
          method: 'PATCH',
          body: { isResolved: true },
        }),
        { commentId: comment.id }
      );
      expect(patched.status).toBe(200);

      expect(await waitForCommentEvents(stream.getBuffer)).toEqual([
        { versionId: scenario.version.id },
      ]);
    } finally {
      await stream.cancel();
    }
  });

  it('pushes an event when a reply is created', async () => {
    const scenario = await seedVersion({ visibility: 'PRIVATE' });
    const parent = await createComment({
      versionId: scenario.version.id,
      authorId: scenario.owner.id,
      content: 'parent',
    });
    signedInAs(scenario.owner);
    const stream = await openOwnerStream(scenario.version.id);

    try {
      const created = await callRoute(
        createCommentRoute,
        apiRequest(`/api/versions/${scenario.version.id}/comments`, {
          body: { content: 'reply', timestamp: 1, parentId: parent.id },
        }),
        { versionId: scenario.version.id }
      );
      expect(created.status).toBe(201);

      expect(await waitForCommentEvents(stream.getBuffer)).toEqual([
        { versionId: scenario.version.id },
      ]);
    } finally {
      await stream.cancel();
    }
  });
});
