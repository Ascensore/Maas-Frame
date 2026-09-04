import { notFound } from 'next/navigation';
import { requireProjectAccessOrRedirect } from '@/lib/route-access';
import { db } from '@/lib/db';
import {
  isDirectFileUploadEnabled,
  isRoughCutFeatureEnabled,
  isS3VideoUploadsEnabled,
} from '@/lib/feature-flags';
import { inferCameraRole, metadataStringRecord } from '@/lib/rough-cut/camera-roles';
import { readImportStatus } from '@/lib/rough-cut/drive-import';
import { editModeFromLayout, guessRoughCutLayout } from '@/lib/rough-cut/layout';
import {
  isFileBackedProvider,
  isReadyFileBackedVideo,
  loadFolderVideos,
  toLayoutGuessClips,
} from '@/lib/rough-cut/load';
import { EditWorkspaceClient, type EditBinClip, type EditFolder } from './edit-workspace-client';

interface EditPageProps {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ folder?: string }>;
}

export default async function ProjectEditPage({ params, searchParams }: EditPageProps) {
  const { projectId } = await params;
  const { folder: requestedFolderId } = await searchParams;

  if (!isRoughCutFeatureEnabled()) {
    notFound();
  }

  const { project } = await requireProjectAccessOrRedirect({
    projectId,
    intent: 'manage',
  });

  const projectRow = await db.project.findUnique({
    where: { id: project.id },
    select: { name: true, workspaceId: true, editorialBriefId: true },
  });
  if (!projectRow) notFound();

  const folders = await db.folder.findMany({
    where: { projectId: project.id },
    orderBy: [{ position: 'asc' }, { name: 'asc' }],
    select: { id: true, name: true, parentId: true, editorialBriefId: true },
  });

  const currentFolder = requestedFolderId
    ? (folders.find((folder) => folder.id === requestedFolderId) ?? null)
    : null;
  const currentFolderId = currentFolder?.id ?? null;

  const videos = await loadFolderVideos(project.id, currentFolderId);
  const clips: EditBinClip[] = videos.map((video) => {
    const version = video.versions[0] ?? null;
    const metadata = metadataStringRecord(video.metadata);
    const providerId = version?.providerId ?? null;
    return {
      id: video.id,
      title: video.title,
      durationSeconds: typeof version?.duration === 'number' ? version.duration : null,
      startTimecode: version?.startTimecode ?? null,
      recordedAt: version?.recordedAt ? version.recordedAt.toISOString() : null,
      createdAt: video.createdAt.toISOString(),
      position: video.position,
      providerId,
      cameraRole: inferCameraRole(video.title, metadata, 'camera'),
      metadata,
      importStatus: readImportStatus(video.metadata),
      fileBacked: isReadyFileBackedVideo(video),
      embedOnly: Boolean(providerId && !isFileBackedProvider(providerId)),
    };
  });

  const launchClips = clips.filter((clip) => clip.fileBacked);
  const guess = guessRoughCutLayout(
    toLayoutGuessClips(videos.filter((video) => isReadyFileBackedVideo(video)))
  );

  const serializedFolders: EditFolder[] = folders.map((folder) => ({
    id: folder.id,
    name: folder.name,
    parentId: folder.parentId,
    editorialBriefId: folder.editorialBriefId,
  }));

  return (
    <EditWorkspaceClient
      key={currentFolderId ?? 'root'}
      projectId={project.id}
      projectName={projectRow.name}
      workspaceId={projectRow.workspaceId}
      projectBriefId={projectRow.editorialBriefId}
      folders={serializedFolders}
      currentFolderId={currentFolderId}
      clips={clips}
      guessedMode={editModeFromLayout(guess.layout)}
      guessReason={guess.reason}
      guessedOrderedIds={guess.orderedIds}
      launchCount={launchClips.length}
      directUploadsEnabled={isDirectFileUploadEnabled()}
      directUploadProvider={isS3VideoUploadsEnabled() ? 'r2' : 'bunny'}
      driveImportEnabled={isS3VideoUploadsEnabled()}
    />
  );
}
