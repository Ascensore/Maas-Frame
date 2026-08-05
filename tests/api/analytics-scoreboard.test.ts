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

/**
 * The Monday this week started, in UTC.
 *
 * Anything asserted per week has to be seeded from here rather than from
 * `daysAgo`: weeks start on Monday, so "three days ago" is last week on a
 * Wednesday and this week on a Saturday, and a suite written the second way
 * fails on the days the calendar disagrees.
 */
function startOfThisWeek(): Date {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  return start;
}

/** `days` into the week beginning at `weekStart`. Negative walks back a week. */
function intoWeek(weekStart: Date, days: number): Date {
  const date = new Date(weekStart);
  date.setUTCDate(date.getUTCDate() + days);
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
    // Seeded into last week, which is whole however the suite is scheduled.
    const lastWeek = intoWeek(startOfThisWeek(), -7);
    for (const day of [0, 1, 2]) {
      await seedEvent({
        name: 'LANDING_VIEW',
        occurredAt: intoWeek(lastWeek, day),
        anonymousId: 'visitor-one',
        channel: 'GITHUB',
      });
    }
    await seedEvent({
      name: 'LANDING_VIEW',
      occurredAt: intoWeek(lastWeek, 1),
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
    // The pair has to land in the week the assertions read, which is this one.
    const thisWeek = startOfThisWeek();
    await seedEvent({ name: 'SUBSCRIPTION_STARTED', occurredAt: daysAgo(120) });
    await seedEvent({ name: 'SUBSCRIPTION_STARTED', occurredAt: thisWeek });
    await seedEvent({ name: 'SUBSCRIPTION_CANCELED', occurredAt: thisWeek });

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
