// The property the whole acquisition system rests on: every funnel event is
// recorded exactly once, against the right account, and nothing at all is
// recorded when the feature flag is off.
//
// The dedupe key is a UNIQUE column, so these tests are checking that each call
// site derives the right key. A key that varies when it should not shows up here
// as a duplicated row, which is the failure that would quietly inflate the
// scoreboard.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { db } from '@/lib/db';
import { POST as beacon } from '@/app/api/events/route';
import { POST as register } from '@/app/api/auth/register/route';
import { recordSubscriptionTransition } from '@/lib/analytics/billing-events';
import { recordSignupCompleted } from '@/lib/analytics/signup';
import { signAnonymousId, signFirstTouch, type FirstTouch } from '@/lib/analytics/cookies';
import { apiRequest, callRoute } from '../helpers/request';
import { signedOut } from '../helpers/session';
import { createUser } from '../factories';

const ANON_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const INVITE_CODE = 'test-invite';
const ORIGIN = 'http://localhost:3000';
const SECRET = 'analytics-test-secret';
const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

const GITHUB_TOUCH: FirstTouch = {
  channel: 'GITHUB',
  utmSource: 'github',
  utmMedium: 'readme',
  utmCampaign: null,
  referrerHost: 'github.com',
  landingPath: '/',
};

/** What the proxy would have set. Signed, because nothing downstream trusts anything else. */
async function visitorCookies(anonymousId = ANON_ID, touch: FirstTouch = GITHUB_TOUCH) {
  return {
    of_aid: (await signAnonymousId(anonymousId)) ?? '',
    of_ft: (await signFirstTouch(touch)) ?? '',
  };
}

async function beaconRequest(options?: {
  name?: string;
  origin?: string | null;
  userAgent?: string | null;
  cookies?: Record<string, string>;
}) {
  const headers: Record<string, string> = {};
  const origin = options?.origin === undefined ? ORIGIN : options.origin;
  if (origin) headers.origin = origin;
  const userAgent = options?.userAgent === undefined ? BROWSER_UA : options.userAgent;
  if (userAgent) headers['user-agent'] = userAgent;

  return apiRequest('/api/events', {
    body: { name: options?.name ?? 'cta_clicked' },
    headers,
    cookies: options?.cookies ?? (await visitorCookies()),
  });
}

async function eventNames(): Promise<string[]> {
  const rows = await db.analyticsEvent.findMany({ orderBy: { dedupeKey: 'asc' } });
  return rows.map((row) => row.name);
}

