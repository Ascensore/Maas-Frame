import { db } from '../lib/db';
import { buildExpiredBillingWhereInput } from '../lib/billing';
import { collectWorkspaceMediaUrls, deleteMediaFilesBestEffort } from '../lib/r2-cleanup';
import { cleanupBunnyStreamVideosBestEffort } from '../lib/bunny-stream-cleanup';
import { logCleanupWarnings } from '../lib/cleanup-warnings';

type ExpiredWorkspaceTarget = {
  id: string;
  ownerId: string;
  ownerEmail: string | null;
};

/**
 * The owners past their grace period, and the workspaces they own.
 *
 * Both counts are reported, because they answer different questions and a single number
 * conflated them: zero workspaces can mean nobody expired, or that everyone who expired owns
 * nothing. The first is normal, the second means media is being kept alive by rows the
 * cleanup cannot reach, and telling them apart used to require a hand-written query.
 */
async function getExpiredWorkspaceTargets(): Promise<{
  owners: number;
  workspaces: ExpiredWorkspaceTarget[];
}> {
  const expiredOwners = await db.user.findMany({
    where: buildExpiredBillingWhereInput(),
    select: { id: true },
  });

  if (expiredOwners.length === 0) {
    return { owners: 0, workspaces: [] };
  }

  const workspaces = await db.workspace.findMany({
    where: {
      ownerId: { in: expiredOwners.map((owner) => owner.id) },
    },
    select: {
      id: true,
      ownerId: true,
      owner: {
        select: {
          email: true,
        },
      },
    },
  });

  return {
    owners: expiredOwners.length,
    workspaces: workspaces.map((workspace) => ({
      id: workspace.id,
      ownerId: workspace.ownerId,
      ownerEmail: workspace.owner.email,
    })),
  };
}

export async function cleanupExpiredBillingWorkspaces(options?: { dryRun?: boolean }) {
  const dryRun = options?.dryRun ?? false;
  const { owners, workspaces } = await getExpiredWorkspaceTargets();

  if (workspaces.length === 0) {
    return { owners, scanned: 0, deleted: 0 };
  }

  let deleted = 0;

  for (const workspace of workspaces) {
    const [workspaceVersionRefs, workspaceAssetRefs, mediaUrls] = await Promise.all([
      db.videoVersion.findMany({
        where: {
          video: {
            project: {
              workspaceId: workspace.id,
            },
          },
        },
        select: {
          providerId: true,
          videoId: true,
        },
      }),
      db.videoAsset.findMany({
        where: {
          provider: 'BUNNY',
          providerVideoId: { not: null },
          video: {
            project: {
              workspaceId: workspace.id,
            },
          },
        },
        select: {
          providerVideoId: true,
        },
      }),
      collectWorkspaceMediaUrls(workspace.id),
    ]);

    if (dryRun) {
      const ownerLabel = workspace.ownerEmail ?? workspace.ownerId;
      console.log(
        `[expired-billing-cleanup] Would delete workspace ${workspace.id} owned by ${ownerLabel}`
      );
      continue;
    }

    const bunnyRefs = [
      ...workspaceVersionRefs,
      ...workspaceAssetRefs.map((asset) => ({
        providerId: 'bunny',
        videoId: asset.providerVideoId as string,
      })),
    ];

    await db.workspace.delete({ where: { id: workspace.id } });
    const [bunny, r2] = await Promise.all([
      cleanupBunnyStreamVideosBestEffort(bunnyRefs),
      deleteMediaFilesBestEffort(mediaUrls),
    ]);
    // The rows are already gone, so a refused delete leaves media nothing points at. The
    // orphan sweep in the calling script picks those up, but only a log says it happened.
    logCleanupWarnings({ entityType: 'workspace', entityId: workspace.id }, { bunny, r2 });
    deleted += 1;
  }

  return { owners, scanned: workspaces.length, deleted };
}
