import { beforeEach, describe, expect, it } from 'vitest';
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { setGuestIdentityCookie } from '@/lib/guest-identity';
import { GET as getVideo } from '@/app/api/projects/[projectId]/videos/[videoId]/route';
import { PATCH as patchProject } from '@/app/api/projects/[projectId]/route';
import { GET as watchVideo } from '@/app/api/watch/[videoId]/route';
import { apiRequest, callRoute, readData } from '../helpers/request';
import { signedInAs, signedOut } from '../helpers/session';
import { addProjectMember, createUser, createVideo, seedProject, seedVersion } from '../factories';

function guestCookies(identityId: string): Record<string, string> {
  const carrier = NextResponse.json({});
  setGuestIdentityCookie(carrier, identityId);
  return {
    openframe_guest_identity: carrier.cookies.get('openframe_guest_identity')?.value ?? '',
  };
}

describe('review watermarks', () => {
  beforeEach(() => {
    signedOut();
  });

  it('returns 401 without a session and leaves watermarkReviews off', async () => {
    const scenario = await seedProject();

    const response = await callRoute(
      patchProject,
      apiRequest(`/api/projects/${scenario.project.id}`, {
        method: 'PATCH',
        body: { watermarkReviews: true },
      }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(401);
    expect(
      (await db.project.findUniqueOrThrow({ where: { id: scenario.project.id } })).watermarkReviews
    ).toBe(false);
  });

  it('returns 403 for a project COMMENTATOR and leaves watermarkReviews off', async () => {
    const scenario = await seedProject();
    const commentator = await createUser();
    await addProjectMember({
      projectId: scenario.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await callRoute(
      patchProject,
      apiRequest(`/api/projects/${scenario.project.id}`, {
        method: 'PATCH',
        body: { watermarkReviews: true },
      }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(403);
    expect(
      (await db.project.findUniqueOrThrow({ where: { id: scenario.project.id } })).watermarkReviews
    ).toBe(false);
  });

  it('lets an owner turn review watermarks on and labels the current viewer on GET video', async () => {
    const scenario = await seedProject({
      owner: { name: 'Ada Lovelace' },
    });
    const video = await createVideo({ projectId: scenario.project.id });
    const commentator = await createUser({ name: 'Charles Babbage' });
    await addProjectMember({
      projectId: scenario.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(scenario.owner);

    const patchResponse = await callRoute(
      patchProject,
      apiRequest(`/api/projects/${scenario.project.id}`, {
        method: 'PATCH',
        body: { watermarkReviews: true },
      }),
      { projectId: scenario.project.id }
    );

    expect(patchResponse.status).toBe(200);
    expect(
      (await db.project.findUniqueOrThrow({ where: { id: scenario.project.id } })).watermarkReviews
    ).toBe(true);

    signedInAs(commentator);
    const getResponse = await callRoute(
      getVideo,
      apiRequest(`/api/projects/${scenario.project.id}/videos/${video.id}`),
      { projectId: scenario.project.id, videoId: video.id }
    );

    expect(getResponse.status).toBe(200);
    const payload = await readData<{ reviewWatermark: string | null }>(getResponse);
    expect(payload.reviewWatermark).toBe(`Charles Babbage · ${commentator.email}`);
  });

  it('returns a null reviewWatermark when the project flag is off', async () => {
    const scenario = await seedProject({ owner: { name: 'Ada Lovelace' } });
    const video = await createVideo({ projectId: scenario.project.id });
    signedInAs(scenario.owner);

    const response = await callRoute(
      getVideo,
      apiRequest(`/api/projects/${scenario.project.id}/videos/${video.id}`),
      { projectId: scenario.project.id, videoId: video.id }
    );

    expect(response.status).toBe(200);
    const payload = await readData<{ reviewWatermark: string | null }>(response);
    expect(payload.reviewWatermark).toBeNull();
  });

  it('leaves watermarkReviews off when a name-only PATCH is sent', async () => {
    const scenario = await seedProject({ watermarkReviews: false });
    signedInAs(scenario.owner);

    const response = await callRoute(
      patchProject,
      apiRequest(`/api/projects/${scenario.project.id}`, {
        method: 'PATCH',
        body: { name: 'Unwatermarked rename' },
      }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(200);
    const stored = await db.project.findUniqueOrThrow({ where: { id: scenario.project.id } });
    expect(stored.name).toBe('Unwatermarked rename');
    expect(stored.watermarkReviews).toBe(false);
  });

  it('leaves watermarkReviews on when a name-only PATCH is sent', async () => {
    const scenario = await seedProject({ watermarkReviews: true });
    signedInAs(scenario.owner);

    const response = await callRoute(
      patchProject,
      apiRequest(`/api/projects/${scenario.project.id}`, {
        method: 'PATCH',
        body: { name: 'Still watermarked' },
      }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(200);
    const stored = await db.project.findUniqueOrThrow({ where: { id: scenario.project.id } });
    expect(stored.name).toBe('Still watermarked');
    expect(stored.watermarkReviews).toBe(true);
  });

  it('lets an owner turn review watermarks off', async () => {
    const scenario = await seedProject({ watermarkReviews: true });
    signedInAs(scenario.owner);

    const response = await callRoute(
      patchProject,
      apiRequest(`/api/projects/${scenario.project.id}`, {
        method: 'PATCH',
        body: { watermarkReviews: false },
      }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(200);
    expect(
      (await db.project.findUniqueOrThrow({ where: { id: scenario.project.id } })).watermarkReviews
    ).toBe(false);
  });

  it('returns a guest identity watermark on a PUBLIC watch when the project watermarks reviews', async () => {
    const scenario = await seedVersion({
      visibility: 'PUBLIC',
      watermarkReviews: true,
    });
    signedOut();

    const response = await callRoute(
      watchVideo,
      apiRequest(`/api/watch/${scenario.video.id}`, {
        cookies: guestCookies('abcdefghijklmnop'),
      }),
      { videoId: scenario.video.id }
    );

    expect(response.status).toBe(200);
    const payload = await readData<{ reviewWatermark: string | null }>(response);
    expect(payload.reviewWatermark).toBe('Guest abcdefgh');
  });

  it('returns a null reviewWatermark on a PUBLIC watch when the project flag is off', async () => {
    const scenario = await seedVersion({
      visibility: 'PUBLIC',
      watermarkReviews: false,
    });
    signedOut();

    const response = await callRoute(
      watchVideo,
      apiRequest(`/api/watch/${scenario.video.id}`, {
        cookies: guestCookies('abcdefghijklmnop'),
      }),
      { videoId: scenario.video.id }
    );

    expect(response.status).toBe(200);
    const payload = await readData<{ reviewWatermark: string | null }>(response);
    expect(payload.reviewWatermark).toBeNull();
  });
});
