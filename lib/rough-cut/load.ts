import { db } from '@/lib/db';
import { inferCameraRole, metadataStringRecord } from '@/lib/rough-cut/camera-roles';
import { readImportStatus } from '@/lib/rough-cut/drive-import';
import type { LayoutGuessClip } from '@/lib/rough-cut/layout';
import {
  BUILTIN_ROUGH_CUT_PROFILE,
  resolveEffectiveProfile,
  type FolderProfileLink,
} from '@/lib/rough-cut/profile';
import { toResolvedProfile } from '@/lib/rough-cut/serialize';
import type { ResolvedRoughCutProfile } from '@/lib/rough-cut/types';

export async function loadFolderProfileLinks(projectId: string): Promise<FolderProfileLink[]> {
  const folders = await db.folder.findMany({
    where: { projectId },
    select: { id: true, parentId: true, name: true, roughCutProfileId: true },
  });
  return folders;
}

export async function loadResolvedProfile(options: {
  workspaceId: string;
  projectId: string;
  folderId: string | null;
  profileId?: string | null;
}): Promise<ResolvedRoughCutProfile> {
  const [profiles, folders] = await Promise.all([
    db.roughCutProfile.findMany({ where: { workspaceId: options.workspaceId } }),
    loadFolderProfileLinks(options.projectId),
  ]);
  const profilesById = new Map(profiles.map((row) => [row.id, toResolvedProfile(row)]));
  const workspaceDefault = profiles.find((row) => row.isDefault)
    ? toResolvedProfile(profiles.find((row) => row.isDefault)!)
    : null;

  if (options.profileId) {
    const explicit = profilesById.get(options.profileId);
    if (explicit) return explicit;
  }

  return resolveEffectiveProfile({
    folderId: options.folderId,
    folders,
    profilesById,
    workspaceDefault,
  });
}

export async function loadFolderVideos(projectId: string, folderId: string | null) {
  return db.video.findMany({
    where: { projectId, folderId, kind: 'VIDEO' },
    orderBy: [{ position: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      title: true,
      position: true,
      metadata: true,
      createdAt: true,
      versions: {
        orderBy: { versionNumber: 'desc' },
        take: 1,
        select: {
          id: true,
          versionNumber: true,
          versionLabel: true,
          providerId: true,
          originalUrl: true,
          duration: true,
          frameRateNum: true,
          frameRateDen: true,
          dropFrame: true,
          startTimecode: true,
          recordedAt: true,
        },
      },
    },
  });
}

export function isFileBackedProvider(providerId: string): boolean {
  return providerId === 'r2' || providerId === 'bunny';
}

export function isReadyFileBackedVideo(video: {
  metadata: unknown;
  versions: Array<{ providerId: string }>;
}): boolean {
  const version = video.versions[0];
  if (!version || !isFileBackedProvider(version.providerId)) return false;
  const status = readImportStatus(video.metadata);
  return status !== 'pending' && status !== 'failed';
}

export function previewCameraRoles(
  videos: Awaited<ReturnType<typeof loadFolderVideos>>,
  metadataKey: string
) {
  return videos.map((video) => {
    const version = video.versions[0] ?? null;
    return {
      videoId: video.id,
      versionId: version?.id ?? null,
      title: video.title,
      role: inferCameraRole(video.title, metadataStringRecord(video.metadata), metadataKey),
      providerId: version?.providerId ?? null,
      fileBacked: isReadyFileBackedVideo(video),
    };
  });
}

export function toLayoutGuessClips(
  videos: Awaited<ReturnType<typeof loadFolderVideos>>
): LayoutGuessClip[] {
  return videos.map((video) => {
    const version = video.versions[0];
    return {
      id: video.id,
      title: video.title,
      position: video.position,
      durationSeconds: typeof version?.duration === 'number' ? version.duration : 0,
      startTimecode: version?.startTimecode ?? null,
      recordedAt: version?.recordedAt ? version.recordedAt.toISOString() : null,
      createdAt: video.createdAt.toISOString(),
      metadata: metadataStringRecord(video.metadata),
    };
  });
}

export { BUILTIN_ROUGH_CUT_PROFILE };
