import { z } from 'zod';
import { folderPath } from '../folders';
import type {
  ResolvedRoughCutProfile,
  RoughCutOverlapBehaviour,
  RoughCutSyncStrategy,
} from './types';
import { ROUGH_CUT_OVERLAP, ROUGH_CUT_SYNC } from './types';

export const BUILTIN_ROUGH_CUT_PROFILE: ResolvedRoughCutProfile = {
  id: null,
  name: 'Default',
  minShotSeconds: 1.5,
  safetyPauseSeconds: 2,
  maxShotSeconds: null,
  overlapBehaviour: 'WIDE',
  handleFrames: 0,
  wideCameraRole: 'WIDE',
  cameraRoleMetadataKey: 'camera',
  syncStrategy: 'AUTO',
  mediaPathPrefix: './media/',
  isDefault: true,
};

const NAME_MAX = 80;
const PATH_MAX = 80;
const ROLE_MAX = 40;

export function isSafeMediaPathPrefix(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > PATH_MAX) return false;
  if (trimmed.includes('..')) return false;
  if (trimmed.startsWith('/') || /^[a-zA-Z]:/.test(trimmed)) return false;
  if (trimmed.includes('\\')) return false;
  return true;
}

const profileFields = {
  name: z.string().trim().min(1).max(NAME_MAX),
  minShotSeconds: z.number().finite().positive().max(30),
  safetyPauseSeconds: z.number().finite().nonnegative().max(60),
  maxShotSeconds: z.number().finite().positive().max(600).nullable(),
  overlapBehaviour: z.enum(ROUGH_CUT_OVERLAP),
  handleFrames: z.number().int().min(0).max(48),
  wideCameraRole: z.string().trim().min(1).max(ROLE_MAX),
  cameraRoleMetadataKey: z.string().trim().min(1).max(ROLE_MAX),
  syncStrategy: z.enum(ROUGH_CUT_SYNC),
  mediaPathPrefix: z.string().trim().min(1).max(PATH_MAX),
  isDefault: z.boolean(),
};

export const roughCutProfileCreateSchema = z
  .object({
    name: profileFields.name,
    minShotSeconds: profileFields.minShotSeconds.default(1.5),
    safetyPauseSeconds: profileFields.safetyPauseSeconds.default(2),
    maxShotSeconds: profileFields.maxShotSeconds.optional(),
    overlapBehaviour: profileFields.overlapBehaviour.default('WIDE'),
    handleFrames: profileFields.handleFrames.default(0),
    wideCameraRole: profileFields.wideCameraRole.default('WIDE'),
    cameraRoleMetadataKey: profileFields.cameraRoleMetadataKey.default('camera'),
    syncStrategy: profileFields.syncStrategy.default('AUTO'),
    mediaPathPrefix: profileFields.mediaPathPrefix.default('./media/'),
    isDefault: profileFields.isDefault.default(false),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!isSafeMediaPathPrefix(value.mediaPathPrefix)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mediaPathPrefix'],
        message: 'mediaPathPrefix must be a relative folder path without ..',
      });
    }
  });

export const roughCutProfilePatchSchema = z
  .object({
    name: profileFields.name.optional(),
    minShotSeconds: profileFields.minShotSeconds.optional(),
    safetyPauseSeconds: profileFields.safetyPauseSeconds.optional(),
    maxShotSeconds: profileFields.maxShotSeconds.optional(),
    overlapBehaviour: profileFields.overlapBehaviour.optional(),
    handleFrames: profileFields.handleFrames.optional(),
    wideCameraRole: profileFields.wideCameraRole.optional(),
    cameraRoleMetadataKey: profileFields.cameraRoleMetadataKey.optional(),
    syncStrategy: profileFields.syncStrategy.optional(),
    mediaPathPrefix: profileFields.mediaPathPrefix.optional(),
    isDefault: profileFields.isDefault.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.mediaPathPrefix !== undefined && !isSafeMediaPathPrefix(value.mediaPathPrefix)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mediaPathPrefix'],
        message: 'mediaPathPrefix must be a relative folder path without ..',
      });
    }
  });

export type RoughCutProfileCreate = z.infer<typeof roughCutProfileCreateSchema>;
export type RoughCutProfilePatch = z.infer<typeof roughCutProfilePatchSchema>;

function zodErrorMessage(error: z.ZodError): string {
  const first = error.issues[0];
  if (!first) return 'Invalid profile';
  const path = first.path.length > 0 ? `${first.path.join('.')}: ` : '';
  return `${path}${first.message}`;
}

