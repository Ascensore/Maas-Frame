import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { hashC2cToken } from '@/lib/c2c-token';
import { hashApiToken } from '@/lib/api-token';
import {
  GET as listConnections,
  POST as createConnection,
} from '@/app/api/projects/[projectId]/c2c-connections/route';
import { DELETE as revokeConnection } from '@/app/api/projects/[projectId]/c2c-connections/[connectionId]/route';
import { POST as c2cR2Init } from '@/app/api/c2c/r2-init/route';
import { POST as c2cR2Complete } from '@/app/api/c2c/r2-complete/route';
import { POST as c2cCreateVideo } from '@/app/api/c2c/videos/route';
import { TranscriptStatus } from '@prisma/client';
import { scheduleVersionTranscription } from '@/lib/transcription/schedule';
import { apiRequest, callRoute, readData } from '../helpers/request';
import { signedInAs, signedOut } from '../helpers/session';
import { addProjectMember, createFolder, createUser, seedProject } from '../factories';

function enableS3VideoUploads(): void {
  vi.stubEnv('OPENFRAME_ENABLE_S3_VIDEO_UPLOADS', 'true');
  vi.stubEnv('OPENFRAME_ENABLE_BUNNY_UPLOADS', 'false');
  vi.stubEnv('R2_ACCESS_KEY_ID', 'test-access-key');
  vi.stubEnv('R2_SECRET_ACCESS_KEY', 'test-secret-key');
  vi.stubEnv('R2_BUCKET_NAME', 'openframe-test');
  vi.stubEnv('R2_ACCOUNT_ID', 'test-account');
}

function connectionsUrl(projectId: string): string {
  return `/api/projects/${projectId}/c2c-connections`;
}

