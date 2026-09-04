// Editorial briefs: workspace CRUD plus the folder and project bindings that
// decide which brief a rough cut resolves to.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import {
  GET as listBriefs,
  POST as createBriefRoute,
} from '@/app/api/workspaces/[workspaceId]/editorial-briefs/route';
import {
  DELETE as deleteBriefRoute,
  PATCH as patchBriefRoute,
} from '@/app/api/workspaces/[workspaceId]/editorial-briefs/[briefId]/route';
import { PATCH as patchFolder } from '@/app/api/projects/[projectId]/folders/[folderId]/route';
import { PATCH as patchProject } from '@/app/api/projects/[projectId]/route';
import { BUILTIN_BRIEF_TEMPLATES } from '@/lib/rough-cut/brief';
import { apiRequest, callRoute, readData } from '../helpers/request';
import { signedInAs, signedOut } from '../helpers/session';
import {
  addWorkspaceMember,
  createEditorialBrief,
  createFolder,
  createUser,
  createWorkspace,
  seedProject,
} from '../factories';

function briefsUrl(workspaceId: string) {
  return `/api/workspaces/${workspaceId}/editorial-briefs`;
}

function briefUrl(workspaceId: string, briefId: string) {
  return `${briefsUrl(workspaceId)}/${briefId}`;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /api/workspaces/[workspaceId]/editorial-briefs', () => {
  it('returns 401 to an anonymous caller', async () => {
    const { workspace } = await seedProject();
    signedOut();
    const response = await callRoute(listBriefs, apiRequest(briefsUrl(workspace.id)), {
      workspaceId: workspace.id,
    });
    expect(response.status).toBe(401);
  });

  it('returns 403 to a signed-in stranger', async () => {
    const { workspace } = await seedProject();
    await createEditorialBrief({ workspaceId: workspace.id });
    signedInAs(await createUser());
    const response = await callRoute(listBriefs, apiRequest(briefsUrl(workspace.id)), {
      workspaceId: workspace.id,
    });
    expect(response.status).toBe(403);
  });

  it('lists briefs with their parsed config for a workspace commentator', async () => {
    const owner = await createUser();
    const workspace = await createWorkspace({ ownerId: owner.id });
    const brief = await createEditorialBrief({
      workspaceId: workspace.id,
      name: 'Pitch night',
      projectType: 'ASCENSORE',
      config: { pacing: { silenceAggressiveness: 'low' } },
    });
    const commentator = await createUser();
    await addWorkspaceMember({
      workspaceId: workspace.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const payload = await readData<{
      briefs: Array<{ id: string; name: string; projectType: string; config: unknown }>;
    }>(
      await callRoute(listBriefs, apiRequest(briefsUrl(workspace.id)), {
        workspaceId: workspace.id,
      })
    );

    expect(payload.briefs).toEqual([
      expect.objectContaining({
        id: brief.id,
        name: 'Pitch night',
        projectType: 'ASCENSORE',
        config: expect.objectContaining({
          pacing: { silenceAggressiveness: 'low' },
          cameraGrammar: { followSpeaker: true, holdWideOnChaos: true },
        }),
      }),
    ]);
  });
});

describe('POST /api/workspaces/[workspaceId]/editorial-briefs', () => {
  it('returns 401 to an anonymous caller and writes no row', async () => {
    const { workspace } = await seedProject();
    signedOut();
    vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'true');
    const response = await callRoute(
      createBriefRoute,
      apiRequest(briefsUrl(workspace.id), { body: { name: 'Show', projectType: 'ASCENSORE' } }),
      { workspaceId: workspace.id }
    );
    expect(response.status).toBe(401);
    expect(await db.editorialBrief.count()).toBe(0);
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
      createBriefRoute,
      apiRequest(briefsUrl(workspace.id), { body: { name: 'Show', projectType: 'ASCENSORE' } }),
      { workspaceId: workspace.id }
    );
    expect(response.status).toBe(403);
    expect(await db.editorialBrief.count()).toBe(0);
  });

  it('creates a brief from the template for its type with the body laid over it', async () => {
    const { owner, workspace } = await seedProject();
    signedInAs(owner);
    vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'true');

    const response = await callRoute(
      createBriefRoute,
      apiRequest(briefsUrl(workspace.id), {
        body: {
          name: 'Pitch night',
          projectType: 'ASCENSORE',
          isDefault: true,
          config: { pacing: { silenceAggressiveness: 'low' }, technical: { minShotSeconds: 2 } },
        },
      }),
      { workspaceId: workspace.id }
    );

    expect(response.status).toBe(201);
    const payload = await readData<{ brief: { id: string } }>(response);
    const stored = await db.editorialBrief.findUniqueOrThrow({ where: { id: payload.brief.id } });
    expect(stored).toMatchObject({
      workspaceId: workspace.id,
      name: 'Pitch night',
      projectType: 'ASCENSORE',
      isDefault: true,
    });
    expect(stored.config).toEqual({
      ...BUILTIN_BRIEF_TEMPLATES.ASCENSORE,
      pacing: { silenceAggressiveness: 'low' },
      technical: { roughCutProfileId: null, minShotSeconds: 2 },
    });
  });

  it('keeps one default per project type', async () => {
    const { owner, workspace } = await seedProject();
    const oldShowDefault = await createEditorialBrief({
      workspaceId: workspace.id,
      projectType: 'ASCENSORE',
      isDefault: true,
    });
    const interviewDefault = await createEditorialBrief({
      workspaceId: workspace.id,
      projectType: 'INTERVIEW',
      isDefault: true,
    });
    signedInAs(owner);
    vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'true');

    const response = await callRoute(
      createBriefRoute,
      apiRequest(briefsUrl(workspace.id), {
        body: { name: 'New show default', projectType: 'ASCENSORE', isDefault: true },
      }),
      { workspaceId: workspace.id }
    );

    expect(response.status).toBe(201);
    const rows = await db.editorialBrief.findMany({ where: { workspaceId: workspace.id } });
    const defaults = rows.filter((row) => row.isDefault).map((row) => row.name);
    expect(defaults.sort()).toEqual([interviewDefault.name, 'New show default'].sort());
    expect(
      (await db.editorialBrief.findUniqueOrThrow({ where: { id: oldShowDefault.id } })).isDefault
    ).toBe(false);
  });

  it('rejects an unknown type, a mismatched config type, and a duplicate name', async () => {
    const { owner, workspace } = await seedProject();
    await createEditorialBrief({ workspaceId: workspace.id, name: 'Taken' });
    signedInAs(owner);
    vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'true');

    const unknownType = await callRoute(
      createBriefRoute,
      apiRequest(briefsUrl(workspace.id), { body: { name: 'x', projectType: 'VLOG' } }),
      { workspaceId: workspace.id }
    );
    const mismatched = await callRoute(
      createBriefRoute,
      apiRequest(briefsUrl(workspace.id), {
        body: { name: 'x', projectType: 'ASCENSORE', config: { projectType: 'INTERVIEW' } },
      }),
      { workspaceId: workspace.id }
    );
    const duplicate = await callRoute(
      createBriefRoute,
      apiRequest(briefsUrl(workspace.id), { body: { name: 'Taken', projectType: 'INTERVIEW' } }),
      { workspaceId: workspace.id }
    );

    expect(unknownType.status).toBe(400);
    expect(mismatched.status).toBe(400);
    expect(duplicate.status).toBe(409);
    expect(await db.editorialBrief.count({ where: { workspaceId: workspace.id } })).toBe(1);
  });

  it('returns 403 when the feature flag is off and writes no row', async () => {
    const { owner, workspace } = await seedProject();
    signedInAs(owner);
    vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'false');
    const response = await callRoute(
      createBriefRoute,
      apiRequest(briefsUrl(workspace.id), { body: { name: 'Show', projectType: 'ASCENSORE' } }),
      { workspaceId: workspace.id }
    );
    expect(response.status).toBe(403);
    expect(await db.editorialBrief.count()).toBe(0);
  });
});

