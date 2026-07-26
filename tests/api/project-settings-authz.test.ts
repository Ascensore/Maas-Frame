// Authorization tests for the remaining project-scoped routes that the suite
// only ever exercised anonymously: the comment tag CRUD, the project-level Bunny
// upload initializer, the comment export, and the workspace invitation cancel.
//
// None of these is the flashiest endpoint in the app, and that is exactly why
// they are worth pinning. Each one is a small handler whose entire access story
// is a single `if (!access.canEdit)` that no test had ever exercised with a
// signed-in caller. A tag route that any project member can rewrite is a way to
// vandalise every review in the project; a `bunny-init` that any member can call
// is a way to spend the workspace owner's storage; and the invitation cancel is
// the workspace roster.
//
// The pattern is the same throughout: a signed-in stranger who owns a real
// workspace of their own, a COMMENTATOR who is a genuine member, a
// cross-tenant identifier substitution where the route takes two ids, and a
// positive control that reaches a status the refusals cannot produce.

import { describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { GET as listTags, POST as createTag } from '@/app/api/projects/[projectId]/tags/route';
import {
  DELETE as deleteTag,
  PATCH as patchTag,
} from '@/app/api/projects/[projectId]/tags/[tagId]/route';
import { POST as initProjectBunnyUpload } from '@/app/api/projects/[projectId]/videos/bunny-init/route';
import { GET as exportComments } from '@/app/api/versions/[versionId]/comments/export/route';
import { DELETE as cancelWorkspaceInvitation } from '@/app/api/workspaces/[workspaceId]/members/invitations/[invitationId]/route';
import { apiRequest, callRoute, readData, readError } from '../helpers/request';
import { signedInAs } from '../helpers/session';
import {
  addProjectMember,
  addWorkspaceMember,
  createComment,
  createCommentTag,
  createInvitation,
  createUser,
  seedProject,
  seedVersion,
} from '../factories';

const SEEDED_TAG_NAME = 'Seeded tag';
const SEEDED_TAG_COLOR = '#3B82F6';

function tagsUrl(projectId: string): string {
  return `/api/projects/${projectId}/tags`;
}

// ---------------------------------------------------------------------------
// Comment tags
// ---------------------------------------------------------------------------
describe('POST /api/projects/[projectId]/tags', () => {
  it('returns 403 to a signed-in stranger and writes no tag', async () => {
    const scenario = await seedProject();
    await seedProject();
    const stranger = await createUser();
    signedInAs(stranger);

    const response = await callRoute(
      createTag,
      apiRequest(tagsUrl(scenario.project.id), {
        body: { name: 'Stranger tag', color: '#ff0000' },
      }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(403);
    expect(await db.commentTag.count()).toBe(0);
  });

  it('returns 403 to a project COMMENTATOR and writes no tag', async () => {
    const scenario = await seedProject();
    const commentator = await createUser();
    await addProjectMember({
      projectId: scenario.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await callRoute(
      createTag,
      apiRequest(tagsUrl(scenario.project.id), {
        body: { name: 'Commentator tag', color: '#ff0000' },
      }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(403);
    expect(await db.commentTag.count()).toBe(0);
  });

  it('returns 403 to a workspace COMMENTATOR and writes no tag', async () => {
    const scenario = await seedProject();
    const workspaceCommentator = await createUser();
    await addWorkspaceMember({
      workspaceId: scenario.workspace.id,
      userId: workspaceCommentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(workspaceCommentator);

    const response = await callRoute(
      createTag,
      apiRequest(tagsUrl(scenario.project.id), {
        body: { name: 'Workspace commentator tag', color: '#ff0000' },
      }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(403);
    expect(await db.commentTag.count()).toBe(0);
  });

  it('lets the project owner create a tag', async () => {
    const scenario = await seedProject();
    signedInAs(scenario.owner);

    const response = await callRoute(
      createTag,
      apiRequest(tagsUrl(scenario.project.id), { body: { name: 'Owner tag', color: '#ff0000' } }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(201);
    const tag = await db.commentTag.findFirstOrThrow();
    expect(tag.name).toBe('Owner tag');
    expect(tag.projectId).toBe(scenario.project.id);
  });
});

describe('PATCH and DELETE /api/projects/[projectId]/tags/[tagId]', () => {
  it('returns 403 to a project COMMENTATOR and leaves the tag alone', async () => {
    const scenario = await seedProject();
    const tag = await createCommentTag({
      projectId: scenario.project.id,
      name: SEEDED_TAG_NAME,
      color: SEEDED_TAG_COLOR,
    });
    const commentator = await createUser();
    await addProjectMember({
      projectId: scenario.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await callRoute(
      patchTag,
      apiRequest(`${tagsUrl(scenario.project.id)}/${tag.id}`, {
        method: 'PATCH',
        body: { name: 'Renamed by a commentator', color: '#000000' },
      }),
      { projectId: scenario.project.id, tagId: tag.id }
    );

    expect(response.status).toBe(403);
    const after = await db.commentTag.findUniqueOrThrow({ where: { id: tag.id } });
    expect(after.name).toBe(SEEDED_TAG_NAME);
    expect(after.color).toBe(SEEDED_TAG_COLOR);
  });

  it('returns 403 to a project COMMENTATOR deleting a tag and keeps the row', async () => {
    const scenario = await seedProject();
    const tag = await createCommentTag({ projectId: scenario.project.id, name: SEEDED_TAG_NAME });
    const commentator = await createUser();
    await addProjectMember({
      projectId: scenario.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await callRoute(
      deleteTag,
      apiRequest(`${tagsUrl(scenario.project.id)}/${tag.id}`, { method: 'DELETE' }),
      { projectId: scenario.project.id, tagId: tag.id }
    );

    expect(response.status).toBe(403);
    expect(await db.commentTag.count({ where: { id: tag.id } })).toBe(1);
  });

  // The tag id is a global identifier and the project id in the path is what
  // scopes it. An admin of one project must not be able to rename another
  // project's tags by pasting the id in.
  it('returns 404 for a tag belonging to another project and leaves it alone', async () => {
    const mine = await seedProject();
    const theirs = await seedProject();
    const foreignTag = await createCommentTag({
      projectId: theirs.project.id,
      name: SEEDED_TAG_NAME,
      color: SEEDED_TAG_COLOR,
    });
    signedInAs(mine.owner);

    const response = await callRoute(
      patchTag,
      apiRequest(`${tagsUrl(mine.project.id)}/${foreignTag.id}`, {
        method: 'PATCH',
        body: { name: 'Renamed across the tenant boundary' },
      }),
      { projectId: mine.project.id, tagId: foreignTag.id }
    );

    expect(response.status).toBe(404);
    const after = await db.commentTag.findUniqueOrThrow({ where: { id: foreignTag.id } });
    expect(after.name).toBe(SEEDED_TAG_NAME);
    expect(after.color).toBe(SEEDED_TAG_COLOR);
  });

  it('returns 404 when deleting a tag belonging to another project', async () => {
    const mine = await seedProject();
    const theirs = await seedProject();
    const foreignTag = await createCommentTag({
      projectId: theirs.project.id,
      name: SEEDED_TAG_NAME,
    });
    signedInAs(mine.owner);

    const response = await callRoute(
      deleteTag,
      apiRequest(`${tagsUrl(mine.project.id)}/${foreignTag.id}`, { method: 'DELETE' }),
      { projectId: mine.project.id, tagId: foreignTag.id }
    );

    expect(response.status).toBe(404);
    expect(await db.commentTag.count({ where: { id: foreignTag.id } })).toBe(1);
  });

  it('lets the project owner rename and then delete a tag', async () => {
    const scenario = await seedProject();
    const tag = await createCommentTag({
      projectId: scenario.project.id,
      name: SEEDED_TAG_NAME,
      color: SEEDED_TAG_COLOR,
    });
    signedInAs(scenario.owner);

    const renamed = await callRoute(
      patchTag,
      apiRequest(`${tagsUrl(scenario.project.id)}/${tag.id}`, {
        method: 'PATCH',
        body: { name: 'Renamed by the owner' },
      }),
      { projectId: scenario.project.id, tagId: tag.id }
    );

    expect(renamed.status).toBe(200);
    expect((await db.commentTag.findUniqueOrThrow({ where: { id: tag.id } })).name).toBe(
      'Renamed by the owner'
    );

    const removed = await callRoute(
      deleteTag,
      apiRequest(`${tagsUrl(scenario.project.id)}/${tag.id}`, { method: 'DELETE' }),
      { projectId: scenario.project.id, tagId: tag.id }
    );

    expect(removed.status).toBe(200);
    expect(await db.commentTag.count({ where: { id: tag.id } })).toBe(0);
  });

  // GET is deliberately looser than the writes: a COMMENTATOR needs the tag list
  // to file a comment against one. Pinned so the read gate and the write gate stay
  // visibly different.
  it('lets a project COMMENTATOR read the tag list', async () => {
    const scenario = await seedProject();
    const tag = await createCommentTag({ projectId: scenario.project.id, name: SEEDED_TAG_NAME });
    const commentator = await createUser();
    await addProjectMember({
      projectId: scenario.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await callRoute(listTags, apiRequest(tagsUrl(scenario.project.id)), {
      projectId: scenario.project.id,
    });

    expect(response.status).toBe(200);
    const tags = await readData<Array<{ id: string }>>(response);
    expect(tags.map((entry) => entry.id)).toEqual([tag.id]);
  });
});

// ---------------------------------------------------------------------------
// POST /api/projects/[projectId]/videos/bunny-init
// ---------------------------------------------------------------------------
// Hands out a signed upload credential against the workspace owner's Bunny
// library, so the guard here is the thing standing between a COMMENTATOR and
// somebody else's storage bill.
describe('POST /api/projects/[projectId]/videos/bunny-init', () => {
  it('returns 403 to a signed-in stranger', async () => {
    const scenario = await seedProject();
    await seedProject();
    const stranger = await createUser();
    signedInAs(stranger);

    const response = await callRoute(
      initProjectBunnyUpload,
      apiRequest(`/api/projects/${scenario.project.id}/videos/bunny-init`, {
        body: { title: 'A clip' },
      }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(403);
  });

  it('returns 403 to a project COMMENTATOR', async () => {
    const scenario = await seedProject();
    const commentator = await createUser();
    await addProjectMember({
      projectId: scenario.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await callRoute(
      initProjectBunnyUpload,
      apiRequest(`/api/projects/${scenario.project.id}/videos/bunny-init`, {
        body: { title: 'A clip' },
      }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(403);
  });

  // Positive control. Bunny uploads are unconfigured in the test environment, so
  // an authorized caller stops on the feature check one line below the guard. A
  // 400 is a status neither refusal above can reach.
  it('gets the project owner past the access check onto the disabled-feature check', async () => {
    const scenario = await seedProject();
    signedInAs(scenario.owner);

    const response = await callRoute(
      initProjectBunnyUpload,
      apiRequest(`/api/projects/${scenario.project.id}/videos/bunny-init`, {
        body: { title: 'A clip' },
      }),
      { projectId: scenario.project.id }
    );

    expect(response.status).toBe(400);
    expect(await readError(response)).toContain('Bunny direct uploads are disabled');
  });
});

// ---------------------------------------------------------------------------
// GET /api/versions/[versionId]/comments/export
// ---------------------------------------------------------------------------
// The export takes a bare versionId, so the version alone decides which project
// is authorized. It also masks a refusal as a 404 rather than a 403, which is a
// reasonable thing to do and a terrible thing to test without a positive control:
// a 404 is exactly what a wrong id would produce too.
describe('GET /api/versions/[versionId]/comments/export', () => {
  it('returns 404 to a signed-in stranger', async () => {
    const scenario = await seedVersion();
    await createComment({ versionId: scenario.version.id, authorId: scenario.owner.id });
    await seedProject();
    const stranger = await createUser();
    signedInAs(stranger);

    const response = await callRoute(
      exportComments,
      apiRequest(`/api/versions/${scenario.version.id}/comments/export`),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(404);
  });

  it('returns 404 for a version id belonging to another workspace', async () => {
    const mine = await seedVersion();
    const theirs = await seedVersion();
    await createComment({ versionId: theirs.version.id, authorId: theirs.owner.id });
    signedInAs(mine.owner);

    const response = await callRoute(
      exportComments,
      apiRequest(`/api/versions/${theirs.version.id}/comments/export`),
      { versionId: theirs.version.id }
    );

    expect(response.status).toBe(404);
  });

  // Positive control: the identical request from a caller who is only a
  // COMMENTATOR succeeds, so the two 404s above are the access check and not a
  // dead id.
  it('lets a project COMMENTATOR export the comments as CSV', async () => {
    const scenario = await seedVersion();
    await createComment({
      versionId: scenario.version.id,
      authorId: scenario.owner.id,
      content: 'Exportable comment',
    });
    const commentator = await createUser();
    await addProjectMember({
      projectId: scenario.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const response = await callRoute(
      exportComments,
      apiRequest(`/api/versions/${scenario.version.id}/comments/export`),
      { versionId: scenario.version.id }
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Exportable comment');
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/workspaces/[workspaceId]/members/invitations/[invitationId]
// ---------------------------------------------------------------------------
describe('DELETE /api/workspaces/[workspaceId]/members/invitations/[invitationId]', () => {
  it('returns 403 to a signed-in stranger and leaves the invitation pending', async () => {
    const scenario = await seedProject();
    await seedProject();
    const invitation = await createInvitation({
      invitedById: scenario.owner.id,
      scope: 'WORKSPACE',
      workspaceId: scenario.workspace.id,
    });
    const stranger = await createUser();
    signedInAs(stranger);

    const response = await callRoute(
      cancelWorkspaceInvitation,
      apiRequest(`/api/workspaces/${scenario.workspace.id}/members/invitations/${invitation.id}`, {
        method: 'DELETE',
      }),
      { workspaceId: scenario.workspace.id, invitationId: invitation.id }
    );

    expect(response.status).toBe(403);
    expect((await db.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).status).toBe(
      'PENDING'
    );
  });

  it('returns 403 to a workspace COMMENTATOR and leaves the invitation pending', async () => {
    const scenario = await seedProject();
    const invitation = await createInvitation({
      invitedById: scenario.owner.id,
      scope: 'WORKSPACE',
      workspaceId: scenario.workspace.id,
    });
    const workspaceCommentator = await createUser();
    await addWorkspaceMember({
      workspaceId: scenario.workspace.id,
      userId: workspaceCommentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(workspaceCommentator);

    const response = await callRoute(
      cancelWorkspaceInvitation,
      apiRequest(`/api/workspaces/${scenario.workspace.id}/members/invitations/${invitation.id}`, {
        method: 'DELETE',
      }),
      { workspaceId: scenario.workspace.id, invitationId: invitation.id }
    );

    expect(response.status).toBe(403);
    expect((await db.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).status).toBe(
      'PENDING'
    );
  });

  it('returns 404 for an invitation scoped to another workspace', async () => {
    const mine = await seedProject();
    const theirs = await seedProject();
    const foreignInvitation = await createInvitation({
      invitedById: theirs.owner.id,
      scope: 'WORKSPACE',
      workspaceId: theirs.workspace.id,
    });
    signedInAs(mine.owner);

    const response = await callRoute(
      cancelWorkspaceInvitation,
      apiRequest(
        `/api/workspaces/${mine.workspace.id}/members/invitations/${foreignInvitation.id}`,
        { method: 'DELETE' }
      ),
      { workspaceId: mine.workspace.id, invitationId: foreignInvitation.id }
    );

    expect(response.status).toBe(404);
    expect(
      (await db.invitation.findUniqueOrThrow({ where: { id: foreignInvitation.id } })).status
    ).toBe('PENDING');
  });

  it('lets a workspace ADMIN cancel the invitation', async () => {
    const scenario = await seedProject();
    const invitation = await createInvitation({
      invitedById: scenario.owner.id,
      scope: 'WORKSPACE',
      workspaceId: scenario.workspace.id,
    });
    const workspaceAdmin = await createUser();
    await addWorkspaceMember({
      workspaceId: scenario.workspace.id,
      userId: workspaceAdmin.id,
      role: 'ADMIN',
    });
    signedInAs(workspaceAdmin);

    const response = await callRoute(
      cancelWorkspaceInvitation,
      apiRequest(`/api/workspaces/${scenario.workspace.id}/members/invitations/${invitation.id}`, {
        method: 'DELETE',
      }),
      { workspaceId: scenario.workspace.id, invitationId: invitation.id }
    );

    expect(response.status).toBe(200);
    expect((await db.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).status).toBe(
      'CANCELED'
    );
  });
});
