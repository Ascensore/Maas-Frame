export type CommentSourceValue = 'HUMAN' | 'AGENT';

export function isSignedInProjectMember(access: {
  isOwner: boolean;
  isProjectMember: boolean;
  isWorkspaceMember: boolean;
}): boolean {
  return access.isOwner || access.isProjectMember || access.isWorkspaceMember;
}

/**
 * Signed-in project or workspace members may resolve or delete agent comments.
 * Guests may not: agent posts are not theirs, and a share link must not be a
 * delete key. Public-project viewers are not members.
 */
export function canSignedInMemberManageAgentComment(options: {
  source: CommentSourceValue;
  userId: string | null | undefined;
  isMember: boolean;
}): boolean {
  return options.source === 'AGENT' && Boolean(options.userId) && options.isMember;
}
