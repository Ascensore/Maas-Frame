import { describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import {
  GET as listFolders,
  POST as createFolderRoute,
} from '@/app/api/projects/[projectId]/folders/route';
import {
  DELETE as deleteFolder,
  PATCH as patchFolder,
} from '@/app/api/projects/[projectId]/folders/[folderId]/route';
import { GET as listVideos, POST as addVideo } from '@/app/api/projects/[projectId]/videos/route';
import { PATCH as patchVideo } from '@/app/api/projects/[projectId]/videos/[videoId]/route';
import { apiRequest, callRoute, readData, readError } from '../helpers/request';
import { signedInAs, signedOut } from '../helpers/session';
import { addProjectMember, createFolder, createUser, createVideo, seedProject } from '../factories';

function foldersUrl(projectId: string): string {
  return `/api/projects/${projectId}/folders`;
}

function folderUrl(projectId: string, folderId: string): string {
  return `${foldersUrl(projectId)}/${folderId}`;
}

function videosUrl(projectId: string): string {
  return `/api/projects/${projectId}/videos`;
}

async function folderRow(folderId: string) {
  return db.folder.findUnique({ where: { id: folderId } });
}

describe('GET /api/projects/[projectId]/folders', () => {
  it('returns 403 to an anonymous caller on a PRIVATE project', async () => {
    const scenario = await seedProject({ visibility: 'PRIVATE' });
    signedOut();

    const response = await callRoute(listFolders, apiRequest(foldersUrl(scenario.project.id)), {
      projectId: scenario.project.id,
    });

    expect(response.status).toBe(403);
  });

  it('lists folders for a project COMMENTATOR', async () => {
    const scenario = await seedProject();
    const dailies = await createFolder({ projectId: scenario.project.id, name: 'Dailies' });
    const commentator = await createUser();
    await addProjectMember({
      projectId: scenario.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const payload = await readData<{ folders: Array<{ id: string; name: string }> }>(
      await callRoute(listFolders, apiRequest(foldersUrl(scenario.project.id)), {
        projectId: scenario.project.id,
      })
    );

    expect(payload.folders).toEqual([
      expect.objectContaining({ id: dailies.id, name: 'Dailies', parentId: null }),
    ]);
  });
});

describe('POST /api/projects/[projectId]/folders', () => {
  it('returns 401 without a session and writes no folder', async () => {
    const scenario = await seedProject();
    signedOut();

    const response = await callRoute(
      createFolderRoute,
      apiRequest(foldersUrl(scenario.project.id), { body: { name: 'Dailies' } }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(401);
    expect(await db.folder.count()).toBe(0);
  });

  it('returns 403 to a signed-in stranger and writes no folder', async () => {
    const scenario = await seedProject();
    await seedProject();
    const stranger = await createUser();
    signedInAs(stranger);

    const response = await callRoute(
      createFolderRoute,
      apiRequest(foldersUrl(scenario.project.id), { body: { name: 'Dailies' } }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(403);
    expect(await db.folder.count()).toBe(0);
  });

  it('returns 403 to a project COMMENTATOR and writes no folder', async () => {
    const scenario = await seedProject();
    const commentator = await createUser();
    await addProjectMember({
      projectId: scenario.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await callRoute(
      createFolderRoute,
      apiRequest(foldersUrl(scenario.project.id), { body: { name: 'Dailies' } }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(403);
    expect(await db.folder.count()).toBe(0);
  });

  it('lets the owner create a named folder', async () => {
    const scenario = await seedProject();
    signedInAs(scenario.owner);

    const payload = await readData<{
      folder: { id: string; name: string; parentId: string | null };
    }>(
      await callRoute(
        createFolderRoute,
        apiRequest(foldersUrl(scenario.project.id), { body: { name: '  Dailies  ' } }),
        { projectId: scenario.project.id }
      )
    );

    expect(payload.folder.name).toBe('Dailies');
    expect(payload.folder.parentId).toBeNull();
    const row = await folderRow(payload.folder.id);
    expect(row).toMatchObject({
      name: 'Dailies',
      projectId: scenario.project.id,
      parentId: null,
    });
  });

  it('nests a folder under a parent in the same project', async () => {
    const scenario = await seedProject();
    const parent = await createFolder({ projectId: scenario.project.id, name: 'Dailies' });
    signedInAs(scenario.owner);

    const payload = await readData<{ folder: { parentId: string | null } }>(
      await callRoute(
        createFolderRoute,
        apiRequest(foldersUrl(scenario.project.id), {
          body: { name: 'Cam A', parentId: parent.id },
        }),
        { projectId: scenario.project.id }
      )
    );

    expect(payload.folder.parentId).toBe(parent.id);
    expect(await folderRow(payload.folder.id)).toMatchObject({
      parentId: parent.id,
      projectId: scenario.project.id,
    });
  });

  it('rejects a parent folder that belongs to another project', async () => {
    const mine = await seedProject();
    const theirs = await seedProject();
    const foreign = await createFolder({ projectId: theirs.project.id, name: 'Theirs' });
    signedInAs(mine.owner);

    const response = await callRoute(
      createFolderRoute,
      apiRequest(foldersUrl(mine.project.id), {
        body: { name: 'Cam A', parentId: foreign.id },
      }),
      { projectId: mine.project.id }
    );

    expect(response.status).toBe(400);
    expect(await db.folder.count({ where: { projectId: mine.project.id } })).toBe(0);
  });

  it('rejects nesting past 32 levels', async () => {
    const scenario = await seedProject();
    let parentId: string | null = null;
    for (let i = 0; i < 32; i += 1) {
      const folder = await createFolder({
        projectId: scenario.project.id,
        name: `L${i}`,
        parentId,
      });
      parentId = folder.id;
    }
    signedInAs(scenario.owner);

    const response = await callRoute(
      createFolderRoute,
      apiRequest(foldersUrl(scenario.project.id), {
        body: { name: 'too deep', parentId },
      }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(400);
    expect(await readError(response)).toMatch(/32/);
    expect(await db.folder.count({ where: { projectId: scenario.project.id } })).toBe(32);
  });
});

describe('PATCH /api/projects/[projectId]/folders/[folderId]', () => {
  it('returns 401 without a session and leaves the name alone', async () => {
    const scenario = await seedProject();
    const folder = await createFolder({ projectId: scenario.project.id, name: 'Dailies' });
    signedOut();

    const response = await callRoute(
      patchFolder,
      apiRequest(folderUrl(scenario.project.id, folder.id), {
        method: 'PATCH',
        body: { name: 'Renamed' },
      }),
      { projectId: scenario.project.id, folderId: folder.id }
    );

    expect(response.status).toBe(401);
    expect(await folderRow(folder.id)).toMatchObject({ name: 'Dailies' });
  });

  it('returns 403 to a signed-in stranger and leaves the name alone', async () => {
    const scenario = await seedProject();
    await seedProject();
    const folder = await createFolder({ projectId: scenario.project.id, name: 'Dailies' });
    const stranger = await createUser();
    signedInAs(stranger);

    const response = await callRoute(
      patchFolder,
      apiRequest(folderUrl(scenario.project.id, folder.id), {
        method: 'PATCH',
        body: { name: 'Renamed' },
      }),
      { projectId: scenario.project.id, folderId: folder.id }
    );

    expect(response.status).toBe(403);
    expect(await folderRow(folder.id)).toMatchObject({ name: 'Dailies' });
  });

  it('returns 403 to a project COMMENTATOR and leaves the name alone', async () => {
    const scenario = await seedProject();
    const folder = await createFolder({ projectId: scenario.project.id, name: 'Dailies' });
    const commentator = await createUser();
    await addProjectMember({
      projectId: scenario.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await callRoute(
      patchFolder,
      apiRequest(folderUrl(scenario.project.id, folder.id), {
        method: 'PATCH',
        body: { name: 'Renamed' },
      }),
      { projectId: scenario.project.id, folderId: folder.id }
    );

    expect(response.status).toBe(403);
    expect(await folderRow(folder.id)).toMatchObject({ name: 'Dailies' });
  });

  it('lets the owner rename a folder', async () => {
    const scenario = await seedProject();
    const folder = await createFolder({ projectId: scenario.project.id, name: 'Dailies' });
    signedInAs(scenario.owner);

    const response = await callRoute(
      patchFolder,
      apiRequest(folderUrl(scenario.project.id, folder.id), {
        method: 'PATCH',
        body: { name: 'Selects' },
      }),
      { projectId: scenario.project.id, folderId: folder.id }
    );

    expect(response.status).toBe(200);
    expect(await folderRow(folder.id)).toMatchObject({ name: 'Selects' });
  });

  it('rejects moving a folder under one of its descendants', async () => {
    const scenario = await seedProject();
    const root = await createFolder({ projectId: scenario.project.id, name: 'Root' });
    const child = await createFolder({
      projectId: scenario.project.id,
      name: 'Child',
      parentId: root.id,
    });
    signedInAs(scenario.owner);

    const response = await callRoute(
      patchFolder,
      apiRequest(folderUrl(scenario.project.id, root.id), {
        method: 'PATCH',
        body: { parentId: child.id },
      }),
      { projectId: scenario.project.id, folderId: root.id }
    );

    expect(response.status).toBe(400);
    expect(await folderRow(root.id)).toMatchObject({ parentId: null });
  });

  it('rejects relocating a folder past 32 levels', async () => {
    const scenario = await seedProject();
    let parentId: string | null = null;
    for (let i = 0; i < 32; i += 1) {
      const folder = await createFolder({
        projectId: scenario.project.id,
        name: `L${i}`,
        parentId,
      });
      parentId = folder.id;
    }
    const mover = await createFolder({ projectId: scenario.project.id, name: 'Mover' });
    signedInAs(scenario.owner);

    const response = await callRoute(
      patchFolder,
      apiRequest(folderUrl(scenario.project.id, mover.id), {
        method: 'PATCH',
        body: { parentId },
      }),
      { projectId: scenario.project.id, folderId: mover.id }
    );

    expect(response.status).toBe(400);
    expect(await readError(response)).toMatch(/32/);
    expect(await folderRow(mover.id)).toMatchObject({ parentId: null });
  });

  it('returns 404 when the folder belongs to another project', async () => {
    const mine = await seedProject();
    const theirs = await seedProject();
    const foreign = await createFolder({ projectId: theirs.project.id, name: 'Theirs' });
    signedInAs(mine.owner);

    const response = await callRoute(
      patchFolder,
      apiRequest(folderUrl(mine.project.id, foreign.id), {
        method: 'PATCH',
        body: { name: 'Stolen' },
      }),
      { projectId: mine.project.id, folderId: foreign.id }
    );

    expect(response.status).toBe(404);
    expect(await folderRow(foreign.id)).toMatchObject({ name: 'Theirs' });
  });
});

describe('DELETE /api/projects/[projectId]/folders/[folderId]', () => {
  it('returns 401 without a session and leaves the folder', async () => {
    const scenario = await seedProject();
    const folder = await createFolder({ projectId: scenario.project.id, name: 'Dailies' });
    signedOut();

    const response = await callRoute(
      deleteFolder,
      apiRequest(folderUrl(scenario.project.id, folder.id), { method: 'DELETE' }),
      { projectId: scenario.project.id, folderId: folder.id }
    );

    expect(response.status).toBe(401);
    expect(await folderRow(folder.id)).not.toBeNull();
  });

  it('returns 403 to a signed-in stranger and leaves the folder', async () => {
    const scenario = await seedProject();
    await seedProject();
    const folder = await createFolder({ projectId: scenario.project.id, name: 'Dailies' });
    const stranger = await createUser();
    signedInAs(stranger);

    const response = await callRoute(
      deleteFolder,
      apiRequest(folderUrl(scenario.project.id, folder.id), { method: 'DELETE' }),
      { projectId: scenario.project.id, folderId: folder.id }
    );

    expect(response.status).toBe(403);
    expect(await folderRow(folder.id)).not.toBeNull();
  });

  it('returns 403 to a project COMMENTATOR and leaves the folder', async () => {
    const scenario = await seedProject();
    const folder = await createFolder({ projectId: scenario.project.id, name: 'Dailies' });
    const commentator = await createUser();
    await addProjectMember({
      projectId: scenario.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await callRoute(
      deleteFolder,
      apiRequest(folderUrl(scenario.project.id, folder.id), { method: 'DELETE' }),
      { projectId: scenario.project.id, folderId: folder.id }
    );

    expect(response.status).toBe(403);
    expect(await folderRow(folder.id)).not.toBeNull();
  });

  it('deletes the folder, sends its videos to the project root, and cascades nested folders', async () => {
    const scenario = await seedProject();
    const parent = await createFolder({ projectId: scenario.project.id, name: 'Dailies' });
    const child = await createFolder({
      projectId: scenario.project.id,
      name: 'Cam A',
      parentId: parent.id,
    });
    const video = await createVideo({
      projectId: scenario.project.id,
      folderId: parent.id,
      title: 'Clip',
    });
    const nestedVideo = await createVideo({
      projectId: scenario.project.id,
      folderId: child.id,
      title: 'Nested clip',
    });
    signedInAs(scenario.owner);

    const response = await callRoute(
      deleteFolder,
      apiRequest(folderUrl(scenario.project.id, parent.id), { method: 'DELETE' }),
      { projectId: scenario.project.id, folderId: parent.id }
    );

    expect(response.status).toBe(200);
    expect(await folderRow(parent.id)).toBeNull();
    expect(await folderRow(child.id)).toBeNull();
    expect(await db.video.findUniqueOrThrow({ where: { id: video.id } })).toMatchObject({
      folderId: null,
    });
    expect(await db.video.findUniqueOrThrow({ where: { id: nestedVideo.id } })).toMatchObject({
      folderId: null,
    });
  });
});

describe('video folder assignment', () => {
  it('lets the owner move a video into a folder and back to the root', async () => {
    const scenario = await seedProject();
    const folder = await createFolder({ projectId: scenario.project.id, name: 'Dailies' });
    const video = await createVideo({ projectId: scenario.project.id, title: 'Clip' });
    signedInAs(scenario.owner);

    const intoFolder = await callRoute(
      patchVideo,
      apiRequest(`${videosUrl(scenario.project.id)}/${video.id}`, {
        method: 'PATCH',
        body: { folderId: folder.id },
      }),
      { projectId: scenario.project.id, videoId: video.id }
    );
    expect(intoFolder.status).toBe(200);
    expect(await db.video.findUniqueOrThrow({ where: { id: video.id } })).toMatchObject({
      folderId: folder.id,
    });

    const toRoot = await callRoute(
      patchVideo,
      apiRequest(`${videosUrl(scenario.project.id)}/${video.id}`, {
        method: 'PATCH',
        body: { folderId: null },
      }),
      { projectId: scenario.project.id, videoId: video.id }
    );
    expect(toRoot.status).toBe(200);
    expect(await db.video.findUniqueOrThrow({ where: { id: video.id } })).toMatchObject({
      folderId: null,
    });
  });

  it('refuses a folder from another project and leaves the video at the root', async () => {
    const mine = await seedProject();
    const theirs = await seedProject();
    const foreign = await createFolder({ projectId: theirs.project.id, name: 'Theirs' });
    const video = await createVideo({ projectId: mine.project.id, title: 'Clip' });
    signedInAs(mine.owner);

    const response = await callRoute(
      patchVideo,
      apiRequest(`${videosUrl(mine.project.id)}/${video.id}`, {
        method: 'PATCH',
        body: { folderId: foreign.id },
      }),
      { projectId: mine.project.id, videoId: video.id }
    );

    expect(response.status).toBe(400);
    expect(await db.video.findUniqueOrThrow({ where: { id: video.id } })).toMatchObject({
      folderId: null,
    });
  });

  it('lists only videos in the requested folder', async () => {
    const scenario = await seedProject();
    const folder = await createFolder({ projectId: scenario.project.id, name: 'Dailies' });
    const inFolder = await createVideo({
      projectId: scenario.project.id,
      folderId: folder.id,
      title: 'Inside',
    });
    await createVideo({ projectId: scenario.project.id, title: 'At root' });
    signedInAs(scenario.owner);

    const inFolderPayload = await readData<{ videos: Array<{ id: string }> }>(
      await callRoute(
        listVideos,
        apiRequest(videosUrl(scenario.project.id), { searchParams: { folder: folder.id } }),
        { projectId: scenario.project.id }
      )
    );
    expect(inFolderPayload.videos.map((entry) => entry.id)).toEqual([inFolder.id]);

    const rootPayload = await readData<{ videos: Array<{ id: string }> }>(
      await callRoute(
        listVideos,
        apiRequest(videosUrl(scenario.project.id), { searchParams: { folder: 'root' } }),
        { projectId: scenario.project.id }
      )
    );
    expect(rootPayload.videos).toHaveLength(1);
    expect(rootPayload.videos[0].id).not.toBe(inFolder.id);
  });

  it('creates a video inside the requested folder', async () => {
    const scenario = await seedProject();
    const folder = await createFolder({ projectId: scenario.project.id, name: 'Dailies' });
    signedInAs(scenario.owner);

    const payload = await readData<{ id: string }>(
      await callRoute(
        addVideo,
        apiRequest(videosUrl(scenario.project.id), {
          body: {
            title: 'Clip',
            videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
            folderId: folder.id,
          },
        }),
        { projectId: scenario.project.id }
      )
    );

    expect(await db.video.findUniqueOrThrow({ where: { id: payload.id } })).toMatchObject({
      folderId: folder.id,
    });
  });
});
