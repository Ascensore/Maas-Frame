// Authorization tests for the per-video and per-version routes, from callers who
// are signed in but not entitled.
//
// tests/api/auth-matrix.test.ts already proves these handlers refuse a caller
// with no session. That is the weaker half of the property, because
// `!session?.user?.id` is true for a signed-out caller for a reason that has
// nothing to do with who owns the video. Rewriting `if (!access.canEdit)` as
// `if (!access.hasAccess)` leaves the matrix entirely green while handing a
// COMMENTATOR the ability to rename and delete every video in the project. The
// cases below are the other half: a signed-in stranger, a project COMMENTATOR, a
// workspace member without admin, and a caller whose workspace owner has lost
// billing access.
//
// Three rules apply throughout.
//
//  1. Every refusal asserts the row afterwards. A DELETE that was refused has to
//     leave the video present; a PATCH that was refused has to leave the field at
//     its seeded literal. A status code on its own does not separate a guard from
//     a route that fell over before reaching one.
//
//  2. Every cluster carries a positive control. Without one, a typo in the params
//     object produces a 404 that satisfies every negative assertion in the block,
//     and the file proves nothing.
//
//  3. The video always carries two versions. The DELETE handler refuses to remove
//     the last remaining version with a 400, so a single-version fixture would let
//     that validation branch stand in for the authorization branch it is supposed
//     to be testing.

import { describe, expect, it } from 'vitest';
import type { Project, User, Video, VideoVersion, Workspace } from '@prisma/client';
import { db } from '@/lib/db';
import {
  DELETE as deleteVideo,
  GET as getVideo,
  PATCH as patchVideo,
} from '@/app/api/projects/[projectId]/videos/[videoId]/route';
import {
  DELETE as deleteVersion,
  PATCH as patchVersion,
} from '@/app/api/projects/[projectId]/videos/[videoId]/versions/[versionId]/route';
import { POST as addVersion } from '@/app/api/projects/[projectId]/videos/[videoId]/versions/route';
import { apiRequest, callRoute, readData } from '../helpers/request';
import { signedInAs } from '../helpers/session';
import {
  addProjectMember,
  addWorkspaceMember,
  createExpiredUser,
  createUser,
  createVersion,
  createVideo,
  seedProject,
} from '../factories';

// Seeded as literals so every "unchanged" assertion compares against a value
// written in this file rather than one read back out of the fixture.
const SEEDED_VIDEO_TITLE = 'Seeded video title';
const SEEDED_DESCRIPTION = 'Seeded description';
const SEEDED_LABEL_V1 = 'Seeded label v1';
const SEEDED_LABEL_V2 = 'Seeded label v2';

const YOUTUBE_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

interface VideoFixture {
  owner: User;
  workspace: Workspace;
  project: Project;
  video: Video;
  /** The active version. */
  first: VideoVersion;
  /** The inactive spare, so DELETE can never bail out on "only version". */
  second: VideoVersion;
}

async function seedVideo(
  input: { ownerUser?: User; allowDownloads?: boolean } = {}
): Promise<VideoFixture> {
  const { owner, workspace, project } = await seedProject({
    ownerUser: input.ownerUser,
    visibility: 'PRIVATE',
    allowDownloads: input.allowDownloads,
  });
  const video = await createVideo({
    projectId: project.id,
    title: SEEDED_VIDEO_TITLE,
    description: SEEDED_DESCRIPTION,
  });
  const first = await createVersion({
    videoParentId: video.id,
    versionNumber: 1,
    versionLabel: SEEDED_LABEL_V1,
    isActive: true,
  });
  const second = await createVersion({
    videoParentId: video.id,
    versionNumber: 2,
    versionLabel: SEEDED_LABEL_V2,
    isActive: false,
  });

  return { owner, workspace, project, video, first, second };
}

function videoUrl(projectId: string, videoId: string): string {
  return `/api/projects/${projectId}/videos/${videoId}`;
}

function versionUrl(projectId: string, videoId: string, versionId: string): string {
  return `${videoUrl(projectId, videoId)}/versions/${versionId}`;
}

/** The seeded scalars of one video, for an "it did not change" assertion. */
async function videoState(videoId: string): Promise<{ title: string; description: string | null }> {
  const row = await db.video.findUniqueOrThrow({
    where: { id: videoId },
    select: { title: true, description: true },
  });
  return row;
}

