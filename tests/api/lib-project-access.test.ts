// Exercises checkProjectAccess() directly, against real rows, next to
// computeProjectAccess() on the same rows.
//
// Nothing did that before. Every existing test reaches checkProjectAccess()
// through a route and only ever sees the status code it produced, and
// tests/unit/lib/route-access.test.ts mocks it out entirely. That leaves its
// input resolution, the four queries it runs to decide who the caller is,
// uncovered: deleting the `wsOwner?.ownerId === userId` branch in lib/auth.ts,
// which is the line that makes a workspace owner an owner, failed exactly one
// test out of 984.
//
// The two functions resolve the same six inputs by different routes.
// computeProjectAccess() reads them off a project fetched with
// projectAccessInclude(); checkProjectAccess() queries for each relation
// separately. Since they were refactored onto one shared formula helper
// (resolveProjectPermissions) the formulas cannot drift, which makes it easy to
// read the refactor as a guarantee that the two functions agree. It is not one.
// The formulas are shared; the inputs are not, and they already disagree in one
// place, asserted below rather than smoothed over.
//
// Expected values are written out by hand for every actor. Comparing the two
// functions to each other would be a weaker test: a wrong answer that both
// produce would pass. Comparing both to the same hand-written table proves
// agreement and correctness at once.

import { beforeEach, describe, expect, it } from 'vitest';
import { ProjectMemberRole, WorkspaceMemberRole } from '@prisma/client';
import {
  checkProjectAccess,
  computeProjectAccess,
  projectAccessInclude,
  type EnrichedProjectForAccess,
} from '@/lib/auth';
import { db } from '@/lib/db';
import {
  addProjectMember,
  addWorkspaceMember,
  createExpiredUser,
  createProject,
  createUser,
  createWorkspace,
} from '../factories';

type Intent = 'view' | 'manage' | 'delete';

/** `undefined` stands for a caller that passes no options at all. */
const INTENTS: ReadonlyArray<Intent | undefined> = [undefined, 'view', 'manage', 'delete'];

type Actor =
  | 'an anonymous caller'
  | 'an outsider'
  | 'a project commentator'
  | 'a project admin'
  | 'a workspace commentator'
  | 'a workspace admin'
  | 'the workspace owner'
  | 'the project owner'
  | 'a project owner who also owns the workspace';

const ACTORS: readonly Actor[] = [
  'an anonymous caller',
  'an outsider',
  'a project commentator',
  'a project admin',
  'a workspace commentator',
  'a workspace admin',
  'the workspace owner',
  'the project owner',
  'a project owner who also owns the workspace',
];

/** Exactly the shape both functions return, so `toEqual` covers every field. */
interface ExpectedAccess {
  isOwner: boolean;
  isProjectMember: boolean;
  isProjectAdmin: boolean;
  isWorkspaceMember: boolean;
  isWorkspaceAdmin: boolean;
  hasAccess: boolean;
  canEdit: boolean;
  canDelete: boolean;
  ownerBillingActive: boolean;
}

// ---------------------------------------------------------------------------
// The tables
// ---------------------------------------------------------------------------
// Three scenarios, because the two functions can only disagree over inputs and
// these are the inputs they read differently: who the caller is (nine actors),
// whether the project is public (the second table), and whether the workspace
// owner still has billing access (the third). checkProjectAccess() resolves
// billing in two different queries depending on which branch it takes, so the
// expired table is the one that catches a branch that forgets to.

