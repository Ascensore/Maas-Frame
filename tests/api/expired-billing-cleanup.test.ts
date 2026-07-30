// Exercises scripts/expired-billing-cleanup.ts against a real database, because the bug this
// file exists for could not be seen any other way.
//
// The filter used to be written as `NOT: buildBillingAccessWhereInput(now)`, which the unit
// tests happily asserted on: as an object it reads correctly. Prisma renders it as
// `NOT (status IN (...) OR "trialEndsAt" > $1 OR "stripeCurrentPeriodEnd" > $2)`, and SQL
// comparisons against NULL are unknown rather than false, so a row with both dates empty
// evaluates to NOT NULL and is dropped. A canceled subscriber is exactly that row, so the
// scheduled cleanup deleted nothing at all while reporting success. Only a query against
// Postgres shows it, which is why these tests live here and not in tests/unit.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BillingSubscriptionStatus } from '@prisma/client';
import { db } from '@/lib/db';
import { cleanupExpiredBillingWorkspaces } from '../../scripts/expired-billing-cleanup';
import { createUser, createVersion, createVideo, seedProject } from '../factories';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Every Bunny video id the cleanup asked Bunny to delete, in call order. */
let bunnyDeletes: string[] = [];

beforeEach(() => {
  bunnyDeletes = [];
  vi.stubEnv('BUNNY_STREAM_API_KEY', 'test-bunny-key');
  vi.stubEnv('BUNNY_STREAM_LIBRARY_ID', '999999');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: { method?: string }) => {
      // Matched on the parsed host rather than a substring of the href, so a request to some
      // other service that merely mentions the Bunny host cannot be recorded as a Bunny
      // delete. The recorder decides what the assertions see, so a loose match here would
      // make a test pass for the wrong reason.
      const target = new URL(typeof url === 'string' ? url : url.toString());
      if (init?.method === 'DELETE' && target.host === 'video.bunnycdn.com') {
        bunnyDeletes.push(target.pathname.split('/videos/')[1] ?? '');
        return new Response(null, { status: 200 });
      }
      throw new Error(`Unexpected fetch in test: ${init?.method ?? 'GET'} ${target.href}`);
    })
  );
});

// tests/setup/api.ts already undoes stubbed envs after every test, but not globals, and a
// leaked fetch stub would swallow the next file's HTTP calls.
afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * An owner whose access ended `endedDaysAgo` ago, shaped the way Stripe actually leaves the
 * row: the status is CANCELED and both date columns are empty, because
 * markSubscriptionCanceledByCustomerId() clears trialEndsAt and Stripe no longer reports
 * current_period_end on the subscription itself.
 */
async function seedCanceledOwner(endedDaysAgo: number) {
  const owner = await createUser({
    subscriptionStatus: BillingSubscriptionStatus.CANCELED,
    trialEndsAt: null,
    stripeCurrentPeriodEnd: null,
    billingAccessEndedAt: new Date(Date.now() - endedDaysAgo * DAY_MS),
  });
  const { workspace, project } = await seedProject({ ownerUser: owner });
  const video = await createVideo({ projectId: project.id });
  const version = await createVersion({
    videoParentId: video.id,
    providerId: 'bunny',
    providerVideoId: `bunny-video-${workspace.id.slice(0, 12)}`,
  });

  return { owner, workspace, project, video, version };
}

describe('cleanupExpiredBillingWorkspaces', () => {
  it('deletes the workspace of a canceled owner whose trial and period columns are null', async () => {
    const { workspace, version } = await seedCanceledOwner(30);

    const result = await cleanupExpiredBillingWorkspaces();

    expect(result).toEqual({ owners: 1, scanned: 1, deleted: 1 });
    expect(await db.workspace.findUnique({ where: { id: workspace.id } })).toBeNull();
    expect(bunnyDeletes).toEqual([version.videoId]);
  });

  it('leaves an owner inside the fifteen day grace period alone', async () => {
    const { workspace } = await seedCanceledOwner(5);

    const result = await cleanupExpiredBillingWorkspaces();

    expect(result).toEqual({ owners: 0, scanned: 0, deleted: 0 });
    expect(await db.workspace.findUnique({ where: { id: workspace.id } })).not.toBeNull();
    expect(bunnyDeletes).toEqual([]);
  });

  it('leaves an owner with billing access alone', async () => {
    const { workspace } = await seedProject();

    const result = await cleanupExpiredBillingWorkspaces();

    expect(result).toEqual({ owners: 0, scanned: 0, deleted: 0 });
    expect(await db.workspace.findUnique({ where: { id: workspace.id } })).not.toBeNull();
  });

  it('collects an owner whose trial lapsed without Stripe ever setting an end date', async () => {
    const owner = await createUser({
      subscriptionStatus: BillingSubscriptionStatus.FREE,
      trialEndsAt: new Date(Date.now() - 30 * DAY_MS),
      billingAccessEndedAt: null,
    });
    const { workspace } = await seedProject({ ownerUser: owner });

    const result = await cleanupExpiredBillingWorkspaces();

    expect(result).toEqual({ owners: 1, scanned: 1, deleted: 1 });
    expect(await db.workspace.findUnique({ where: { id: workspace.id } })).toBeNull();
  });

  it('reports what it would delete without touching anything on a dry run', async () => {
    const { workspace } = await seedCanceledOwner(30);

    const result = await cleanupExpiredBillingWorkspaces({ dryRun: true });

    expect(result).toEqual({ owners: 1, scanned: 1, deleted: 0 });
    expect(await db.workspace.findUnique({ where: { id: workspace.id } })).not.toBeNull();
    expect(bunnyDeletes).toEqual([]);
  });

  // The guard is `{ id: { in: [] } }`, and an empty IN list is only safe if Prisma renders it
  // as a contradiction rather than dropping the filter. It renders `WHERE 1=0`, but a
  // regression there would delete every workspace on a self-hosted deployment, so it is worth
  // a test rather than trust.
  it('deletes nothing when Stripe is disabled, since nothing can expire without billing', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_STRIPE', 'false');
    const { workspace } = await seedCanceledOwner(30);

    const result = await cleanupExpiredBillingWorkspaces();

    expect(result).toEqual({ owners: 0, scanned: 0, deleted: 0 });
    expect(await db.workspace.findUnique({ where: { id: workspace.id } })).not.toBeNull();
    expect(bunnyDeletes).toEqual([]);
  });

  it('counts an expired owner who owns no workspace, so an empty scan is not mistaken for an empty user table', async () => {
    await createUser({
      subscriptionStatus: BillingSubscriptionStatus.CANCELED,
      trialEndsAt: null,
      stripeCurrentPeriodEnd: null,
      billingAccessEndedAt: new Date(Date.now() - 30 * DAY_MS),
    });

    expect(await cleanupExpiredBillingWorkspaces()).toEqual({
      owners: 1,
      scanned: 0,
      deleted: 0,
    });
  });
});
