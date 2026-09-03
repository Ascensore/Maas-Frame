import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import {
  GET as listRoughCuts,
  POST as createRoughCutRoute,
} from '@/app/api/projects/[projectId]/rough-cuts/route';
import {
  DELETE as deleteRoughCutRoute,
  GET as getRoughCutRoute,
} from '@/app/api/rough-cuts/[roughCutId]/route';
import { GET as downloadRoughCutRoute } from '@/app/api/rough-cuts/[roughCutId]/download/route';
import { apiRequest, callRoute, readData } from '../helpers/request';
import { signedInAs, signedOut } from '../helpers/session';
import { createRoughCut, createUser, createVideo, createVersion, seedProject } from '../factories';
import { assembleDecisionList } from '@/lib/rough-cut/decision-list';

function cutsUrl(projectId: string) {
  return `/api/projects/${projectId}/rough-cuts`;
}

async function seedMulticam() {
  const scenario = await seedProject();
  const camA = await createVideo({
    projectId: scenario.project.id,
    title: 'Cam A',
    metadata: { camera: 'A' },
  });
  const camB = await createVideo({
    projectId: scenario.project.id,
    title: 'Cam B',
    metadata: { camera: 'B' },
  });
  const versionA = await createVersion({
    videoParentId: camA.id,
    providerId: 'r2',
    providerVideoId: 'videos/cam-a.mp4',
    originalUrl: '/api/upload/video/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.mp4',
  });
  const versionB = await createVersion({
    videoParentId: camB.id,
    providerId: 'r2',
    providerVideoId: 'videos/cam-b.mp4',
    originalUrl: '/api/upload/video/bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee.mp4',
  });
  return { ...scenario, camA, camB, versionA, versionB };
}

