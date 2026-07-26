import {
  ProjectMemberRole,
  ProjectVisibility,
  type CommentTag,
  type Project,
  type ProjectMember,
} from '@prisma/client';
import { db } from '@/lib/db';
import { nextSeq } from './seq';

export interface CreateProjectInput {
  ownerId: string;
  workspaceId: string;
  name?: string;
  slug?: string;
  description?: string | null;
  visibility?: ProjectVisibility;
  allowDownloads?: boolean;
}

export async function createProject(input: CreateProjectInput): Promise<Project> {
  const seq = nextSeq();
  return db.project.create({
    data: {
      name: input.name ?? `Project ${seq}`,
      slug: input.slug ?? `project-${seq}`,
      description: input.description ?? null,
      visibility: input.visibility ?? ProjectVisibility.PRIVATE,
      allowDownloads: input.allowDownloads ?? false,
      ownerId: input.ownerId,
      workspaceId: input.workspaceId,
    },
  });
}

export interface AddProjectMemberInput {
  projectId: string;
  userId: string;
  role?: ProjectMemberRole;
}

export async function addProjectMember(input: AddProjectMemberInput): Promise<ProjectMember> {
  return db.projectMember.create({
    data: {
      projectId: input.projectId,
      userId: input.userId,
      role: input.role ?? ProjectMemberRole.COMMENTATOR,
    },
  });
}

export interface CreateCommentTagInput {
  projectId: string;
  name?: string;
  color?: string;
  position?: number;
}

export async function createCommentTag(input: CreateCommentTagInput): Promise<CommentTag> {
  const seq = nextSeq();
  return db.commentTag.create({
    data: {
      projectId: input.projectId,
      name: input.name ?? `Tag ${seq}`,
      color: input.color ?? '#3B82F6',
      position: input.position ?? 0,
    },
  });
}
