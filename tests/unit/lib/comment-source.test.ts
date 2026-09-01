import { describe, expect, it } from 'vitest';
import { canSignedInMemberManageAgentComment, isSignedInProjectMember } from '@/lib/comment-source';

describe('isSignedInProjectMember', () => {
  it('treats owners, project members, and workspace members as members', () => {
    expect(
      isSignedInProjectMember({ isOwner: true, isProjectMember: false, isWorkspaceMember: false })
    ).toBe(true);
    expect(
      isSignedInProjectMember({ isOwner: false, isProjectMember: true, isWorkspaceMember: false })
    ).toBe(true);
    expect(
      isSignedInProjectMember({ isOwner: false, isProjectMember: false, isWorkspaceMember: true })
    ).toBe(true);
  });

  it('does not treat a public-project viewer as a member', () => {
    expect(
      isSignedInProjectMember({ isOwner: false, isProjectMember: false, isWorkspaceMember: false })
    ).toBe(false);
  });
});

describe('canSignedInMemberManageAgentComment', () => {
  it('allows a signed-in member to resolve or delete an agent comment', () => {
    expect(
      canSignedInMemberManageAgentComment({
        source: 'AGENT',
        userId: 'user-1',
        isMember: true,
      })
    ).toBe(true);
  });

  it('refuses guests, human comments, and non-members', () => {
    expect(
      canSignedInMemberManageAgentComment({
        source: 'AGENT',
        userId: null,
        isMember: true,
      })
    ).toBe(false);
    expect(
      canSignedInMemberManageAgentComment({
        source: 'HUMAN',
        userId: 'user-1',
        isMember: true,
      })
    ).toBe(false);
    expect(
      canSignedInMemberManageAgentComment({
        source: 'AGENT',
        userId: 'user-1',
        isMember: false,
      })
    ).toBe(false);
  });
});
