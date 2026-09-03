import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import {
  GET as listProfiles,
  POST as createProfileRoute,
} from '@/app/api/workspaces/[workspaceId]/rough-cut-profiles/route';
import {
  DELETE as deleteProfileRoute,
  PATCH as patchProfileRoute,
} from '@/app/api/workspaces/[workspaceId]/rough-cut-profiles/[profileId]/route';
import { PATCH as patchFolder } from '@/app/api/projects/[projectId]/folders/[folderId]/route';
import { GET as listFolders } from '@/app/api/projects/[projectId]/folders/route';
import { apiRequest, callRoute, readData } from '../helpers/request';
import { signedInAs, signedOut } from '../helpers/session';
import {
  addWorkspaceMember,
  createFolder,
  createRoughCutProfile,
  createUser,
  createWorkspace,
  seedProject,
} from '../factories';

function profilesUrl(workspaceId: string) {
  return `/api/workspaces/${workspaceId}/rough-cut-profiles`;
}

function profileUrl(workspaceId: string, profileId: string) {
  return `${profilesUrl(workspaceId)}/${profileId}`;
}

describe('GET /api/workspaces/[workspaceId]/rough-cut-profiles', () => {
  it('returns 401 to an anonymous caller', async () => {
    const { workspace } = await seedProject();
    signedOut();
    const response = await callRoute(listProfiles, apiRequest(profilesUrl(workspace.id)), {
      workspaceId: workspace.id,
    });
    expect(response.status).toBe(401);
  });

  it('returns 403 to a signed-in stranger', async () => {
    const { workspace } = await seedProject();
    const stranger = await createUser();
    signedInAs(stranger);
    const response = await callRoute(listProfiles, apiRequest(profilesUrl(workspace.id)), {
      workspaceId: workspace.id,
    });
    expect(response.status).toBe(403);
    expect(await db.roughCutProfile.count({ where: { workspaceId: workspace.id } })).toBe(0);
  });

  it('lists profiles for a workspace commentator', async () => {
    const owner = await createUser();
    const workspace = await createWorkspace({ ownerId: owner.id });
    const profile = await createRoughCutProfile({
      workspaceId: workspace.id,
      name: 'Interview',
    });
    const commentator = await createUser();
    await addWorkspaceMember({
      workspaceId: workspace.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const payload = await readData<{ profiles: Array<{ id: string; name: string }> }>(
      await callRoute(listProfiles, apiRequest(profilesUrl(workspace.id)), {
        workspaceId: workspace.id,
      })
    );
    expect(payload.profiles).toEqual([
      expect.objectContaining({ id: profile.id, name: 'Interview' }),
    ]);
  });
});

describe('POST /api/workspaces/[workspaceId]/rough-cut-profiles', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 401 to an anonymous caller and writes no row', async () => {
    const { workspace } = await seedProject();
    signedOut();
    vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'true');

    const response = await callRoute(
      createProfileRoute,
      apiRequest(profilesUrl(workspace.id), { body: { name: 'Interview' } }),
      { workspaceId: workspace.id }
    );
    expect(response.status).toBe(401);
    expect(await db.roughCutProfile.count({ where: { workspaceId: workspace.id } })).toBe(0);
  });

  it('returns 403 to a workspace commentator and writes no row', async () => {
    const owner = await createUser();
    const workspace = await createWorkspace({ ownerId: owner.id });
    const commentator = await createUser();
    await addWorkspaceMember({
      workspaceId: workspace.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);
    vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'true');

    const response = await callRoute(
      createProfileRoute,
      apiRequest(profilesUrl(workspace.id), { body: { name: 'Interview' } }),
      { workspaceId: workspace.id }
    );
    expect(response.status).toBe(403);
    expect(await db.roughCutProfile.count({ where: { workspaceId: workspace.id } })).toBe(0);
  });

  it('creates a profile for the workspace owner', async () => {
    const owner = await createUser();
    const workspace = await createWorkspace({ ownerId: owner.id });
    signedInAs(owner);
    vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'true');

    const response = await callRoute(
      createProfileRoute,
      apiRequest(profilesUrl(workspace.id), {
        body: {
          name: 'Interview',
          minShotSeconds: 2,
          overlapBehaviour: 'HOLD',
          isDefault: true,
        },
      }),
      { workspaceId: workspace.id }
    );
    expect(response.status).toBe(201);
    const payload = await readData<{
      profile: { id: string; name: string; minShotSeconds: number; overlapBehaviour: string };
    }>(response);
    expect(payload.profile.name).toBe('Interview');
    expect(payload.profile.minShotSeconds).toBe(2);
    expect(payload.profile.overlapBehaviour).toBe('HOLD');

    const row = await db.roughCutProfile.findUnique({ where: { id: payload.profile.id } });
    expect(row).not.toBeNull();
    expect(row?.workspaceId).toBe(workspace.id);
    expect(row?.isDefault).toBe(true);
  });

  it('clears the previous default when a second profile is marked default', async () => {
    const owner = await createUser();
    const workspace = await createWorkspace({ ownerId: owner.id });
    const first = await createRoughCutProfile({
      workspaceId: workspace.id,
      name: 'First',
      isDefault: true,
    });
    signedInAs(owner);
    vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'true');

    const response = await callRoute(
      createProfileRoute,
      apiRequest(profilesUrl(workspace.id), {
        body: { name: 'Second', isDefault: true },
      }),
      { workspaceId: workspace.id }
    );
    expect(response.status).toBe(201);
    const created = await readData<{ profile: { id: string } }>(response);
    const firstAfter = await db.roughCutProfile.findUnique({ where: { id: first.id } });
    const second = await db.roughCutProfile.findUnique({ where: { id: created.profile.id } });
    expect(firstAfter?.isDefault).toBe(false);
    expect(second?.isDefault).toBe(true);
  });

  it('returns 403 when the feature flag is off and writes no row', async () => {
    const owner = await createUser();
    const workspace = await createWorkspace({ ownerId: owner.id });
    signedInAs(owner);
    vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'false');

    const response = await callRoute(
      createProfileRoute,
      apiRequest(profilesUrl(workspace.id), { body: { name: 'Interview' } }),
      { workspaceId: workspace.id }
    );
    expect(response.status).toBe(403);
    expect(await db.roughCutProfile.count({ where: { workspaceId: workspace.id } })).toBe(0);
  });
});