const PRIVATE_ACTIVE_BILLING: Record<Actor, ExpectedAccess> = {
  'an anonymous caller': {
    isOwner: false,
    isProjectMember: false,
    isProjectAdmin: false,
    isWorkspaceMember: false,
    isWorkspaceAdmin: false,
    hasAccess: false,
    canEdit: false,
    canDelete: false,
    ownerBillingActive: true,
  },
  // Their ADMIN roles live in an unrelated workspace, so they buy nothing here.
  'an outsider': {
    isOwner: false,
    isProjectMember: false,
    isProjectAdmin: false,
    isWorkspaceMember: false,
    isWorkspaceAdmin: false,
    hasAccess: false,
    canEdit: false,
    canDelete: false,
    ownerBillingActive: true,
  },
  'a project commentator': {
    isOwner: false,
    isProjectMember: true,
    isProjectAdmin: false,
    isWorkspaceMember: false,
    isWorkspaceAdmin: false,
    hasAccess: true,
    canEdit: false,
    canDelete: false,
    ownerBillingActive: true,
  },
  'a project admin': {
    isOwner: false,
    isProjectMember: true,
    isProjectAdmin: true,
    isWorkspaceMember: false,
    isWorkspaceAdmin: false,
    hasAccess: true,
    canEdit: true,
    canDelete: false,
    ownerBillingActive: true,
  },
  'a workspace commentator': {
    isOwner: false,
    isProjectMember: false,
    isProjectAdmin: false,
    isWorkspaceMember: true,
    isWorkspaceAdmin: false,
    hasAccess: true,
    canEdit: false,
    canDelete: false,
    ownerBillingActive: true,
  },
  'a workspace admin': {
    isOwner: false,
    isProjectMember: false,
    isProjectAdmin: false,
    isWorkspaceMember: true,
    isWorkspaceAdmin: true,
    hasAccess: true,
    canEdit: true,
    canDelete: false,
    ownerBillingActive: true,
  },
  // The workspace owner has no WorkspaceMember row; the OWNER role is derived
  // from workspace.ownerId, and deleting the project is theirs alone.
  'the workspace owner': {
    isOwner: false,
    isProjectMember: false,
    isProjectAdmin: false,
    isWorkspaceMember: true,
    isWorkspaceAdmin: true,
    hasAccess: true,
    canEdit: true,
    canDelete: true,
    ownerBillingActive: true,
  },
  'the project owner': {
    isOwner: true,
    isProjectMember: false,
    isProjectAdmin: false,
    isWorkspaceMember: false,
    isWorkspaceAdmin: false,
    hasAccess: true,
    canEdit: true,
    canDelete: true,
    ownerBillingActive: true,
  },
  'a project owner who also owns the workspace': {
    isOwner: true,
    isProjectMember: false,
    isProjectAdmin: false,
    isWorkspaceMember: true,
    isWorkspaceAdmin: true,
    hasAccess: true,
    canEdit: true,
    canDelete: true,
    ownerBillingActive: true,
  },
};

// Public only moves the two actors who had no relationship to the project.
const PUBLIC_ACTIVE_BILLING: Record<Actor, ExpectedAccess> = {
  ...PRIVATE_ACTIVE_BILLING,
  'an anonymous caller': { ...PRIVATE_ACTIVE_BILLING['an anonymous caller'], hasAccess: true },
  'an outsider': { ...PRIVATE_ACTIVE_BILLING['an outsider'], hasAccess: true },
};

/**
 * With the workspace owner's billing lapsed, the identity flags still resolve
 * and every permission closes, including the project owner's own. The project
 * owner is a separate person with a live trial of their own: it is the
 * *workspace* owner's billing that pays for the workspace.
 */
const PRIVATE_EXPIRED_BILLING: Record<Actor, ExpectedAccess> = Object.fromEntries(
  ACTORS.map((actor) => [
    actor,
    {
      ...PRIVATE_ACTIVE_BILLING[actor],
      hasAccess: false,
      canEdit: false,
      canDelete: false,
      ownerBillingActive: false,
    },
  ])
) as Record<Actor, ExpectedAccess>;

interface Scenario {
  name: string;
  visibility: 'PRIVATE' | 'PUBLIC';
  billing: 'active' | 'expired';
  expected: Record<Actor, ExpectedAccess>;
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: 'a PRIVATE project whose workspace owner has billing access',
    visibility: 'PRIVATE',
    billing: 'active',
    expected: PRIVATE_ACTIVE_BILLING,
  },
  {
    name: 'a PUBLIC project whose workspace owner has billing access',
    visibility: 'PUBLIC',
    billing: 'active',
    expected: PUBLIC_ACTIVE_BILLING,
  },
  {
    name: 'a PRIVATE project whose workspace owner has lost billing access',
    visibility: 'PRIVATE',
    billing: 'expired',
    expected: PRIVATE_EXPIRED_BILLING,
  },
];

// ---------------------------------------------------------------------------
// The known divergence
// ---------------------------------------------------------------------------

