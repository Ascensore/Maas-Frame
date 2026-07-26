import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getApprovalCandidatesForProject } from '@/lib/approval-workflow';

const dbMock = vi.hoisted(() => ({
  project: { findUnique: vi.fn() },
}));

vi.mock('@/lib/db', () => ({ db: dbMock, default: dbMock, disconnectDb: vi.fn() }));

interface Candidate {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
}

function user(id: string, name: string | null, email: string | null = `${id}@example.com`) {
  return { id, name, email, image: null };
}

function mockProject(options: {
  owner?: Candidate | null;
  members?: Array<{ user: Candidate | null }>;
  workspaceOwner?: Candidate | null;
  workspaceMembers?: Array<{ user: Candidate | null }>;
}) {
  dbMock.project.findUnique.mockResolvedValue({
    owner: options.owner ?? null,
    members: options.members ?? [],
    workspace: {
      owner: options.workspaceOwner ?? null,
      members: options.workspaceMembers ?? [],
    },
  });
}

beforeEach(() => {
  dbMock.project.findUnique.mockReset();
});

describe('getApprovalCandidatesForProject', () => {
  it('returns null when the project does not exist', async () => {
    dbMock.project.findUnique.mockResolvedValue(null);

    await expect(getApprovalCandidatesForProject('missing')).resolves.toBeNull();
  });

  it('collects the project owner, the workspace owner and both member lists', async () => {
    mockProject({
      owner: user('u-owner', 'Owner'),
      workspaceOwner: user('u-ws-owner', 'Workspace Owner'),
      members: [{ user: user('u-pm', 'Project Member') }],
      workspaceMembers: [{ user: user('u-wm', 'Workspace Member') }],
    });

    const candidates = await getApprovalCandidatesForProject('p1');

    expect(candidates?.map((c) => c.id).sort()).toEqual(['u-owner', 'u-pm', 'u-wm', 'u-ws-owner']);
  });

  it('deduplicates a user who owns both the project and the workspace', async () => {
    const owner = user('u-owner', 'Owner');
    mockProject({ owner, workspaceOwner: owner });

    const candidates = await getApprovalCandidatesForProject('p1');

    expect(candidates).toHaveLength(1);
    expect(candidates?.[0].id).toBe('u-owner');
  });

  it('deduplicates a user listed as both a project and a workspace member', async () => {
    const member = user('u-both', 'Both');
    mockProject({
      owner: user('u-owner', 'Owner'),
      members: [{ user: member }],
      workspaceMembers: [{ user: member }],
    });

    const candidates = await getApprovalCandidatesForProject('p1');

    expect(candidates?.filter((c) => c.id === 'u-both')).toHaveLength(1);
  });

  it('keeps the last record seen for a duplicated id', async () => {
    mockProject({
      owner: user('u-dup', 'Stale Name'),
      workspaceMembers: [{ user: user('u-dup', 'Fresh Name') }],
    });

    const candidates = await getApprovalCandidatesForProject('p1');

    expect(candidates?.[0].name).toBe('Fresh Name');
  });

  it('sorts by display name case-insensitively', async () => {
    mockProject({
      owner: user('u1', 'zoe'),
      workspaceOwner: user('u2', 'Adam'),
      members: [{ user: user('u3', 'mike') }],
      workspaceMembers: [{ user: user('u4', 'Bella') }],
    });

    const candidates = await getApprovalCandidatesForProject('p1');

    expect(candidates?.map((c) => c.name)).toEqual(['Adam', 'Bella', 'mike', 'zoe']);
  });

  it('sorts by email when a candidate has no display name', async () => {
    mockProject({
      owner: user('u1', null, 'aaron@example.com'),
      workspaceOwner: user('u2', 'Bella', 'bella@example.com'),
    });

    const candidates = await getApprovalCandidatesForProject('p1');

    expect(candidates?.map((c) => c.id)).toEqual(['u1', 'u2']);
  });

  it('sorts a candidate with neither name nor email first', async () => {
    mockProject({
      owner: user('u-blank', null, null),
      workspaceOwner: user('u-named', 'Adam'),
    });

    const candidates = await getApprovalCandidatesForProject('p1');

    expect(candidates?.map((c) => c.id)).toEqual(['u-blank', 'u-named']);
  });

  it('skips null owner and null member user rows without throwing', async () => {
    mockProject({
      owner: null,
      workspaceOwner: null,
      members: [{ user: null }, { user: user('u-real', 'Real') }],
      workspaceMembers: [{ user: null }],
    });

    const candidates = await getApprovalCandidatesForProject('p1');

    expect(candidates).toEqual([
      { id: 'u-real', name: 'Real', email: 'u-real@example.com', image: null },
    ]);
  });

  it('returns an empty list when the project has no people attached at all', async () => {
    mockProject({});

    await expect(getApprovalCandidatesForProject('p1')).resolves.toEqual([]);
  });

  it('queries by project id', async () => {
    mockProject({ owner: user('u1', 'Owner') });

    await getApprovalCandidatesForProject('project-42');

    expect(dbMock.project.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'project-42' } })
    );
  });
});