describe('PATCH /api/workspaces/[workspaceId]/rough-cut-profiles/[profileId]', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 401 to an anonymous caller and leaves the row unchanged', async () => {
    const owner = await createUser();
    const workspace = await createWorkspace({ ownerId: owner.id });
    const profile = await createRoughCutProfile({ workspaceId: workspace.id, name: 'Keep me' });
    signedOut();
    vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'true');

    const response = await callRoute(
      patchProfileRoute,
      apiRequest(profileUrl(workspace.id, profile.id), { body: { name: 'Hijacked' } }),
      { workspaceId: workspace.id, profileId: profile.id }
    );
    expect(response.status).toBe(401);
    const row = await db.roughCutProfile.findUnique({ where: { id: profile.id } });
    expect(row?.name).toBe('Keep me');
  });

  it('returns 403 to a commentator and leaves the row unchanged', async () => {
    const owner = await createUser();
    const workspace = await createWorkspace({ ownerId: owner.id });
    const commentator = await createUser();
    await addWorkspaceMember({
      workspaceId: workspace.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    const profile = await createRoughCutProfile({ workspaceId: workspace.id, name: 'Keep me' });
    signedInAs(commentator);
    vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'true');

    const response = await callRoute(
      patchProfileRoute,
      apiRequest(profileUrl(workspace.id, profile.id), { body: { name: 'Hijacked' } }),
      { workspaceId: workspace.id, profileId: profile.id }
    );
    expect(response.status).toBe(403);
    const row = await db.roughCutProfile.findUnique({ where: { id: profile.id } });
    expect(row?.name).toBe('Keep me');
  });

  it('patches a profile for the workspace owner', async () => {
    const owner = await createUser();
    const workspace = await createWorkspace({ ownerId: owner.id });
    const profile = await createRoughCutProfile({ workspaceId: workspace.id, name: 'Draft' });
    signedInAs(owner);
    vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'true');

    const response = await callRoute(
      patchProfileRoute,
      apiRequest(profileUrl(workspace.id, profile.id), {
        body: { name: 'Live', maxShotSeconds: 12 },
      }),
      { workspaceId: workspace.id, profileId: profile.id }
    );
    expect(response.status).toBe(200);
    const row = await db.roughCutProfile.findUnique({ where: { id: profile.id } });
    expect(row?.name).toBe('Live');
    expect(row?.maxShotSeconds).toBe(12);
  });

  it('returns 403 when the feature flag is off and leaves the row unchanged', async () => {
    const owner = await createUser();
    const workspace = await createWorkspace({ ownerId: owner.id });
    const profile = await createRoughCutProfile({ workspaceId: workspace.id, name: 'Keep me' });
    signedInAs(owner);
    vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'false');

    const response = await callRoute(
      patchProfileRoute,
      apiRequest(profileUrl(workspace.id, profile.id), { body: { name: 'Hijacked' } }),
      { workspaceId: workspace.id, profileId: profile.id }
    );
    expect(response.status).toBe(403);
    const row = await db.roughCutProfile.findUnique({ where: { id: profile.id } });
    expect(row?.name).toBe('Keep me');
  });
});