beforeEach(() => {
  signedOut();
  vi.stubEnv('OPENFRAME_ENABLE_ANALYTICS', 'true');
  vi.stubEnv('NEXTAUTH_SECRET', SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /api/events', () => {
  it('records a CTA click and the first touch behind it', async () => {
    const response = await callRoute(beacon, await beaconRequest());

    expect(response.status).toBe(204);

    const events = await db.analyticsEvent.findMany();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      name: 'CTA_CLICKED',
      anonymousId: ANON_ID,
      channel: 'GITHUB',
      userId: null,
    });

    const touches = await db.acquisitionTouch.findMany();
    expect(touches).toHaveLength(1);
    expect(touches[0]).toMatchObject({
      anonymousId: ANON_ID,
      channel: 'GITHUB',
      utmSource: 'github',
      referrerHost: 'github.com',
    });
  });

  it('records one event however many times the same visitor clicks', async () => {
    await callRoute(beacon, await beaconRequest());
    await callRoute(beacon, await beaconRequest());
    await callRoute(beacon, await beaconRequest());

    expect(await db.analyticsEvent.count()).toBe(1);
  });

  it('counts two different visitors separately', async () => {
    await callRoute(beacon, await beaconRequest());
    await callRoute(
      beacon,
      await beaconRequest({ cookies: await visitorCookies('f0e1d2c3b4a596877869504132231415') })
    );

    expect(await db.analyticsEvent.count()).toBe(2);
  });

  it('never keeps the first touch of a visitor who came back through another link', async () => {
    await callRoute(beacon, await beaconRequest());
    await callRoute(
      beacon,
      await beaconRequest({
        cookies: await visitorCookies(ANON_ID, {
          ...GITHUB_TOUCH,
          channel: 'GOOGLE',
          utmSource: null,
        }),
      })
    );

    const touches = await db.acquisitionTouch.findMany();
    expect(touches).toHaveLength(1);
    expect(touches[0]?.channel).toBe('GITHUB');
  });

  it('refuses to record an event name the beacon does not own', async () => {
    // Without this the endpoint would let any anonymous caller write a payment
    // into the funnel.
    for (const name of ['subscription_started', 'signup_completed', 'SUBSCRIPTION_STARTED', '']) {
      const response = await callRoute(beacon, await beaconRequest({ name }));
      expect(response.status, name).toBe(204);
    }

    expect(await db.analyticsEvent.count()).toBe(0);
  });

  it('ignores a cross-origin caller', async () => {
    const response = await callRoute(
      beacon,
      await beaconRequest({ origin: 'https://evil.example' })
    );

    expect(response.status).toBe(204);
    expect(await db.analyticsEvent.count()).toBe(0);
  });

  it('ignores a caller with no anonymous id cookie', async () => {
    await callRoute(beacon, await beaconRequest({ cookies: {} }));

    expect(await db.analyticsEvent.count()).toBe(0);
    expect(await db.acquisitionTouch.count()).toBe(0);
  });

  it('ignores a hand-written cookie, whatever channel it claims', async () => {
    // httpOnly stops JavaScript, not curl. Without the signature this is a
    // visitor of the caller's choosing, filed under a channel of their choosing,
    // and every row on the scoreboard is theirs to write.
    await callRoute(
      beacon,
      await beaconRequest({
        cookies: {
          of_aid: 'deadbeefdeadbeefdeadbeefdeadbeef',
          of_ft: encodeURIComponent(JSON.stringify({ c: 'GITHUB', p: '/' })),
        },
      })
    );

    expect(await db.analyticsEvent.count()).toBe(0);
    expect(await db.acquisitionTouch.count()).toBe(0);
  });

  it('ignores a cookie signed by another deployment', async () => {
    const cookies = await visitorCookies();
    vi.stubEnv('NEXTAUTH_SECRET', 'some-other-secret');

    await callRoute(beacon, await beaconRequest({ cookies }));

    expect(await db.analyticsEvent.count()).toBe(0);
  });

  it('ignores a script that sends no user agent', async () => {
    await callRoute(beacon, await beaconRequest({ userAgent: null }));

    expect(await db.analyticsEvent.count()).toBe(0);
  });

  it('writes nothing at all when the flag is off', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_ANALYTICS', 'false');

    const response = await callRoute(beacon, await beaconRequest());

    expect(response.status).toBe(204);
    expect(await db.analyticsEvent.count()).toBe(0);
    expect(await db.acquisitionTouch.count()).toBe(0);
  });
});

describe('signup attribution', () => {
  async function registerWithCookies(email: string) {
    return callRoute(
      register,
      apiRequest('/api/auth/register', {
        body: {
          name: 'New User',
          email,
          password: 'correct horse battery',
          inviteCode: INVITE_CODE,
        },
        headers: { 'user-agent': BROWSER_UA },
        cookies: await visitorCookies(),
      })
    );
  }

  it('copies the first touch onto the account and records the signup once', async () => {
    const response = await registerWithCookies('attributed@example.com');
    expect(response.status).toBe(201);

    const user = await db.user.findUniqueOrThrow({ where: { email: 'attributed@example.com' } });
    const acquisition = await db.userAcquisition.findUniqueOrThrow({
      where: { userId: user.id },
    });

    expect(acquisition).toMatchObject({
      channel: 'GITHUB',
      utmSource: 'github',
      utmMedium: 'readme',
      referrerHost: 'github.com',
      anonymousId: ANON_ID,
    });

    const signups = await db.analyticsEvent.findMany({ where: { name: 'SIGNUP_COMPLETED' } });
    expect(signups).toHaveLength(1);
    expect(signups[0]?.userId).toBe(user.id);
  });

  it('claims the events the visitor produced before they had an account', async () => {
    await callRoute(beacon, await beaconRequest());
    await registerWithCookies('backfilled@example.com');

    const user = await db.user.findUniqueOrThrow({ where: { email: 'backfilled@example.com' } });
    const click = await db.analyticsEvent.findFirstOrThrow({ where: { name: 'CTA_CLICKED' } });

    // Without the backfill the click and the signup are two unrelated rows and
    // no query can tell you which channel converted.
    expect(click.userId).toBe(user.id);
  });

  it('records one signup even if the helper runs twice', async () => {
    const user = await createUser();

    await recordSignupCompleted({
      userId: user.id,
      visitor: { anonymousId: ANON_ID, firstTouch: GITHUB_TOUCH, clientIp: null },
    });
    await recordSignupCompleted({
      userId: user.id,
      visitor: { anonymousId: ANON_ID, firstTouch: GITHUB_TOUCH, clientIp: null },
    });

    expect(await db.analyticsEvent.count({ where: { name: 'SIGNUP_COMPLETED' } })).toBe(1);
    expect(await db.userAcquisition.count({ where: { userId: user.id } })).toBe(1);
  });

  it('records no acquisition row when the flag is off', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_ANALYTICS', 'false');

    const response = await registerWithCookies('unmeasured@example.com');

    expect(response.status).toBe(201);
    expect(await db.userAcquisition.count()).toBe(0);
    expect(await db.analyticsEvent.count()).toBe(0);
  });
});

