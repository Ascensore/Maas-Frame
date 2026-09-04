import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { POST as importUrl } from '@/app/api/projects/[projectId]/videos/import-url/route';
import { apiRequest, callRoute, readData, readError } from '../helpers/request';
import { signedInAs, signedOut } from '../helpers/session';
import { addProjectMember, createFolder, createUser, seedProject } from '../factories';

const DRIVE_FILE_ID = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms';
const DRIVE_FILE_URL = `https://drive.google.com/file/d/${DRIVE_FILE_ID}/view?usp=sharing`;
const DRIVE_FOLDER_URL = `https://drive.google.com/drive/folders/${DRIVE_FILE_ID}`;

function importUrlPath(projectId: string): string {
  return `/api/projects/${projectId}/videos/import-url`;
}

function enableS3VideoUploads(): void {
  vi.stubEnv('OPENFRAME_ENABLE_S3_VIDEO_UPLOADS', 'true');
  vi.stubEnv('OPENFRAME_ENABLE_BUNNY_UPLOADS', 'false');
  vi.stubEnv('R2_ACCESS_KEY_ID', 'test-access-key');
  vi.stubEnv('R2_SECRET_ACCESS_KEY', 'test-secret-key');
  vi.stubEnv('R2_BUCKET_NAME', 'openframe-test');
  vi.stubEnv('R2_ACCOUNT_ID', 'test-account');
}

describe('POST /api/projects/[projectId]/videos/import-url', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 401 without a session and creates no video', async () => {
    const scenario = await seedProject();
    signedOut();
    enableS3VideoUploads();

    const response = await callRoute(
      importUrl,
      apiRequest(importUrlPath(scenario.project.id), { body: { url: DRIVE_FILE_URL } }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(401);
    expect(await db.video.count()).toBe(0);
    expect(await db.mediaJob.count()).toBe(0);
  });

  it('returns 403 for a project COMMENTATOR and creates no video', async () => {
    const scenario = await seedProject();
    const commentator = await createUser();
    await addProjectMember({
      projectId: scenario.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);
    enableS3VideoUploads();

    const response = await callRoute(
      importUrl,
      apiRequest(importUrlPath(scenario.project.id), { body: { url: DRIVE_FILE_URL } }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(403);
    expect(await db.video.count()).toBe(0);
  });

  it('returns 400 for a Drive folder URL and creates no video', async () => {
    const scenario = await seedProject();
    signedInAs(scenario.owner);
    enableS3VideoUploads();

    const response = await callRoute(
      importUrl,
      apiRequest(importUrlPath(scenario.project.id), { body: { url: DRIVE_FOLDER_URL } }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(400);
    expect(await readError(response)).toContain('folders cannot be imported');
    expect(await db.video.count()).toBe(0);
  });

  it('returns 400 when object storage is disabled, after authorizing', async () => {
    const scenario = await seedProject();
    signedInAs(scenario.owner);
    vi.stubEnv('OPENFRAME_ENABLE_S3_VIDEO_UPLOADS', 'false');

    const response = await callRoute(
      importUrl,
      apiRequest(importUrlPath(scenario.project.id), { body: { url: DRIVE_FILE_URL } }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(400);
    expect(await readError(response)).toContain('Direct file uploads are disabled');
    expect(await db.video.count()).toBe(0);
  });

  it('creates an r2 video and an IMPORT_DRIVE job for a public file link', async () => {
    const scenario = await seedProject();
    signedInAs(scenario.owner);
    enableS3VideoUploads();

    const response = await callRoute(
      importUrl,
      apiRequest(importUrlPath(scenario.project.id), {
        body: { url: DRIVE_FILE_URL, title: 'Card A' },
      }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(201);
    const payload = await readData<{
      video: { id: string; title: string; folderId: string | null; importStatus: string };
    }>(response);
    expect(payload.video.title).toBe('Card A');
    expect(payload.video.importStatus).toBe('pending');
    expect(payload.video.folderId).toBeNull();

    const video = await db.video.findUniqueOrThrow({ where: { id: payload.video.id } });
    expect(video.projectId).toBe(scenario.project.id);
    expect(video.metadata).toMatchObject({
      import_source: 'gdrive',
      import_file_id: DRIVE_FILE_ID,
      import_status: 'pending',
    });

    const version = await db.videoVersion.findFirstOrThrow({
      where: { videoParentId: video.id },
    });
    expect(version.providerId).toBe('r2');
    expect(version.videoId.startsWith('videos/')).toBe(true);
    expect(version.originalUrl.startsWith('/api/upload/video/')).toBe(true);

    expect(
      await db.mediaJob.count({ where: { kind: 'IMPORT_DRIVE', versionId: version.id } })
    ).toBe(1);
    expect(await db.mediaJob.count({ where: { kind: 'PROBE_MEDIA' } })).toBe(0);
  });

  it('stores the video in the requested project folder', async () => {
    const scenario = await seedProject();
    const folder = await createFolder({ projectId: scenario.project.id, name: 'Dailies' });
    signedInAs(scenario.owner);
    enableS3VideoUploads();

    const response = await callRoute(
      importUrl,
      apiRequest(importUrlPath(scenario.project.id), {
        body: { url: DRIVE_FILE_URL, folderId: folder.id },
      }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(201);
    const payload = await readData<{ video: { id: string; folderId: string | null } }>(response);
    expect(payload.video.folderId).toBe(folder.id);
    expect((await db.video.findUniqueOrThrow({ where: { id: payload.video.id } })).folderId).toBe(
      folder.id
    );
  });
});
