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
    title: 'ISO 1',
    metadata: { camera: 'A' },
  });
  const camB = await createVideo({
    projectId: scenario.project.id,
    title: 'ISO 2',
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

function sampleDecisions(videoId: string, versionId: string) {
  return assembleDecisionList({
    edits: [
      {
        timelineStartSeconds: 0,
        timelineEndSeconds: 2,
        inSeconds: 0,
        outSeconds: 2,
        sourceVersionId: versionId,
        cameraRole: 'A',
        targetTrack: 1,
      },
    ],
    clips: [
      {
        videoId,
        versionId,
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
    fileNames: new Map([[versionId, '01-Cam A-v1.mp4']]),
    mediaPathPrefix: './media/',
    rate: { num: 24, den: 1, dropFrame: false },
  });
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
    expect(stored.layout).toBe('MULTICAM');
    expect(await db.mediaJob.count({ where: { kind: 'ASSEMBLE_ROUGH_CUT' } })).toBe(1);
    const job = await db.mediaJob.findFirstOrThrow({ where: { kind: 'ASSEMBLE_ROUGH_CUT' } });
    expect(job.payload).toEqual({ roughCutId: payload.roughCut.id });
  });

  it('creates a LINEAR cut for a single file-backed video', async () => {
    const scenario = await seedProject();
    const only = await createVideo({
      projectId: scenario.project.id,
      title: 'Interview',
    });
    await createVersion({
      videoParentId: only.id,
      providerId: 'r2',
      originalUrl: '/api/upload/video/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.mp4',
    });
    signedInAs(scenario.owner);
    vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'true');

    const response = await callRoute(
      createRoughCutRoute,
      apiRequest(cutsUrl(scenario.project.id), { body: { folderId: null } }),
      { projectId: scenario.project.id }
    );
    expect(response.status).toBe(201);
    const payload = await readData<{
      roughCut: { id: string };
      layout: string;
      guessedLayout: string;
    }>(response);
    expect(payload.layout).toBe('LINEAR');
    expect(payload.guessedLayout).toBe('LINEAR');
    const stored = await db.roughCut.findUniqueOrThrow({ where: { id: payload.roughCut.id } });
    expect(stored.layout).toBe('LINEAR');
    expect(stored.requestedById).toBe(scenario.owner.id);
    expect(await db.mediaJob.count({ where: { kind: 'ASSEMBLE_ROUGH_CUT' } })).toBe(1);
  });

  it('ignores Drive imports that have not finished copying into storage', async () => {
    const scenario = await seedProject();
    const pending = await createVideo({
      projectId: scenario.project.id,
      title: 'Still importing',
      metadata: {
        import_source: 'gdrive',
        import_file_id: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms',
        import_status: 'pending',
      },
    });
    await createVersion({
      videoParentId: pending.id,
      providerId: 'r2',
      originalUrl: '/api/upload/video/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.mp4',
    });
    signedInAs(scenario.owner);
    vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'true');

    const response = await callRoute(
      createRoughCutRoute,
      apiRequest(cutsUrl(scenario.project.id), { body: { folderId: null } }),
      { projectId: scenario.project.id }
    );
    expect(response.status).toBe(400);
    expect(await db.roughCut.count()).toBe(0);
    expect(await db.mediaJob.count({ where: { kind: 'ASSEMBLE_ROUGH_CUT' } })).toBe(0);
  });

  it('assembles ready file-backed clips and skips a pending Drive import in the same folder', async () => {
    const scenario = await seedProject();
    const ready = await createVideo({
      projectId: scenario.project.id,
      title: 'Interview',
    });
    await createVersion({
      videoParentId: ready.id,
      providerId: 'r2',
      originalUrl: '/api/upload/video/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.mp4',
    });
    const pending = await createVideo({
      projectId: scenario.project.id,
      title: 'Still importing',
      position: 1,
      metadata: {
        import_source: 'gdrive',
        import_file_id: '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms',
        import_status: 'pending',
      },
    });
    await createVersion({
      videoParentId: pending.id,
      providerId: 'r2',
      originalUrl: '/api/upload/video/bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee.mp4',
    });
    signedInAs(scenario.owner);
    vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'true');

    const mixed = await callRoute(
      createRoughCutRoute,
      apiRequest(cutsUrl(scenario.project.id), { body: { folderId: null } }),
      { projectId: scenario.project.id }
    );
    expect(mixed.status).toBe(201);
    const payload = await readData<{
      roughCut: { id: string };
      cameras: Array<{ videoId: string; title: string }>;
      layout: string;
    }>(mixed);
    expect(payload.layout).toBe('LINEAR');
    expect(payload.cameras.map((camera) => camera.videoId)).toEqual([ready.id]);
    expect(await db.roughCut.count()).toBe(1);
    expect(await db.mediaJob.count({ where: { kind: 'ASSEMBLE_ROUGH_CUT' } })).toBe(1);
  });

  it('returns 400 when MULTICAM is requested with a single video and writes no row', async () => {
    const scenario = await seedProject();
    const only = await createVideo({
      projectId: scenario.project.id,
      title: 'ISO 1',
      metadata: { camera: 'A' },
    });
    await createVersion({
      videoParentId: only.id,
      providerId: 'r2',
      originalUrl: '/api/upload/video/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.mp4',
    });
    signedInAs(scenario.owner);
    vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'true');

    const response = await callRoute(
      createRoughCutRoute,
      apiRequest(cutsUrl(scenario.project.id), { body: { folderId: null, layout: 'MULTICAM' } }),
      { projectId: scenario.project.id }
    );
    expect(response.status).toBe(400);
    expect(await db.roughCut.count()).toBe(0);
    expect(await db.mediaJob.count({ where: { kind: 'ASSEMBLE_ROUGH_CUT' } })).toBe(0);
  });

  it('guesses SEQUENTIAL from numbered filenames and stores that layout', async () => {
    const scenario = await seedProject();
    const second = await createVideo({
      projectId: scenario.project.id,
      title: 'Clip_002',
      position: 0,
    });
    const first = await createVideo({
      projectId: scenario.project.id,
      title: 'Clip_001',
      position: 1,
    });
    await createVersion({
      videoParentId: second.id,
      providerId: 'r2',
      originalUrl: '/api/upload/video/bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee.mp4',
    });
    await createVersion({
      videoParentId: first.id,
      providerId: 'r2',
      originalUrl: '/api/upload/video/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.mp4',
    });
    signedInAs(scenario.owner);
    vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'true');

    const response = await callRoute(
      createRoughCutRoute,
      apiRequest(cutsUrl(scenario.project.id), { body: { folderId: null } }),
      { projectId: scenario.project.id }
    );
    expect(response.status).toBe(201);
    const payload = await readData<{
      roughCut: { id: string };
      layout: string;
      guessedLayout: string;
      cameras: Array<{ videoId: string; title: string }>;
    }>(response);
    expect(payload.layout).toBe('SEQUENTIAL');
    expect(payload.guessedLayout).toBe('SEQUENTIAL');
    expect(payload.cameras.map((camera) => camera.title)).toEqual(['Clip_001', 'Clip_002']);
    const stored = await db.roughCut.findUniqueOrThrow({ where: { id: payload.roughCut.id } });
    expect(stored.layout).toBe('SEQUENTIAL');
    expect(await db.mediaJob.count({ where: { kind: 'ASSEMBLE_ROUGH_CUT' } })).toBe(1);
  });

  it('stores an explicit SEQUENTIAL layout even when cameras look like multicam', async () => {
    const scenario = await seedMulticam();
    signedInAs(scenario.owner);
    vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'true');

    const response = await callRoute(
      createRoughCutRoute,
      apiRequest(cutsUrl(scenario.project.id), {
        body: { folderId: null, layout: 'SEQUENTIAL' },
      }),
      { projectId: scenario.project.id }
    );
    expect(response.status).toBe(201);
    const payload = await readData<{
      roughCut: { id: string };
      layout: string;
      guessedLayout: string;
    }>(response);
    expect(payload.guessedLayout).toBe('MULTICAM');
    expect(payload.layout).toBe('SEQUENTIAL');
    const stored = await db.roughCut.findUniqueOrThrow({ where: { id: payload.roughCut.id } });
    expect(stored.layout).toBe('SEQUENTIAL');
    expect(await db.mediaJob.count({ where: { kind: 'ASSEMBLE_ROUGH_CUT' } })).toBe(1);
  });

  it('stores a manual clip order on the snapshot and returns cameras in that order', async () => {
    const scenario = await seedProject();
    const first = await createVideo({
      projectId: scenario.project.id,
      title: 'Clip_001',
      position: 0,
    });
    const second = await createVideo({
      projectId: scenario.project.id,
      title: 'Clip_002',
      position: 1,
    });
    await createVersion({
      videoParentId: first.id,
      providerId: 'r2',
      originalUrl: '/api/upload/video/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.mp4',
    });
    await createVersion({
      videoParentId: second.id,
      providerId: 'r2',
      originalUrl: '/api/upload/video/bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee.mp4',
    });
    signedInAs(scenario.owner);
    vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'true');

    const response = await callRoute(
      createRoughCutRoute,
      apiRequest(cutsUrl(scenario.project.id), {
        body: {
          folderId: null,
          layout: 'SEQUENTIAL',
          clipOrder: [second.id, first.id],
        },
      }),
      { projectId: scenario.project.id }
    );
    expect(response.status).toBe(201);
    const payload = await readData<{
      roughCut: { id: string };
      cameras: Array<{ videoId: string }>;
    }>(response);
    expect(payload.cameras.map((camera) => camera.videoId)).toEqual([second.id, first.id]);
    const stored = await db.roughCut.findUniqueOrThrow({ where: { id: payload.roughCut.id } });
    const snapshot = stored.profileSnapshot as { clipOrder?: string[] };
    expect(snapshot.clipOrder).toEqual([second.id, first.id]);
    expect(await db.mediaJob.count({ where: { kind: 'ASSEMBLE_ROUGH_CUT' } })).toBe(1);
  });

  it('stores camera names and the safety camera on a multicam cut', async () => {
    const scenario = await seedMulticam();
    signedInAs(scenario.owner);
    vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'true');

    const response = await callRoute(
      createRoughCutRoute,
      apiRequest(cutsUrl(scenario.project.id), {
        body: {
          folderId: null,
          layout: 'MULTICAM',
          cameraRoles: { [scenario.camA.id]: 'Interview', [scenario.camB.id]: 'Wide' },
          wideCameraRole: 'Wide',
        },
      }),
      { projectId: scenario.project.id }
    );
    expect(response.status).toBe(201);
    const payload = await readData<{
      roughCut: { id: string };
      cameras: Array<{ videoId: string; role: string }>;
    }>(response);
    const roles = Object.fromEntries(
      payload.cameras.map((camera) => [camera.videoId, camera.role])
    );
    expect(roles[scenario.camA.id]).toBe('INTERVIEW');
    expect(roles[scenario.camB.id]).toBe('WIDE');
    const stored = await db.roughCut.findUniqueOrThrow({ where: { id: payload.roughCut.id } });
    const snapshot = stored.profileSnapshot as {
      cameraRoles?: Record<string, string>;
      wideCameraRole?: string;
    };
    expect(snapshot.cameraRoles?.[scenario.camA.id]).toBe('INTERVIEW');
    expect(snapshot.wideCameraRole).toBe('WIDE');
  });

  it('returns 400 for a clipOrder id that is not in the folder and writes no row', async () => {
    const scenario = await seedMulticam();
    signedInAs(scenario.owner);
    vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'true');

    const response = await callRoute(
      createRoughCutRoute,
      apiRequest(cutsUrl(scenario.project.id), {
        body: { folderId: null, clipOrder: ['not-a-video'] },
      }),
      { projectId: scenario.project.id }
    );
    expect(response.status).toBe(400);
    expect(await db.roughCut.count()).toBe(0);
    expect(await db.mediaJob.count({ where: { kind: 'ASSEMBLE_ROUGH_CUT' } })).toBe(0);
  });

  it('returns 400 for an unknown layout and writes no row', async () => {
    const scenario = await seedMulticam();
    signedInAs(scenario.owner);
    vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'true');

    const response = await callRoute(
      createRoughCutRoute,
      apiRequest(cutsUrl(scenario.project.id), { body: { folderId: null, layout: 'stacked' } }),
      { projectId: scenario.project.id }
    );
    expect(response.status).toBe(400);
    expect(await db.roughCut.count()).toBe(0);
    expect(await db.mediaJob.count({ where: { kind: 'ASSEMBLE_ROUGH_CUT' } })).toBe(0);
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

  it('returns 409 when a cut is already pending', async () => {
    const scenario = await seedMulticam();
    signedInAs(scenario.owner);
    vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'true');
    await createRoughCut({
      projectId: scenario.project.id,
      requestedById: scenario.owner.id,
      status: 'PENDING',
    });

    const response = await callRoute(
      createRoughCutRoute,
      apiRequest(cutsUrl(scenario.project.id), { body: { folderId: null } }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(409);
    expect(await db.roughCut.count()).toBe(1);
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

  it('returns 403 to a signed-in stranger', async () => {
    const scenario = await seedProject();
    await createRoughCut({
      projectId: scenario.project.id,
      requestedById: scenario.owner.id,
    });
    const stranger = await createUser();
    signedInAs(stranger);

    const response = await callRoute(listRoughCuts, apiRequest(cutsUrl(scenario.project.id)), {
      projectId: scenario.project.id,
    });
    expect(response.status).toBe(403);
    expect(await db.roughCut.count()).toBe(1);
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

  it('returns the cut for the owner and reports whether decisions exist', async () => {
    const scenario = await seedProject();
    const video = await createVideo({ projectId: scenario.project.id, title: 'Cam A' });
    const version = await createVersion({
      videoParentId: video.id,
      providerId: 'r2',
      originalUrl: '/api/upload/video/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.mp4',
    });
    signedInAs(scenario.owner);

    const pending = await createRoughCut({
      projectId: scenario.project.id,
      requestedById: scenario.owner.id,
      status: 'PENDING',
    });
    const ready = await createRoughCut({
      projectId: scenario.project.id,
      requestedById: scenario.owner.id,
      status: 'READY',
      decisions: sampleDecisions(video.id, version.id),
    });

    const pendingResponse = await callRoute(
      getRoughCutRoute,
      apiRequest(`/api/rough-cuts/${pending.id}`),
      { roughCutId: pending.id }
    );
    expect(pendingResponse.status).toBe(200);
    const pendingPayload = await readData<{
      roughCut: { id: string; status: string; hasDecisions: boolean; outputVideoId: string | null };
    }>(pendingResponse);
    expect(pendingPayload.roughCut.id).toBe(pending.id);
    expect(pendingPayload.roughCut.status).toBe('PENDING');
    expect(pendingPayload.roughCut.hasDecisions).toBe(false);
    expect(pendingPayload.roughCut.outputVideoId).toBeNull();

    const readyResponse = await callRoute(
      getRoughCutRoute,
      apiRequest(`/api/rough-cuts/${ready.id}`),
      { roughCutId: ready.id }
    );
    expect(readyResponse.status).toBe(200);
    const readyPayload = await readData<{
      roughCut: { id: string; status: string; hasDecisions: boolean };
    }>(readyResponse);
    expect(readyPayload.roughCut.id).toBe(ready.id);
    expect(readyPayload.roughCut.status).toBe('READY');
    expect(readyPayload.roughCut.hasDecisions).toBe(true);

    expect(await db.roughCut.findUniqueOrThrow({ where: { id: pending.id } })).toMatchObject({
      status: 'PENDING',
      decisions: null,
    });
    expect(
      (await db.roughCut.findUniqueOrThrow({ where: { id: ready.id } })).decisions
    ).not.toBeNull();
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

  it('returns 403 to a signed-in stranger and leaves the row', async () => {
    const scenario = await seedProject();
    const cut = await createRoughCut({
      projectId: scenario.project.id,
      requestedById: scenario.owner.id,
    });
    const stranger = await createUser();
    signedInAs(stranger);

    const response = await callRoute(
      deleteRoughCutRoute,
      apiRequest(`/api/rough-cuts/${cut.id}`, { method: 'DELETE' }),
      { roughCutId: cut.id }
    );
    expect(response.status).toBe(403);
    expect(await db.roughCut.findUnique({ where: { id: cut.id } })).not.toBeNull();
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
    const cut = await createRoughCut({
      projectId: scenario.project.id,
      requestedById: scenario.owner.id,
      status: 'READY',
      decisions: sampleDecisions(video.id, version.id),
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

  it('returns an FCP7 .xml attachment when the cut is READY', async () => {
    const scenario = await seedProject();
    const video = await createVideo({ projectId: scenario.project.id, title: 'Cam A' });
    const version = await createVersion({
      videoParentId: video.id,
      providerId: 'r2',
      originalUrl: '/api/upload/video/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.mp4',
    });
    const cut = await createRoughCut({
      projectId: scenario.project.id,
      requestedById: scenario.owner.id,
      status: 'READY',
      decisions: sampleDecisions(video.id, version.id),
    });
    signedInAs(scenario.owner);

    const response = await callRoute(
      downloadRoughCutRoute,
      apiRequest(`/api/rough-cuts/${cut.id}/download?format=xml`),
      { roughCutId: cut.id }
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('.xml');
    const body = await response.text();
    expect(body).toContain('<xmeml version="5">');
    expect(body).toContain('file://localhost/./media/01-Cam%20A-v1.mp4');
  });

  it('returns 500 when READY decisions cannot be parsed and leaves the row', async () => {
    const scenario = await seedProject();
    const cut = await createRoughCut({
      projectId: scenario.project.id,
      requestedById: scenario.owner.id,
      status: 'READY',
      decisions: { version: 1, edits: [] },
    });
    signedInAs(scenario.owner);

    const response = await callRoute(
      downloadRoughCutRoute,
      apiRequest(`/api/rough-cuts/${cut.id}/download?format=otio`),
      { roughCutId: cut.id }
    );
    expect(response.status).toBe(500);
    const stored = await db.roughCut.findUniqueOrThrow({ where: { id: cut.id } });
    expect(stored.status).toBe('READY');
    expect(stored.decisions).toEqual({ version: 1, edits: [] });
  });

  it('returns 400 when the cut is not READY and leaves the row', async () => {
    const scenario = await seedProject();
    const cut = await createRoughCut({
      projectId: scenario.project.id,
      requestedById: scenario.owner.id,
      status: 'PENDING',
    });
    signedInAs(scenario.owner);

    const response = await callRoute(
      downloadRoughCutRoute,
      apiRequest(`/api/rough-cuts/${cut.id}/download?format=otio`),
      { roughCutId: cut.id }
    );
    expect(response.status).toBe(400);
    const stored = await db.roughCut.findUniqueOrThrow({ where: { id: cut.id } });
    expect(stored.status).toBe('PENDING');
  });
});
