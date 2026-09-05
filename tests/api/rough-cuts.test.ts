import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { BUILTIN_BRIEF_TEMPLATES } from '@/lib/rough-cut/brief';
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
import {
  createEditorialBrief,
  createFolder,
  createReadyTranscript,
  createRoughCut,
  createRoughCutProfile,
  createUser,
  createVersion,
  createVideo,
  seedProject,
} from '../factories';
import { assembleDecisionList } from '@/lib/rough-cut/decision-list';
import { scheduleVersionTranscription } from '@/lib/transcription/schedule';

function cutsUrl(projectId: string) {
  return `/api/projects/${projectId}/rough-cuts`;
}

async function seedMulticam() {
  const scenario = await seedProject();
  const camA = await createVideo({
    projectId: scenario.project.id,
    title: 'ISO 1',
    metadata: { camera: 'A' },
    position: 0,
  });
  const camB = await createVideo({
    projectId: scenario.project.id,
    title: 'ISO 2',
    metadata: { camera: 'B' },
    position: 1,
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
          wideCameraRole: 'Interview',
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
    expect(snapshot.cameraRoles?.[scenario.camB.id]).toBe('WIDE');
    expect(snapshot.wideCameraRole).toBe('INTERVIEW');
    expect(await db.mediaJob.count({ where: { kind: 'ASSEMBLE_ROUGH_CUT' } })).toBe(1);
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

  it('returns 400 for a cameraRoles id that is not in the folder and writes no row', async () => {
    const scenario = await seedMulticam();
    signedInAs(scenario.owner);
    vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'true');

    const response = await callRoute(
      createRoughCutRoute,
      apiRequest(cutsUrl(scenario.project.id), {
        body: { folderId: null, cameraRoles: { 'not-a-video': 'A' } },
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

  // A sequential cut reads one transcript per clip, so every clip is ensured.
  // Multicam reads a single session transcript and is covered on its own below.
  it('starts a transcription for every sequential clip that has none and parks the run', async () => {
    const scenario = await seedMulticam();
    await createReadyTranscript({
      versionId: scenario.versionA.id,
      segments: [{ startSec: 0, endSec: 2, text: 'hello' }],
    });
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
      roughCut: { id: string; warnings: Array<{ code: string }> | null };
      transcripts: { ready: number; pending: number; enqueued: number; failed: number };
    }>(response);
    expect(payload.transcripts).toEqual({ ready: 1, pending: 1, enqueued: 1, failed: 0 });
    expect(payload.roughCut.warnings?.map((warning) => warning.code)).toEqual([
      'waiting-for-transcript',
    ]);

    const pending = await db.transcript.findMany({ where: { versionId: scenario.versionB.id } });
    expect(pending.map((row) => row.status)).toEqual(['PENDING']);
    const jobs = await db.mediaJob.findMany({ where: { versionId: scenario.versionB.id } });
    expect(jobs.map((job) => job.kind).sort()).toEqual(['EXTRACT_AUDIO', 'TRANSCRIBE']);
    expect(
      await db.mediaJob.count({ where: { versionId: scenario.versionA.id, kind: 'TRANSCRIBE' } })
    ).toBe(0);
    expect(vi.mocked(scheduleVersionTranscription)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(scheduleVersionTranscription).mock.calls[0]?.[0]).toBe(scenario.versionB.id);
  });

  it('ensures only the wide camera on a multicam cut', async () => {
    const scenario = await seedMulticam();
    await createReadyTranscript({
      versionId: scenario.versionA.id,
      segments: [{ startSec: 0, endSec: 2, text: 'hello' }],
    });
    signedInAs(scenario.owner);
    vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'true');

    // ISO 1 carries `camera: 'A'`, so naming A as the safety shot makes it the
    // camera whose transcript the assembler will read.
    const response = await callRoute(
      createRoughCutRoute,
      apiRequest(cutsUrl(scenario.project.id), {
        body: { folderId: null, layout: 'MULTICAM', wideCameraRole: 'A' },
      }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(201);
    const payload = await readData<{
      roughCut: { warnings: Array<{ code: string }> | null };
      transcripts: { ready: number; pending: number; enqueued: number; failed: number };
    }>(response);
    expect(payload.transcripts).toEqual({ ready: 1, pending: 0, enqueued: 0, failed: 0 });
    expect(payload.roughCut.warnings).toBeNull();

    expect(await db.transcript.count({ where: { versionId: scenario.versionB.id } })).toBe(0);
    expect(
      await db.mediaJob.count({
        where: { versionId: scenario.versionB.id, kind: { in: ['EXTRACT_AUDIO', 'TRANSCRIBE'] } },
      })
    ).toBe(0);
    expect(vi.mocked(scheduleVersionTranscription)).not.toHaveBeenCalled();
  });

  it('ensures the wide camera even when another angle already has a transcript', async () => {
    const scenario = await seedMulticam();
    await createReadyTranscript({
      versionId: scenario.versionB.id,
      segments: [{ startSec: 0, endSec: 2, text: 'hello' }],
    });
    signedInAs(scenario.owner);
    vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'true');

    const response = await callRoute(
      createRoughCutRoute,
      apiRequest(cutsUrl(scenario.project.id), {
        body: { folderId: null, layout: 'MULTICAM', wideCameraRole: 'A' },
      }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(201);
    const payload = await readData<{
      roughCut: { warnings: Array<{ code: string }> | null };
      transcripts: { ready: number; pending: number; enqueued: number; failed: number };
    }>(response);
    expect(payload.transcripts).toEqual({ ready: 0, pending: 1, enqueued: 1, failed: 0 });
    expect(payload.roughCut.warnings?.map((warning) => warning.code)).toEqual([
      'waiting-for-transcript',
    ]);

    const pending = await db.transcript.findMany({ where: { status: 'PENDING' } });
    expect(pending.map((row) => row.versionId)).toEqual([scenario.versionA.id]);
    expect(
      await db.mediaJob.count({
        where: { versionId: scenario.versionB.id, kind: { in: ['EXTRACT_AUDIO', 'TRANSCRIBE'] } },
      })
    ).toBe(0);
    expect(vi.mocked(scheduleVersionTranscription)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(scheduleVersionTranscription).mock.calls[0]?.[0]).toBe(scenario.versionA.id);
  });

  it('retries a FAILED transcript when a cut is requested', async () => {
    const scenario = await seedMulticam();
    for (const version of [scenario.versionA, scenario.versionB]) {
      await createReadyTranscript({
        versionId: version.id,
        // The route upserts on (versionId, 'und'), so a FAILED row in another
        // language would be left alone and a second row would appear instead.
        language: 'und',
        status: 'FAILED',
        segments: [],
      });
    }
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
    const rows = await db.transcript.findMany({
      where: { versionId: { in: [scenario.versionA.id, scenario.versionB.id] } },
      orderBy: { versionId: 'asc' },
    });
    expect(rows.map((row) => row.status)).toEqual(['PENDING', 'PENDING']);

    // A reset row with no jobs behind it would never be picked up again.
    for (const versionId of [scenario.versionA.id, scenario.versionB.id]) {
      const jobs = await db.mediaJob.findMany({ where: { versionId } });
      expect(jobs.filter((job) => job.kind === 'EXTRACT_AUDIO')).toHaveLength(1);
      expect(jobs.filter((job) => job.kind === 'TRANSCRIBE')).toHaveLength(1);
    }
    expect(vi.mocked(scheduleVersionTranscription)).toHaveBeenCalledTimes(2);
    expect(
      vi
        .mocked(scheduleVersionTranscription)
        .mock.calls.map((call) => call[0])
        .sort()
    ).toEqual([scenario.versionA.id, scenario.versionB.id].sort());
  });

  it('does not park the run when transcription is off for this host', async () => {
    const scenario = await seedMulticam();
    signedInAs(scenario.owner);
    vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'true');
    vi.stubEnv('OPENFRAME_ENABLE_TRANSCRIPTION', 'false');

    const response = await callRoute(
      createRoughCutRoute,
      apiRequest(cutsUrl(scenario.project.id), {
        body: { folderId: null, layout: 'SEQUENTIAL' },
      }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(201);
    const payload = await readData<{
      roughCut: { id: string; warnings: Array<{ code: string }> | null };
      transcripts: { ready: number; pending: number; enqueued: number; failed: number };
    }>(response);
    expect(payload.transcripts).toEqual({ ready: 0, pending: 0, enqueued: 0, failed: 2 });
    expect(payload.roughCut.warnings).toBeNull();
    expect(await db.transcript.count()).toBe(0);
    expect(vi.mocked(scheduleVersionTranscription)).not.toHaveBeenCalled();
  });

  it('ensures the wide camera when the wide role is the second camera in position order', async () => {
    const scenario = await seedMulticam();
    signedInAs(scenario.owner);
    vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'true');

    // ISO 2 carries `camera: 'B'` and sits second by position.
    const response = await callRoute(
      createRoughCutRoute,
      apiRequest(cutsUrl(scenario.project.id), {
        body: { folderId: null, layout: 'MULTICAM', wideCameraRole: 'B' },
      }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(201);
    const payload = await readData<{
      transcripts: { ready: number; pending: number; enqueued: number; failed: number };
    }>(response);
    expect(payload.transcripts).toEqual({ ready: 0, pending: 1, enqueued: 1, failed: 0 });

    const rows = await db.transcript.findMany({});
    expect(rows.map((row) => row.versionId)).toEqual([scenario.versionB.id]);
    expect(vi.mocked(scheduleVersionTranscription)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(scheduleVersionTranscription).mock.calls[0]?.[0]).toBe(scenario.versionB.id);
  });

  it('falls back to the first camera in position order when no camera holds the wide role', async () => {
    const scenario = await seedMulticam();
    signedInAs(scenario.owner);
    vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'true');

    // No camera is named WIDE, so pickWideClip infers the first clip by
    // position. The reversed clipOrder moves the cut's ordering but not the
    // positions the assembler ranks by, so the route must ignore it here.
    const response = await callRoute(
      createRoughCutRoute,
      apiRequest(cutsUrl(scenario.project.id), {
        body: {
          folderId: null,
          layout: 'MULTICAM',
          wideCameraRole: 'WIDE',
          clipOrder: [scenario.camB.id, scenario.camA.id],
        },
      }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(201);
    const payload = await readData<{
      transcripts: { ready: number; pending: number; enqueued: number; failed: number };
    }>(response);
    expect(payload.transcripts).toEqual({ ready: 0, pending: 1, enqueued: 1, failed: 0 });

    const rows = await db.transcript.findMany({});
    expect(rows.map((row) => row.versionId)).toEqual([scenario.versionA.id]);
    expect(vi.mocked(scheduleVersionTranscription)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(scheduleVersionTranscription).mock.calls[0]?.[0]).toBe(scenario.versionA.id);
  });

  it('stores a trimmed script and refuses one that is too long', async () => {
    const scenario = await seedMulticam();
    signedInAs(scenario.owner);
    vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'true');

    const refused = await callRoute(
      createRoughCutRoute,
      apiRequest(cutsUrl(scenario.project.id), {
        body: { folderId: null, script: 'x'.repeat(20_001) },
      }),
      { projectId: scenario.project.id }
    );
    expect(refused.status).toBe(400);
    expect(await db.roughCut.count()).toBe(0);

    const response = await callRoute(
      createRoughCutRoute,
      apiRequest(cutsUrl(scenario.project.id), {
        body: { folderId: null, script: '  We help founders raise faster.\n\n  ' },
      }),
      { projectId: scenario.project.id }
    );
    expect(response.status).toBe(201);
    const payload = await readData<{ roughCut: { id: string; hasScript: boolean } }>(response);
    expect(payload.roughCut.hasScript).toBe(true);
    const stored = await db.roughCut.findUniqueOrThrow({ where: { id: payload.roughCut.id } });
    expect(stored.script).toBe('We help founders raise faster.');

    const detail = await callRoute(
      getRoughCutRoute,
      apiRequest(`/api/rough-cuts/${payload.roughCut.id}`),
      { roughCutId: payload.roughCut.id }
    );
    const shown = await readData<{ roughCut: { script: string | null } }>(detail);
    expect(shown.roughCut.script).toBe('We help founders raise faster.');
  });
});

/** Two clips that look like nothing in particular: no timecode, no dates, same inferred role. */
async function seedWeakGuess(folderId: string | null = null) {
  const scenario = await seedProject();
  const first = await createVideo({ projectId: scenario.project.id, title: 'Take one', folderId });
  const second = await createVideo({ projectId: scenario.project.id, title: 'Take two', folderId });
  await createVersion({
    videoParentId: first.id,
    providerId: 'r2',
    originalUrl: '/api/upload/video/cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee.mp4',
  });
  await createVersion({
    videoParentId: second.id,
    providerId: 'r2',
    originalUrl: '/api/upload/video/dddddddd-bbbb-cccc-dddd-eeeeeeeeeeee.mp4',
  });
  return scenario;
}

describe('POST /api/projects/[projectId]/rough-cuts with an editorial brief', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('snapshots the folder’s brief, its source, and the technical override on the profile', async () => {
    const scenario = await seedMulticam();
    const brief = await createEditorialBrief({
      workspaceId: scenario.workspace.id,
      projectType: 'ASCENSORE',
      config: { technical: { minShotSeconds: 3 } },
    });
    const folder = await createFolder({
      projectId: scenario.project.id,
      editorialBriefId: brief.id,
    });
    await db.video.updateMany({
      where: { projectId: scenario.project.id },
      data: { folderId: folder.id },
    });
    signedInAs(scenario.owner);
    vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'true');

    const response = await callRoute(
      createRoughCutRoute,
      apiRequest(cutsUrl(scenario.project.id), {
        body: { folderId: folder.id, wideCameraRole: 'B' },
      }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(201);
    const payload = await readData<{ roughCut: { id: string; briefId: string | null } }>(response);
    expect(payload.roughCut.briefId).toBe(brief.id);
    const stored = await db.roughCut.findUniqueOrThrow({ where: { id: payload.roughCut.id } });
    expect(stored.briefId).toBe(brief.id);
    expect(stored.briefSnapshot).toEqual({
      version: 1,
      briefId: brief.id,
      source: 'folder',
      layoutSource: 'guess',
      brief: {
        ...BUILTIN_BRIEF_TEMPLATES.ASCENSORE,
        technical: { roughCutProfileId: null, minShotSeconds: 3 },
      },
      projectGuidelines: null,
    });
    // The brief's technical block beats the profile; dialog values still land on the snapshot.
    expect(stored.profileSnapshot).toMatchObject({ minShotSeconds: 3, wideCameraRole: 'B' });

    const fetched = await readData<{
      roughCut: { briefId: string | null; briefSnapshot: { source: string } | null };
    }>(
      await callRoute(getRoughCutRoute, apiRequest(`/api/rough-cuts/${stored.id}`), {
        roughCutId: stored.id,
      })
    );
    expect(fetched.roughCut.briefId).toBe(brief.id);
    expect(fetched.roughCut.briefSnapshot).toMatchObject({ source: 'folder' });
  });

  it('records the project’s editorial guidelines on the snapshot at run time', async () => {
    const scenario = await seedMulticam();
    await db.project.update({
      where: { id: scenario.project.id },
      data: { editorialGuidelines: 'Keep the founder’s origin story in full.' },
    });
    signedInAs(scenario.owner);
    vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'true');

    const response = await callRoute(
      createRoughCutRoute,
      apiRequest(cutsUrl(scenario.project.id), { body: { folderId: null } }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(201);
    const payload = await readData<{ roughCut: { id: string } }>(response);
    const stored = await db.roughCut.findUniqueOrThrow({ where: { id: payload.roughCut.id } });
    expect(stored.briefSnapshot).toMatchObject({
      source: 'builtin',
      projectGuidelines: 'Keep the founder’s origin story in full.',
    });

    // Later edits to the project do not rewrite what an existing run recorded.
    await db.project.update({
      where: { id: scenario.project.id },
      data: { editorialGuidelines: null },
    });
    const again = await db.roughCut.findUniqueOrThrow({ where: { id: payload.roughCut.id } });
    expect(again.briefSnapshot).toMatchObject({
      projectGuidelines: 'Keep the founder’s origin story in full.',
    });
  });

  it('a brief’s profile pointer picks the profile, and an explicit profileId still wins', async () => {
    const scenario = await seedMulticam();
    const pointed = await createRoughCutProfile({
      workspaceId: scenario.workspace.id,
      name: 'Pointed',
      minShotSeconds: 4,
    });
    const explicit = await createRoughCutProfile({
      workspaceId: scenario.workspace.id,
      name: 'Explicit',
      minShotSeconds: 5,
    });
    const brief = await createEditorialBrief({
      workspaceId: scenario.workspace.id,
      config: { technical: { roughCutProfileId: pointed.id } },
    });
    await db.project.update({
      where: { id: scenario.project.id },
      data: { editorialBriefId: brief.id },
    });
    signedInAs(scenario.owner);
    vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'true');

    const viaBrief = await callRoute(
      createRoughCutRoute,
      apiRequest(cutsUrl(scenario.project.id), { body: { folderId: null } }),
      { projectId: scenario.project.id }
    );
    expect(viaBrief.status).toBe(201);
    const first = await db.roughCut.findUniqueOrThrow({
      where: { id: (await readData<{ roughCut: { id: string } }>(viaBrief)).roughCut.id },
    });
    expect(first.profileId).toBe(pointed.id);
    expect(first.profileSnapshot).toMatchObject({ minShotSeconds: 4 });
    await db.roughCut.delete({ where: { id: first.id } });

    const viaDialog = await callRoute(
      createRoughCutRoute,
      apiRequest(cutsUrl(scenario.project.id), {
        body: { folderId: null, profileId: explicit.id },
      }),
      { projectId: scenario.project.id }
    );
    expect(viaDialog.status).toBe(201);
    const second = await db.roughCut.findUniqueOrThrow({
      where: { id: (await readData<{ roughCut: { id: string } }>(viaDialog)).roughCut.id },
    });
    expect(second.profileId).toBe(explicit.id);
    expect(second.profileSnapshot).toMatchObject({ minShotSeconds: 5 });
  });

  it('an explicit briefId wins over the folder binding; an unknown one is refused', async () => {
    const scenario = await seedMulticam();
    const bound = await createEditorialBrief({ workspaceId: scenario.workspace.id });
    const chosen = await createEditorialBrief({
      workspaceId: scenario.workspace.id,
      projectType: 'INTERVIEW',
    });
    const foreign = await createEditorialBrief({ workspaceId: (await seedProject()).workspace.id });
    const folder = await createFolder({
      projectId: scenario.project.id,
      editorialBriefId: bound.id,
    });
    await db.video.updateMany({
      where: { projectId: scenario.project.id },
      data: { folderId: folder.id },
    });
    signedInAs(scenario.owner);
    vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'true');

    const refused = await callRoute(
      createRoughCutRoute,
      apiRequest(cutsUrl(scenario.project.id), {
        body: { folderId: folder.id, briefId: foreign.id },
      }),
      { projectId: scenario.project.id }
    );
    expect(refused.status).toBe(400);
    expect(await db.roughCut.count()).toBe(0);

    const response = await callRoute(
      createRoughCutRoute,
      apiRequest(cutsUrl(scenario.project.id), {
        body: { folderId: folder.id, briefId: chosen.id },
      }),
      { projectId: scenario.project.id }
    );
    expect(response.status).toBe(201);
    const payload = await readData<{ roughCut: { id: string } }>(response);
    const stored = await db.roughCut.findUniqueOrThrow({ where: { id: payload.roughCut.id } });
    expect(stored.briefId).toBe(chosen.id);
    expect(stored.briefSnapshot).toMatchObject({ source: 'requested', briefId: chosen.id });
  });

  it('a root cut falls back to the project’s brief, then the workspace default, then the template', async () => {
    const scenario = await seedMulticam();
    signedInAs(scenario.owner);
    vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'true');
    const create = async () => {
      const response = await callRoute(
        createRoughCutRoute,
        apiRequest(cutsUrl(scenario.project.id), { body: { folderId: null } }),
        { projectId: scenario.project.id }
      );
      expect(response.status).toBe(201);
      const payload = await readData<{ roughCut: { id: string } }>(response);
      const stored = await db.roughCut.findUniqueOrThrow({ where: { id: payload.roughCut.id } });
      await db.roughCut.delete({ where: { id: stored.id } });
      return stored;
    };

    // Nothing bound: two synced cameras read as an interview, from the template.
    expect(await create()).toMatchObject({
      briefId: null,
      briefSnapshot: expect.objectContaining({
        source: 'builtin',
        brief: expect.objectContaining({ projectType: 'INTERVIEW' }),
      }),
    });

    // The other type's default is stored first, so keying defaults by the
    // first isDefault row rather than by type would pick the wrong brief.
    await createEditorialBrief({
      workspaceId: scenario.workspace.id,
      projectType: 'ASCENSORE',
      isDefault: true,
    });
    const workspaceDefault = await createEditorialBrief({
      workspaceId: scenario.workspace.id,
      projectType: 'INTERVIEW',
      isDefault: true,
    });
    expect(await create()).toMatchObject({
      briefId: workspaceDefault.id,
      briefSnapshot: expect.objectContaining({ source: 'workspace-default' }),
    });

    const projectBrief = await createEditorialBrief({ workspaceId: scenario.workspace.id });
    await db.project.update({
      where: { id: scenario.project.id },
      data: { editorialBriefId: projectBrief.id },
    });
    expect(await create()).toMatchObject({
      briefId: projectBrief.id,
      briefSnapshot: expect.objectContaining({ source: 'project' }),
    });
  });

  it('a requested projectType picks the template when nothing is bound, and an unknown one is refused', async () => {
    const scenario = await seedMulticam();
    signedInAs(scenario.owner);
    vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'true');

    const refused = await callRoute(
      createRoughCutRoute,
      apiRequest(cutsUrl(scenario.project.id), { body: { folderId: null, projectType: 'VLOG' } }),
      { projectId: scenario.project.id }
    );
    expect(refused.status).toBe(400);
    expect(await db.roughCut.count()).toBe(0);

    const response = await callRoute(
      createRoughCutRoute,
      apiRequest(cutsUrl(scenario.project.id), {
        body: { folderId: null, projectType: 'ascensore' },
      }),
      { projectId: scenario.project.id }
    );
    expect(response.status).toBe(201);
    const payload = await readData<{ roughCut: { id: string } }>(response);
    const stored = await db.roughCut.findUniqueOrThrow({ where: { id: payload.roughCut.id } });
    expect(stored.briefSnapshot).toMatchObject({
      source: 'builtin',
      brief: expect.objectContaining({ projectType: 'ASCENSORE' }),
    });
  });

  it('a weak layout guess follows the brief’s bias, and an explicit layout still wins', async () => {
    const scenario = await seedWeakGuess();
    const brief = await createEditorialBrief({
      workspaceId: scenario.workspace.id,
      projectType: 'TALKING_HEAD',
      config: { layoutBias: 'SEQUENTIAL' },
    });
    await db.project.update({
      where: { id: scenario.project.id },
      data: { editorialBriefId: brief.id },
    });
    signedInAs(scenario.owner);
    vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'true');

    const biased = await callRoute(
      createRoughCutRoute,
      apiRequest(cutsUrl(scenario.project.id), { body: { folderId: null } }),
      { projectId: scenario.project.id }
    );
    expect(biased.status).toBe(201);
    const first = await db.roughCut.findUniqueOrThrow({
      where: { id: (await readData<{ roughCut: { id: string } }>(biased)).roughCut.id },
    });
    expect(first.layout).toBe('SEQUENTIAL');
    expect(first.briefSnapshot).toMatchObject({ layoutSource: 'brief' });
    await db.roughCut.delete({ where: { id: first.id } });

    const explicit = await callRoute(
      createRoughCutRoute,
      apiRequest(cutsUrl(scenario.project.id), { body: { folderId: null, layout: 'MULTICAM' } }),
      { projectId: scenario.project.id }
    );
    expect(explicit.status).toBe(201);
    const second = await db.roughCut.findUniqueOrThrow({
      where: { id: (await readData<{ roughCut: { id: string } }>(explicit)).roughCut.id },
    });
    expect(second.layout).toBe('MULTICAM');
    expect(second.briefSnapshot).toMatchObject({ layoutSource: 'dialog' });
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

  it('lists cuts for the owner, flagging the script without sending it', async () => {
    const scenario = await seedProject();
    signedInAs(scenario.owner);
    const cut = await createRoughCut({
      projectId: scenario.project.id,
      requestedById: scenario.owner.id,
      script: 'We help founders raise faster.',
    });

    const payload = await readData<{
      roughCuts: Array<{ id: string; hasScript: boolean }>;
    }>(
      await callRoute(listRoughCuts, apiRequest(cutsUrl(scenario.project.id)), {
        projectId: scenario.project.id,
      })
    );
    expect(payload.roughCuts.map((row) => row.id)).toEqual([cut.id]);
    // The list flags the script; only the single-run GET carries the text.
    expect(payload.roughCuts[0]?.hasScript).toBe(true);
    expect(Object.keys(payload.roughCuts[0] ?? {})).not.toContain('script');
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

  it('exports placeholder markers always and cut islands only with ?cuts=1', async () => {
    const scenario = await seedProject();
    const video = await createVideo({ projectId: scenario.project.id, title: 'Cam A' });
    const version = await createVersion({
      videoParentId: video.id,
      providerId: 'r2',
      originalUrl: '/api/upload/video/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.mp4',
    });
    const decisions = sampleDecisions(video.id, version.id);
    const cut = await createRoughCut({
      projectId: scenario.project.id,
      requestedById: scenario.owner.id,
      status: 'READY',
      decisions: {
        ...decisions,
        cuts: [
          {
            key: `${version.id}:48-72`,
            sourceVersionId: version.id,
            inSeconds: 2,
            outSeconds: 3,
            reason: { code: 'DEAD_AIR', summary: '1.0s of dead air after the last word' },
            transcriptText: null,
          },
        ],
        markers: [
          {
            key: `${version.id}:INFOGRAPHIC:24`,
            kind: 'INFOGRAPHIC',
            timelineSeconds: 1,
            durationSeconds: 1,
            title: 'Infographic: KPI',
            reason: { code: 'MARKER_JARGON', summary: '“KPI” in “our KPI”' },
          },
        ],
      },
    });
    signedInAs(scenario.owner);

    const plain = await callRoute(
      downloadRoughCutRoute,
      apiRequest(`/api/rough-cuts/${cut.id}/download?format=xml`),
      { roughCutId: cut.id }
    );
    expect(plain.status).toBe(200);
    const plainBody = await plain.text();
    expect(plainBody).toContain('<name>Infographic: KPI</name>');
    expect(plainBody).not.toContain('Cut: 1.0s of dead air');

    const xmlWithCuts = await callRoute(
      downloadRoughCutRoute,
      apiRequest(`/api/rough-cuts/${cut.id}/download?format=xml&cuts=1`),
      { roughCutId: cut.id }
    );
    expect(xmlWithCuts.status).toBe(200);
    expect(await xmlWithCuts.text()).toContain(
      '<name>Cut: 1.0s of dead air after the last word</name>'
    );

    const withCuts = await callRoute(
      downloadRoughCutRoute,
      apiRequest(`/api/rough-cuts/${cut.id}/download?format=otio&cuts=1`),
      { roughCutId: cut.id }
    );
    expect(withCuts.status).toBe(200);
    const otio = JSON.parse(await withCuts.text()) as {
      tracks: { children: Array<{ markers?: Array<{ name: string; color: string }> }> };
    };
    expect(otio.tracks.children[0]?.markers?.map((marker) => [marker.name, marker.color])).toEqual([
      ['Infographic: KPI', 'BLUE'],
      ['Cut: 1.0s of dead air after the last word', 'RED'],
    ]);
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
