// Two composite builders for the arrangement almost every api test needs: an
// owner with billing access, their workspace, a project inside it, and
// optionally a video with one version.
//
// These are a shorthand, not shared state. Each call inserts fresh rows, and
// resetDb() wipes them after the test, so nothing here creates an ordering
// dependency between tests.

import type {
  Project,
  ProjectVisibility,
  User,
  Video,
  VideoVersion,
  Workspace,
} from '@prisma/client';
import { createProject } from './project';
import { createUser, type CreateUserInput } from './user';
import { createVersion, createVideo } from './video';
import { createWorkspace } from './workspace';

export interface ProjectScenario {
  owner: User;
  workspace: Workspace;
  project: Project;
}

export interface SeedProjectInput {
  visibility?: ProjectVisibility;
  allowDownloads?: boolean;
  projectName?: string;
  owner?: CreateUserInput;
  /** Reuse an existing user as the workspace and project owner. */
  ownerUser?: User;
}

export async function seedProject(input: SeedProjectInput = {}): Promise<ProjectScenario> {
  const owner = input.ownerUser ?? (await createUser(input.owner));
  const workspace = await createWorkspace({ ownerId: owner.id });
  const project = await createProject({
    ownerId: owner.id,
    workspaceId: workspace.id,
    visibility: input.visibility,
    allowDownloads: input.allowDownloads,
    name: input.projectName,
  });

  return { owner, workspace, project };
}

export interface VersionScenario extends ProjectScenario {
  video: Video;
  version: VideoVersion;
}

export interface SeedVersionInput extends SeedProjectInput {
  providerId?: string;
  sizeBytes?: bigint;
  duration?: number | null;
}

export async function seedVersion(input: SeedVersionInput = {}): Promise<VersionScenario> {
  const scenario = await seedProject(input);
  const video = await createVideo({ projectId: scenario.project.id });
  const version = await createVersion({
    videoParentId: video.id,
    providerId: input.providerId,
    sizeBytes: input.sizeBytes,
    duration: input.duration,
  });

  return { ...scenario, video, version };
}
