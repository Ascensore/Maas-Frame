// Result scoping for GET /api/search.
//
// The auth matrix already proves an anonymous caller gets 401, and beyond that
// there is nothing to test on the authorization axis: the route reads the
// caller's id straight off the session, so no "forbidden caller" exists. The
// question this file asks instead is a data-leak one, and nothing asserted it
// before: does the search actually restrict its rows to the caller's own
// tenants?
//
// It matters because search is the one endpoint that queries `project`,
// `workspace` and `video` globally rather than through a project id in the URL.
// Every filter is inline in the handler, none of it goes through
// `checkProjectAccess()`, and there is no shared helper that a regression would
// have to break twice. Dropping the `projectAccessFilter` clause from the video
// query would turn the search box into a list of every video title in the
// database, and until this file nothing would have noticed.
//
// Every test uses a term that appears in exactly one tenant's rows, so a hit is
// unambiguous. Each refusal is paired with the same query run by a caller who
// should see it, which is what rules out an empty result that came from the
// query never matching anything in the first place.

import { describe, expect, it } from 'vitest';
import { GET as search } from '@/app/api/search/route';
import { GET as listProjects } from '@/app/api/projects/route';
import { apiRequest, callRoute, readData } from '../helpers/request';
import { signedInAs, signedOut } from '../helpers/session';
import {
  addProjectMember,
  addWorkspaceMember,
  createExpiredUser,
  createProject,
  createUser,
  createVideo,
  createWorkspace,
  nextSeq,
  seedProject,
} from '../factories';

interface SearchResults {
  projects: Array<{ id: string; name: string }>;
  workspaces: Array<{ id: string; name: string }>;
  videos: Array<{ id: string; title: string }>;
}

async function searchFor(term: string): Promise<SearchResults> {
  const response = await callRoute(
    search,
    apiRequest('/api/search', { searchParams: { q: term } })
  );
  expect(response.status).toBe(200);
  return readData<SearchResults>(response);
}

/** A term that cannot collide with a factory default name or another test's rows. */
function uniqueTerm(): string {
  return `Zephyrine${nextSeq()}`;
}