export function parseRoughCutProfileCreate(
  input: unknown
): { ok: true; value: RoughCutProfileCreate } | { ok: false; error: string } {
  const parsed = roughCutProfileCreateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: zodErrorMessage(parsed.error) };
  return { ok: true, value: parsed.data };
}

export function parseRoughCutProfilePatch(
  input: unknown
): { ok: true; value: RoughCutProfilePatch } | { ok: false; error: string } {
  const parsed = roughCutProfilePatchSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: zodErrorMessage(parsed.error) };
  if (Object.keys(parsed.data).length === 0) {
    return { ok: false, error: 'Provide at least one profile field' };
  }
  return { ok: true, value: parsed.data };
}

export function snapshotFromProfile(profile: ResolvedRoughCutProfile): ResolvedRoughCutProfile {
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
  };
}

export function profileFromSnapshot(value: unknown): ResolvedRoughCutProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...BUILTIN_ROUGH_CUT_PROFILE };
  }
  const raw = value as Record<string, unknown>;
  const overlap = ROUGH_CUT_OVERLAP.includes(raw.overlapBehaviour as RoughCutOverlapBehaviour)
    ? (raw.overlapBehaviour as RoughCutOverlapBehaviour)
    : BUILTIN_ROUGH_CUT_PROFILE.overlapBehaviour;
  const sync = ROUGH_CUT_SYNC.includes(raw.syncStrategy as RoughCutSyncStrategy)
    ? (raw.syncStrategy as RoughCutSyncStrategy)
    : BUILTIN_ROUGH_CUT_PROFILE.syncStrategy;
  return {
    id: typeof raw.id === 'string' ? raw.id : null,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : 'Default',
    minShotSeconds:
      typeof raw.minShotSeconds === 'number' && Number.isFinite(raw.minShotSeconds)
        ? raw.minShotSeconds
        : BUILTIN_ROUGH_CUT_PROFILE.minShotSeconds,
    safetyPauseSeconds:
      typeof raw.safetyPauseSeconds === 'number' && Number.isFinite(raw.safetyPauseSeconds)
        ? raw.safetyPauseSeconds
        : BUILTIN_ROUGH_CUT_PROFILE.safetyPauseSeconds,
    maxShotSeconds:
      typeof raw.maxShotSeconds === 'number' && Number.isFinite(raw.maxShotSeconds)
        ? raw.maxShotSeconds
        : null,
    overlapBehaviour: overlap,
    handleFrames:
      typeof raw.handleFrames === 'number' && Number.isInteger(raw.handleFrames)
        ? raw.handleFrames
        : 0,
    wideCameraRole:
      typeof raw.wideCameraRole === 'string' && raw.wideCameraRole.trim()
        ? raw.wideCameraRole.trim()
        : 'WIDE',
    cameraRoleMetadataKey:
      typeof raw.cameraRoleMetadataKey === 'string' && raw.cameraRoleMetadataKey.trim()
        ? raw.cameraRoleMetadataKey.trim()
        : 'camera',
    syncStrategy: sync,
    mediaPathPrefix:
      typeof raw.mediaPathPrefix === 'string' && isSafeMediaPathPrefix(raw.mediaPathPrefix)
        ? raw.mediaPathPrefix.trim()
        : './media/',
    isDefault: raw.isDefault === true,
  };
}

export type FolderProfileLink = {
  id: string;
  parentId: string | null;
  name: string;
  roughCutProfileId: string | null;
};

/**
 * Walk from the current folder up to the project root and return the first
 * profile id found. A folder with no profile inherits from its nearest ancestor.
 */
export function resolveEffectiveProfileId(
  folderId: string | null,
  folders: FolderProfileLink[]
): string | null {
  if (!folderId) return null;
  const path = folderPath(folderId, folders);
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const crumb = path[index];
    if (!crumb) continue;
    const folder = folders.find((entry) => entry.id === crumb.id);
    if (folder?.roughCutProfileId) return folder.roughCutProfileId;
  }
  return null;
}

export function resolveEffectiveProfile(options: {
  folderId: string | null;
  folders: FolderProfileLink[];
  profilesById: Map<string, ResolvedRoughCutProfile>;
  workspaceDefault: ResolvedRoughCutProfile | null;
}): ResolvedRoughCutProfile {
  const profileId = resolveEffectiveProfileId(options.folderId, options.folders);
  if (profileId) {
    const matched = options.profilesById.get(profileId);
    if (matched) return matched;
  }
  if (options.workspaceDefault) return options.workspaceDefault;
  return { ...BUILTIN_ROUGH_CUT_PROFILE };
}