describe('DELETE /api/workspaces/[workspaceId]/rough-cut-profiles/[profileId]', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 401 to an anonymous caller and leaves the row', async () => {
    const owner = await createUser();
    const workspace = await createWorkspace({ ownerId: owner.id });
    const profile = await createRoughCutProfile({ workspaceId: workspace.id });
    signedOut();
    vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'true');

    const response = await callRoute(
      deleteProfileRoute,
      apiRequest(profileUrl(workspace.id, profile.id), { method: 'DELETE' }),
      { workspaceId: workspace.id, profileId: profile.id }
    );
    expect(response.status).toBe(401);
    expect(await db.roughCutProfile.findUnique({ where: { id: profile.id } })).not.toBeNull();
  });

  it('returns 403 to a commentator and leaves the row', async () => {
    const owner = await createUser();
    const workspace = await createWorkspace({ ownerId: owner.id });
    const commentator = await createUser();
    await addWorkspaceMember({
      workspaceId: workspace.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    const profile = await createRoughCutProfile({ workspaceId: workspace.id });
    signedInAs(commentator);
    vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'true');

    const response = await callRoute(
      deleteProfileRoute,
      apiRequest(profileUrl(workspace.id, profile.id), { method: 'DELETE' }),
      { workspaceId: workspace.id, profileId: profile.id }
    );
    expect(response.status).toBe(403);
    expect(await db.roughCutProfile.findUnique({ where: { id: profile.id } })).not.toBeNull();
  });

  it('deletes a profile for the workspace owner', async () => {
    const owner = await createUser();
    const workspace = await createWorkspace({ ownerId: owner.id });
    const profile = await createRoughCutProfile({ workspaceId: workspace.id });
    signedInAs(owner);
    vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'true');

    const response = await callRoute(
      deleteProfileRoute,
      apiRequest(profileUrl(workspace.id, profile.id), { method: 'DELETE' }),
      { workspaceId: workspace.id, profileId: profile.id }
    );
    expect(response.status).toBe(200);
    expect(await db.roughCutProfile.findUnique({ where: { id: profile.id } })).toBeNull();
  });

  it('returns 403 when the feature flag is off and leaves the row', async () => {
    const owner = await createUser();
    const workspace = await createWorkspace({ ownerId: owner.id });
    const profile = await createRoughCutProfile({ workspaceId: workspace.id });
    signedInAs(owner);
    vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'false');

    const response = await callRoute(
      deleteProfileRoute,
      apiRequest(profileUrl(workspace.id, profile.id), { method: 'DELETE' }),
      { workspaceId: workspace.id, profileId: profile.id }
    );
    expect(response.status).toBe(403);
    expect(await db.roughCutProfile.findUnique({ where: { id: profile.id } })).not.toBeNull();
  });
});

describe('PATCH /api/projects/[projectId]/folders/[folderId] roughCutProfileId', () => {
  it('binds a folder to a workspace profile', async () => {
    const scenario = await seedProject();
    const folder = await createFolder({ projectId: scenario.project.id, name: 'A-cam' });
    const profile = await createRoughCutProfile({
      workspaceId: scenario.workspace.id,
      name: 'Interview',
    });
    signedInAs(scenario.owner);

    const response = await callRoute(
      patchFolder,
      apiRequest(`/api/projects/${scenario.project.id}/folders/${folder.id}`, {
        body: { roughCutProfileId: profile.id },
      }),
      { projectId: scenario.project.id, folderId: folder.id }
    );
    expect(response.status).toBe(200);
    const row = await db.folder.findUnique({ where: { id: folder.id } });
    expect(row?.roughCutProfileId).toBe(profile.id);

    const listed = await readData<{
      folders: Array<{ id: string; roughCutProfileId: string | null }>;
    }>(
      await callRoute(listFolders, apiRequest(`/api/projects/${scenario.project.id}/folders`), {
        projectId: scenario.project.id,
      })
    );
    expect(listed.folders.find((entry) => entry.id === folder.id)?.roughCutProfileId).toBe(
      profile.id
    );
  });

  it('clears a folder profile binding with null', async () => {
    const scenario = await seedProject();
    const profile = await createRoughCutProfile({ workspaceId: scenario.workspace.id });
    const folder = await createFolder({
      projectId: scenario.project.id,
      name: 'Bound',
      roughCutProfileId: profile.id,
    });
    signedInAs(scenario.owner);

    const response = await callRoute(
      patchFolder,
      apiRequest(`/api/projects/${scenario.project.id}/folders/${folder.id}`, {
        body: { roughCutProfileId: null },
      }),
      { projectId: scenario.project.id, folderId: folder.id }
    );
    expect(response.status).toBe(200);
    const row = await db.folder.findUnique({ where: { id: folder.id } });
    expect(row?.roughCutProfileId).toBeNull();
  });

  it('rejects a profile from another workspace and leaves the folder unbound', async () => {
    const scenario = await seedProject();
    const otherOwner = await createUser();
    const otherWorkspace = await createWorkspace({ ownerId: otherOwner.id });
    const foreign = await createRoughCutProfile({
      workspaceId: otherWorkspace.id,
      name: 'Foreign',
    });
    const folder = await createFolder({ projectId: scenario.project.id, name: 'A-cam' });
    signedInAs(scenario.owner);

    const response = await callRoute(
      patchFolder,
      apiRequest(`/api/projects/${scenario.project.id}/folders/${folder.id}`, {
        body: { roughCutProfileId: foreign.id },
      }),
      { projectId: scenario.project.id, folderId: folder.id }
    );
    expect(response.status).toBe(400);
    const row = await db.folder.findUnique({ where: { id: folder.id } });
    expect(row?.roughCutProfileId).toBeNull();
  });
});
