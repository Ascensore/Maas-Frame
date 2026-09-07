import { parseBrollEvidence } from '@/lib/rough-cut/broll-evidence-schema';
import { Prisma } from '@prisma/client';
import { checkWorkspaceAccess } from '@/lib/auth';
import { shapeEditPreset } from './presets';
import { db } from '@/lib/db';
import { GRAPHIC_PRESETS } from '@/lib/rough-cut/effects';

export async function listEditAssets(
  projectId: string,
  client: Prisma.TransactionClient | typeof db = db,
  selectedId?: string,
  automaticOnly = false
) {
  const versions = await client.videoVersion.findMany({
    where: {
      providerId: 'r2',
      isActive: true,
      duration: { gt: 0 },
      video: { projectId },
      ...(automaticOnly
        ? selectedId
          ? { id: selectedId }
          : { video: { projectId, metadata: { path: ['usage'], equals: 'broll' } } }
        : {}),
    },
    include: {
      video: { select: { id: true, title: true, metadata: true } },
      mediaJobs: {
        where: { kind: 'ANALYZE_BROLL' },
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { id: true, status: true, error: true },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  return versions.map((version) => ({
    versionId: version.id,
    title: version.video.title,
    duration: version.duration!,
    visualEvidence: parseBrollEvidence(version.visualEvidence, version.id) ?? undefined,
    analysisStatus: version.mediaJobs[0]?.status ?? null,
    analysisJobId: version.mediaJobs[0]?.id ?? null,
    analysisError: version.mediaJobs[0]?.error ?? null,
    description: JSON.stringify(version.video.metadata).slice(0, 2000),
    clip: {
      versionId: version.id,
      videoId: version.video.id,
      role: 'BROLL',
      offsetSeconds: 0,
      durationSeconds: version.duration!,
      track: 2,
      fileName: `${version.id}.mp4`,
      targetUrl: `${version.id}.mp4`,
    },
  }));
}

export async function listEditPresets(
  projectId: string,
  client: Prisma.TransactionClient | typeof db = db
) {
  const project = await client.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { workspaceId: true },
  });
  const rows = await client.editPreset.findMany({
    where: { workspaceId: project.workspaceId, archived: false },
    orderBy: { name: 'asc' },
    take: 50,
  });
  return [...GRAPHIC_PRESETS, ...rows.map(shapeEditPreset)];
}
export async function editLibrary(projectId: string, userId?: string) {
  const project = await db.project.findUniqueOrThrow({
    where: { id: projectId },
    include: { workspace: true },
  });
  const access = userId ? await checkWorkspaceAccess(project.workspace, userId) : null;
  return {
    workspaceId: project.workspaceId,
    canManagePresets: access?.canEdit ?? false,
    presets: await listEditPresets(projectId),
    assets: (await listEditAssets(projectId)).map((asset) => ({
      ...asset,
      visualEvidence: asset.visualEvidence && {
        ...asset.visualEvidence,
        frames: asset.visualEvidence.frames.map((frame, index) => ({
          ...frame,
          previewUrl: `/api/versions/${encodeURIComponent(asset.versionId)}/broll-evidence?frame=${index}&generation=${encodeURIComponent(frame.key.split('/').at(-2)!)}`,
        })),
      },
    })),
  };
}