/**
 * The one place the two functions disagree, spelled out rather than filtered
 * out.
 *
 * `shouldLoadWorkspaceRole` in lib/auth.ts skips the workspace queries for a
 * project owner on `intent: 'view'`, on the reasoning that an owner passes every
 * check on their own. That is true of the three permission booleans, and it is
 * why this is harmless today, but it is not true of the two identity flags:
 * checkProjectAccess() reports `isWorkspaceMember: false, isWorkspaceAdmin:
 * false` for an owner who is in fact the workspace owner, where
 * computeProjectAccess() on the same rows reports true and true.
 *
 * Harmless today rests on one fact and not on the design: the only consumer of
 * `isWorkspaceMember` from checkProjectAccess() is
 * app/api/versions/[versionId]/approvals/route.ts:37, and its
 * `isOwner || isProjectMember || isWorkspaceMember` is already satisfied by
 * `isOwner` for exactly the actor that diverges. Nothing consumes
 * `isWorkspaceAdmin` from checkProjectAccess() at all; `canEdit` folds it in,
 * and `isOwner` covers that too. The next reader of either flag inherits the
 * bug, which is why this is asserted instead of hidden behind a comparison of
 * `hasAccess` alone.
 *
 * If this stops matching, the divergence was closed: delete this function and
 * the test at the bottom of the file rather than widening either of them.
 */
