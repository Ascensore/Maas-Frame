import { MediaJobKind, type Prisma } from '@prisma/client';
import { enqueueMediaJob } from '@/lib/media-jobs';
import { briefConfigFromStored, type EditorialProjectType } from '@/lib/rough-cut/brief';
import type { ResolvedRoughCutProfile } from '@/lib/rough-cut/types';

export function shapeRoughCutProfile(profile: {
  id: string;
  name: string;
  minShotSeconds: number;
  safetyPauseSeconds: number;
  maxShotSeconds: number | null;
  overlapBehaviour: ResolvedRoughCutProfile['overlapBehaviour'];
  handleFrames: number;
  wideCameraRole: string;
  cameraRoleMetadataKey: string;
  syncStrategy: ResolvedRoughCutProfile['syncStrategy'];
  mediaPathPrefix: string;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: profile.id,
    name: profile.name,
    minShotSeconds: profile.minShotSeconds,
    safetyPauseSeconds: profile.safetyPauseSeconds,
    maxShotSeconds: profile.maxShotSeconds,
    overlapBehaviour: profile.overlapBehaviour,
    handleFrames: profile.handleFrames,
    wideCameraRole: profile.wideCameraRole,
    cameraRoleMetadataKey: profile.cameraRoleMetadataKey,
    syncStrategy: profile.syncStrategy,
    mediaPathPrefix: profile.mediaPathPrefix,
    isDefault: profile.isDefault,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

export function shapeEditorialBrief(row: {
  id: string;
  name: string;
  projectType: EditorialProjectType;
  isDefault: boolean;
  config: Prisma.JsonValue;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    name: row.name,
    projectType: row.projectType,
    isDefault: row.isDefault,
    config: briefConfigFromStored(row.config, row.projectType),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function shapeRoughCut(row: {
  id: string;
  status: string;
  projectId: string;
  folderId: string | null;
  profileId: string | null;
  briefId?: string | null;
  requestedById: string;
  layout: string;
  frameRateNum: number | null;
  frameRateDen: number | null;
  dropFrame: boolean;
  profileSnapshot: Prisma.JsonValue;
  briefSnapshot?: Prisma.JsonValue | null;
  syncReport: Prisma.JsonValue | null;
  decisions: Prisma.JsonValue | null;
  warnings: Prisma.JsonValue | null;
  error: string | null;
  outputVideoId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    status: row.status,
    projectId: row.projectId,
    folderId: row.folderId,
    profileId: row.profileId,
    briefId: row.briefId ?? null,
    requestedById: row.requestedById,
    layout: row.layout,
    frameRateNum: row.frameRateNum,
    frameRateDen: row.frameRateDen,
    dropFrame: row.dropFrame,
    profileSnapshot: row.profileSnapshot,
    briefSnapshot: row.briefSnapshot ?? null,
    syncReport: row.syncReport,
    warnings: row.warnings,
    error: row.error,
    outputVideoId: row.outputVideoId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    hasDecisions: row.decisions !== null,
  };
}

export async function enqueueAssembleRoughCut(options: {
  versionId: string;
  roughCutId: string;
}): Promise<string> {
  return enqueueMediaJob(options.versionId, MediaJobKind.ASSEMBLE_ROUGH_CUT, {
    roughCutId: options.roughCutId,
  });
}

export function toResolvedProfile(row: {
  id: string;
  name: string;
  minShotSeconds: number;
  safetyPauseSeconds: number;
  maxShotSeconds: number | null;
  overlapBehaviour: ResolvedRoughCutProfile['overlapBehaviour'];
  handleFrames: number;
  wideCameraRole: string;
  cameraRoleMetadataKey: string;
  syncStrategy: ResolvedRoughCutProfile['syncStrategy'];
  mediaPathPrefix: string;
  isDefault: boolean;
}): ResolvedRoughCutProfile {
  return {
    id: row.id,
    name: row.name,
    minShotSeconds: row.minShotSeconds,
    safetyPauseSeconds: row.safetyPauseSeconds,
    maxShotSeconds: row.maxShotSeconds,
    overlapBehaviour: row.overlapBehaviour,
    handleFrames: row.handleFrames,
    wideCameraRole: row.wideCameraRole,
    cameraRoleMetadataKey: row.cameraRoleMetadataKey,
    syncStrategy: row.syncStrategy,
    mediaPathPrefix: row.mediaPathPrefix,
    isDefault: row.isDefault,
  };
}
