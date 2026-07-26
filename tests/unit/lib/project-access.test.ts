import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BillingSubscriptionStatus, ProjectMemberRole, WorkspaceMemberRole } from '@prisma/client';
import { computeProjectAccess, type EnrichedProjectForAccess } from '@/lib/auth';

// `@/lib/auth` reaches `@/lib/db`, which opens a pg Pool and registers process
// signal handlers on import. computeProjectAccess itself touches no database.
vi.mock('@/lib/db', () => ({ db: {}, default: {}, disconnectDb: vi.fn() }));

const PROJECT_OWNER = 'user-project-owner';
const WORKSPACE_OWNER = 'user-workspace-owner';
const OUTSIDER = 'user-outsider';
const PROJECT_COMMENTATOR = 'user-project-commentator';
const PROJECT_ADMIN = 'user-project-admin';
const WORKSPACE_COMMENTATOR = 'user-workspace-commentator';
const WORKSPACE_ADMIN = 'user-workspace-admin';

type OwnerBilling = NonNullable<EnrichedProjectForAccess['workspace']['owner']>;

// computeProjectAccess calls hasBillingAccess() without an injected `now`, so the
// fixtures use dates far enough from any real clock that the result cannot drift.
const ACTIVE_BILLING: OwnerBilling = {
  subscriptionStatus: BillingSubscriptionStatus.FREE,
  trialEndsAt: new Date('2099-01-01T00:00:00Z'),
  stripeCurrentPeriodEnd: null,
  billingAccessEndedAt: null,
};

const EXPIRED_BILLING: OwnerBilling = {
  subscriptionStatus: BillingSubscriptionStatus.CANCELED,
  trialEndsAt: new Date('2020-01-01T00:00:00Z'),
  stripeCurrentPeriodEnd: new Date('2020-01-08T00:00:00Z'),
  billingAccessEndedAt: new Date('2020-01-08T00:00:00Z'),
};

type Actor =
  | 'anonymous'
  | 'signed-in outsider'
  | 'project commentator'
  | 'project admin'
  | 'workspace commentator'
  | 'workspace admin'
  | 'workspace owner'
  | 'project owner';

function userIdFor(actor: Actor): string | undefined {
  switch (actor) {
    case 'anonymous':
      return undefined;
    case 'signed-in outsider':
      return OUTSIDER;
    case 'project commentator':
      return PROJECT_COMMENTATOR;
    case 'project admin':
      return PROJECT_ADMIN;
    case 'workspace commentator':
      return WORKSPACE_COMMENTATOR;
    case 'workspace admin':
      return WORKSPACE_ADMIN;
    case 'workspace owner':
      return WORKSPACE_OWNER;
    case 'project owner':
      return PROJECT_OWNER;
  }
}

function projectMembersFor(actor: Actor): Array<{ role: ProjectMemberRole }> {
  if (actor === 'project commentator') return [{ role: ProjectMemberRole.COMMENTATOR }];
  if (actor === 'project admin') return [{ role: ProjectMemberRole.ADMIN }];
  return [];
}

function workspaceMembersFor(actor: Actor): Array<{ role: WorkspaceMemberRole }> {
  if (actor === 'workspace commentator') return [{ role: WorkspaceMemberRole.COMMENTATOR }];
  if (actor === 'workspace admin') return [{ role: WorkspaceMemberRole.ADMIN }];
  return [];
}

function buildProject(options: {
  actor: Actor;
  visibility: 'PRIVATE' | 'PUBLIC';
  owner: OwnerBilling | null;
}): EnrichedProjectForAccess {
  return {
    id: 'project-1',
    ownerId: PROJECT_OWNER,
    workspaceId: 'workspace-1',
    visibility: options.visibility,
    workspace: {
      id: 'workspace-1',
      ownerId: WORKSPACE_OWNER,
      owner: options.owner,
      members: workspaceMembersFor(options.actor),
    },
    members: projectMembersFor(options.actor),
  };
}

interface MatrixCase {
  actor: Actor;
  visibility: 'PRIVATE' | 'PUBLIC';
  billing: 'active' | 'expired';
  hasAccess: boolean;
  canEdit: boolean;
  canDelete: boolean;
  isWorkspaceAdmin: boolean;
}