// ---------------------------------------------------------------------------
// GET /api/projects/[projectId]/videos/[videoId]
// ---------------------------------------------------------------------------
// Gated on `access.hasAccess`, which is the loosest of the three flags. The point
// of the pair below is that "loosest" still is not "anyone with a session".
describe('GET /api/projects/[projectId]/videos/[videoId]', () => {
  it('returns 403 to a signed-in stranger with their own unrelated workspace', async () => {
    const fixture = await seedVideo();
    // A full tenant of their own, so the stranger is a plausible customer rather
    // than a user with no rows anywhere.
    await seedProject();
    const stranger = await createUser();
    signedInAs(stranger);

    const response = await callRoute(
      getVideo,
      apiRequest(videoUrl(fixture.project.id, fixture.video.id)),
      { projectId: fixture.project.id, videoId: fixture.video.id }
    );

    expect(response.status).toBe(403);
  });

  it('returns 403 to a project COMMENTATOR once the workspace owner loses billing', async () => {
    const expiredOwner = await createExpiredUser();
    const fixture = await seedVideo({ ownerUser: expiredOwner });
    const commentator = await createUser();
    await addProjectMember({
      projectId: fixture.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await callRoute(
      getVideo,
      apiRequest(videoUrl(fixture.project.id, fixture.video.id)),
      { projectId: fixture.project.id, videoId: fixture.video.id }
    );

    expect(response.status).toBe(403);
  });

  // Positive control for the two refusals above: the same URL, the same params,
  // a caller who is only a COMMENTATOR, and it succeeds. So the 403s are the
  // access check talking and not a broken request.
  it('lets a project COMMENTATOR read the video', async () => {
    const fixture = await seedVideo();
    const commentator = await createUser();
    await addProjectMember({
      projectId: fixture.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await callRoute(
      getVideo,
      apiRequest(videoUrl(fixture.project.id, fixture.video.id)),
      { projectId: fixture.project.id, videoId: fixture.video.id }
    );

    expect(response.status).toBe(200);
    const payload = await readData<{ id: string; canManageTags: boolean }>(response);
    expect(payload.id).toBe(fixture.video.id);
    // The read succeeded but the edit flags did not come with it.
    expect(payload.canManageTags).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/projects/[projectId]/videos/[videoId]
// ---------------------------------------------------------------------------
describe('PATCH /api/projects/[projectId]/videos/[videoId]', () => {
  it('returns 403 to a signed-in stranger and leaves the title alone', async () => {
    const fixture = await seedVideo();
    await seedProject();
    const stranger = await createUser();
    signedInAs(stranger);

    const response = await callRoute(
      patchVideo,
      apiRequest(videoUrl(fixture.project.id, fixture.video.id), {
        method: 'PATCH',
        body: { title: 'renamed by a stranger', description: 'rewritten by a stranger' },
      }),
      { projectId: fixture.project.id, videoId: fixture.video.id }
    );

    expect(response.status).toBe(403);
    expect(await videoState(fixture.video.id)).toEqual({
      title: SEEDED_VIDEO_TITLE,
      description: SEEDED_DESCRIPTION,
    });
  });

  it('returns 403 to a project COMMENTATOR and leaves the title alone', async () => {
    const fixture = await seedVideo();
    const commentator = await createUser();
    await addProjectMember({
      projectId: fixture.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await callRoute(
      patchVideo,
      apiRequest(videoUrl(fixture.project.id, fixture.video.id), {
        method: 'PATCH',
        body: { title: 'renamed by a commentator' },
      }),
      { projectId: fixture.project.id, videoId: fixture.video.id }
    );

    expect(response.status).toBe(403);
    expect(await videoState(fixture.video.id)).toEqual({
      title: SEEDED_VIDEO_TITLE,
      description: SEEDED_DESCRIPTION,
    });
  });

  // A workspace COMMENTATOR reaches `hasAccess` through `isWorkspaceMember` but
  // never reaches `canEdit`, which wants ADMIN or OWNER. That gap is the whole
  // difference between reading the project and rewriting it.
  it('returns 403 to a workspace COMMENTATOR who is not a project member', async () => {
    const fixture = await seedVideo();
    const workspaceCommentator = await createUser();
    await addWorkspaceMember({
      workspaceId: fixture.workspace.id,
      userId: workspaceCommentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(workspaceCommentator);

    const response = await callRoute(
      patchVideo,
      apiRequest(videoUrl(fixture.project.id, fixture.video.id), {
        method: 'PATCH',
        body: { title: 'renamed by a workspace commentator' },
      }),
      { projectId: fixture.project.id, videoId: fixture.video.id }
    );

    expect(response.status).toBe(403);
    expect(await videoState(fixture.video.id)).toEqual({
      title: SEEDED_VIDEO_TITLE,
      description: SEEDED_DESCRIPTION,
    });
  });

  // `canEdit` is `workspaceOwnerBillingAccess && (...)`, so a lapsed trial locks
  // out even the person who created the video.
  it('returns 403 to the owner once their own billing access has lapsed', async () => {
    const expiredOwner = await createExpiredUser();
    const fixture = await seedVideo({ ownerUser: expiredOwner });
    signedInAs(expiredOwner);

    const response = await callRoute(
      patchVideo,
      apiRequest(videoUrl(fixture.project.id, fixture.video.id), {
        method: 'PATCH',
        body: { title: 'renamed after the trial ran out' },
      }),
      { projectId: fixture.project.id, videoId: fixture.video.id }
    );

    expect(response.status).toBe(403);
    expect(await videoState(fixture.video.id)).toEqual({
      title: SEEDED_VIDEO_TITLE,
      description: SEEDED_DESCRIPTION,
    });
  });

  // The IDOR shape: a caller with a legitimate project of their own, substituting
  // a video id out of somebody else's workspace. The `where` clause pairs the two
  // ids, so the lookup misses and the access check never even runs.
  it('returns 404 for a video id belonging to another workspace', async () => {
    const mine = await seedVideo();
    const theirs = await seedVideo();
    signedInAs(mine.owner);

    const response = await callRoute(
      patchVideo,
      apiRequest(videoUrl(mine.project.id, theirs.video.id), {
        method: 'PATCH',
        body: { title: 'renamed across the tenant boundary' },
      }),
      { projectId: mine.project.id, videoId: theirs.video.id }
    );

    expect(response.status).toBe(404);
    expect(await videoState(theirs.video.id)).toEqual({
      title: SEEDED_VIDEO_TITLE,
      description: SEEDED_DESCRIPTION,
    });
    expect(await videoState(mine.video.id)).toEqual({
      title: SEEDED_VIDEO_TITLE,
      description: SEEDED_DESCRIPTION,
    });
  });

  it('lets the project owner rename the video', async () => {
    const fixture = await seedVideo();
    signedInAs(fixture.owner);

    const response = await callRoute(
      patchVideo,
      apiRequest(videoUrl(fixture.project.id, fixture.video.id), {
        method: 'PATCH',
        body: { title: 'Renamed by the owner' },
      }),
      { projectId: fixture.project.id, videoId: fixture.video.id }
    );

    expect(response.status).toBe(200);
    expect(await videoState(fixture.video.id)).toEqual({
      title: 'Renamed by the owner',
      description: SEEDED_DESCRIPTION,
    });
  });

  it('lets a project ADMIN rename the video', async () => {
    const fixture = await seedVideo();
    const admin = await createUser();
    await addProjectMember({ projectId: fixture.project.id, userId: admin.id, role: 'ADMIN' });
    signedInAs(admin);

    const response = await callRoute(
      patchVideo,
      apiRequest(videoUrl(fixture.project.id, fixture.video.id), {
        method: 'PATCH',
        body: { title: 'Renamed by a project admin' },
      }),
      { projectId: fixture.project.id, videoId: fixture.video.id }
    );

    expect(response.status).toBe(200);
    expect(await videoState(fixture.video.id)).toEqual({
      title: 'Renamed by a project admin',
      description: SEEDED_DESCRIPTION,
    });
  });

  it('lets a workspace ADMIN rename the video', async () => {
    const fixture = await seedVideo();
    const workspaceAdmin = await createUser();
    await addWorkspaceMember({
      workspaceId: fixture.workspace.id,
      userId: workspaceAdmin.id,
      role: 'ADMIN',
    });
    signedInAs(workspaceAdmin);

    const response = await callRoute(
      patchVideo,
      apiRequest(videoUrl(fixture.project.id, fixture.video.id), {
        method: 'PATCH',
        body: { title: 'Renamed by a workspace admin' },
      }),
      { projectId: fixture.project.id, videoId: fixture.video.id }
    );

    expect(response.status).toBe(200);
    expect(await videoState(fixture.video.id)).toEqual({
      title: 'Renamed by a workspace admin',
      description: SEEDED_DESCRIPTION,
    });
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/projects/[projectId]/videos/[videoId]
// ---------------------------------------------------------------------------
describe('DELETE /api/projects/[projectId]/videos/[videoId]', () => {
  it('returns 403 to a signed-in stranger and keeps the video', async () => {
    const fixture = await seedVideo();
    await seedProject();
    const stranger = await createUser();
    signedInAs(stranger);

    const response = await callRoute(
      deleteVideo,
      apiRequest(videoUrl(fixture.project.id, fixture.video.id), { method: 'DELETE' }),
      { projectId: fixture.project.id, videoId: fixture.video.id }
    );

    expect(response.status).toBe(403);
    expect(await db.video.count({ where: { id: fixture.video.id } })).toBe(1);
    expect(await db.videoVersion.count({ where: { videoParentId: fixture.video.id } })).toBe(2);
  });

  it('returns 403 to a project COMMENTATOR and keeps the video', async () => {
    const fixture = await seedVideo();
    const commentator = await createUser();
    await addProjectMember({
      projectId: fixture.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await callRoute(
      deleteVideo,
      apiRequest(videoUrl(fixture.project.id, fixture.video.id), { method: 'DELETE' }),
      { projectId: fixture.project.id, videoId: fixture.video.id }
    );

    expect(response.status).toBe(403);
    expect(await db.video.count({ where: { id: fixture.video.id } })).toBe(1);
    expect(await db.videoVersion.count({ where: { videoParentId: fixture.video.id } })).toBe(2);
  });

  it('returns 403 to a workspace COMMENTATOR and keeps the video', async () => {
    const fixture = await seedVideo();
    const workspaceCommentator = await createUser();
    await addWorkspaceMember({
      workspaceId: fixture.workspace.id,
      userId: workspaceCommentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(workspaceCommentator);

    const response = await callRoute(
      deleteVideo,
      apiRequest(videoUrl(fixture.project.id, fixture.video.id), { method: 'DELETE' }),
      { projectId: fixture.project.id, videoId: fixture.video.id }
    );

    expect(response.status).toBe(403);
    expect(await db.video.count({ where: { id: fixture.video.id } })).toBe(1);
  });

  it('returns 403 to the owner once their own billing access has lapsed', async () => {
    const expiredOwner = await createExpiredUser();
    const fixture = await seedVideo({ ownerUser: expiredOwner });
    signedInAs(expiredOwner);

    const response = await callRoute(
      deleteVideo,
      apiRequest(videoUrl(fixture.project.id, fixture.video.id), { method: 'DELETE' }),
      { projectId: fixture.project.id, videoId: fixture.video.id }
    );

    expect(response.status).toBe(403);
    expect(await db.video.count({ where: { id: fixture.video.id } })).toBe(1);
  });

  it('returns 404 for a video id belonging to another workspace and keeps it', async () => {
    const mine = await seedVideo();
    const theirs = await seedVideo();
    signedInAs(mine.owner);

    const response = await callRoute(
      deleteVideo,
      apiRequest(videoUrl(mine.project.id, theirs.video.id), { method: 'DELETE' }),
      { projectId: mine.project.id, videoId: theirs.video.id }
    );

    expect(response.status).toBe(404);
    expect(await db.video.count({ where: { id: theirs.video.id } })).toBe(1);
    expect(await db.videoVersion.count({ where: { videoParentId: theirs.video.id } })).toBe(2);
  });

  it('lets the project owner delete the video and its versions', async () => {
    const fixture = await seedVideo();
    signedInAs(fixture.owner);

    const response = await callRoute(
      deleteVideo,
      apiRequest(videoUrl(fixture.project.id, fixture.video.id), { method: 'DELETE' }),
      { projectId: fixture.project.id, videoId: fixture.video.id }
    );

    expect(response.status).toBe(200);
    expect(await db.video.count({ where: { id: fixture.video.id } })).toBe(0);
    expect(await db.videoVersion.count({ where: { videoParentId: fixture.video.id } })).toBe(0);
  });

  it('lets a project ADMIN delete the video', async () => {
    const fixture = await seedVideo();
    const admin = await createUser();
    await addProjectMember({ projectId: fixture.project.id, userId: admin.id, role: 'ADMIN' });
    signedInAs(admin);

    const response = await callRoute(
      deleteVideo,
      apiRequest(videoUrl(fixture.project.id, fixture.video.id), { method: 'DELETE' }),
      { projectId: fixture.project.id, videoId: fixture.video.id }
    );

    expect(response.status).toBe(200);
    expect(await db.video.count({ where: { id: fixture.video.id } })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/projects/[projectId]/videos/[videoId]/versions/[versionId]
// ---------------------------------------------------------------------------
describe('PATCH /api/projects/[projectId]/videos/[videoId]/versions/[versionId]', () => {
  it('returns 403 to a signed-in stranger and leaves the label alone', async () => {
    const fixture = await seedVideo();
    await seedProject();
    const stranger = await createUser();
    signedInAs(stranger);

    const response = await callRoute(
      patchVersion,
      apiRequest(versionUrl(fixture.project.id, fixture.video.id, fixture.first.id), {
        method: 'PATCH',
        body: { versionLabel: 'relabelled by a stranger' },
      }),
      {
        projectId: fixture.project.id,
        videoId: fixture.video.id,
        versionId: fixture.first.id,
      }
    );

    expect(response.status).toBe(403);
    expect(
      (await db.videoVersion.findUniqueOrThrow({ where: { id: fixture.first.id } })).versionLabel
    ).toBe(SEEDED_LABEL_V1);
  });

  it('returns 403 to a project COMMENTATOR and leaves the label alone', async () => {
    const fixture = await seedVideo();
    const commentator = await createUser();
    await addProjectMember({
      projectId: fixture.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await callRoute(
      patchVersion,
      apiRequest(versionUrl(fixture.project.id, fixture.video.id, fixture.first.id), {
        method: 'PATCH',
        body: { versionLabel: 'relabelled by a commentator' },
      }),
      {
        projectId: fixture.project.id,
        videoId: fixture.video.id,
        versionId: fixture.first.id,
      }
    );

    expect(response.status).toBe(403);
    expect(
      (await db.videoVersion.findUniqueOrThrow({ where: { id: fixture.first.id } })).versionLabel
    ).toBe(SEEDED_LABEL_V1);
  });

  // `isActive: true` is the interesting payload for a COMMENTATOR: flipping which
  // version is live changes what every reviewer sees, without touching any text.
  it('returns 403 when a project COMMENTATOR tries to switch the active version', async () => {
    const fixture = await seedVideo();
    const commentator = await createUser();
    await addProjectMember({
      projectId: fixture.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await callRoute(
      patchVersion,
      apiRequest(versionUrl(fixture.project.id, fixture.video.id, fixture.second.id), {
        method: 'PATCH',
        body: { isActive: true },
      }),
      {
        projectId: fixture.project.id,
        videoId: fixture.video.id,
        versionId: fixture.second.id,
      }
    );

    expect(response.status).toBe(403);
    expect(
      (await db.videoVersion.findUniqueOrThrow({ where: { id: fixture.first.id } })).isActive
    ).toBe(true);
    expect(
      (await db.videoVersion.findUniqueOrThrow({ where: { id: fixture.second.id } })).isActive
    ).toBe(false);
  });

  it('returns 403 to a workspace COMMENTATOR and leaves the label alone', async () => {
    const fixture = await seedVideo();
    const workspaceCommentator = await createUser();
    await addWorkspaceMember({
      workspaceId: fixture.workspace.id,
      userId: workspaceCommentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(workspaceCommentator);

    const response = await callRoute(
      patchVersion,
      apiRequest(versionUrl(fixture.project.id, fixture.video.id, fixture.first.id), {
        method: 'PATCH',
        body: { versionLabel: 'relabelled by a workspace commentator' },
      }),
      {
        projectId: fixture.project.id,
        videoId: fixture.video.id,
        versionId: fixture.first.id,
      }
    );

    expect(response.status).toBe(403);
    expect(
      (await db.videoVersion.findUniqueOrThrow({ where: { id: fixture.first.id } })).versionLabel
    ).toBe(SEEDED_LABEL_V1);
  });

  it('returns 403 to the owner once their own billing access has lapsed', async () => {
    const expiredOwner = await createExpiredUser();
    const fixture = await seedVideo({ ownerUser: expiredOwner });
    signedInAs(expiredOwner);

    const response = await callRoute(
      patchVersion,
      apiRequest(versionUrl(fixture.project.id, fixture.video.id, fixture.first.id), {
        method: 'PATCH',
        body: { versionLabel: 'relabelled after the trial ran out' },
      }),
      {
        projectId: fixture.project.id,
        videoId: fixture.video.id,
        versionId: fixture.first.id,
      }
    );

    expect(response.status).toBe(403);
    expect(
      (await db.videoVersion.findUniqueOrThrow({ where: { id: fixture.first.id } })).versionLabel
    ).toBe(SEEDED_LABEL_V1);
  });

  // Full cross-tenant substitution: their video, their version, my projectId.
  // `getVersionWithAccess` finds the row by (versionId, videoParentId) and then
  // re-checks that the video really sits in the project from the URL, which is
  // the condition that turns this into a 404 instead of an edit.
  it('returns 404 for a version reached through another workspace video id', async () => {
    const mine = await seedVideo();
    const theirs = await seedVideo();
    signedInAs(mine.owner);

    const response = await callRoute(
      patchVersion,
      apiRequest(versionUrl(mine.project.id, theirs.video.id, theirs.first.id), {
        method: 'PATCH',
        body: { versionLabel: 'relabelled across the tenant boundary' },
      }),
      {
        projectId: mine.project.id,
        videoId: theirs.video.id,
        versionId: theirs.first.id,
      }
    );

    expect(response.status).toBe(404);
    expect(
      (await db.videoVersion.findUniqueOrThrow({ where: { id: theirs.first.id } })).versionLabel
    ).toBe(SEEDED_LABEL_V1);
  });

  // The other half of the substitution: my own project and my own video in the
  // path, only the version id borrowed. The lookup pairs versionId with
  // videoParentId, so it misses.
  it('returns 404 for a foreign version id pasted onto my own video', async () => {
    const mine = await seedVideo();
    const theirs = await seedVideo();
    signedInAs(mine.owner);

    const response = await callRoute(
      patchVersion,
      apiRequest(versionUrl(mine.project.id, mine.video.id, theirs.first.id), {
        method: 'PATCH',
        body: { versionLabel: 'relabelled by id substitution' },
      }),
      {
        projectId: mine.project.id,
        videoId: mine.video.id,
        versionId: theirs.first.id,
      }
    );

    expect(response.status).toBe(404);
    expect(
      (await db.videoVersion.findUniqueOrThrow({ where: { id: theirs.first.id } })).versionLabel
    ).toBe(SEEDED_LABEL_V1);
  });

  it('lets the project owner relabel a version', async () => {
    const fixture = await seedVideo();
    signedInAs(fixture.owner);

    const response = await callRoute(
      patchVersion,
      apiRequest(versionUrl(fixture.project.id, fixture.video.id, fixture.first.id), {
        method: 'PATCH',
        body: { versionLabel: 'Relabelled by the owner' },
      }),
      {
        projectId: fixture.project.id,
        videoId: fixture.video.id,
        versionId: fixture.first.id,
      }
    );

    expect(response.status).toBe(200);
    expect(
      (await db.videoVersion.findUniqueOrThrow({ where: { id: fixture.first.id } })).versionLabel
    ).toBe('Relabelled by the owner');
  });

  it('lets a workspace ADMIN switch the active version', async () => {
    const fixture = await seedVideo();
    const workspaceAdmin = await createUser();
    await addWorkspaceMember({
      workspaceId: fixture.workspace.id,
      userId: workspaceAdmin.id,
      role: 'ADMIN',
    });
    signedInAs(workspaceAdmin);

    const response = await callRoute(
      patchVersion,
      apiRequest(versionUrl(fixture.project.id, fixture.video.id, fixture.second.id), {
        method: 'PATCH',
        body: { isActive: true },
      }),
      {
        projectId: fixture.project.id,
        videoId: fixture.video.id,
        versionId: fixture.second.id,
      }
    );

    expect(response.status).toBe(200);
    expect(
      (await db.videoVersion.findUniqueOrThrow({ where: { id: fixture.second.id } })).isActive
    ).toBe(true);
    expect(
      (await db.videoVersion.findUniqueOrThrow({ where: { id: fixture.first.id } })).isActive
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/projects/[projectId]/videos/[videoId]/versions/[versionId]
// ---------------------------------------------------------------------------
describe('DELETE /api/projects/[projectId]/videos/[videoId]/versions/[versionId]', () => {
  it('returns 403 to a signed-in stranger and keeps both versions', async () => {
    const fixture = await seedVideo();
    await seedProject();
    const stranger = await createUser();
    signedInAs(stranger);

    const response = await callRoute(
      deleteVersion,
      apiRequest(versionUrl(fixture.project.id, fixture.video.id, fixture.first.id), {
        method: 'DELETE',
      }),
      {
        projectId: fixture.project.id,
        videoId: fixture.video.id,
        versionId: fixture.first.id,
      }
    );

    expect(response.status).toBe(403);
    expect(await db.videoVersion.count({ where: { videoParentId: fixture.video.id } })).toBe(2);
    expect(await db.videoVersion.count({ where: { id: fixture.first.id } })).toBe(1);
  });

  it('returns 403 to a project COMMENTATOR and keeps both versions', async () => {
    const fixture = await seedVideo();
    const commentator = await createUser();
    await addProjectMember({
      projectId: fixture.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await callRoute(
      deleteVersion,
      apiRequest(versionUrl(fixture.project.id, fixture.video.id, fixture.first.id), {
        method: 'DELETE',
      }),
      {
        projectId: fixture.project.id,
        videoId: fixture.video.id,
        versionId: fixture.first.id,
      }
    );

    expect(response.status).toBe(403);
    expect(await db.videoVersion.count({ where: { videoParentId: fixture.video.id } })).toBe(2);
  });

  it('returns 403 to a workspace COMMENTATOR and keeps both versions', async () => {
    const fixture = await seedVideo();
    const workspaceCommentator = await createUser();
    await addWorkspaceMember({
      workspaceId: fixture.workspace.id,
      userId: workspaceCommentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(workspaceCommentator);

    const response = await callRoute(
      deleteVersion,
      apiRequest(versionUrl(fixture.project.id, fixture.video.id, fixture.first.id), {
        method: 'DELETE',
      }),
      {
        projectId: fixture.project.id,
        videoId: fixture.video.id,
        versionId: fixture.first.id,
      }
    );

    expect(response.status).toBe(403);
    expect(await db.videoVersion.count({ where: { videoParentId: fixture.video.id } })).toBe(2);
  });

  it('returns 403 to the owner once their own billing access has lapsed', async () => {
    const expiredOwner = await createExpiredUser();
    const fixture = await seedVideo({ ownerUser: expiredOwner });
    signedInAs(expiredOwner);

    const response = await callRoute(
      deleteVersion,
      apiRequest(versionUrl(fixture.project.id, fixture.video.id, fixture.first.id), {
        method: 'DELETE',
      }),
      {
        projectId: fixture.project.id,
        videoId: fixture.video.id,
        versionId: fixture.first.id,
      }
    );

    expect(response.status).toBe(403);
    expect(await db.videoVersion.count({ where: { videoParentId: fixture.video.id } })).toBe(2);
  });

  it('returns 404 for a version reached through another workspace video id', async () => {
    const mine = await seedVideo();
    const theirs = await seedVideo();
    signedInAs(mine.owner);

    const response = await callRoute(
      deleteVersion,
      apiRequest(versionUrl(mine.project.id, theirs.video.id, theirs.first.id), {
        method: 'DELETE',
      }),
      {
        projectId: mine.project.id,
        videoId: theirs.video.id,
        versionId: theirs.first.id,
      }
    );

    expect(response.status).toBe(404);
    expect(await db.videoVersion.count({ where: { videoParentId: theirs.video.id } })).toBe(2);
  });

  it('returns 404 for a foreign version id pasted onto my own video', async () => {
    const mine = await seedVideo();
    const theirs = await seedVideo();
    signedInAs(mine.owner);

    const response = await callRoute(
      deleteVersion,
      apiRequest(versionUrl(mine.project.id, mine.video.id, theirs.first.id), { method: 'DELETE' }),
      {
        projectId: mine.project.id,
        videoId: mine.video.id,
        versionId: theirs.first.id,
      }
    );

    expect(response.status).toBe(404);
    expect(await db.videoVersion.count({ where: { id: theirs.first.id } })).toBe(1);
    expect(await db.videoVersion.count({ where: { videoParentId: mine.video.id } })).toBe(2);
  });

  // Positive control, and the reason every fixture above carries a spare version:
  // this is the branch that would otherwise answer 400 for everybody, authorized
  // or not, and make the whole block meaningless.
  it('lets the project owner delete a version and promotes the survivor', async () => {
    const fixture = await seedVideo();
    signedInAs(fixture.owner);

    const response = await callRoute(
      deleteVersion,
      apiRequest(versionUrl(fixture.project.id, fixture.video.id, fixture.first.id), {
        method: 'DELETE',
      }),
      {
        projectId: fixture.project.id,
        videoId: fixture.video.id,
        versionId: fixture.first.id,
      }
    );

    expect(response.status).toBe(200);
    expect(await db.videoVersion.count({ where: { id: fixture.first.id } })).toBe(0);
    expect(
      (await db.videoVersion.findUniqueOrThrow({ where: { id: fixture.second.id } })).isActive
    ).toBe(true);
  });

  it('lets a project ADMIN delete a version', async () => {
    const fixture = await seedVideo();
    const admin = await createUser();
    await addProjectMember({ projectId: fixture.project.id, userId: admin.id, role: 'ADMIN' });
    signedInAs(admin);

    const response = await callRoute(
      deleteVersion,
      apiRequest(versionUrl(fixture.project.id, fixture.video.id, fixture.second.id), {
        method: 'DELETE',
      }),
      {
        projectId: fixture.project.id,
        videoId: fixture.video.id,
        versionId: fixture.second.id,
      }
    );

    expect(response.status).toBe(200);
    expect(await db.videoVersion.count({ where: { videoParentId: fixture.video.id } })).toBe(1);
  });

  // The validation branch, pinned separately so it is obvious that the 403s above
  // are not this 400 wearing a different number. An authorized caller on a
  // single-version video gets 400; an unauthorized one never gets that far.
  it('returns 400 to the owner when only one version is left', async () => {
    const { owner, project } = await seedProject();
    const video = await createVideo({ projectId: project.id, title: SEEDED_VIDEO_TITLE });
    const only = await createVersion({
      videoParentId: video.id,
      versionNumber: 1,
      versionLabel: SEEDED_LABEL_V1,
      isActive: true,
    });
    signedInAs(owner);

    const response = await callRoute(
      deleteVersion,
      apiRequest(versionUrl(project.id, video.id, only.id), { method: 'DELETE' }),
      { projectId: project.id, videoId: video.id, versionId: only.id }
    );

    expect(response.status).toBe(400);
    expect(await db.videoVersion.count({ where: { id: only.id } })).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// POST /api/projects/[projectId]/videos/[videoId]/versions
// ---------------------------------------------------------------------------
// Adding a version is the write that everything else in the review flow hangs
// off, and it is gated on `canEdit` like the two handlers above.
describe('POST /api/projects/[projectId]/videos/[videoId]/versions', () => {
  it('returns 403 to a signed-in stranger and writes no version', async () => {
    const fixture = await seedVideo();
    await seedProject();
    const stranger = await createUser();
    signedInAs(stranger);

    const response = await callRoute(
      addVersion,
      apiRequest(`${videoUrl(fixture.project.id, fixture.video.id)}/versions`, {
        body: { videoUrl: YOUTUBE_URL, versionLabel: 'added by a stranger' },
      }),
      { projectId: fixture.project.id, videoId: fixture.video.id }
    );

    expect(response.status).toBe(403);
    expect(await db.videoVersion.count({ where: { videoParentId: fixture.video.id } })).toBe(2);
  });

  it('returns 403 to a project COMMENTATOR and writes no version', async () => {
    const fixture = await seedVideo();
    const commentator = await createUser();
    await addProjectMember({
      projectId: fixture.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await callRoute(
      addVersion,
      apiRequest(`${videoUrl(fixture.project.id, fixture.video.id)}/versions`, {
        body: { videoUrl: YOUTUBE_URL, versionLabel: 'added by a commentator' },
      }),
      { projectId: fixture.project.id, videoId: fixture.video.id }
    );

    expect(response.status).toBe(403);
    expect(await db.videoVersion.count({ where: { videoParentId: fixture.video.id } })).toBe(2);
  });

  it('returns 404 for a video id belonging to another workspace', async () => {
    const mine = await seedVideo();
    const theirs = await seedVideo();
    signedInAs(mine.owner);

    const response = await callRoute(
      addVersion,
      apiRequest(`${videoUrl(mine.project.id, theirs.video.id)}/versions`, {
        body: { videoUrl: YOUTUBE_URL, versionLabel: 'added across the tenant boundary' },
      }),
      { projectId: mine.project.id, videoId: theirs.video.id }
    );

    expect(response.status).toBe(404);
    expect(await db.videoVersion.count({ where: { videoParentId: theirs.video.id } })).toBe(2);
  });

  it('lets the project owner add a version', async () => {
    const fixture = await seedVideo();
    signedInAs(fixture.owner);

    const response = await callRoute(
      addVersion,
      apiRequest(`${videoUrl(fixture.project.id, fixture.video.id)}/versions`, {
        body: { videoUrl: YOUTUBE_URL, versionLabel: 'Added by the owner' },
      }),
      { projectId: fixture.project.id, videoId: fixture.video.id }
    );

    expect(response.status).toBe(201);
    expect(await db.videoVersion.count({ where: { videoParentId: fixture.video.id } })).toBe(3);
  });
});
