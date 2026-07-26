import { db, disconnectDb } from '../lib/db';
import { cleanupExpiredBillingWorkspaces } from './expired-billing-cleanup';
import { logError } from '@/lib/logger';

const BUNNY_API_BASE = 'https://video.bunnycdn.com';
const BUNNY_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const ITEMS_PER_PAGE = 100;
const MAX_PAGES = 200;
const CHUNK_SIZE = 500;
// Seven days, not one. A video only counts as abandoned once nothing has claimed it for
// long enough that no upload, retry or delayed finalisation could still be in flight, and
// a day is short enough that an upload interrupted overnight looks abandoned by morning.
const DEFAULT_GRACE_HOURS = 7 * 24;

type BunnyConfig = {
  apiKey: string;
  libraryId: string;
};

type BunnyVideo = {
  id: string;
  uploadedAt: Date;
  title: string | null;
};

function getBunnyConfig(): BunnyConfig {
  const apiKey = process.env.BUNNY_STREAM_API_KEY;
  const libraryId =
    process.env.BUNNY_STREAM_LIBRARY_ID || process.env.NEXT_PUBLIC_BUNNY_STREAM_LIBRARY_ID;

  if (!apiKey || !libraryId) {
    throw new Error('Missing BUNNY_STREAM_API_KEY or BUNNY_STREAM_LIBRARY_ID.');
  }

  return { apiKey, libraryId };
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  return value as Record<string, unknown>;
}

function parseVideoId(item: unknown): string | null {
  const record = toRecord(item);
  if (!record) return null;

  const candidates = [record.guid, record.videoId, record.id];
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      const trimmed = candidate.trim();
      if (BUNNY_VIDEO_ID_PATTERN.test(trimmed)) return trimmed;
    }
  }

  return null;
}

function parseTitle(item: unknown): string | null {
  const record = toRecord(item);
  if (!record) return null;

  for (const candidate of [record.title, record.Title]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }

  return null;
}