// Expected values are written out by hand, not derived from the production
// formula, so a change in the formula shows up as a failure here.
const matrix: MatrixCase[] = [
  // Anonymous: only a public project on a paid workspace is readable.
  {
    actor: 'anonymous',
    visibility: 'PUBLIC',
    billing: 'active',
    hasAccess: true,
    canEdit: false,
    canDelete: false,
    isWorkspaceAdmin: false,
  },
  {
    actor: 'anonymous',
    visibility: 'PRIVATE',
    billing: 'active',
    hasAccess: false,
    canEdit: false,
    canDelete: false,
    isWorkspaceAdmin: false,
  },
  {
    actor: 'anonymous',
    visibility: 'PUBLIC',
    billing: 'expired',
    hasAccess: false,
    canEdit: false,
    canDelete: false,
    isWorkspaceAdmin: false,
  },
  {
    actor: 'anonymous',
    visibility: 'PRIVATE',
    billing: 'expired',
    hasAccess: false,
    canEdit: false,
    canDelete: false,
    isWorkspaceAdmin: false,
  },

  // Signed-in but unrelated user: identical to anonymous.
  {
    actor: 'signed-in outsider',
    visibility: 'PUBLIC',
    billing: 'active',
    hasAccess: true,
    canEdit: false,
    canDelete: false,
    isWorkspaceAdmin: false,
  },
  {
    actor: 'signed-in outsider',
    visibility: 'PRIVATE',
    billing: 'active',
    hasAccess: false,
    canEdit: false,
    canDelete: false,
    isWorkspaceAdmin: false,
  },
  {
    actor: 'signed-in outsider',
    visibility: 'PUBLIC',
    billing: 'expired',
    hasAccess: false,
    canEdit: false,
    canDelete: false,
    isWorkspaceAdmin: false,
  },
  {
    actor: 'signed-in outsider',
    visibility: 'PRIVATE',
    billing: 'expired',
    hasAccess: false,
    canEdit: false,
    canDelete: false,
    isWorkspaceAdmin: false,
  },

  // Project COMMENTATOR: reads a private project, never edits.
  {
    actor: 'project commentator',
    visibility: 'PRIVATE',
    billing: 'active',
    hasAccess: true,
    canEdit: false,
    canDelete: false,
    isWorkspaceAdmin: false,
  },
  {
    actor: 'project commentator',
    visibility: 'PUBLIC',
    billing: 'active',
    hasAccess: true,
    canEdit: false,
    canDelete: false,
    isWorkspaceAdmin: false,
  },
  {
    actor: 'project commentator',
    visibility: 'PRIVATE',
    billing: 'expired',
    hasAccess: false,
    canEdit: false,
    canDelete: false,
    isWorkspaceAdmin: false,
  },
  {
    actor: 'project commentator',
    visibility: 'PUBLIC',
    billing: 'expired',
    hasAccess: false,
    canEdit: false,
    canDelete: false,
    isWorkspaceAdmin: false,
  },

  // Project ADMIN: edits, but deleting the project stays with the owners.
  {
    actor: 'project admin',
    visibility: 'PRIVATE',
    billing: 'active',
    hasAccess: true,
    canEdit: true,
    canDelete: false,
    isWorkspaceAdmin: false,
  },
  {
    actor: 'project admin',
    visibility: 'PUBLIC',
    billing: 'active',
    hasAccess: true,
    canEdit: true,
    canDelete: false,
    isWorkspaceAdmin: false,
  },
  {
    actor: 'project admin',
    visibility: 'PRIVATE',
    billing: 'expired',
    hasAccess: false,
    canEdit: false,
    canDelete: false,
    isWorkspaceAdmin: false,
  },
  {
    actor: 'project admin',
    visibility: 'PUBLIC',
    billing: 'expired',
    hasAccess: false,
    canEdit: false,
    canDelete: false,
    isWorkspaceAdmin: false,
  },

  // Workspace COMMENTATOR: reads every project in the workspace, edits none.
  {
    actor: 'workspace commentator',
    visibility: 'PRIVATE',
    billing: 'active',
    hasAccess: true,
    canEdit: false,
    canDelete: false,
    isWorkspaceAdmin: false,
  },
  {
    actor: 'workspace commentator',
    visibility: 'PUBLIC',
    billing: 'active',
    hasAccess: true,
    canEdit: false,
    canDelete: false,
    isWorkspaceAdmin: false,
  },
  {
    actor: 'workspace commentator',
    visibility: 'PRIVATE',
    billing: 'expired',
    hasAccess: false,
    canEdit: false,
    canDelete: false,
    isWorkspaceAdmin: false,
  },
  {
    actor: 'workspace commentator',
    visibility: 'PUBLIC',
    billing: 'expired',
    hasAccess: false,
    canEdit: false,
    canDelete: false,
    isWorkspaceAdmin: false,
  },

  // Workspace ADMIN: edits any project including public ones (the regression
  // fixed by fix/public-project-hides-workspace-admin-actions), but cannot delete.
  {
    actor: 'workspace admin',
    visibility: 'PRIVATE',
    billing: 'active',
    hasAccess: true,
    canEdit: true,
    canDelete: false,
    isWorkspaceAdmin: true,
  },
  {
    actor: 'workspace admin',
    visibility: 'PUBLIC',
    billing: 'active',
    hasAccess: true,
    canEdit: true,
    canDelete: false,
    isWorkspaceAdmin: true,
  },
  {
    actor: 'workspace admin',
    visibility: 'PRIVATE',
    billing: 'expired',
    hasAccess: false,
    canEdit: false,
    canDelete: false,
    isWorkspaceAdmin: true,
  },
  {
    actor: 'workspace admin',
    visibility: 'PUBLIC',
    billing: 'expired',
    hasAccess: false,
    canEdit: false,
    canDelete: false,
    isWorkspaceAdmin: true,
  },

  // Workspace OWNER: full control while billing holds.
  {
    actor: 'workspace owner',
    visibility: 'PRIVATE',
    billing: 'active',
    hasAccess: true,
    canEdit: true,
    canDelete: true,
    isWorkspaceAdmin: true,
  },
  {
    actor: 'workspace owner',
    visibility: 'PUBLIC',
    billing: 'active',
    hasAccess: true,
    canEdit: true,
    canDelete: true,
    isWorkspaceAdmin: true,
  },
  {
    actor: 'workspace owner',
    visibility: 'PRIVATE',
    billing: 'expired',
    hasAccess: false,
    canEdit: false,
    canDelete: false,
    isWorkspaceAdmin: true,
  },
  {
    actor: 'workspace owner',
    visibility: 'PUBLIC',
    billing: 'expired',
    hasAccess: false,
    canEdit: false,
    canDelete: false,
    isWorkspaceAdmin: true,
  },

  // Project owner who is not the workspace owner: full control over the project.
  {
    actor: 'project owner',
    visibility: 'PRIVATE',
    billing: 'active',
    hasAccess: true,
    canEdit: true,
    canDelete: true,
    isWorkspaceAdmin: false,
  },
  {
    actor: 'project owner',
    visibility: 'PUBLIC',
    billing: 'active',
    hasAccess: true,
    canEdit: true,
    canDelete: true,
    isWorkspaceAdmin: false,
  },
  {
    actor: 'project owner',
    visibility: 'PRIVATE',
    billing: 'expired',
    hasAccess: false,
    canEdit: false,
    canDelete: false,
    isWorkspaceAdmin: false,
  },
  {
    actor: 'project owner',
    visibility: 'PUBLIC',
    billing: 'expired',
    hasAccess: false,
    canEdit: false,
    canDelete: false,
    isWorkspaceAdmin: false,
  },
];

