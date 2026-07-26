import {
  DeleteObjectCommand,
  ListObjectsV2Command,
  type ListObjectsV2CommandInput,
} from '@aws-sdk/client-s3';
import { db, disconnectDb } from '../lib/db';
import { r2Client, R2_BUCKET_NAME } from '../lib/r2';
import { cleanupExpiredBillingWorkspaces } from './expired-billing-cleanup';
import { logError } from '@/lib/logger';

// Seven days. This was fifteen minutes, which is shorter than a slow multipart upload of
// a large file: an object still being written, or written but not yet finalised into a
// row, looked abandoned and could be deleted out from under the upload that was creating
// it. An object only counts as abandoned once nothing has claimed it for long enough that
// no upload, retry or delayed finalisation could still be in flight.
const UNATTACHED_UPLOAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CHUNK_SIZE = 500;
const PREFIXES = ['images/', 'voice/', 'videos/'] as const;

type CleanupCandidate = {
  key: string;
  url: string;
};

type UserFeedbackScreenshotDelegate = {
  findMany: (args: {
    where: { url: { in: string[] } };
    select: { url: true };
  }) => Promise<Array<{ url: string }>>;
};

function keyToProxyUrl(key: string): string | null {
  if (key.startsWith('images/')) {
    const filename = key.slice('images/'.length);
    return filename ? `/api/upload/image/${filename}` : null;
  }
  if (key.startsWith('voice/')) {
    const filename = key.slice('voice/'.length);
    return filename ? `/api/upload/audio/${filename}` : null;
  }
  if (key.startsWith('videos/')) {
    const filename = key.slice('videos/'.length);
    return filename ? `/api/upload/video/${filename}` : null;
  }
  return null;
}

/**
 * The owner of each orphaned object key, from the upload session that created it.
 *
 * Unlike the Bunny side, this is an answer rather than a guess: `videoUploadSession` keeps
 * `objectKey` alongside the user who initiated the upload, and the row survives even when
 * the upload never became a video, which is exactly the case that produces an orphan.
 * Both the initiating user and the billed user are reported when they differ, because the
 * billed one is who paid for the bytes.
 */
async function findUploadSessionOwners(keys: string[]): Promise<Map<string, string>> {
  const owners = new Map<string, string>();

  for (const group of chunk(keys, CHUNK_SIZE)) {
    // VideoUploadSession holds the ids but declares no relation to User, so the addresses
    // are resolved in a second query rather than by widening the schema for a script.
    const sessions = await db.videoUploadSession.findMany({
      where: { objectKey: { in: group } },
      select: { objectKey: true, status: true, userId: true, billedUserId: true },
    });
    if (sessions.length === 0) continue;

    const userIds = [
      ...new Set(sessions.flatMap((session) => [session.userId, session.billedUserId])),
    ];
    const users = await db.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, email: true },
    });
    const emailById = new Map(users.map((user) => [user.id, user.email]));

    for (const session of sessions) {
      const initiator = emailById.get(session.userId) ?? null;
      const billed = emailById.get(session.billedUserId) ?? null;
      const who =
        billed && billed !== initiator
          ? `${initiator ?? 'unknown'} (billed: ${billed})`
          : (initiator ?? billed ?? 'unknown');
      owners.set(session.objectKey, `${who} [session ${session.status.toLowerCase()}]`);
    }
  }

  return owners;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

async function listCleanupCandidates(): Promise<{
  candidates: CleanupCandidate[];
  scanned: number;
}> {
  const candidates: CleanupCandidate[] = [];
  const cutoff = Date.now() - UNATTACHED_UPLOAD_TTL_MS;
  let scanned = 0;

  for (const prefix of PREFIXES) {
    let continuationToken: string | undefined;
    let isTruncated = true;

    while (isTruncated) {
      const input: ListObjectsV2CommandInput = {
        Bucket: R2_BUCKET_NAME,
        Prefix: prefix,
      };
      if (continuationToken) input.ContinuationToken = continuationToken;

      const response = await r2Client.send(new ListObjectsV2Command(input));
      const contents = response.Contents ?? [];
      scanned += contents.length;

      for (const item of contents) {
        if (!item.Key || !item.LastModified) continue;
        if (item.LastModified.getTime() > cutoff) continue;

        const url = keyToProxyUrl(item.Key);
        if (!url) continue;
        candidates.push({ key: item.Key, url });
      }

      isTruncated = response.IsTruncated ?? false;
      continuationToken = response.NextContinuationToken;
    }
  }

  return { candidates, scanned };
}