describe('PATCH /api/workspaces/[workspaceId]/editorial-briefs/[briefId]', () => {
  it('returns 401 to an anonymous caller and 403 to a stranger, leaving the row', async () => {
    const { workspace } = await seedProject();
    const brief = await createEditorialBrief({ workspaceId: workspace.id, name: 'Original' });
    vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'true');

    signedOut();
    const anonymous = await callRoute(
      patchBriefRoute,
      apiRequest(briefUrl(workspace.id, brief.id), { method: 'PATCH', body: { name: 'Hacked' } }),
      { workspaceId: workspace.id, briefId: brief.id }
    );
    signedInAs(await createUser());
    const stranger = await callRoute(
      patchBriefRoute,
      apiRequest(briefUrl(workspace.id, brief.id), { method: 'PATCH', body: { name: 'Hacked' } }),
      { workspaceId: workspace.id, briefId: brief.id }
    );

    expect(anonymous.status).toBe(401);
    expect(stranger.status).toBe(403);
    expect((await db.editorialBrief.findUniqueOrThrow({ where: { id: brief.id } })).name).toBe(
      'Original'
    );
  });

  it('lays a config patch over the stored config, not the template', async () => {
    const { owner, workspace } = await seedProject();
    const brief = await createEditorialBrief({
      workspaceId: workspace.id,
      projectType: 'TALKING_HEAD',
      config: { pacing: { silenceAggressiveness: 'low' } },
    });
    signedInAs(owner);
    vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'true');

    const response = await callRoute(
      patchBriefRoute,
      apiRequest(briefUrl(workspace.id, brief.id), {
        method: 'PATCH',
        body: { name: 'Renamed', config: { takeSelection: { enabled: false } } },
      }),
      { workspaceId: workspace.id, briefId: brief.id }
    );

    expect(response.status).toBe(200);
    const stored = await db.editorialBrief.findUniqueOrThrow({ where: { id: brief.id } });
    expect(stored.name).toBe('Renamed');
    expect(stored.config).toEqual({
      ...BUILTIN_BRIEF_TEMPLATES.TALKING_HEAD,
      pacing: { silenceAggressiveness: 'low' },
      takeSelection: { enabled: false, groupBy: 'semantic_beat' },
    });
  });

  it('making a brief the default unseats the other default of the same type only', async () => {
    const { owner, workspace } = await seedProject();
    const brief = await createEditorialBrief({
      workspaceId: workspace.id,
      projectType: 'INTERVIEW',
    });
    const sameType = await createEditorialBrief({
      workspaceId: workspace.id,
      projectType: 'INTERVIEW',
      isDefault: true,
    });
    const otherType = await createEditorialBrief({
      workspaceId: workspace.id,
      projectType: 'ASCENSORE',
      isDefault: true,
    });
    signedInAs(owner);
    vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'true');

    const response = await callRoute(
      patchBriefRoute,
      apiRequest(briefUrl(workspace.id, brief.id), { method: 'PATCH', body: { isDefault: true } }),
      { workspaceId: workspace.id, briefId: brief.id }
    );

    expect(response.status).toBe(200);
    const byId = new Map(
      (await db.editorialBrief.findMany({ where: { workspaceId: workspace.id } })).map((row) => [
        row.id,
        row.isDefault,
      ])
    );
    expect(byId.get(brief.id)).toBe(true);
    expect(byId.get(sameType.id)).toBe(false);
    expect(byId.get(otherType.id)).toBe(true);
  });

  it('rejects an empty patch', async () => {
    const { owner, workspace } = await seedProject();
    const brief = await createEditorialBrief({ workspaceId: workspace.id });
    signedInAs(owner);
    vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'true');
    const response = await callRoute(
      patchBriefRoute,
      apiRequest(briefUrl(workspace.id, brief.id), { method: 'PATCH', body: {} }),
      { workspaceId: workspace.id, briefId: brief.id }
    );
    expect(response.status).toBe(400);
  });
});

