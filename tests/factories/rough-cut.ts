import type {
  EditorialBrief,
  EditorialProjectType,
  RoughCut,
  RoughCutLayout,
  RoughCutProfile,
  RoughCutStatus,
} from '@prisma/client';
import { db } from '@/lib/db';
import {
  BUILTIN_BRIEF_TEMPLATES,
  mergeBriefConfig,
  type EditorialBriefConfigPatch,
} from '@/lib/rough-cut/brief';
import { BUILTIN_ROUGH_CUT_PROFILE, snapshotFromProfile } from '@/lib/rough-cut/profile';
import { nextSeq } from './seq';

export interface CreateRoughCutProfileInput {
  workspaceId: string;
  name?: string;
  minShotSeconds?: number;
  safetyPauseSeconds?: number;
  maxShotSeconds?: number | null;
  overlapBehaviour?: RoughCutProfile['overlapBehaviour'];
  handleFrames?: number;
  wideCameraRole?: string;
  cameraRoleMetadataKey?: string;
  syncStrategy?: RoughCutProfile['syncStrategy'];
  mediaPathPrefix?: string;
  isDefault?: boolean;
}

export async function createRoughCutProfile(
  input: CreateRoughCutProfileInput
): Promise<RoughCutProfile> {
  const seq = nextSeq();
  return db.roughCutProfile.create({
    data: {
      workspaceId: input.workspaceId,
      name: input.name ?? `Profile ${seq}`,
      minShotSeconds: input.minShotSeconds ?? 1.5,
      safetyPauseSeconds: input.safetyPauseSeconds ?? 2,
      maxShotSeconds: input.maxShotSeconds ?? null,
      overlapBehaviour: input.overlapBehaviour ?? 'WIDE',
      handleFrames: input.handleFrames ?? 0,
      wideCameraRole: input.wideCameraRole ?? 'WIDE',
      cameraRoleMetadataKey: input.cameraRoleMetadataKey ?? 'camera',
      syncStrategy: input.syncStrategy ?? 'AUTO',
      mediaPathPrefix: input.mediaPathPrefix ?? './media/',
      isDefault: input.isDefault ?? false,
    },
  });
}

export interface CreateRoughCutInput {
  projectId: string;
  requestedById: string;
  folderId?: string | null;
  profileId?: string | null;
  status?: RoughCutStatus;
  layout?: RoughCutLayout;
  decisions?: object | null;
}

export async function createRoughCut(input: CreateRoughCutInput): Promise<RoughCut> {
  return db.roughCut.create({
    data: {
      projectId: input.projectId,
      requestedById: input.requestedById,
      folderId: input.folderId ?? null,
      profileId: input.profileId ?? null,
      status: input.status ?? 'PENDING',
      layout: input.layout ?? 'MULTICAM',
      profileSnapshot: snapshotFromProfile(BUILTIN_ROUGH_CUT_PROFILE),
      decisions: input.decisions ?? undefined,
    },
  });
}

export interface CreateEditorialBriefInput {
  workspaceId: string;
  name?: string;
  projectType?: EditorialProjectType;
  isDefault?: boolean;
  /** Laid over the template for the project type, as the create route does. */
  config?: EditorialBriefConfigPatch;
}

export async function createEditorialBrief(
  input: CreateEditorialBriefInput
): Promise<EditorialBrief> {
  const seq = nextSeq();
  const projectType = input.projectType ?? 'TALKING_HEAD';
  return db.editorialBrief.create({
    data: {
      workspaceId: input.workspaceId,
      name: input.name ?? `Brief ${seq}`,
      projectType,
      isDefault: input.isDefault ?? false,
      config: mergeBriefConfig(BUILTIN_BRIEF_TEMPLATES[projectType], {
        ...(input.config ?? {}),
        projectType,
      }),
    },
  });
}