describe('computeProjectAccess', () => {
  beforeEach(() => {
    // hasBillingAccess() short-circuits to true when Stripe is disabled, so pin
    // the flag on for the whole matrix.
    vi.stubEnv('OPENFRAME_ENABLE_STRIPE', 'true');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(matrix)(
    'grants { access: $hasAccess, edit: $canEdit, delete: $canDelete } to a $actor on a $visibility project with $billing billing',
    ({ actor, visibility, billing, hasAccess, canEdit, canDelete, isWorkspaceAdmin }) => {
      const project = buildProject({
        actor,
        visibility,
        owner: billing === 'active' ? ACTIVE_BILLING : EXPIRED_BILLING,
      });

      const access = computeProjectAccess(project, userIdFor(actor));

      expect(access.hasAccess).toBe(hasAccess);
      expect(access.canEdit).toBe(canEdit);
      expect(access.canDelete).toBe(canDelete);
      expect(access.isWorkspaceAdmin).toBe(isWorkspaceAdmin);
      expect(access.ownerBillingActive).toBe(billing === 'active');
    }
  );

  it('reports every role flag for a project admin who is also a workspace commentator', () => {
    const project: EnrichedProjectForAccess = {
      id: 'project-1',
      ownerId: PROJECT_OWNER,
      workspaceId: 'workspace-1',
      visibility: 'PRIVATE',
      workspace: {
        id: 'workspace-1',
        ownerId: WORKSPACE_OWNER,
        owner: ACTIVE_BILLING,
        members: [{ role: WorkspaceMemberRole.COMMENTATOR }],
      },
      members: [{ role: ProjectMemberRole.ADMIN }],
    };

    expect(computeProjectAccess(project, PROJECT_ADMIN)).toEqual({
      isOwner: false,
      isProjectMember: true,
      isProjectAdmin: true,
      isWorkspaceMember: true,
      isWorkspaceAdmin: false,
      hasAccess: true,
      canEdit: true,
      canDelete: false,
      ownerBillingActive: true,
    });
  });

  it('denies everything when the workspace owner row is missing', () => {
    const project = buildProject({ actor: 'project owner', visibility: 'PUBLIC', owner: null });

    const access = computeProjectAccess(project, PROJECT_OWNER);

    expect(access.ownerBillingActive).toBe(false);
    expect(access.hasAccess).toBe(false);
    expect(access.canEdit).toBe(false);
    expect(access.canDelete).toBe(false);
    // The identity flags still resolve; only the billing gate closed.
    expect(access.isOwner).toBe(true);
  });

  it('denies canEdit when the workspace owner trial has expired', () => {
    const project = buildProject({
      actor: 'workspace admin',
      visibility: 'PRIVATE',
      owner: {
        subscriptionStatus: BillingSubscriptionStatus.FREE,
        trialEndsAt: new Date('2020-01-01T00:00:00Z'),
        stripeCurrentPeriodEnd: null,
        billingAccessEndedAt: null,
      },
    });

    const access = computeProjectAccess(project, WORKSPACE_ADMIN);

    expect(access.isWorkspaceAdmin).toBe(true);
    expect(access.canEdit).toBe(false);
    expect(access.hasAccess).toBe(false);
  });

  it('keeps access when the workspace owner subscription is ACTIVE but every date is in the past', () => {
    const project = buildProject({
      actor: 'workspace commentator',
      visibility: 'PRIVATE',
      owner: {
        subscriptionStatus: BillingSubscriptionStatus.ACTIVE,
        trialEndsAt: new Date('2020-01-01T00:00:00Z'),
        stripeCurrentPeriodEnd: new Date('2020-01-08T00:00:00Z'),
        billingAccessEndedAt: null,
      },
    });

    const access = computeProjectAccess(project, WORKSPACE_COMMENTATOR);

    expect(access.ownerBillingActive).toBe(true);
    expect(access.hasAccess).toBe(true);
  });

  it('treats billing as active for every workspace when Stripe is disabled', () => {
    vi.stubEnv('OPENFRAME_ENABLE_STRIPE', 'false');
    const project = buildProject({
      actor: 'signed-in outsider',
      visibility: 'PUBLIC',
      owner: EXPIRED_BILLING,
    });

    const access = computeProjectAccess(project, OUTSIDER);

    expect(access.ownerBillingActive).toBe(true);
    expect(access.hasAccess).toBe(true);
    expect(access.canEdit).toBe(false);
  });

  it('reads only the first project membership row', () => {
    const project: EnrichedProjectForAccess = {
      id: 'project-1',
      ownerId: PROJECT_OWNER,
      workspaceId: 'workspace-1',
      visibility: 'PRIVATE',
      workspace: {
        id: 'workspace-1',
        ownerId: WORKSPACE_OWNER,
        owner: ACTIVE_BILLING,
        members: [],
      },
      members: [{ role: ProjectMemberRole.COMMENTATOR }, { role: ProjectMemberRole.ADMIN }],
    };

    const access = computeProjectAccess(project, PROJECT_COMMENTATOR);

    expect(access.isProjectAdmin).toBe(false);
    expect(access.canEdit).toBe(false);
  });

  it('prefers the OWNER role over a stale workspace membership row for the same user', () => {
    const project: EnrichedProjectForAccess = {
      id: 'project-1',
      ownerId: PROJECT_OWNER,
      workspaceId: 'workspace-1',
      visibility: 'PRIVATE',
      workspace: {
        id: 'workspace-1',
        ownerId: WORKSPACE_OWNER,
        owner: ACTIVE_BILLING,
        members: [{ role: WorkspaceMemberRole.COMMENTATOR }],
      },
      members: [],
    };

    const access = computeProjectAccess(project, WORKSPACE_OWNER);

    expect(access.isWorkspaceAdmin).toBe(true);
    expect(access.canDelete).toBe(true);
  });

  it('treats an unknown visibility string as private', () => {
    const project = buildProject({
      actor: 'anonymous',
      visibility: 'PUBLIC',
      owner: ACTIVE_BILLING,
    });
    const restricted = { ...project, visibility: 'UNLISTED' };

    expect(computeProjectAccess(restricted, undefined).hasAccess).toBe(false);
  });
});