function parseUploadedAt(item: unknown): Date | null {
  const record = toRecord(item);
  if (!record) return null;

  const candidates = [
    record.dateUploaded,
    record.DateUploaded,
    record.dateCreated,
    record.DateCreated,
    record.createdAt,
    record.CreatedAt,
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const parsed = new Date(candidate);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  return null;
}

async function fetchBunnyPage(
  config: BunnyConfig,
  page: number
): Promise<{ items: unknown[]; totalItems: number | null }> {
  const response = await fetch(
    `${BUNNY_API_BASE}/library/${config.libraryId}/videos?page=${page}&itemsPerPage=${ITEMS_PER_PAGE}`,
    {
      headers: {
        AccessKey: config.apiKey,
        Accept: 'application/json',
      },
      cache: 'no-store',
    }
  );

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Bunny list API failed (${response.status}): ${body.slice(0, 300)}`);
  }

  const payload = await response.json();
  const record = toRecord(payload);
  if (!record) return { items: [], totalItems: null };

  const items = Array.isArray(record.items)
    ? record.items
    : Array.isArray(record.Items)
      ? record.Items
      : [];

  const totalItems =
    typeof record.totalItems === 'number'
      ? record.totalItems
      : typeof record.TotalItems === 'number'
        ? record.TotalItems
        : null;

  return { items, totalItems };
}

async function listBunnyVideos(
  config: BunnyConfig
): Promise<{ videos: BunnyVideo[]; scanned: number; skippedInvalid: number }> {
  const videos: BunnyVideo[] = [];
  let scanned = 0;
  let skippedInvalid = 0;
  let page = 1;

  while (page <= MAX_PAGES) {
    const { items, totalItems } = await fetchBunnyPage(config, page);
    if (items.length === 0) break;

    scanned += items.length;
    for (const item of items) {
      const id = parseVideoId(item);
      const uploadedAt = parseUploadedAt(item);
      if (!id || !uploadedAt) {
        skippedInvalid += 1;
        continue;
      }
      videos.push({ id, uploadedAt, title: parseTitle(item) });
    }

    if (totalItems !== null && page * ITEMS_PER_PAGE >= totalItems) break;
    page += 1;
  }

  return { videos, scanned, skippedInvalid };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Every Bunny id the database still points at.
 *
 * A Bunny id is stored in two places per row, and both are checked. `VideoVersion.videoId`
 * and `VideoAsset.providerVideoId` hold the guid on its own, while `originalUrl` and
 * `sourceUrl` embed the same guid inside
 * `https://iframe.mediadelivery.net/embed/<library>/<guid>`. They are written together, so
 * they normally agree, but this decides what gets deleted: a row whose id column was left
 * empty or drifted while its url still carried the guid would make a live video look
 * orphaned. Reading both makes disagreement harmless rather than destructive.
 */
async function findReferencedVideoIds(videoIds: string[]): Promise<Set<string>> {
  const referenced = new Set<string>();

  for (const group of chunk(videoIds, CHUNK_SIZE)) {
    const [versionRows, assetRows] = await Promise.all([
      db.videoVersion.findMany({
        where: { providerId: 'bunny' },
        select: { videoId: true, originalUrl: true },
      }),
      db.videoAsset.findMany({
        where: { provider: 'BUNNY' },
        select: { providerVideoId: true, sourceUrl: true },
      }),
    ]);

    // Every Bunny row is read rather than filtered by id, because the url has to be
    // searched for a guid it merely contains. There are as many of these rows as there
    // are Bunny videos in the product, so this is one small scan instead of one LIKE per
    // candidate id.
    const ids = new Set(group);
    const urls: string[] = [];

    for (const row of versionRows) {
      if (row.videoId && ids.has(row.videoId)) referenced.add(row.videoId);
      if (row.originalUrl) urls.push(row.originalUrl);
    }
    for (const row of assetRows) {
      if (row.providerVideoId && ids.has(row.providerVideoId)) referenced.add(row.providerVideoId);
      if (row.sourceUrl) urls.push(row.sourceUrl);
    }

    for (const url of urls) {
      for (const id of group) {
        if (!referenced.has(id) && url.includes(id)) referenced.add(id);
      }
    }
  }

  return referenced;
}

/**
 * Best-effort owner for an orphan, by matching its Bunny title against titles still in the
 * database.
 *
 * An orphan is by definition a video nothing in the database points at, so there is no
 * authoritative owner to look up: `bunny-init` sends Bunny a title and nothing else, no
 * user id and no email. What is left is the title, and it is worth matching because the
 * common way an orphan appears is a version upload that failed and was then retried
 * successfully, which leaves a live row carrying the same title.
 *
 * A hit is therefore a hint, not a fact, and the output says so. A miss means the video
 * cannot be attributed at all from what Bunny and the database hold today.
 */
async function findOwnerHintsByTitle(titles: string[]): Promise<Map<string, string[]>> {
  const hints = new Map<string, Set<string>>();
  const unique = [...new Set(titles.filter((title): title is string => Boolean(title)))];

  const remember = (title: string | null, emails: Array<string | null | undefined>) => {
    if (!title) return;
    const existing = hints.get(title) ?? new Set<string>();
    for (const email of emails) {
      if (email) existing.add(email);
    }
    if (existing.size > 0) hints.set(title, existing);
  };

  const ownerSelect = {
    project: {
      select: {
        owner: { select: { email: true } },
        workspace: { select: { owner: { select: { email: true } } } },
      },
    },
  } as const;

  for (const group of chunk(unique, CHUNK_SIZE)) {
    const [videos, versions, assets] = await Promise.all([
      db.video.findMany({
        where: { title: { in: group } },
        select: { title: true, ...ownerSelect },
      }),
      db.videoVersion.findMany({
        where: { title: { in: group } },
        select: { title: true, video: { select: ownerSelect } },
      }),
      db.videoAsset.findMany({
        where: { displayName: { in: group } },
        select: { displayName: true, video: { select: ownerSelect } },
      }),
    ]);

    for (const row of videos) {
      remember(row.title, [row.project.owner?.email, row.project.workspace.owner?.email]);
    }
    for (const row of versions) {
      const project = row.video.project;
      remember(row.title, [project.owner?.email, project.workspace.owner?.email]);
    }
    for (const row of assets) {
      const project = row.video.project;
      remember(row.displayName, [project.owner?.email, project.workspace.owner?.email]);
    }
  }

  return new Map([...hints].map(([title, emails]) => [title, [...emails].sort()]));
}

async function deleteBunnyVideo(
  config: BunnyConfig,
  videoId: string
): Promise<'deleted' | 'already_missing'> {
  const response = await fetch(
    `${BUNNY_API_BASE}/library/${config.libraryId}/videos/${encodeURIComponent(videoId)}`,
    {
      method: 'DELETE',
      headers: {
        AccessKey: config.apiKey,
      },
    }
  );

  if (response.status === 404) return 'already_missing';
  if (response.ok) return 'deleted';

  const body = await response.text().catch(() => '');
  throw new Error(
    `Bunny delete API failed for ${videoId} (${response.status}): ${body.slice(0, 300)}`
  );
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const graceHours = DEFAULT_GRACE_HOURS;
  const graceMs = graceHours * 60 * 60 * 1000;
  const cutoff = Date.now() - graceMs;

  const config = getBunnyConfig();
  console.log(`[bunny-orphan-cleanup] Starting (${dryRun ? 'dry-run' : 'delete mode'})`);
  console.log(`[bunny-orphan-cleanup] Grace period: ${graceHours}h`);

  const expiredBillingCleanup = await cleanupExpiredBillingWorkspaces({ dryRun });
  console.log(
    `[bunny-orphan-cleanup] Expired owner workspaces scanned: ${expiredBillingCleanup.scanned}`
  );
  console.log(
    `[bunny-orphan-cleanup] Expired owner workspaces deleted: ${expiredBillingCleanup.deleted}`
  );

  const { videos, scanned, skippedInvalid } = await listBunnyVideos(config);
  const eligible = videos.filter((video) => video.uploadedAt.getTime() <= cutoff);
  console.log(`[bunny-orphan-cleanup] Scanned: ${scanned}`);
  console.log(`[bunny-orphan-cleanup] Skipped invalid metadata: ${skippedInvalid}`);
  console.log(`[bunny-orphan-cleanup] Eligible (old enough): ${eligible.length}`);

  if (eligible.length === 0) {
    console.log('[bunny-orphan-cleanup] No eligible Bunny videos found');
    return;
  }

  const eligibleIds = eligible.map((video) => video.id);
  const referenced = await findReferencedVideoIds(eligibleIds);

  const orphanIds = eligibleIds.filter((id) => !referenced.has(id));

  // A dry run that only reports a count cannot be acted on: the point of it is to see
  // what would go before anything does. Deleting prints the same list, so a real run is
  // auditable after the fact too.
  if (orphanIds.length > 0) {
    const byId = new Map(eligible.map((video) => [video.id, video]));
    const orphanTitles = orphanIds
      .map((orphanId) => byId.get(orphanId)?.title)
      .filter((title): title is string => Boolean(title));
    const ownerHints = await findOwnerHintsByTitle(orphanTitles);

    console.log(
      `[bunny-orphan-cleanup] Orphans ${dryRun ? 'that would be deleted' : 'to delete'}:`
    );
    for (const orphanId of orphanIds) {
      const video = byId.get(orphanId);
      const uploadedAt = video?.uploadedAt.toISOString() ?? 'unknown date';
      const title = video?.title ?? 'untitled';
      const emails = video?.title ? (ownerHints.get(video.title) ?? []) : [];
      // "possibly" is load-bearing: this is a title match, not a stored owner.
      const owner =
        emails.length > 0 ? `possibly ${emails.join(', ')}` : 'owner unknown (no title match)';
      console.log(`[bunny-orphan-cleanup]   ${orphanId}  ${uploadedAt}  ${title}  ${owner}`);
    }
  }

  let deleted = 0;
  let alreadyMissing = 0;
  let failed = 0;

  for (const orphanId of orphanIds) {
    if (dryRun) continue;

    try {
      const result = await deleteBunnyVideo(config, orphanId);
      if (result === 'already_missing') {
        alreadyMissing += 1;
      } else {
        deleted += 1;
      }
    } catch (error) {
      failed += 1;
      logError(`[bunny-orphan-cleanup] Failed deleting ${orphanId}:`, error);
    }
  }

  console.log('[bunny-orphan-cleanup] Summary');
  console.log(`[bunny-orphan-cleanup] Referenced: ${referenced.size}`);
  console.log(`[bunny-orphan-cleanup] Orphaned: ${orphanIds.length}`);
  console.log(`[bunny-orphan-cleanup] Deleted: ${deleted}`);
  console.log(`[bunny-orphan-cleanup] Already missing: ${alreadyMissing}`);
  console.log(`[bunny-orphan-cleanup] Failed: ${failed}`);
}

main()
  .catch((error) => {
    logError('[bunny-orphan-cleanup] Fatal error:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectDb();
  });
