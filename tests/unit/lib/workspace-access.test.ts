import { describe, expect, it, vi } from 'vitest';
import { resolveWorkspacePermissions } from '@/lib/auth';

// `@/lib/auth` reaches `@/lib/db`, which opens a pg Pool and registers process
// signal handlers on import. resolveWorkspacePermissions touches no database.
vi.mock('@/lib/db', () => ({ db: {}, default: {}, disconnectDb: vi.fn() }));

// The workspace half of the permission matrix. Until this file existed the
// formulas were only ever reached through checkWorkspaceAccess(), which means
// they were asserted on incidentally by whichever route a suite happened to
// call. tests/unit/lib/project-access.test.ts does the same job for projects.
//
// Every case below states the expected verdict outright rather than deriving it
// from the inputs, so a change to the formula cannot quietly change the
// expectation with it.

// There is deliberately no separate 'anonymous' actor. resolveWorkspacePermissions
// receives three booleans, not a user, and an anonymous caller and a signed-in
// outsider set all three to false, so the two would be byte-identical inputs
// running under names that imply a distinction this function cannot see. Telling
// "no session" from "a session with no membership" is checkWorkspaceAccess()'s
// job: it is the one that resolves a userId to membership rows before calling
// here, and it is covered against the database in the api suites.
type Actor = 'outsider' | 'member' | 'admin' | 'owner';

function inputsFor(actor: Actor, ownerBillingActive: boolean) {
  return {
    isOwner: actor === 'owner',
    isMember: actor === 'member' || actor === 'admin',
    isAdmin: actor === 'admin',
    ownerBillingActive,
  };
}

describe('resolveWorkspacePermissions, with the owner billing active', () => {
  const cases: Array<{
    actor: Actor;
    hasAccess: boolean;
    canEdit: boolean;
    canDelete: boolean;
  }> = [
    { actor: 'outsider', hasAccess: false, canEdit: false, canDelete: false },
    { actor: 'member', hasAccess: true, canEdit: false, canDelete: false },
    { actor: 'admin', hasAccess: true, canEdit: true, canDelete: false },
    { actor: 'owner', hasAccess: true, canEdit: true, canDelete: true },
  ];

  for (const { actor, hasAccess, canEdit, canDelete } of cases) {
    it(`grants a ${actor} access=${hasAccess}, edit=${canEdit}, delete=${canDelete}`, () => {
      const result = resolveWorkspacePermissions(inputsFor(actor, true));

      expect(result.hasAccess).toBe(hasAccess);
      expect(result.canEdit).toBe(canEdit);
      expect(result.canDelete).toBe(canDelete);
    });
  }

  it('only the owner can delete, an admin cannot', () => {
    // Stated separately because it is the one rule that differs from the
    // project matrix, where a project admin does get canDelete through the
    // workspace-owner branch.
    expect(resolveWorkspacePermissions(inputsFor('admin', true)).canDelete).toBe(false);
    expect(resolveWorkspacePermissions(inputsFor('owner', true)).canDelete).toBe(true);
  });

  it('reports the membership flags it was handed, unchanged', () => {
    expect(resolveWorkspacePermissions(inputsFor('admin', true))).toEqual({
      isOwner: false,
      isMember: true,
      isAdmin: true,
      hasAccess: true,
      canEdit: true,
      canDelete: false,
      ownerBillingActive: true,
    });
  });
});

describe('resolveWorkspacePermissions, with the owner billing lapsed', () => {
  // Billing is the outer gate: it revokes everything, including from the owner
  // of the workspace. A member who kept `hasAccess` here would keep reading a
  // workspace the account no longer pays for.
  for (const actor of ['outsider', 'member', 'admin', 'owner'] as const) {
    it(`refuses a ${actor} everything`, () => {
      const result = resolveWorkspacePermissions(inputsFor(actor, false));

      expect(result.hasAccess).toBe(false);
      expect(result.canEdit).toBe(false);
      expect(result.canDelete).toBe(false);
    });
  }

  it('still reports the membership flags, so a caller can tell "lapsed" from "not a member"', () => {
    const result = resolveWorkspacePermissions(inputsFor('owner', false));

    expect(result.isOwner).toBe(true);
    expect(result.ownerBillingActive).toBe(false);
  });
});
