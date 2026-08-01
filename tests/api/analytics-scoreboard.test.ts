// Exercises the scoreboard queries against a real database.
//
// These are raw SQL: a date_trunc grouping, a COALESCE across two tables and a
// filtered left join. None of that is checked by the type system, so a seeded
// week with known counts is the only thing standing between a renamed column and
// a growth page that renders zeros forever.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import type { AcquisitionChannel, AnalyticsEventName } from '@prisma/client';
import { db } from '@/lib/db';
import { AT_RISK_SILENT_DAYS, getScoreboard } from '@/lib/analytics/scoreboard';
import { createUser } from '../factories';

function daysAgo(days: number): Date {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date;
}

let sequence = 0;

async function seedEvent(params: {
  name: AnalyticsEventName;
  occurredAt: Date;
  userId?: string;
  anonymousId?: string;
  channel?: AcquisitionChannel;
}) {
  sequence += 1;
  await db.analyticsEvent.create({
    data: {
      name: params.name,
      dedupeKey: `${params.name}:seed-${sequence}`,
      occurredAt: params.occurredAt,
      userId: params.userId ?? null,
      anonymousId: params.anonymousId ?? null,
      channel: params.channel ?? null,
    },
  });
}

beforeEach(() => {
  sequence = 0;
  vi.stubEnv('OPENFRAME_ENABLE_ANALYTICS', 'true');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getScoreboard', () => {
  it('returns an empty week for every week in the window when nothing happened', async () => {
    const scoreboard = await getScoreboard({ weeks: 4 });

    expect(scoreboard.weeks).toHaveLength(4);
    expect(scoreboard.weeks.every((week) => week.visitors === 0)).toBe(true);
    expect(scoreboard.channels).toEqual([]);
    expect(scoreboard.paidAccounts).toEqual([]);
  });

  it('counts a returning visitor once per week, not once per visit', async () => {
    // Landing views are deduped per visitor per day, so the same person on three
    // days is three rows. Weekly visitors is a distinct count over the id.
    for (const days of [1, 2, 3]) {
      await seedEvent({
        name: 'LANDING_VIEW',
        occurredAt: daysAgo(days),
        anonymousId: 'visitor-one',
        channel: 'GITHUB',
      });
    }
    await seedEvent({
      name: 'LANDING_VIEW',
      occurredAt: daysAgo(1),
      anonymousId: 'visitor-two',
      channel: 'GOOGLE',
    });

    const scoreboard = await getScoreboard({ weeks: 2 });
    const total = scoreboard.weeks.reduce((sum, week) => sum + week.visitors, 0);

    expect(total).toBe(2);
  });

  it('reads a signed-up visitor through the channel on their account', async () => {
    const user = await createUser();
    await db.userAcquisition.create({
      data: { userId: user.id, channel: 'YOUTUBE', anonymousId: 'visitor-three' },
    });

    // The visitor event carries GITHUB from the cookie, but the account says
    // YouTube. The account wins, so correcting a channel corrects its history.
    await seedEvent({
      name: 'LANDING_VIEW',
      occurredAt: daysAgo(2),
      anonymousId: 'visitor-three',
      channel: 'GITHUB',
      userId: user.id,
    });
    await seedEvent({
      name: 'SIGNUP_COMPLETED',
      occurredAt: daysAgo(2),
      userId: user.id,
      anonymousId: 'visitor-three',
    });

    const scoreboard = await getScoreboard({ weeks: 2 });
    const youtube = scoreboard.channels.find((row) => row.channel === 'YOUTUBE');

    expect(youtube).toMatchObject({ visitors: 1, signups: 1 });
    expect(scoreboard.channels.find((row) => row.channel === 'GITHUB')).toBeUndefined();
  });

  it('carries subscriptions started before the window into the running total', async () => {
    await seedEvent({ name: 'SUBSCRIPTION_STARTED', occurredAt: daysAgo(120) });
    await seedEvent({ name: 'SUBSCRIPTION_STARTED', occurredAt: daysAgo(3) });
    await seedEvent({ name: 'SUBSCRIPTION_CANCELED', occurredAt: daysAgo(3) });

    const scoreboard = await getScoreboard({ weeks: 2 });
    const last = scoreboard.weeks[scoreboard.weeks.length - 1];

    // One from before the window, plus one started and one canceled inside it.
    expect(last?.activePaid).toBe(1);
    expect(last?.newPaid).toBe(1);
    expect(last?.canceled).toBe(1);
  });

  it('flags a paid account that has produced nothing recently', async () => {
    const busy = await createUser({ subscriptionStatus: 'ACTIVE' });
    const silent = await createUser({ subscriptionStatus: 'ACTIVE' });
    const trialing = await createUser({ subscriptionStatus: 'TRIALING' });
    await createUser({ subscriptionStatus: 'FREE' });

    await seedEvent({ name: 'VIDEO_ADDED', occurredAt: daysAgo(2), userId: busy.id });
    await seedEvent({ name: 'SHARE_LINK_CREATED', occurredAt: daysAgo(20), userId: busy.id });
    await seedEvent({
      name: 'VIDEO_ADDED',
      occurredAt: daysAgo(AT_RISK_SILENT_DAYS + 5),
      userId: silent.id,
    });
    // A signup is not a value event, so it must not clear the risk flag.
    await seedEvent({ name: 'SIGNUP_COMPLETED', occurredAt: daysAgo(1), userId: trialing.id });

    const scoreboard = await getScoreboard({ weeks: 4 });
    const ids = scoreboard.paidAccounts.map((row) => row.userId).sort();
    const atRisk = scoreboard.atRisk.map((row) => row.userId).sort();

    expect(ids).toEqual([busy.id, silent.id, trialing.id].sort());
    expect(atRisk).toEqual([silent.id, trialing.id].sort());

    const busyRow = scoreboard.paidAccounts.find((row) => row.userId === busy.id);
    expect(busyRow?.valueEvents7).toBe(1);
    expect(busyRow?.valueEvents30).toBe(2);
  });
});