describe('subscription transitions', () => {
  const SUB = 'sub_test_1';
  const periodEnd = new Date('2026-09-01T00:00:00.000Z');

  async function transition(params: {
    userId: string;
    beforeStatus: 'FREE' | 'TRIALING' | 'ACTIVE' | 'CANCELED';
    afterStatus: 'FREE' | 'TRIALING' | 'ACTIVE' | 'CANCELED';
    beforeCancelAtPeriodEnd?: boolean;
    afterCancelAtPeriodEnd?: boolean;
    hadTrial?: boolean;
    trialEndsAt?: Date | null;
  }) {
    await recordSubscriptionTransition({
      userId: params.userId,
      subscriptionId: SUB,
      before: {
        status: params.beforeStatus,
        cancelAtPeriodEnd: params.beforeCancelAtPeriodEnd ?? false,
        hadTrial: params.hadTrial ?? false,
      },
      after: {
        status: params.afterStatus,
        cancelAtPeriodEnd: params.afterCancelAtPeriodEnd ?? false,
        trialEndsAt: params.trialEndsAt ?? null,
        currentPeriodEnd: periodEnd,
      },
    });
  }

  it('records the trial once and the conversion to paid once', async () => {
    const user = await createUser();

    await transition({
      userId: user.id,
      beforeStatus: 'FREE',
      afterStatus: 'TRIALING',
      trialEndsAt: new Date('2026-08-15T00:00:00.000Z'),
    });
    // The same webhook arriving again, which Stripe does routinely.
    await transition({
      userId: user.id,
      beforeStatus: 'FREE',
      afterStatus: 'TRIALING',
      trialEndsAt: new Date('2026-08-15T00:00:00.000Z'),
    });
    await transition({
      userId: user.id,
      beforeStatus: 'TRIALING',
      afterStatus: 'ACTIVE',
      hadTrial: true,
    });

    expect(await eventNames()).toEqual(['SUBSCRIPTION_STARTED', 'TRIAL_STARTED']);
  });

  it('does not record a second trial for an account that already had one', async () => {
    const user = await createUser();

    await transition({
      userId: user.id,
      beforeStatus: 'CANCELED',
      afterStatus: 'TRIALING',
      hadTrial: true,
      trialEndsAt: new Date('2026-08-15T00:00:00.000Z'),
    });

    expect(await eventNames()).toEqual([]);
  });

  it('counts one cancellation for the flag and the status that follow each other', async () => {
    const user = await createUser();

    // The customer cancels in the portal: cancel_at_period_end flips on.
    await transition({
      userId: user.id,
      beforeStatus: 'ACTIVE',
      afterStatus: 'ACTIVE',
      afterCancelAtPeriodEnd: true,
    });
    // The term ends weeks later and Stripe marks the subscription canceled.
    await transition({
      userId: user.id,
      beforeStatus: 'ACTIVE',
      afterStatus: 'CANCELED',
      beforeCancelAtPeriodEnd: true,
    });

    expect(await db.analyticsEvent.count({ where: { name: 'SUBSCRIPTION_CANCELED' } })).toBe(1);
  });

  it('records a reactivation when the customer changes their mind', async () => {
    const user = await createUser();

    await transition({
      userId: user.id,
      beforeStatus: 'ACTIVE',
      afterStatus: 'ACTIVE',
      afterCancelAtPeriodEnd: true,
    });
    await transition({
      userId: user.id,
      beforeStatus: 'ACTIVE',
      afterStatus: 'ACTIVE',
      beforeCancelAtPeriodEnd: true,
      afterCancelAtPeriodEnd: false,
    });

    expect(await eventNames()).toEqual(['SUBSCRIPTION_CANCELED', 'SUBSCRIPTION_REACTIVATED']);
  });

  it('records nothing when nothing changed', async () => {
    const user = await createUser();

    await transition({ userId: user.id, beforeStatus: 'ACTIVE', afterStatus: 'ACTIVE' });

    expect(await eventNames()).toEqual([]);
  });

  it('writes nothing when the flag is off', async () => {
    vi.stubEnv('OPENFRAME_ENABLE_ANALYTICS', 'false');
    const user = await createUser();

    await transition({ userId: user.id, beforeStatus: 'FREE', afterStatus: 'ACTIVE' });

    expect(await db.analyticsEvent.count()).toBe(0);
  });
});