async function findReferencedUrls(urls: string[]): Promise<Set<string>> {
  const referenced = new Set<string>();
  const userFeedbackScreenshotDelegate = (
    db as unknown as {
      userFeedbackScreenshot?: UserFeedbackScreenshotDelegate;
    }
  ).userFeedbackScreenshot;

  for (const group of chunk(urls, CHUNK_SIZE)) {
    const [commentRows, feedbackRows, feedbackAttachmentRows, assetRows, versionRows] =
      await Promise.all([
        db.comment.findMany({
          where: {
            OR: [{ voiceUrl: { in: group } }, { imageUrl: { in: group } }],
          },
          select: {
            voiceUrl: true,
            imageUrl: true,
          },
        }),
        db.userFeedback.findMany({
          where: { screenshotUrl: { in: group } },
          select: { screenshotUrl: true },
        }),
        userFeedbackScreenshotDelegate
          ? userFeedbackScreenshotDelegate.findMany({
              where: { url: { in: group } },
              select: { url: true },
            })
          : Promise.resolve([] as Array<{ url: string }>),
        db.videoAsset.findMany({
          where: {
            OR: [{ sourceUrl: { in: group } }, { thumbnailUrl: { in: group } }],
          },
          select: { sourceUrl: true, thumbnailUrl: true },
        }),
        db.videoVersion.findMany({
          where: {
            OR: [{ originalUrl: { in: group } }, { thumbnailUrl: { in: group } }],
          },
          select: { originalUrl: true, thumbnailUrl: true },
        }),
      ]);

    for (const row of commentRows) {
      if (row.voiceUrl) referenced.add(row.voiceUrl);
      if (row.imageUrl) referenced.add(row.imageUrl);
    }
    for (const row of feedbackRows) {
      if (row.screenshotUrl) referenced.add(row.screenshotUrl);
    }
    for (const row of feedbackAttachmentRows) {
      if (row.url) referenced.add(row.url);
    }
    for (const row of assetRows) {
      if (row.sourceUrl) referenced.add(row.sourceUrl);
      if (row.thumbnailUrl) referenced.add(row.thumbnailUrl);
    }
    for (const row of versionRows) {
      if (row.originalUrl) referenced.add(row.originalUrl);
      if (row.thumbnailUrl) referenced.add(row.thumbnailUrl);
    }
  }

  return referenced;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  console.log(`[r2-orphan-cleanup] Starting (${dryRun ? 'dry-run' : 'delete mode'})`);

  const expiredBillingCleanup = await cleanupExpiredBillingWorkspaces({ dryRun });
  console.log(
    `[r2-orphan-cleanup] Expired owner workspaces scanned: ${expiredBillingCleanup.scanned}`
  );
  console.log(
    `[r2-orphan-cleanup] Expired owner workspaces deleted: ${expiredBillingCleanup.deleted}`
  );

  const { candidates, scanned } = await listCleanupCandidates();
  console.log(
    `[r2-orphan-cleanup] Scanned: ${scanned}, eligible (old enough): ${candidates.length}`
  );

  if (candidates.length === 0) {
    console.log('[r2-orphan-cleanup] No eligible objects found');
    return;
  }

  const referenced = await findReferencedUrls(candidates.map((candidate) => candidate.url));

  let deleted = 0;
  let failed = 0;

  // A dry run that only reports a count cannot be acted on: the point of it is to see
  // what would go before anything does. Deleting prints the same list, so a real run is
  // auditable after the fact too.
  const orphanCandidates = candidates.filter((candidate) => !referenced.has(candidate.url));
  const referencedCount = candidates.length - orphanCandidates.length;
  const orphaned = orphanCandidates.length;

  if (orphanCandidates.length > 0) {
    const owners = await findUploadSessionOwners(orphanCandidates.map((c) => c.key));

    console.log(`[r2-orphan-cleanup] Orphans ${dryRun ? 'that would be deleted' : 'to delete'}:`);
    for (const candidate of orphanCandidates) {
      const email = owners.get(candidate.key);
      console.log(
        `[r2-orphan-cleanup]   ${candidate.key}  ${email ?? 'owner unknown (no upload session)'}`
      );
    }
  }

  for (const candidate of orphanCandidates) {
    if (dryRun) continue;

    try {
      await r2Client.send(
        new DeleteObjectCommand({
          Bucket: R2_BUCKET_NAME,
          Key: candidate.key,
        })
      );
      deleted += 1;
    } catch (error) {
      failed += 1;
      logError(`[r2-orphan-cleanup] Failed deleting ${candidate.key}:`, error);
    }
  }

  console.log('[r2-orphan-cleanup] Summary');
  console.log(`[r2-orphan-cleanup] Referenced: ${referencedCount}`);
  console.log(`[r2-orphan-cleanup] Orphaned: ${orphaned}`);
  console.log(`[r2-orphan-cleanup] Deleted: ${deleted}`);
  console.log(`[r2-orphan-cleanup] Failed: ${failed}`);
}

main()
  .catch((error) => {
    logError('[r2-orphan-cleanup] Fatal error:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectDb();
    r2Client.destroy();
  });