describe('POST /api/projects/[projectId]/rough-cuts', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 401 to an anonymous caller and writes no row', async () => {
    const scenario = await seedMulticam();
    signedOut();
    vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'true');

    const response = await callRoute(
      createRoughCutRoute,
      apiRequest(cutsUrl(scenario.project.id), { body: { folderId: null } }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(401);
    expect(await db.roughCut.count()).toBe(0);
  });

  it('returns 403 to a signed-in stranger', async () => {
    const scenario = await seedMulticam();
    const stranger = await createUser();
    signedInAs(stranger);
    vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'true');

    const response = await callRoute(
      createRoughCutRoute,
      apiRequest(cutsUrl(scenario.project.id), { body: { folderId: null } }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(403);
    expect(await db.roughCut.count()).toBe(0);
  });

  it('enqueues a pending rough cut for the owner', async () => {
    const scenario = await seedMulticam();
    signedInAs(scenario.owner);
    vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'true');

    const response = await callRoute(
      createRoughCutRoute,
      apiRequest(cutsUrl(scenario.project.id), { body: { folderId: null } }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(201);
    const payload = await readData<{
      roughCut: { id: string; status: string };
      cameras: Array<{ role: string }>;
    }>(response);
    expect(payload.roughCut.status).toBe('PENDING');
    expect(payload.cameras.map((camera) => camera.role).sort()).toEqual(['A', 'B']);

    const stored = await db.roughCut.findUniqueOrThrow({ where: { id: payload.roughCut.id } });
    expect(stored.requestedById).toBe(scenario.owner.id);
    expect(stored.projectId).toBe(scenario.project.id);
    expect(await db.mediaJob.count({ where: { kind: 'ASSEMBLE_ROUGH_CUT' } })).toBe(1);
  });

  it('returns 403 when the feature flag is off and writes no row', async () => {
    const scenario = await seedMulticam();
    signedInAs(scenario.owner);
    vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'false');

    const response = await callRoute(
      createRoughCutRoute,
      apiRequest(cutsUrl(scenario.project.id), { body: { folderId: null } }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(403);
    expect(await db.roughCut.count()).toBe(0);
  });

  it('returns 409 when a cut is already running', async () => {
    const scenario = await seedMulticam();
    signedInAs(scenario.owner);
    vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'true');
    await createRoughCut({
      projectId: scenario.project.id,
      requestedById: scenario.owner.id,
      status: 'RUNNING',
    });

    const response = await callRoute(
      createRoughCutRoute,
      apiRequest(cutsUrl(scenario.project.id), { body: { folderId: null } }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(409);
    expect(await db.roughCut.count()).toBe(1);
  });
});

describe('GET /api/projects/[projectId]/rough-cuts', () => {
  it('returns 401 to an anonymous caller', async () => {
    const scenario = await seedProject();
    signedOut();
    const response = await callRoute(listRoughCuts, apiRequest(cutsUrl(scenario.project.id)), {
      projectId: scenario.project.id,
    });
    expect(response.status).toBe(401);
  });

  it('lists cuts for the owner', async () => {
    const scenario = await seedProject();
    signedInAs(scenario.owner);
    const cut = await createRoughCut({
      projectId: scenario.project.id,
      requestedById: scenario.owner.id,
    });

    const payload = await readData<{ roughCuts: Array<{ id: string }> }>(
      await callRoute(listRoughCuts, apiRequest(cutsUrl(scenario.project.id)), {
        projectId: scenario.project.id,
      })
    );
    expect(payload.roughCuts.map((row) => row.id)).toEqual([cut.id]);
  });
});

describe('GET /api/rough-cuts/[roughCutId]', () => {
  it('returns 401 to an anonymous caller', async () => {
    const scenario = await seedProject();
    const cut = await createRoughCut({
      projectId: scenario.project.id,
      requestedById: scenario.owner.id,
    });
    signedOut();

    const response = await callRoute(getRoughCutRoute, apiRequest(`/api/rough-cuts/${cut.id}`), {
      roughCutId: cut.id,
    });
    expect(response.status).toBe(401);
    expect(await db.roughCut.findUnique({ where: { id: cut.id } })).not.toBeNull();
  });

  it('returns 403 to a signed-in stranger and leaves the row', async () => {
    const scenario = await seedProject();
    const cut = await createRoughCut({
      projectId: scenario.project.id,
      requestedById: scenario.owner.id,
    });
    const stranger = await createUser();
    signedInAs(stranger);

    const response = await callRoute(getRoughCutRoute, apiRequest(`/api/rough-cuts/${cut.id}`), {
      roughCutId: cut.id,
    });
    expect(response.status).toBe(403);
    expect(await db.roughCut.count()).toBe(1);
  });
});

describe('DELETE /api/rough-cuts/[roughCutId]', () => {
  it('returns 401 to an anonymous caller and leaves the row', async () => {
    const scenario = await seedProject();
    const cut = await createRoughCut({
      projectId: scenario.project.id,
      requestedById: scenario.owner.id,
    });
    signedOut();

    const response = await callRoute(
      deleteRoughCutRoute,
      apiRequest(`/api/rough-cuts/${cut.id}`, { method: 'DELETE' }),
      { roughCutId: cut.id }
    );
    expect(response.status).toBe(401);
    expect(await db.roughCut.findUnique({ where: { id: cut.id } })).not.toBeNull();
  });

  it('deletes the row for the owner', async () => {
    const scenario = await seedProject();
    const cut = await createRoughCut({
      projectId: scenario.project.id,
      requestedById: scenario.owner.id,
    });
    signedInAs(scenario.owner);

    const response = await callRoute(
      deleteRoughCutRoute,
      apiRequest(`/api/rough-cuts/${cut.id}`, { method: 'DELETE' }),
      { roughCutId: cut.id }
    );
    expect(response.status).toBe(200);
    expect(await db.roughCut.findUnique({ where: { id: cut.id } })).toBeNull();
  });
});

describe('GET /api/rough-cuts/[roughCutId]/download', () => {
  it('returns 401 to an anonymous caller', async () => {
    const scenario = await seedProject();
    const cut = await createRoughCut({
      projectId: scenario.project.id,
      requestedById: scenario.owner.id,
      status: 'READY',
    });
    signedOut();

    const response = await callRoute(
      downloadRoughCutRoute,
      apiRequest(`/api/rough-cuts/${cut.id}/download?format=otio`),
      { roughCutId: cut.id }
    );
    expect(response.status).toBe(401);
  });

  it('returns 403 to a signed-in stranger', async () => {
    const scenario = await seedProject();
    const cut = await createRoughCut({
      projectId: scenario.project.id,
      requestedById: scenario.owner.id,
      status: 'READY',
    });
    const stranger = await createUser();
    signedInAs(stranger);

    const response = await callRoute(
      downloadRoughCutRoute,
      apiRequest(`/api/rough-cuts/${cut.id}/download?format=otio`),
      { roughCutId: cut.id }
    );
    expect(response.status).toBe(403);
  });

  it('returns a .otio attachment when the cut is READY', async () => {
    const scenario = await seedProject();
    const video = await createVideo({ projectId: scenario.project.id, title: 'Cam A' });
    const version = await createVersion({
      videoParentId: video.id,
      providerId: 'r2',
      originalUrl: '/api/upload/video/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.mp4',
    });
    const decisions = assembleDecisionList({
      edits: [
        {
          timelineStartSeconds: 0,
          timelineEndSeconds: 2,
          inSeconds: 0,
          outSeconds: 2,
          sourceVersionId: version.id,
          cameraRole: 'A',
          targetTrack: 1,
        },
      ],
      clips: [
        {
          videoId: video.id,
          versionId: version.id,
          title: 'Cam A',
          role: 'A',
          position: 0,
          offsetSeconds: 0,
          durationSeconds: 10,
          frameRateNum: 24,
          frameRateDen: 1,
          dropFrame: false,
          startTimecode: null,
          originalUrl: '/api/upload/video/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.mp4',
          versionNumber: 1,
          versionLabel: null,
        },
      ],
      fileNames: new Map([[version.id, '01-Cam A-v1.mp4']]),
      mediaPathPrefix: './media/',
      rate: { num: 24, den: 1, dropFrame: false },
    });
    const cut = await createRoughCut({
      projectId: scenario.project.id,
      requestedById: scenario.owner.id,
      status: 'READY',
      decisions,
    });
    signedInAs(scenario.owner);

    const response = await callRoute(
      downloadRoughCutRoute,
      apiRequest(`/api/rough-cuts/${cut.id}/download?format=otio`),
      { roughCutId: cut.id }
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('.otio');
    const body = await response.text();
    expect(body).toContain('"OTIO_SCHEMA": "Timeline.1"');
    expect(body).toContain('./media/01-Cam A-v1.mp4');
  });
});
