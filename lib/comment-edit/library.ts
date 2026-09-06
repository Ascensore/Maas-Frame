import { Prisma } from '@prisma/client';
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
    include: { video: { select: { id: true, title: true, metadata: true } } },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  return versions.map((version) => ({
    versionId: version.id,
    title: version.video.title,
    duration: version.duration!,
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

export async function editLibrary(projectId: string) {
  return { presets: GRAPHIC_PRESETS, assets: await listEditAssets(projectId) };
}
