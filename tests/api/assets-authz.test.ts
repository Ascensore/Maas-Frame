// Authorization tests for the /api/videos/[videoId]/assets/* family, from callers
// who are signed in but not entitled.
//
// Every route in this family authorizes through one helper,
// `getVideoAssetAccessContext()` in lib/video-assets.ts, and then reads one of
// three flags off it: `hasViewAccess` to list, `canUploadAssets` to write, and
// `canDownloadAssets` to export. Before this file the only thing standing behind
// those flags was the anonymous sweep in tests/api/auth-matrix.test.ts, so
// collapsing all three onto `hasViewAccess`, or returning a context that is
// simply `{ hasViewAccess: true, canUploadAssets: true, ... }` for any signed-in
// caller, would not have failed a single test in the suite.
//
// Two details make these cases land on the guard rather than short of it.
//
//  - Each route checks the access context *before* it parses the body. So an
//    unauthorized caller gets 403 and an authorized caller sending the same
//    payload gets a 400 from the validation underneath. The positive controls
//    below deliberately stop on that 400: it is a status no unauthorized caller
//    can reach, which is what makes the 403 next to it mean something.
//
//  - The assets are YOUTUBE-provider rows. Deleting an R2 or Bunny asset sends
//    the handler off to object storage, and downloading one proxies the bytes;
//    a YouTube asset exercises the identical authorization path with no network
//    underneath it.

import { describe, expect, it } from 'vitest';
import type { Project, User, Video, VideoAsset, Workspace } from '@prisma/client';
import { db } from '@/lib/db';
import { GET as listAssets, POST as createAsset } from '@/app/api/videos/[videoId]/assets/route';
import { DELETE as deleteAsset } from '@/app/api/videos/[videoId]/assets/[assetId]/route';
import { GET as downloadAsset } from '@/app/api/videos/[videoId]/assets/[assetId]/download/route';
import { POST as initAssetBunnyUpload } from '@/app/api/videos/[videoId]/assets/bunny-init/route';
import { POST as initAssetR2Upload } from '@/app/api/videos/[videoId]/assets/r2-init/route';
import { apiRequest, callRoute, readData, readError } from '../helpers/request';
import { signedInAs } from '../helpers/session';
import {
  addProjectMember,
  addWorkspaceMember,
  createExpiredUser,
  createUser,
  createVideo,
  createVideoAsset,
  nextSeq,
  seedProject,
} from '../factories';

const SEEDED_ASSET_NAME = 'Seeded b-roll';

interface AssetFixture {
  owner: User;
  workspace: Workspace;
  project: Project;
  video: Video;
  /** Uploaded by the project owner, so a COMMENTATOR is not its author. */
  asset: VideoAsset;
}

async function seedAsset(
  input: { allowDownloads: boolean; ownerUser?: User } = { allowDownloads: false }
): Promise<AssetFixture> {
  const { owner, workspace, project } = await seedProject({
    ownerUser: input.ownerUser,
    visibility: 'PRIVATE',
    allowDownloads: input.allowDownloads,
  });
  const video = await createVideo({ projectId: project.id, title: 'Video with assets' });
  const asset = await createVideoAsset({
    videoId: video.id,
    billedUserId: owner.id,
    kind: 'VIDEO',
    provider: 'YOUTUBE',
    displayName: SEEDED_ASSET_NAME,
    sourceUrl: `https://www.youtube.com/watch?v=asset${nextSeq()}`,
    providerVideoId: `asset-provider-${nextSeq()}`,
    uploadedByUserId: owner.id,
  });

  return { owner, workspace, project, video, asset };
}

function assetsUrl(videoId: string): string {
  return `/api/videos/${videoId}/assets`;
}

function assetUrl(videoId: string, assetId: string): string {
  return `${assetsUrl(videoId)}/${assetId}`;
}

