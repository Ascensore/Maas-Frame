import { describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { POST as probe } from '@/app/api/projects/[projectId]/videos/probe/route';
import { PATCH as updateProject } from '@/app/api/projects/[projectId]/route';
import { apiRequest, callRoute } from '../helpers/request';
import { signedInAs, signedOut } from '../helpers/session';
import { createUser, createVideo, createVersion, seedProject } from '../factories';

async function source() {
  const scenario = await seedProject();
  const video = await createVideo({ projectId: scenario.project.id });
  const version = await createVersion({ videoParentId: video.id, providerId: 'r2' });
  return { ...scenario, video, version };
}

describe('edit metadata refresh', () => {
  it('rejects an anonymous caller without creating jobs', async () => {
    const s = await source();
    signedOut();
    const response = await callRoute(
      probe,
      apiRequest(`/api/projects/${s.project.id}/videos/probe`, {
        body: { videoIds: [s.video.id] },
      }),
      { projectId: s.project.id }
    );
    expect(response.status).toBe(401);
    expect(await db.mediaJob.count({ where: { versionId: s.version.id } })).toBe(0);
  });
  it('rejects a signed-in stranger without creating jobs', async () => {
    const s = await source();
    signedInAs(await createUser());
    const response = await callRoute(
      probe,
      apiRequest(`/api/projects/${s.project.id}/videos/probe`, {
        body: { videoIds: [s.video.id] },
      }),
      { projectId: s.project.id }
    );
    expect(response.status).toBe(403);
    expect(await db.mediaJob.count({ where: { versionId: s.version.id } })).toBe(0);
  });
  it('queues the newest original once, including concurrent requests, and retries a failed probe', async () => {
    const s = await source();
    signedInAs(s.owner);
    const latest = await createVersion({
      videoParentId: s.video.id,
      versionNumber: 2,
      providerId: 'r2',
    });
    const request = () =>
      callRoute(
        probe,
        apiRequest(`/api/projects/${s.project.id}/videos/probe`, {
          body: { videoIds: [s.video.id] },
        }),
        { projectId: s.project.id }
      );
    const responses = await Promise.all([request(), request()]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    const jobs = await db.mediaJob.findMany();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ versionId: latest.id, kind: 'PROBE_MEDIA', status: 'PENDING' });
    await db.mediaJob.update({ where: { id: jobs[0]!.id }, data: { status: 'FAILED' } });
    expect((await request()).status).toBe(200);
    expect(await db.mediaJob.count({ where: { versionId: latest.id, status: 'PENDING' } })).toBe(1);
    expect(await db.mediaJob.count({ where: { versionId: s.version.id } })).toBe(0);
  });
  it('refuses a mixed-project batch atomically', async () => {
    const s = await source();
    const foreign = await source();
    signedInAs(s.owner);
    expect(
      (
        await callRoute(
          probe,
          apiRequest(`/api/projects/${s.project.id}/videos/probe`, {
            body: { videoIds: [s.video.id, foreign.video.id] },
          }),
          { projectId: s.project.id }
        )
      ).status
    ).toBe(400);
    expect(await db.mediaJob.count()).toBe(0);
  });
});

describe('project script', () => {
  it('refuses anonymous and unauthorized edits without changing the script', async () => {
    const s = await seedProject();
    await db.project.update({
      where: { id: s.project.id },
      data: { editScript: 'Keep the original lines' },
    });
    const request = () =>
      callRoute(
        updateProject,
        apiRequest(`/api/projects/${s.project.id}`, {
          method: 'PATCH',
          body: { editScript: 'Replace everything' },
        }),
        { projectId: s.project.id }
      );
    signedOut();
    expect((await request()).status).toBe(401);
    expect((await db.project.findUniqueOrThrow({ where: { id: s.project.id } })).editScript).toBe(
      'Keep the original lines'
    );
    signedInAs(await createUser());
    expect((await request()).status).toBe(403);
    expect((await db.project.findUniqueOrThrow({ where: { id: s.project.id } })).editScript).toBe(
      'Keep the original lines'
    );
  });
  it('saves, preserves on unrelated updates, validates, and removes the shared script', async () => {
    const s = await seedProject();
    signedInAs(s.owner);
    const update = (body: unknown) =>
      callRoute(
        updateProject,
        apiRequest(`/api/projects/${s.project.id}`, { method: 'PATCH', body }),
        { projectId: s.project.id }
      );
    expect(
      (await update({ editScript: '  Opening line\nKeep the closing promise.  ' })).status
    ).toBe(200);
    expect((await update({ name: 'New title' })).status).toBe(200);
    expect((await update({ editScript: 'x'.repeat(50001) })).status).toBe(400);
    expect((await update({ editScript: { text: 'wrong type' } })).status).toBe(400);
    expect((await db.project.findUniqueOrThrow({ where: { id: s.project.id } })).editScript).toBe(
      'Opening line\nKeep the closing promise.'
    );
    expect((await update({ editScript: null })).status).toBe(200);
    expect(
      (await db.project.findUniqueOrThrow({ where: { id: s.project.id } })).editScript
    ).toBeNull();
  });
});