function knownDivergence(actor: Actor, intent: Intent | undefined): Partial<ExpectedAccess> {
  const resolvesWorkspaceRole = intent === 'manage' || intent === 'delete';
  if (actor === 'a project owner who also owns the workspace' && !resolvesWorkspaceRole) {
    return { isWorkspaceMember: false, isWorkspaceAdmin: false };
  }
  return {};
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Seeded {
  /** The project every actor except the last one is measured against. */
  projectId: string;
  /** A second project in the same workspace, owned by the workspace owner. */
  ownedProjectId: string;
  userIdFor: (actor: Actor) => string | undefined;
}

/**
 * One workspace, two projects in it, and a user for every actor.
 *
 * The second project matters. Almost every real workspace has projects owned by
 * the person who owns the workspace (that is what signing up produces), and that
 * is the only actor for whom the two functions disagree. A fixture that only had
 * a project owned by somebody other than the workspace owner would agree
 * everywhere and prove less than it looks.
 *
 * The outsider is deliberately not a blank user: they are an ADMIN of another
 * workspace and of a project inside it. Both of checkProjectAccess()'s
 * membership lookups are keyed on a compound unique, and if either lost its
 * project or workspace half the query would still find a row for this user. A
 * blank outsider cannot tell the difference.
 */
async function seedScenario(scenario: Scenario): Promise<Seeded> {
  const workspaceOwner =
    scenario.billing === 'active' ? await createUser() : await createExpiredUser();
  const projectOwner = await createUser();
  const projectAdmin = await createUser();
  const projectCommentator = await createUser();
  const workspaceAdmin = await createUser();
  const workspaceCommentator = await createUser();
  const outsider = await createUser();

  const workspace = await createWorkspace({ ownerId: workspaceOwner.id });
  const project = await createProject({
    ownerId: projectOwner.id,
    workspaceId: workspace.id,
    visibility: scenario.visibility,
  });
  const ownedProject = await createProject({
    ownerId: workspaceOwner.id,
    workspaceId: workspace.id,
    visibility: scenario.visibility,
  });

  await addProjectMember({
    projectId: project.id,
    userId: projectAdmin.id,
    role: ProjectMemberRole.ADMIN,
  });
  await addProjectMember({
    projectId: project.id,
    userId: projectCommentator.id,
    role: ProjectMemberRole.COMMENTATOR,
  });
  await addWorkspaceMember({
    workspaceId: workspace.id,
    userId: workspaceAdmin.id,
    role: WorkspaceMemberRole.ADMIN,
  });
  await addWorkspaceMember({
    workspaceId: workspace.id,
    userId: workspaceCommentator.id,
    role: WorkspaceMemberRole.COMMENTATOR,
  });

  const elsewhere = await createWorkspace({ ownerId: outsider.id });
  const elsewhereProject = await createProject({
    ownerId: outsider.id,
    workspaceId: elsewhere.id,
    visibility: 'PRIVATE',
  });
  await addWorkspaceMember({
    workspaceId: elsewhere.id,
    userId: outsider.id,
    role: WorkspaceMemberRole.ADMIN,
  });
  await addProjectMember({
    projectId: elsewhereProject.id,
    userId: outsider.id,
    role: ProjectMemberRole.ADMIN,
  });

  const userIds: Record<Actor, string | undefined> = {
    'an anonymous caller': undefined,
    'an outsider': outsider.id,
    'a project commentator': projectCommentator.id,
    'a project admin': projectAdmin.id,
    'a workspace commentator': workspaceCommentator.id,
    'a workspace admin': workspaceAdmin.id,
    'the workspace owner': workspaceOwner.id,
    'the project owner': projectOwner.id,
    'a project owner who also owns the workspace': workspaceOwner.id,
  };

  return {
    projectId: project.id,
    ownedProjectId: ownedProject.id,
    userIdFor: (actor) => userIds[actor],
  };
}

/** The project an actor is measured against. */
function projectIdFor(actor: Actor, seeded: Seeded): string {
  return actor === 'a project owner who also owns the workspace'
    ? seeded.ownedProjectId
    : seeded.projectId;
}

/** The project as a route fetches it, with everything computeProjectAccess reads. */
async function fetchEnriched(
  projectId: string,
  userId: string | undefined
): Promise<EnrichedProjectForAccess> {
  return db.project.findUniqueOrThrow({
    where: { id: projectId },
    include: projectAccessInclude(userId),
  });
}

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------
// hasBillingAccess() short-circuits to true when Stripe is disabled, which would
// flatten the expired scenario into the active one. OPENFRAME_ENABLE_STRIPE is
// "true" in .env.test, so the gate is armed for every test here.

for (const scenario of SCENARIOS) {
  describe(`checkProjectAccess on ${scenario.name}`, () => {
    let seeded: Seeded;

    beforeEach(async () => {
      seeded = await seedScenario(scenario);
    });

    for (const actor of ACTORS) {
      it(`resolves ${actor} exactly as computeProjectAccess does, at every intent`, async () => {
        const userId = seeded.userIdFor(actor);
        const projectId = projectIdFor(actor, seeded);
        const expected = scenario.expected[actor];
        const enriched = await fetchEnriched(projectId, userId);

        // The pure half first: given the rows, this is the answer.
        expect(computeProjectAccess(enriched, userId), 'computeProjectAccess').toEqual(expected);

        // And the querying half, which has to arrive at the same place from the
        // same rows, whatever the caller says it intends to do.
        for (const intent of INTENTS) {
          const checked = await checkProjectAccess(
            enriched,
            userId,
            intent === undefined ? undefined : { intent }
          );

          expect(checked, `checkProjectAccess with intent ${intent ?? '(default)'}`).toEqual({
            ...expected,
            ...knownDivergence(actor, intent),
          });
        }
      });
    }
  });
}

// ---------------------------------------------------------------------------
// The divergence, on its own
// ---------------------------------------------------------------------------

describe('checkProjectAccess and computeProjectAccess disagree in one place', () => {
  it('hides the workspace role from a project owner who also owns the workspace, on intent view', async () => {
    const owner = await createUser();
    const workspace = await createWorkspace({ ownerId: owner.id });
    const project = await createProject({
      ownerId: owner.id,
      workspaceId: workspace.id,
      visibility: 'PRIVATE',
    });

    const enriched = await fetchEnriched(project.id, owner.id);

    const computed = computeProjectAccess(enriched, owner.id);
    const viewed = await checkProjectAccess(enriched, owner.id, { intent: 'view' });
    const managed = await checkProjectAccess(enriched, owner.id, { intent: 'manage' });

    // What the rows say: this user owns the workspace the project lives in.
    expect(computed.isWorkspaceMember).toBe(true);
    expect(computed.isWorkspaceAdmin).toBe(true);

    // What checkProjectAccess() says on the intent that pages and GET routes
    // use. `shouldLoadWorkspaceRole` skipped the workspace queries, so the role
    // was never resolved and the two flags read as if this user were a stranger
    // to the workspace.
    expect(viewed.isWorkspaceMember).toBe(false);
    expect(viewed.isWorkspaceAdmin).toBe(false);

    // Ask the same question with a mutating intent and the same user, on the
    // same rows, is a workspace owner again.
    expect(managed.isWorkspaceMember).toBe(true);
    expect(managed.isWorkspaceAdmin).toBe(true);

    // Why nobody has noticed: every permission the flags feed is already
    // granted by isOwner, so the divergence stops at the two identity flags.
    expect(viewed.hasAccess).toBe(true);
    expect(viewed.canEdit).toBe(true);
    expect(viewed.canDelete).toBe(true);
    expect({ ...viewed, isWorkspaceMember: true, isWorkspaceAdmin: true }).toEqual(computed);
  });
});