describe('DELETE /api/workspaces/[workspaceId]/editorial-briefs/[briefId]', () => {
  it('returns 401 to an anonymous caller and 403 to a stranger, leaving the row', async () => {
    const { workspace } = await seedProject();
    const brief = await createEditorialBrief({ workspaceId: workspace.id });
    vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'true');

    signedOut();
    const anonymous = await callRoute(
      deleteBriefRoute,
      apiRequest(briefUrl(workspace.id, brief.id), { method: 'DELETE' }),
      { workspaceId: workspace.id, briefId: brief.id }
    );
    signedInAs(await createUser());
    const stranger = await callRoute(
      deleteBriefRoute,
      apiRequest(briefUrl(workspace.id, brief.id), { method: 'DELETE' }),
      { workspaceId: workspace.id, briefId: brief.id }
    );

    expect(anonymous.status).toBe(401);
    expect(stranger.status).toBe(403);
    expect(await db.editorialBrief.count({ where: { id: brief.id } })).toBe(1);
  });

  it('deletes the row and unbinds the folders and projects that pointed at it', async () => {
    const { owner, workspace, project } = await seedProject();
    const brief = await createEditorialBrief({ workspaceId: workspace.id });
    const folder = await createFolder({ projectId: project.id, editorialBriefId: brief.id });
    await db.project.update({ where: { id: project.id }, data: { editorialBriefId: brief.id } });
    signedInAs(owner);
    vi.stubEnv('OPENFRAME_ENABLE_ROUGH_CUT', 'true');

    const response = await callRoute(
      deleteBriefRoute,
      apiRequest(briefUrl(workspace.id, brief.id), { method: 'DELETE' }),
      { workspaceId: workspace.id, briefId: brief.id }
    );

    expect(response.status).toBe(200);
    expect(await db.editorialBrief.count({ where: { id: brief.id } })).toBe(0);
    expect(
      (await db.folder.findUniqueOrThrow({ where: { id: folder.id } })).editorialBriefId
    ).toBeNull();
    expect(
      (await db.project.findUniqueOrThrow({ where: { id: project.id } })).editorialBriefId
    ).toBeNull();
  });
});