describe('C2C ingest connections', () => {
  beforeEach(() => {
    signedOut();
  });

  it('returns 401 without a session and creates no row', async () => {
    const scenario = await seedProject();

    const response = await callRoute(
      createConnection,
      apiRequest(connectionsUrl(scenario.project.id), {
        method: 'POST',
        body: { name: 'Unit 1' },
      }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(401);
    expect(await db.c2cConnection.count()).toBe(0);
  });

  it('returns 401 listing connections without a session', async () => {
    const scenario = await seedProject();

    const response = await callRoute(
      listConnections,
      apiRequest(connectionsUrl(scenario.project.id)),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(401);
  });

  it('rejects an empty connection name', async () => {
    const scenario = await seedProject();
    signedInAs(scenario.owner);

    const response = await callRoute(
      createConnection,
      apiRequest(connectionsUrl(scenario.project.id), {
        method: 'POST',
        body: { name: '   ' },
      }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(400);
    expect(await db.c2cConnection.count()).toBe(0);
  });

  it('returns 403 for a project COMMENTATOR and creates no row', async () => {
    const scenario = await seedProject();
    const commentator = await createUser();
    await addProjectMember({
      projectId: scenario.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await callRoute(
      createConnection,
      apiRequest(connectionsUrl(scenario.project.id), {
        method: 'POST',
        body: { name: 'Unit 1' },
      }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(403);
    expect(await db.c2cConnection.count()).toBe(0);
  });

  it('lets an owner mint a secret once and lists only the prefix', async () => {
    const scenario = await seedProject();
    signedInAs(scenario.owner);

    const created = await callRoute(
      createConnection,
      apiRequest(connectionsUrl(scenario.project.id), {
        method: 'POST',
        body: { name: 'Unit 1' },
      }),
      { projectId: scenario.project.id }
    );

    expect(created.status).toBe(201);
    const payload = await readData<{
      connection: { id: string; secret: string; tokenPrefix: string; folderId: string | null };
    }>(created);
    expect(payload.connection.secret.startsWith('of_c2c_')).toBe(true);
    expect(payload.connection.folderId).toBeNull();
    expect(
      (await db.c2cConnection.findUniqueOrThrow({ where: { id: payload.connection.id } })).tokenHash
    ).toBe(hashC2cToken(payload.connection.secret));

    const listed = await callRoute(
      listConnections,
      apiRequest(connectionsUrl(scenario.project.id)),
      { projectId: scenario.project.id }
    );
    const listedData = await readData<{
      connections: Array<{ id: string; tokenPrefix: string; secret?: string }>;
    }>(listed);
    expect(listedData.connections).toHaveLength(1);
    expect(listedData.connections[0].tokenPrefix).toBe(payload.connection.tokenPrefix);
    expect(listedData.connections[0].secret).toBeUndefined();
  });

  it('refuses a folder from another project', async () => {
    const scenario = await seedProject();
    const other = await seedProject();
    const foreignFolder = await createFolder({ projectId: other.project.id });
    signedInAs(scenario.owner);

    const response = await callRoute(
      createConnection,
      apiRequest(connectionsUrl(scenario.project.id), {
        method: 'POST',
        body: { name: 'Wrong folder', folderId: foreignFolder.id },
      }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(400);
    expect(await db.c2cConnection.count()).toBe(0);
  });

  it('returns 403 when a COMMENTATOR tries to revoke a connection', async () => {
    const scenario = await seedProject();
    signedInAs(scenario.owner);
    const created = await readData<{ connection: { id: string } }>(
      await callRoute(
        createConnection,
        apiRequest(connectionsUrl(scenario.project.id), {
          method: 'POST',
          body: { name: 'Unit 1' },
        }),
        { projectId: scenario.project.id }
      )
    );

    const commentator = await createUser();
    await addProjectMember({
      projectId: scenario.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await callRoute(
      revokeConnection,
      apiRequest(`${connectionsUrl(scenario.project.id)}/${created.connection.id}`, {
        method: 'DELETE',
      }),
      { projectId: scenario.project.id, connectionId: created.connection.id }
    );

    expect(response.status).toBe(403);
    expect(
      (await db.c2cConnection.findUniqueOrThrow({ where: { id: created.connection.id } })).revokedAt
    ).toBeNull();
  });

  it('lets an owner revoke a connection so ingest tokens stop working', async () => {
    enableS3VideoUploads();
    const scenario = await seedProject();
    signedInAs(scenario.owner);

    const created = await readData<{ connection: { id: string; secret: string } }>(
      await callRoute(
        createConnection,
        apiRequest(connectionsUrl(scenario.project.id), {
          method: 'POST',
          body: { name: 'Unit 1' },
        }),
        { projectId: scenario.project.id }
      )
    );

    const revoked = await callRoute(
      revokeConnection,
      apiRequest(`${connectionsUrl(scenario.project.id)}/${created.connection.id}`, {
        method: 'DELETE',
      }),
      { projectId: scenario.project.id, connectionId: created.connection.id }
    );
    expect(revoked.status).toBe(200);
    expect(
      (await db.c2cConnection.findUniqueOrThrow({ where: { id: created.connection.id } })).revokedAt
    ).toBeInstanceOf(Date);

    signedOut();
    const ingest = await callRoute(
      c2cR2Init,
      apiRequest('/api/c2c/r2-init', {
        method: 'POST',
        headers: { authorization: `Bearer ${created.connection.secret}` },
        body: { fileName: 'clip.mp4', sizeBytes: '2048', contentType: 'video/mp4' },
      })
    );
    expect(ingest.status).toBe(401);
  });
});

describe('C2C ingest', () => {
  beforeEach(() => {
    signedOut();
  });

  it('returns 401 without a C2C bearer token', async () => {
    enableS3VideoUploads();
    const response = await callRoute(
      c2cR2Init,
      apiRequest('/api/c2c/r2-init', {
        method: 'POST',
        body: { fileName: 'clip.mp4', sizeBytes: '2048', contentType: 'video/mp4' },
      })
    );
    expect(response.status).toBe(401);
  });

  it('rejects a live API token on the ingest routes', async () => {
    enableS3VideoUploads();
    const user = await createUser();
    await db.apiToken.create({
      data: {
        userId: user.id,
        name: 'panel',
        tokenHash: hashApiToken(
          'of_live_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
        ),
        tokenPrefix: 'of_live_01234567',
      },
    });

    const response = await callRoute(
      c2cR2Init,
      apiRequest('/api/c2c/r2-init', {
        method: 'POST',
        headers: {
          authorization:
            'Bearer of_live_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        },
        body: { fileName: 'clip.mp4', sizeBytes: '2048', contentType: 'video/mp4' },
      })
    );
    expect(response.status).toBe(401);
  });

  it('uploads into the connection project and ignores a body folderId', async () => {
    enableS3VideoUploads();
    const scenario = await seedProject();
    const folder = await createFolder({ projectId: scenario.project.id });
    signedInAs(scenario.owner);

    const created = await readData<{ connection: { secret: string } }>(
      await callRoute(
        createConnection,
        apiRequest(connectionsUrl(scenario.project.id), {
          method: 'POST',
          body: { name: 'Cart A' },
        }),
        { projectId: scenario.project.id }
      )
    );

    signedOut();
    const initResponse = await callRoute(
      c2cR2Init,
      apiRequest('/api/c2c/r2-init', {
        method: 'POST',
        headers: { authorization: `Bearer ${created.connection.secret}` },
        body: { fileName: 'clip.mp4', sizeBytes: '2048', contentType: 'video/mp4' },
      })
    );
    expect(initResponse.status).toBe(200);
    const init = await readData<{ objectKey: string; proxyUrl: string; uploadToken: string }>(
      initResponse
    );

    const createResponse = await callRoute(
      c2cCreateVideo,
      apiRequest('/api/c2c/videos', {
        method: 'POST',
        headers: { authorization: `Bearer ${created.connection.secret}` },
        body: {
          title: 'A001C001',
          videoUrl: init.proxyUrl,
          providerId: 'r2',
          objectKey: init.objectKey,
          uploadToken: init.uploadToken,
          folderId: folder.id,
        },
      })
    );

    expect(createResponse.status).toBe(201);
    const video = await db.video.findFirstOrThrow({
      where: { title: 'A001C001' },
      include: { versions: true },
    });
    expect(video.projectId).toBe(scenario.project.id);
    expect(video.folderId).toBeNull();
    expect(video.versions).toHaveLength(1);
    const versionId = video.versions[0].id;
    const jobs = await db.mediaJob.findMany({
      where: { versionId },
      select: { kind: true, payload: true },
    });
    expect(jobs.map((job) => job.kind).sort()).toEqual([
      'EXTRACT_AUDIO',
      'PROBE_MEDIA',
      'TRANSCRIBE',
    ]);
    const transcript = await db.transcript.findFirstOrThrow({
      where: { versionId, language: 'und' },
    });
    expect(transcript.status).toBe(TranscriptStatus.PENDING);
    const transcribe = jobs.find((job) => job.kind === 'TRANSCRIBE');
    expect(transcribe?.payload).toEqual({ language: 'und', transcriptId: transcript.id });
    expect(scheduleVersionTranscription).toHaveBeenCalledTimes(1);
    expect(scheduleVersionTranscription).toHaveBeenCalledWith(versionId, 'und', transcript.id);
  });

  it('lands files in the connection folder', async () => {
    enableS3VideoUploads();
    const scenario = await seedProject();
    const folder = await createFolder({ projectId: scenario.project.id, name: 'Dailies' });
    signedInAs(scenario.owner);

    const created = await readData<{ connection: { secret: string } }>(
      await callRoute(
        createConnection,
        apiRequest(connectionsUrl(scenario.project.id), {
          method: 'POST',
          body: { name: 'Cart A', folderId: folder.id },
        }),
        { projectId: scenario.project.id }
      )
    );

    signedOut();
    const init = await readData<{ objectKey: string; proxyUrl: string; uploadToken: string }>(
      await callRoute(
        c2cR2Init,
        apiRequest('/api/c2c/r2-init', {
          method: 'POST',
          headers: { authorization: `Bearer ${created.connection.secret}` },
          body: { fileName: 'clip.mp4', sizeBytes: '2048', contentType: 'video/mp4' },
        })
      )
    );

    const createResponse = await callRoute(
      c2cCreateVideo,
      apiRequest('/api/c2c/videos', {
        method: 'POST',
        headers: { authorization: `Bearer ${created.connection.secret}` },
        body: {
          title: 'A001C002',
          videoUrl: init.proxyUrl,
          objectKey: init.objectKey,
          uploadToken: init.uploadToken,
        },
      })
    );

    expect(createResponse.status).toBe(201);
    const video = await db.video.findFirstOrThrow({ where: { title: 'A001C002' } });
    expect(video.projectId).toBe(scenario.project.id);
    expect(video.folderId).toBe(folder.id);
  });

  it('completes a multipart ingest and leaves the session open for finalisation', async () => {
    enableS3VideoUploads();
    vi.stubEnv('OPENFRAME_R2_MULTIPART_THRESHOLD_BYTES', '1024');
    const scenario = await seedProject();
    signedInAs(scenario.owner);

    const created = await readData<{ connection: { secret: string } }>(
      await callRoute(
        createConnection,
        apiRequest(connectionsUrl(scenario.project.id), {
          method: 'POST',
          body: { name: 'Cart A' },
        }),
        { projectId: scenario.project.id }
      )
    );

    signedOut();
    const init = await readData<{ objectKey: string; uploadToken: string; proxyUrl: string }>(
      await callRoute(
        c2cR2Init,
        apiRequest('/api/c2c/r2-init', {
          method: 'POST',
          headers: { authorization: `Bearer ${created.connection.secret}` },
          body: {
            fileName: 'clip.mp4',
            sizeBytes: String(6 * 1024 * 1024),
            contentType: 'video/mp4',
          },
        })
      )
    );

    const response = await callRoute(
      c2cR2Complete,
      apiRequest('/api/c2c/r2-complete', {
        method: 'POST',
        headers: { authorization: `Bearer ${created.connection.secret}` },
        body: {
          objectKey: init.objectKey,
          uploadToken: init.uploadToken,
          parts: [{ partNumber: 1, etag: 'etag-1' }],
        },
      })
    );
    const payload = await readData<{ objectKey: string; proxyUrl: string }>(response);

    expect(response.status).toBe(200);
    expect(payload.objectKey).toBe(init.objectKey);
    expect(payload.proxyUrl).toBe(init.proxyUrl);
    expect((await db.videoUploadSession.findFirstOrThrow()).status).toBe('INITIATED');
  });
});