// ---------------------------------------------------------------------------
// Cross-tenant leakage
// ---------------------------------------------------------------------------
describe('GET /api/search does not reach into another tenant', () => {
  it('returns nothing to an anonymous caller', async () => {
    const term = uniqueTerm();
    const { project } = await seedProject({ projectName: `${term} project` });
    await createVideo({ projectId: project.id, title: `${term} cut` });
    signedOut();

    const response = await callRoute(
      search,
      apiRequest('/api/search', { searchParams: { q: term } })
    );

    expect(response.status).toBe(401);
  });

  it('hides a stranger project matching the term by name', async () => {
    const term = uniqueTerm();
    await seedProject({ projectName: `${term} deliverables` });
    const outsider = await createUser();
    signedInAs(outsider);

    const results = await searchFor(term);

    expect(results.projects).toEqual([]);
  });

  // The positive control for the case above. Same term, same row, and the only
  // difference is who is asking, so an empty result cannot be blamed on the
  // query failing to match.
  it('shows that same project to its owner', async () => {
    const term = uniqueTerm();
    const { owner } = await seedProject({ projectName: `${term} deliverables` });
    signedInAs(owner);

    const results = await searchFor(term);

    expect(results.projects.map((project) => project.name)).toEqual([`${term} deliverables`]);
  });

  it('hides a stranger project matching the term only in its description', async () => {
    const term = uniqueTerm();
    const scenario = await seedProject();
    await createProject({
      ownerId: scenario.owner.id,
      workspaceId: scenario.workspace.id,
      name: 'Unremarkable name',
      description: `Rough cut for the ${term} campaign`,
    });
    const outsider = await createUser();
    signedInAs(outsider);

    const results = await searchFor(term);

    expect(results.projects).toEqual([]);
  });

  it('shows the description match to the project owner', async () => {
    const term = uniqueTerm();
    const scenario = await seedProject();
    await createProject({
      ownerId: scenario.owner.id,
      workspaceId: scenario.workspace.id,
      name: 'Unremarkable name',
      description: `Rough cut for the ${term} campaign`,
    });
    signedInAs(scenario.owner);

    const results = await searchFor(term);

    expect(results.projects).toHaveLength(1);
  });

  // The headline case from the gap inventory: a video title is the most
  // sensitive string in this product's search index, because it is usually a
  // client name or an unannounced campaign.
  it('hides a video in a stranger project whose title matches the term', async () => {
    const term = uniqueTerm();
    const { project } = await seedProject();
    await createVideo({ projectId: project.id, title: `${term} launch cut` });
    // The outsider owns a real tenant of their own, so nothing about the request
    // is unusual: they simply have no relationship to the project holding the hit.
    await seedProject();
    const outsider = await createUser();
    signedInAs(outsider);

    const results = await searchFor(term);

    expect(results.videos).toEqual([]);
  });

  it('shows that same video to the owner of the project holding it', async () => {
    const term = uniqueTerm();
    const { owner, project } = await seedProject();
    await createVideo({ projectId: project.id, title: `${term} launch cut` });
    signedInAs(owner);

    const results = await searchFor(term);

    expect(results.videos.map((video) => video.title)).toEqual([`${term} launch cut`]);
  });

  it('hides a stranger workspace matching the term by name', async () => {
    const term = uniqueTerm();
    const stranger = await createUser();
    await createWorkspace({ ownerId: stranger.id, name: `${term} Studio` });
    const outsider = await createUser();
    signedInAs(outsider);

    const results = await searchFor(term);

    expect(results.workspaces).toEqual([]);
  });

  it('shows that same workspace to its owner', async () => {
    const term = uniqueTerm();
    const stranger = await createUser();
    await createWorkspace({ ownerId: stranger.id, name: `${term} Studio` });
    signedInAs(stranger);

    const results = await searchFor(term);

    expect(results.workspaces.map((workspace) => workspace.name)).toEqual([`${term} Studio`]);
  });

  // Search is scoped by membership, not by visibility: `checkProjectAccess()`
  // would let this caller open the project, but it does not surface in their
  // search. Pinned because it is the one place the two rules deliberately differ,
  // and because widening search to match the access check would be a real
  // exposure of every public project's video titles.
  it('hides a PUBLIC stranger project the caller has never joined', async () => {
    const term = uniqueTerm();
    const { project } = await seedProject({
      visibility: 'PUBLIC',
      projectName: `${term} open project`,
    });
    await createVideo({ projectId: project.id, title: `${term} open cut` });
    const outsider = await createUser();
    signedInAs(outsider);

    const results = await searchFor(term);

    expect(results.projects).toEqual([]);
    expect(results.videos).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The three ways in
// ---------------------------------------------------------------------------
// The access filter has three branches. Each one is exercised here, because a
// scoping test that only proves "strangers see nothing" would still pass if the
// filter had collapsed to `ownerId` and quietly stopped showing collaborators
// their own work.
describe('GET /api/search reaches everything the caller is entitled to', () => {
  it('shows a project the caller was added to directly', async () => {
    const term = uniqueTerm();
    const { project } = await seedProject({ projectName: `${term} shared cut` });
    const collaborator = await createUser();
    await addProjectMember({
      projectId: project.id,
      userId: collaborator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(collaborator);

    const results = await searchFor(term);

    expect(results.projects.map((entry) => entry.id)).toEqual([project.id]);
  });

  it('shows videos in a project the caller was added to directly', async () => {
    const term = uniqueTerm();
    const { project } = await seedProject();
    const video = await createVideo({ projectId: project.id, title: `${term} rough cut` });
    const collaborator = await createUser();
    await addProjectMember({ projectId: project.id, userId: collaborator.id });
    signedInAs(collaborator);

    const results = await searchFor(term);

    expect(results.videos.map((entry) => entry.id)).toEqual([video.id]);
  });

  // A workspace member with no project membership row at all. This is the branch
  // most likely to be dropped by accident, because the other two are obvious.
  it('shows a project the caller reaches only through workspace membership', async () => {
    const term = uniqueTerm();
    const { workspace, project } = await seedProject({ projectName: `${term} workspace cut` });
    const video = await createVideo({ projectId: project.id, title: `${term} workspace video` });
    const workspaceMember = await createUser();
    await addWorkspaceMember({ workspaceId: workspace.id, userId: workspaceMember.id });
    signedInAs(workspaceMember);

    const results = await searchFor(term);

    expect(results.projects.map((entry) => entry.id)).toEqual([project.id]);
    expect(results.videos.map((entry) => entry.id)).toEqual([video.id]);
  });

  it('shows a workspace the caller is a member of', async () => {
    const term = uniqueTerm();
    const stranger = await createUser();
    const workspace = await createWorkspace({ ownerId: stranger.id, name: `${term} Studio` });
    const member = await createUser();
    await addWorkspaceMember({ workspaceId: workspace.id, userId: member.id });
    signedInAs(member);

    const results = await searchFor(term);

    expect(results.workspaces.map((entry) => entry.id)).toEqual([workspace.id]);
  });

  // A project membership must not leak the enclosing workspace, which usually
  // carries the agency's own name and its other clients.
  it('does not show the enclosing workspace to a project-only member', async () => {
    const term = uniqueTerm();
    const owner = await createUser();
    const workspace = await createWorkspace({ ownerId: owner.id, name: `${term} Studio` });
    const project = await createProject({
      ownerId: owner.id,
      workspaceId: workspace.id,
      name: `${term} client project`,
    });
    const collaborator = await createUser();
    await addProjectMember({ projectId: project.id, userId: collaborator.id });
    signedInAs(collaborator);

    const results = await searchFor(term);

    expect(results.projects.map((entry) => entry.id)).toEqual([project.id]);
    expect(results.workspaces).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------
// Search carries the same billing condition every other read path does. It used to carry
// none: GET /api/projects filters every row through
// `workspace.owner: buildBillingAccessWhereInput()`, and `checkProjectAccess()` makes
// `hasAccess` false the moment the workspace owner's billing lapses, so the project
// itself answers 403, while search went on returning names, descriptions and video
// titles for the same tenant.
describe('GET /api/search and lapsed billing', () => {
  it('hides a project whose workspace owner has lost billing access', async () => {
    const term = uniqueTerm();
    const expiredOwner = await createExpiredUser();
    await seedProject({ ownerUser: expiredOwner, projectName: `${term} lapsed project` });
    signedInAs(expiredOwner);

    const results = await searchFor(term);

    expect(results.projects).toEqual([]);
  });

  // The positive control: the same shape with billing intact still comes back, so the
  // assertion above is about billing and not about the fixture failing to seed.
  it('still returns a project whose workspace owner is paying', async () => {
    const term = uniqueTerm();
    const scenario = await seedProject({ projectName: `${term} live project` });
    signedInAs(scenario.owner);

    const results = await searchFor(term);

    expect(results.projects.map((entry) => entry.name)).toEqual([`${term} live project`]);
  });

  // The same caller, the same row, through the list endpoint instead: the two agree now.
  it('is hidden from GET /api/projects for the same caller and the same row', async () => {
    const expiredOwner = await createExpiredUser();
    await seedProject({ ownerUser: expiredOwner, projectName: 'Lapsed project' });
    signedInAs(expiredOwner);

    const response = await callRoute(listProjects, apiRequest('/api/projects'));

    expect(response.status).toBe(200);
    const { projects } = await readData<{ projects: Array<{ id: string }> }>(response);
    expect(projects).toEqual([]);
  });

  it('hides a video title from a lapsed workspace, even from a collaborator', async () => {
    const term = uniqueTerm();
    const expiredOwner = await createExpiredUser();
    const { project } = await seedProject({ ownerUser: expiredOwner });
    await createVideo({ projectId: project.id, title: `${term} lapsed cut` });
    const collaborator = await createUser();
    await addProjectMember({ projectId: project.id, userId: collaborator.id });
    signedInAs(collaborator);

    const results = await searchFor(term);

    expect(results.videos).toEqual([]);
  });

  it('still returns a video title to a collaborator while the owner is paying', async () => {
    const term = uniqueTerm();
    const { project } = await seedProject();

    await createVideo({ projectId: project.id, title: `${term} live cut` });
    const collaborator = await createUser();
    await addProjectMember({ projectId: project.id, userId: collaborator.id });
    signedInAs(collaborator);

    const results = await searchFor(term);

    expect(results.videos.map((entry) => entry.title)).toEqual([`${term} live cut`]);
  });
});