describe('binding a brief', () => {
  it('a folder accepts a brief from its own workspace, refuses another workspace’s, and clears', async () => {
    const { owner, workspace, project } = await seedProject();
    const other = await seedProject();
    const ours = await createEditorialBrief({ workspaceId: workspace.id });
    const theirs = await createEditorialBrief({ workspaceId: other.workspace.id });
    const folder = await createFolder({ projectId: project.id });
    signedInAs(owner);
    const url = `/api/projects/${project.id}/folders/${folder.id}`;
    const params = { projectId: project.id, folderId: folder.id };

    const bound = await callRoute(
      patchFolder,
      apiRequest(url, { method: 'PATCH', body: { editorialBriefId: ours.id } }),
      params
    );
    expect(bound.status).toBe(200);
    expect(
      (await readData<{ folder: { editorialBriefId: string | null } }>(bound)).folder
    ).toMatchObject({ editorialBriefId: ours.id });
    expect((await db.folder.findUniqueOrThrow({ where: { id: folder.id } })).editorialBriefId).toBe(
      ours.id
    );

    const foreign = await callRoute(
      patchFolder,
      apiRequest(url, { method: 'PATCH', body: { editorialBriefId: theirs.id } }),
      params
    );
    expect(foreign.status).toBe(400);
    expect((await db.folder.findUniqueOrThrow({ where: { id: folder.id } })).editorialBriefId).toBe(
      ours.id
    );

    const cleared = await callRoute(
      patchFolder,
      apiRequest(url, { method: 'PATCH', body: { editorialBriefId: null } }),
      params
    );
    expect(cleared.status).toBe(200);
    expect(
      (await db.folder.findUniqueOrThrow({ where: { id: folder.id } })).editorialBriefId
    ).toBeNull();
  });

  it('a project accepts a brief from its own workspace, refuses another workspace’s, and clears', async () => {
    const { owner, workspace, project } = await seedProject();
    const other = await seedProject();
    const ours = await createEditorialBrief({ workspaceId: workspace.id });
    const theirs = await createEditorialBrief({ workspaceId: other.workspace.id });
    signedInAs(owner);
    const url = `/api/projects/${project.id}`;
    const params = { projectId: project.id };

    const bound = await callRoute(
      patchProject,
      apiRequest(url, { method: 'PATCH', body: { editorialBriefId: ours.id } }),
      params
    );
    expect(bound.status).toBe(200);
    expect(
      (await db.project.findUniqueOrThrow({ where: { id: project.id } })).editorialBriefId
    ).toBe(ours.id);

    const foreign = await callRoute(
      patchProject,
      apiRequest(url, { method: 'PATCH', body: { editorialBriefId: theirs.id } }),
      params
    );
    expect(foreign.status).toBe(400);
    expect(
      (await db.project.findUniqueOrThrow({ where: { id: project.id } })).editorialBriefId
    ).toBe(ours.id);

    const cleared = await callRoute(
      patchProject,
      apiRequest(url, { method: 'PATCH', body: { editorialBriefId: null } }),
      params
    );
    expect(cleared.status).toBe(200);
    expect(
      (await db.project.findUniqueOrThrow({ where: { id: project.id } })).editorialBriefId
    ).toBeNull();
  });
});