// ---------------------------------------------------------------------------
// GET /api/videos/[videoId]/assets
// ---------------------------------------------------------------------------
describe('GET /api/videos/[videoId]/assets', () => {
  it('returns 403 to a signed-in stranger with their own unrelated workspace', async () => {
    const fixture = await seedAsset();
    await seedProject();
    const stranger = await createUser();
    signedInAs(stranger);

    const response = await callRoute(listAssets, apiRequest(assetsUrl(fixture.video.id)), {
      videoId: fixture.video.id,
    });

    expect(response.status).toBe(403);
  });

  it('returns 403 to a project COMMENTATOR once the workspace owner loses billing', async () => {
    const expiredOwner = await createExpiredUser();
    const fixture = await seedAsset({ allowDownloads: true, ownerUser: expiredOwner });
    const commentator = await createUser();
    await addProjectMember({
      projectId: fixture.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await callRoute(listAssets, apiRequest(assetsUrl(fixture.video.id)), {
      videoId: fixture.video.id,
    });

    expect(response.status).toBe(403);
  });

  it('lets a project COMMENTATOR list the assets', async () => {
    const fixture = await seedAsset();
    const commentator = await createUser();
    await addProjectMember({
      projectId: fixture.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await callRoute(listAssets, apiRequest(assetsUrl(fixture.video.id)), {
      videoId: fixture.video.id,
    });

    expect(response.status).toBe(200);
    const payload = await readData<{ assets: Array<{ id: string }> }>(response);
    expect(payload.assets.map((asset) => asset.id)).toEqual([fixture.asset.id]);
  });
});

// ---------------------------------------------------------------------------
// POST /api/videos/[videoId]/assets
// ---------------------------------------------------------------------------
// `canUploadAssets` is intentionally generous: a COMMENTATOR is meant to be able
// to attach a reference clip. Generous is not the same as open, and the cases
// below are the difference.
describe('POST /api/videos/[videoId]/assets', () => {
  it('returns 403 to a signed-in stranger and writes no asset', async () => {
    const fixture = await seedAsset();
    await seedProject();
    const stranger = await createUser();
    signedInAs(stranger);

    const response = await callRoute(
      createAsset,
      apiRequest(assetsUrl(fixture.video.id), {
        body: { provider: 'YOUTUBE', sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
      }),
      { videoId: fixture.video.id }
    );

    expect(response.status).toBe(403);
    expect(await db.videoAsset.count()).toBe(1);
  });

  it('returns 403 to a project COMMENTATOR once the workspace owner loses billing', async () => {
    const expiredOwner = await createExpiredUser();
    const fixture = await seedAsset({ allowDownloads: false, ownerUser: expiredOwner });
    const commentator = await createUser();
    await addProjectMember({
      projectId: fixture.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await callRoute(
      createAsset,
      apiRequest(assetsUrl(fixture.video.id), {
        body: { provider: 'YOUTUBE', sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
      }),
      { videoId: fixture.video.id }
    );

    expect(response.status).toBe(403);
    expect(await db.videoAsset.count()).toBe(1);
  });

  // The IDOR shape: a caller who legitimately uploads assets to their own video,
  // aiming the same request at a video id out of another workspace.
  it('returns 403 for a video id belonging to another workspace', async () => {
    const mine = await seedAsset();
    const theirs = await seedAsset();
    signedInAs(mine.owner);

    const response = await callRoute(
      createAsset,
      apiRequest(assetsUrl(theirs.video.id), {
        body: { provider: 'YOUTUBE', sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
      }),
      { videoId: theirs.video.id }
    );

    expect(response.status).toBe(403);
    expect(await db.videoAsset.count({ where: { videoId: theirs.video.id } })).toBe(1);
  });

  // The positive control. The access check runs before the body is parsed, so an
  // authorized COMMENTATOR sending a deliberately bogus provider gets the 400
  // from the validation underneath. 400 is a status the three refusals above
  // cannot produce, which is what proves they came from the guard.
  it('gets a project COMMENTATOR past the access check and onto body validation', async () => {
    const fixture = await seedAsset();
    const commentator = await createUser();
    await addProjectMember({
      projectId: fixture.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await callRoute(
      createAsset,
      apiRequest(assetsUrl(fixture.video.id), { body: { provider: 'NOT_A_REAL_PROVIDER' } }),
      { videoId: fixture.video.id }
    );

    expect(response.status).toBe(400);
    expect(await readError(response)).toContain('Invalid provider');
    expect(await db.videoAsset.count()).toBe(1);
  });

  // And the same probe from the stranger, to show the ordering is real: identical
  // body, identical URL, and the guard answers first.
  it('still returns 403 to a stranger sending the same invalid body', async () => {
    const fixture = await seedAsset();
    const stranger = await createUser();
    signedInAs(stranger);

    const response = await callRoute(
      createAsset,
      apiRequest(assetsUrl(fixture.video.id), { body: { provider: 'NOT_A_REAL_PROVIDER' } }),
      { videoId: fixture.video.id }
    );

    expect(response.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/videos/[videoId]/assets/[assetId]
// ---------------------------------------------------------------------------
// Two gates in sequence: `canUploadAssets` to be in the room at all, then
// `canDeleteAssetForViewer` which lets a COMMENTATOR remove only what they
// uploaded themselves. Both need their own negative case, because collapsing the
// second one is invisible from outside unless a test actually seeds an asset that
// belongs to somebody else.
describe('DELETE /api/videos/[videoId]/assets/[assetId]', () => {
  it('returns 403 to a signed-in stranger and keeps the asset', async () => {
    const fixture = await seedAsset();
    await seedProject();
    const stranger = await createUser();
    signedInAs(stranger);

    const response = await callRoute(
      deleteAsset,
      apiRequest(assetUrl(fixture.video.id, fixture.asset.id), { method: 'DELETE' }),
      { videoId: fixture.video.id, assetId: fixture.asset.id }
    );

    expect(response.status).toBe(403);
    expect(await db.videoAsset.count({ where: { id: fixture.asset.id } })).toBe(1);
  });

  // The second gate. This caller is a legitimate member who may upload assets of
  // their own; what they may not do is delete the owner's.
  it("returns 403 when a project COMMENTATOR deletes somebody else's asset", async () => {
    const fixture = await seedAsset();
    const commentator = await createUser();
    await addProjectMember({
      projectId: fixture.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await callRoute(
      deleteAsset,
      apiRequest(assetUrl(fixture.video.id, fixture.asset.id), { method: 'DELETE' }),
      { videoId: fixture.video.id, assetId: fixture.asset.id }
    );

    expect(response.status).toBe(403);
    expect(await readError(response)).toContain('only delete assets you uploaded');
    expect(await db.videoAsset.count({ where: { id: fixture.asset.id } })).toBe(1);
  });

  it("returns 403 when a workspace COMMENTATOR deletes the owner's asset", async () => {
    const fixture = await seedAsset();
    const workspaceCommentator = await createUser();
    await addWorkspaceMember({
      workspaceId: fixture.workspace.id,
      userId: workspaceCommentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(workspaceCommentator);

    const response = await callRoute(
      deleteAsset,
      apiRequest(assetUrl(fixture.video.id, fixture.asset.id), { method: 'DELETE' }),
      { videoId: fixture.video.id, assetId: fixture.asset.id }
    );

    expect(response.status).toBe(403);
    expect(await db.videoAsset.count({ where: { id: fixture.asset.id } })).toBe(1);
  });

  it('returns 403 to the owner once their own billing access has lapsed', async () => {
    const expiredOwner = await createExpiredUser();
    const fixture = await seedAsset({ allowDownloads: false, ownerUser: expiredOwner });
    signedInAs(expiredOwner);

    const response = await callRoute(
      deleteAsset,
      apiRequest(assetUrl(fixture.video.id, fixture.asset.id), { method: 'DELETE' }),
      { videoId: fixture.video.id, assetId: fixture.asset.id }
    );

    expect(response.status).toBe(403);
    expect(await db.videoAsset.count({ where: { id: fixture.asset.id } })).toBe(1);
  });

  // Identifier substitution against a route the caller does legitimately reach:
  // their own videoId in the path, somebody else's assetId in the query. The
  // lookup pairs the two, so it misses.
  it('returns 404 for a foreign asset id pasted onto my own video', async () => {
    const mine = await seedAsset();
    const theirs = await seedAsset();
    signedInAs(mine.owner);

    const response = await callRoute(
      deleteAsset,
      apiRequest(assetUrl(mine.video.id, theirs.asset.id), { method: 'DELETE' }),
      { videoId: mine.video.id, assetId: theirs.asset.id }
    );

    expect(response.status).toBe(404);
    expect(await db.videoAsset.count({ where: { id: theirs.asset.id } })).toBe(1);
    expect(await db.videoAsset.count({ where: { id: mine.asset.id } })).toBe(1);
  });

  // The matching pair with both foreign ids, which is the request an attacker who
  // has read an id out of a shared link would actually send. Here the row is
  // found, so the refusal has to come from the access context.
  it('returns 403 for a foreign asset reached through its own foreign video id', async () => {
    const mine = await seedAsset();
    const theirs = await seedAsset();
    signedInAs(mine.owner);

    const response = await callRoute(
      deleteAsset,
      apiRequest(assetUrl(theirs.video.id, theirs.asset.id), { method: 'DELETE' }),
      { videoId: theirs.video.id, assetId: theirs.asset.id }
    );

    expect(response.status).toBe(403);
    expect(await db.videoAsset.count({ where: { id: theirs.asset.id } })).toBe(1);
  });

  it('lets the project owner delete the asset', async () => {
    const fixture = await seedAsset();
    signedInAs(fixture.owner);

    const response = await callRoute(
      deleteAsset,
      apiRequest(assetUrl(fixture.video.id, fixture.asset.id), { method: 'DELETE' }),
      { videoId: fixture.video.id, assetId: fixture.asset.id }
    );

    expect(response.status).toBe(200);
    expect(await db.videoAsset.count({ where: { id: fixture.asset.id } })).toBe(0);
  });

  // The positive control for the second gate specifically: same role, same route,
  // and the only thing that changed is who uploaded the row.
  it('lets a project COMMENTATOR delete an asset they uploaded themselves', async () => {
    const fixture = await seedAsset();
    const commentator = await createUser();
    await addProjectMember({
      projectId: fixture.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    const own = await createVideoAsset({
      videoId: fixture.video.id,
      billedUserId: fixture.owner.id,
      kind: 'VIDEO',
      provider: 'YOUTUBE',
      displayName: 'Uploaded by the commentator',
      sourceUrl: `https://www.youtube.com/watch?v=own${nextSeq()}`,
      uploadedByUserId: commentator.id,
    });
    signedInAs(commentator);

    const response = await callRoute(
      deleteAsset,
      apiRequest(assetUrl(fixture.video.id, own.id), { method: 'DELETE' }),
      { videoId: fixture.video.id, assetId: own.id }
    );

    expect(response.status).toBe(200);
    expect(await db.videoAsset.count({ where: { id: own.id } })).toBe(0);
    // The owner's asset was never in scope and is still there.
    expect(await db.videoAsset.count({ where: { id: fixture.asset.id } })).toBe(1);
  });

  it("lets a project ADMIN delete the owner's asset", async () => {
    const fixture = await seedAsset();
    const admin = await createUser();
    await addProjectMember({ projectId: fixture.project.id, userId: admin.id, role: 'ADMIN' });
    signedInAs(admin);

    const response = await callRoute(
      deleteAsset,
      apiRequest(assetUrl(fixture.video.id, fixture.asset.id), { method: 'DELETE' }),
      { videoId: fixture.video.id, assetId: fixture.asset.id }
    );

    expect(response.status).toBe(200);
    expect(await db.videoAsset.count({ where: { id: fixture.asset.id } })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GET /api/videos/[videoId]/assets/[assetId]/download
// ---------------------------------------------------------------------------
// Two refusals with two different messages: `hasViewAccess` for people who should
// not see the video at all, and `canDownloadAssets` for members of a project whose
// owner has turned exports off. Both are pinned, because merging them would look
// like a tidy-up and would quietly hand the files to every viewer.
describe('GET /api/videos/[videoId]/assets/[assetId]/download', () => {
  // 404 rather than 403 for a caller with no relationship to the project: a 403 confirms
  // the id exists. The comment export route has always answered 404 for the identical
  // shape, and the three download paths now agree.
  it('returns 404 to a signed-in stranger', async () => {
    const fixture = await seedAsset({ allowDownloads: true });
    await seedProject();
    const stranger = await createUser();
    signedInAs(stranger);

    const response = await callRoute(
      downloadAsset,
      apiRequest(`${assetUrl(fixture.video.id, fixture.asset.id)}/download`),
      { videoId: fixture.video.id, assetId: fixture.asset.id }
    );

    expect(response.status).toBe(404);
  });

  it('returns 403 to a project COMMENTATOR when downloads are disabled', async () => {
    const fixture = await seedAsset({ allowDownloads: false });
    const commentator = await createUser();
    await addProjectMember({
      projectId: fixture.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await callRoute(
      downloadAsset,
      apiRequest(`${assetUrl(fixture.video.id, fixture.asset.id)}/download`),
      { videoId: fixture.video.id, assetId: fixture.asset.id }
    );

    expect(response.status).toBe(403);
    expect(await readError(response)).toContain('Downloads are disabled');
  });

  // Positive control: same COMMENTATOR, same asset, allowDownloads flipped on.
  // The request now clears both gates and stops on the provider check, a 400 that
  // neither refusal above can produce.
  it('gets the same COMMENTATOR past both gates once allowDownloads is on', async () => {
    const fixture = await seedAsset({ allowDownloads: true });
    const commentator = await createUser();
    await addProjectMember({
      projectId: fixture.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await callRoute(
      downloadAsset,
      apiRequest(`${assetUrl(fixture.video.id, fixture.asset.id)}/download`),
      { videoId: fixture.video.id, assetId: fixture.asset.id }
    );

    expect(response.status).toBe(400);
    expect(await readError(response)).toContain('YouTube assets cannot be downloaded');
  });

  it('gets the owner past both gates even when allowDownloads is off', async () => {
    const fixture = await seedAsset({ allowDownloads: false });
    signedInAs(fixture.owner);

    const response = await callRoute(
      downloadAsset,
      apiRequest(`${assetUrl(fixture.video.id, fixture.asset.id)}/download`),
      { videoId: fixture.video.id, assetId: fixture.asset.id }
    );

    expect(response.status).toBe(400);
    expect(await readError(response)).toContain('YouTube assets cannot be downloaded');
  });

  it('returns 404 for a foreign asset id pasted onto my own video', async () => {
    const mine = await seedAsset({ allowDownloads: true });
    const theirs = await seedAsset({ allowDownloads: true });
    signedInAs(mine.owner);

    const response = await callRoute(
      downloadAsset,
      apiRequest(`${assetUrl(mine.video.id, theirs.asset.id)}/download`),
      { videoId: mine.video.id, assetId: theirs.asset.id }
    );

    expect(response.status).toBe(404);
  });

  it('returns 404 for a foreign asset reached through its own foreign video id', async () => {
    const mine = await seedAsset({ allowDownloads: true });
    const theirs = await seedAsset({ allowDownloads: true });
    signedInAs(mine.owner);

    const response = await callRoute(
      downloadAsset,
      apiRequest(`${assetUrl(theirs.video.id, theirs.asset.id)}/download`),
      { videoId: theirs.video.id, assetId: theirs.asset.id }
    );

    expect(response.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// The two upload-init routes
// ---------------------------------------------------------------------------
// Both hand out an upload credential, so a caller who gets through them can spend
// the workspace owner's storage quota. Direct uploads are unconfigured in the test
// environment, which is what gives each of these a positive control that stops one
// step past the guard without touching a provider.
describe('POST /api/videos/[videoId]/assets/r2-init', () => {
  it('returns 403 to a signed-in stranger and reserves nothing', async () => {
    const fixture = await seedAsset();
    await seedProject();
    const stranger = await createUser();
    signedInAs(stranger);

    const response = await callRoute(
      initAssetR2Upload,
      apiRequest(`${assetsUrl(fixture.video.id)}/r2-init`, {
        body: { fileName: 'clip.mp4', sizeBytes: '1024', contentType: 'video/mp4' },
      }),
      { videoId: fixture.video.id }
    );

    expect(response.status).toBe(403);
    expect(await db.uploadReservation.count()).toBe(0);
  });

  it('returns 403 for a video id belonging to another workspace', async () => {
    const mine = await seedAsset();
    const theirs = await seedAsset();
    signedInAs(mine.owner);

    const response = await callRoute(
      initAssetR2Upload,
      apiRequest(`${assetsUrl(theirs.video.id)}/r2-init`, {
        body: { fileName: 'clip.mp4', sizeBytes: '1024', contentType: 'video/mp4' },
      }),
      { videoId: theirs.video.id }
    );

    expect(response.status).toBe(403);
    expect(await db.uploadReservation.count()).toBe(0);
  });

  it('gets a project COMMENTATOR past the access check onto the disabled-feature check', async () => {
    const fixture = await seedAsset();
    const commentator = await createUser();
    await addProjectMember({
      projectId: fixture.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await callRoute(
      initAssetR2Upload,
      apiRequest(`${assetsUrl(fixture.video.id)}/r2-init`, {
        body: { fileName: 'clip.mp4', sizeBytes: '1024', contentType: 'video/mp4' },
      }),
      { videoId: fixture.video.id }
    );

    expect(response.status).toBe(400);
    expect(await readError(response)).toContain('S3 video uploads are disabled');
    expect(await db.uploadReservation.count()).toBe(0);
  });
});

describe('POST /api/videos/[videoId]/assets/bunny-init', () => {
  it('returns 403 to a signed-in stranger', async () => {
    const fixture = await seedAsset();
    await seedProject();
    const stranger = await createUser();
    signedInAs(stranger);

    const response = await callRoute(
      initAssetBunnyUpload,
      apiRequest(`${assetsUrl(fixture.video.id)}/bunny-init`, { body: { title: 'A clip' } }),
      { videoId: fixture.video.id }
    );

    expect(response.status).toBe(403);
  });

  it('returns 403 to a project COMMENTATOR once the workspace owner loses billing', async () => {
    const expiredOwner = await createExpiredUser();
    const fixture = await seedAsset({ allowDownloads: false, ownerUser: expiredOwner });
    const commentator = await createUser();
    await addProjectMember({
      projectId: fixture.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await callRoute(
      initAssetBunnyUpload,
      apiRequest(`${assetsUrl(fixture.video.id)}/bunny-init`, { body: { title: 'A clip' } }),
      { videoId: fixture.video.id }
    );

    expect(response.status).toBe(403);
  });

  it('gets a project COMMENTATOR past the access check onto the disabled-feature check', async () => {
    const fixture = await seedAsset();
    const commentator = await createUser();
    await addProjectMember({
      projectId: fixture.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await callRoute(
      initAssetBunnyUpload,
      apiRequest(`${assetsUrl(fixture.video.id)}/bunny-init`, { body: { title: 'A clip' } }),
      { videoId: fixture.video.id }
    );

    expect(response.status).toBe(400);
    expect(await readError(response)).toContain('Direct uploads are disabled');
  });
});
