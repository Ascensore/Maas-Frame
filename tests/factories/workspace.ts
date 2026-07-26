import {
  InvitationRole,
  InvitationScope,
  InvitationStatus,
  WorkspaceMemberRole,
  type Invitation,
  type Workspace,
  type WorkspaceMember,
} from '@prisma/client';
import { db } from '@/lib/db';
import { nextSeq } from './seq';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface CreateWorkspaceInput {
  ownerId: string;
  name?: string;
  slug?: string;
  description?: string | null;
}

export async function createWorkspace(input: CreateWorkspaceInput): Promise<Workspace> {
  const seq = nextSeq();
  return db.workspace.create({
    data: {
      name: input.name ?? `Workspace ${seq}`,
      slug: input.slug ?? `workspace-${seq}`,
      description: input.description ?? null,
      ownerId: input.ownerId,
    },
  });
}

export interface AddWorkspaceMemberInput {
  workspaceId: string;
  userId: string;
  role?: WorkspaceMemberRole;
}

export async function addWorkspaceMember(input: AddWorkspaceMemberInput): Promise<WorkspaceMember> {
  return db.workspaceMember.create({
    data: {
      workspaceId: input.workspaceId,
      userId: input.userId,
      role: input.role ?? WorkspaceMemberRole.COMMENTATOR,
    },
  });
}

export interface CreateInvitationInput {
  invitedById: string;
  email?: string;
  scope: InvitationScope;
  role?: InvitationRole;
  status?: InvitationStatus;
  workspaceId?: string | null;
  projectId?: string | null;
  token?: string;
  expiresAt?: Date;
  acceptedAt?: Date | null;
}

export async function createInvitation(input: CreateInvitationInput): Promise<Invitation> {
  const seq = nextSeq();
  return db.invitation.create({
    data: {
      token: input.token ?? `invitation-token-${seq}`,
      email: input.email ?? `invitee-${seq}@example.com`,
      scope: input.scope,
      role: input.role ?? InvitationRole.COMMENTATOR,
      status: input.status ?? InvitationStatus.PENDING,
      workspaceId: input.workspaceId ?? null,
      projectId: input.projectId ?? null,
      invitedById: input.invitedById,
      expiresAt: input.expiresAt ?? new Date(Date.now() + 7 * DAY_MS),
      acceptedAt: input.acceptedAt ?? null,
    },
  });
}
