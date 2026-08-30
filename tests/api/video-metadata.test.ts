import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import {
  GET as getVideo,
  PATCH as patchVideo,
} from '@/app/api/projects/[projectId]/videos/[videoId]/route';
import { apiRequest, callRoute, readData } from '../helpers/request';
import { signedInAs, signedOut } from '../helpers/session';
import { addProjectMember, createUser, createVideo, seedProject } from '../factories';

function videoUrl(projectId: string, videoId: string): string {
  return `/api/projects/${projectId}/videos/${videoId}`;
}

describe('video custom metadata', () => {
  beforeEach(() => {
    signedOut();
  });

  it('returns 401 without a session', async () => {
    const scenario = await seedProject();
    const video = await createVideo({ projectId: scenario.project.id });

    const response = await callRoute(
      patchVideo,
      apiRequest(videoUrl(scenario.project.id, video.id), {
        method: 'PATCH',
        body: { metadata: { Scene: '12A' } },
      }),
      { projectId: scenario.project.id, videoId: video.id }
    );

    expect(response.status).toBe(401);
    expect((await db.video.findUniqueOrThrow({ where: { id: video.id } })).metadata).toEqual({});
  });

  it('returns 403 for a project COMMENTATOR and leaves metadata empty', async () => {
    const scenario = await seedProject();
    const video = await createVideo({ projectId: scenario.project.id });
    const commentator = await createUser();
    await addProjectMember({
      projectId: scenario.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await callRoute(
      patchVideo,
      apiRequest(videoUrl(scenario.project.id, video.id), {
        method: 'PATCH',
        body: { metadata: { Scene: '12A' } },
      }),
      { projectId: scenario.project.id, videoId: video.id }
    );

    expect(response.status).toBe(403);
    expect((await db.video.findUniqueOrThrow({ where: { id: video.id } })).metadata).toEqual({});
  });

  it('stores the trimmed fields, not the raw body', async () => {
    const scenario = await seedProject();
    const video = await createVideo({ projectId: scenario.project.id });
    signedInAs(scenario.owner);

    const response = await callRoute(
      patchVideo,
      apiRequest(videoUrl(scenario.project.id, video.id), {
        method: 'PATCH',
        body: { metadata: { '  Scene  ': '  12A  ' } },
      }),
      { projectId: scenario.project.id, videoId: video.id }
    );

    expect(response.status).toBe(200);
    expect((await db.video.findUniqueOrThrow({ where: { id: video.id } })).metadata).toEqual({
      Scene: '12A',
    });
  });

  it('leaves metadata alone when the patch only changes the title', async () => {
    const scenario = await seedProject();
    const video = await createVideo({
      projectId: scenario.project.id,
      metadata: { Scene: '12A' },
    });
    signedInAs(scenario.owner);

    const response = await callRoute(
      patchVideo,
      apiRequest(videoUrl(scenario.project.id, video.id), {
        method: 'PATCH',
        body: { title: 'Renamed cut' },
      }),
      { projectId: scenario.project.id, videoId: video.id }
    );

    expect(response.status).toBe(200);
    const row = await db.video.findUniqueOrThrow({ where: { id: video.id } });
    expect(row.title).toBe('Renamed cut');
    expect(row.metadata).toEqual({ Scene: '12A' });
  });

  it('lets the owner replace metadata and returns it on GET', async () => {
    const scenario = await seedProject();
    const video = await createVideo({ projectId: scenario.project.id });
    signedInAs(scenario.owner);

    const patchResponse = await callRoute(
      patchVideo,
      apiRequest(videoUrl(scenario.project.id, video.id), {
        method: 'PATCH',
        body: { metadata: { Scene: '12A', Take: '3' } },
      }),
      { projectId: scenario.project.id, videoId: video.id }
    );

    expect(patchResponse.status).toBe(200);
    expect((await db.video.findUniqueOrThrow({ where: { id: video.id } })).metadata).toEqual({
      Scene: '12A',
      Take: '3',
    });

    const getResponse = await callRoute(
      getVideo,
      apiRequest(videoUrl(scenario.project.id, video.id)),
      { projectId: scenario.project.id, videoId: video.id }
    );
    const payload = await readData<{ metadata: Record<string, string> }>(getResponse);
    expect(payload.metadata).toEqual({ Scene: '12A', Take: '3' });
  });

  it('refuses nested metadata and does not write the row', async () => {
    const scenario = await seedProject();
    const video = await createVideo({
      projectId: scenario.project.id,
      metadata: { Scene: 'kept' },
    });
    signedInAs(scenario.owner);

    const response = await callRoute(
      patchVideo,
      apiRequest(videoUrl(scenario.project.id, video.id), {
        method: 'PATCH',
        body: { metadata: { Scene: { nested: true } } },
      }),
      { projectId: scenario.project.id, videoId: video.id }
    );

    expect(response.status).toBe(400);
    expect((await db.video.findUniqueOrThrow({ where: { id: video.id } })).metadata).toEqual({
      Scene: 'kept',
    });
  });

  it('clears metadata when the owner sends an empty object', async () => {
    const scenario = await seedProject();
    const video = await createVideo({
      projectId: scenario.project.id,
      metadata: { Scene: '12A' },
    });
    signedInAs(scenario.owner);

    const response = await callRoute(
      patchVideo,
      apiRequest(videoUrl(scenario.project.id, video.id), {
        method: 'PATCH',
        body: { metadata: {} },
      }),
      { projectId: scenario.project.id, videoId: video.id }
    );

    expect(response.status).toBe(200);
    expect((await db.video.findUniqueOrThrow({ where: { id: video.id } })).metadata).toEqual({});
  });
});
