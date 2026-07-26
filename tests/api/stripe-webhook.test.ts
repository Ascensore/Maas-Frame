import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { getStripe } from '@/lib/stripe';
import { POST as stripeWebhook } from '@/app/api/stripe/webhook/route';
import { apiRequest, callRoute } from '../helpers/request';
import { createUser } from '../factories';

const CUSTOMER_ID = 'cus_test_webhook';
const ENTITLED_PRICE_ID = 'price_test_openframe_dummy';
const HOUR = 60 * 60;

function unix(offsetSeconds: number): number {
  return Math.floor(Date.now() / 1000) + offsetSeconds;
}

interface SubscriptionFixture {
  id: string;
  customer: string;
  status: string;
  created: number;
  current_period_end: number | null;
  cancel_at_period_end: boolean;
  cancel_at: number | null;
  trial_end: number | null;
  ended_at?: number | null;
  canceled_at?: number | null;
  items: { data: Array<{ price: { id: string } }> };
}

function subscription(overrides: Partial<SubscriptionFixture> = {}): SubscriptionFixture {
  return {
    id: 'sub_test_1',
    customer: CUSTOMER_ID,
    status: 'active',
    created: unix(-24 * HOUR),
    current_period_end: unix(30 * 24 * HOUR),
    cancel_at_period_end: false,
    cancel_at: null,
    trial_end: null,
    items: { data: [{ price: { id: ENTITLED_PRICE_ID } }] },
    ...overrides,
  };
}

/**
 * Installs a Stripe double for one test.
 *
 * `constructEvent` returning the event is what stands in for a valid signature;
 * the default mock in tests/setup/api.ts throws, which is the invalid-signature
 * case. `subscriptions.list` is what syncStripeCustomerSubscriptions re-reads,
 * so it is the source of truth rather than the event body.
 */
function stubStripe(options: {
  event?: unknown;
  subscriptions?: SubscriptionFixture[];
  constructEventThrows?: boolean;
}): { listCalls: number } {
  const counters = { listCalls: 0 };

  vi.mocked(getStripe as unknown as () => unknown).mockReturnValue({
    webhooks: {
      constructEvent: vi.fn(() => {
        if (options.constructEventThrows) {
          throw new Error('No signatures found matching the expected signature for payload');
        }
        return options.event;
      }),
    },
    subscriptions: {
      list: vi.fn(async () => {
        counters.listCalls += 1;
        return { data: options.subscriptions ?? [] };
      }),
    },
  });

  return counters;
}

function webhookRequest(body: unknown, headers: Record<string, string> = {}) {
  return apiRequest('/api/stripe/webhook', {
    method: 'POST',
    rawBody: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function signed(body: unknown) {
  return webhookRequest(body, { 'stripe-signature': 't=1,v1=deadbeef' });
}

describe('POST /api/stripe/webhook', () => {
  beforeEach(() => {
    vi.mocked(getStripe as unknown as () => unknown).mockReset();
  });

  it('returns 400 without a stripe-signature header and never calls Stripe', async () => {
    const counters = stubStripe({ event: { type: 'customer.subscription.updated' } });
    await createUser({ stripeCustomerId: CUSTOMER_ID });

    const response = await callRoute(stripeWebhook, webhookRequest({ type: 'anything' }));

    expect(response.status).toBe(400);
    expect(await response.text()).toBe('Missing Stripe signature');
    expect(counters.listCalls).toBe(0);
  });

  it('returns 400 when the signature does not verify', async () => {
    stubStripe({ constructEventThrows: true });
    const user = await createUser({
      stripeCustomerId: CUSTOMER_ID,
      subscriptionStatus: 'FREE',
      trialEndsAt: null,
    });

    const response = await callRoute(
      stripeWebhook,
      signed({
        type: 'customer.subscription.updated',
        data: { object: subscription({ status: 'active' }) },
      })
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe('Invalid webhook signature');
    // A forged event must not be able to grant a subscription.
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).subscriptionStatus).toBe(
      'FREE'
    );
  });

  it('maps an active subscription onto the user', async () => {
    const periodEnd = unix(30 * 24 * HOUR);
    const user = await createUser({
      stripeCustomerId: CUSTOMER_ID,
      subscriptionStatus: 'FREE',
      trialEndsAt: null,
    });
    stubStripe({
      event: {
        id: 'evt_1',
        type: 'customer.subscription.updated',
        data: { object: subscription({ current_period_end: periodEnd }) },
      },
      subscriptions: [subscription({ current_period_end: periodEnd })],
    });

    const response = await callRoute(
      stripeWebhook,
      signed({ type: 'customer.subscription.updated' })
    );

    expect(response.status).toBe(200);
    const stored = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stored.subscriptionStatus).toBe('ACTIVE');
    expect(stored.stripeSubscriptionId).toBe('sub_test_1');
    expect(stored.stripePriceId).toBe(ENTITLED_PRICE_ID);
    expect(stored.stripeCurrentPeriodEnd?.getTime()).toBe(periodEnd * 1000);
    expect(stored.stripeCancelAtPeriodEnd).toBe(false);
    expect(stored.billingAccessEndedAt).toBeNull();
  });

  it('records the trial end and consumes the trial for a trialing subscription', async () => {
    const trialEnd = unix(7 * 24 * HOUR);
    const user = await createUser({
      stripeCustomerId: CUSTOMER_ID,
      subscriptionStatus: 'FREE',
      trialEndsAt: null,
      billingTrialConsumedAt: null,
    });
    const trialing = subscription({ status: 'trialing', trial_end: trialEnd });
    stubStripe({
      event: { id: 'evt_2', type: 'customer.subscription.created', data: { object: trialing } },
      subscriptions: [trialing],
    });

    const response = await callRoute(
      stripeWebhook,
      signed({ type: 'customer.subscription.created' })
    );

    expect(response.status).toBe(200);
    const stored = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stored.subscriptionStatus).toBe('TRIALING');
    expect(stored.trialEndsAt?.getTime()).toBe(trialEnd * 1000);
    expect(stored.billingTrialConsumedAt).toBeInstanceOf(Date);
  });

  it('does not grant entitlement for a subscription on a different price', async () => {
    const user = await createUser({
      stripeCustomerId: CUSTOMER_ID,
      subscriptionStatus: 'FREE',
      trialEndsAt: null,
    });
    const unrelated = subscription({
      items: { data: [{ price: { id: 'price_some_other_product' } }] },
    });
    stubStripe({
      event: { id: 'evt_3', type: 'customer.subscription.updated', data: { object: unrelated } },
      subscriptions: [unrelated],
    });

    const response = await callRoute(
      stripeWebhook,
      signed({ type: 'customer.subscription.updated' })
    );

    expect(response.status).toBe(200);
    const stored = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    // Active in Stripe, but for a product this app does not sell.
    expect(stored.subscriptionStatus).toBe('FREE');
    expect(stored.stripeCurrentPeriodEnd).toBeNull();
    expect(stored.billingAccessEndedAt).toBeInstanceOf(Date);
    expect(stored.stripePriceId).toBe('price_some_other_product');
  });

  it.each([
    ['past_due', 'PAST_DUE'],
    ['unpaid', 'UNPAID'],
    ['incomplete', 'INCOMPLETE'],
    ['incomplete_expired', 'INCOMPLETE_EXPIRED'],
    ['canceled', 'CANCELED'],
  ])('maps the Stripe status %s onto %s', async (stripeStatus, expected) => {
    const user = await createUser({ stripeCustomerId: CUSTOMER_ID, trialEndsAt: null });
    const sub = subscription({ status: stripeStatus, current_period_end: unix(-HOUR) });
    stubStripe({
      event: { id: 'evt_4', type: 'customer.subscription.updated', data: { object: sub } },
      subscriptions: [sub],
    });

    const response = await callRoute(
      stripeWebhook,
      signed({ type: 'customer.subscription.updated' })
    );

    expect(response.status).toBe(200);
    const stored = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stored.subscriptionStatus).toBe(expected);
    // The period already ended, so access is closed off.
    expect(stored.billingAccessEndedAt).toBeInstanceOf(Date);
  });

  it('marks the subscription canceled when Stripe reports none left', async () => {
    const user = await createUser({
      stripeCustomerId: CUSTOMER_ID,
      subscriptionStatus: 'ACTIVE',
      stripeSubscriptionId: 'sub_test_1',
      stripePriceId: ENTITLED_PRICE_ID,
      stripeCurrentPeriodEnd: new Date(Date.now() + 86_400_000),
      trialEndsAt: null,
    });
    stubStripe({
      event: {
        id: 'evt_5',
        type: 'customer.subscription.deleted',
        data: { object: subscription({ status: 'canceled' }) },
      },
      subscriptions: [],
    });

    const response = await callRoute(
      stripeWebhook,
      signed({ type: 'customer.subscription.deleted' })
    );

    expect(response.status).toBe(200);
    const stored = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stored.subscriptionStatus).toBe('CANCELED');
    expect(stored.stripeSubscriptionId).toBeNull();
    expect(stored.stripePriceId).toBeNull();
    expect(stored.stripeCurrentPeriodEnd).toBeNull();
    expect(stored.trialEndsAt).toBeNull();
    expect(stored.billingAccessEndedAt).toBeInstanceOf(Date);
  });

  // The route deliberately re-lists rather than trusting the event body, so an
  // out-of-order delete of an old subscription cannot revoke a newer active one.
  it('keeps the newer active subscription when an older one is deleted', async () => {
    const periodEnd = unix(30 * 24 * HOUR);
    const user = await createUser({ stripeCustomerId: CUSTOMER_ID, trialEndsAt: null });
    const stale = subscription({
      id: 'sub_old',
      status: 'canceled',
      created: unix(-90 * 24 * HOUR),
      current_period_end: unix(-HOUR),
    });
    const live = subscription({
      id: 'sub_new',
      status: 'active',
      created: unix(-HOUR),
      current_period_end: periodEnd,
    });
    stubStripe({
      event: { id: 'evt_6', type: 'customer.subscription.deleted', data: { object: stale } },
      subscriptions: [stale, live],
    });

    const response = await callRoute(
      stripeWebhook,
      signed({ type: 'customer.subscription.deleted' })
    );

    expect(response.status).toBe(200);
    const stored = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stored.subscriptionStatus).toBe('ACTIVE');
    expect(stored.stripeSubscriptionId).toBe('sub_new');
    expect(stored.stripeCurrentPeriodEnd?.getTime()).toBe(periodEnd * 1000);
  });

  it('syncs on a completed subscription checkout', async () => {
    const periodEnd = unix(30 * 24 * HOUR);
    const user = await createUser({
      stripeCustomerId: CUSTOMER_ID,
      subscriptionStatus: 'FREE',
      trialEndsAt: null,
    });
    const counters = stubStripe({
      event: {
        id: 'evt_7',
        type: 'checkout.session.completed',
        data: { object: { mode: 'subscription', customer: CUSTOMER_ID } },
      },
      subscriptions: [subscription({ current_period_end: periodEnd })],
    });

    const response = await callRoute(stripeWebhook, signed({ type: 'checkout.session.completed' }));

    expect(response.status).toBe(200);
    expect(counters.listCalls).toBe(1);
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).subscriptionStatus).toBe(
      'ACTIVE'
    );
  });

  it('ignores a one-off payment checkout', async () => {
    const user = await createUser({
      stripeCustomerId: CUSTOMER_ID,
      subscriptionStatus: 'FREE',
      trialEndsAt: null,
    });
    const counters = stubStripe({
      event: {
        id: 'evt_8',
        type: 'checkout.session.completed',
        data: { object: { mode: 'payment', customer: CUSTOMER_ID } },
      },
      subscriptions: [subscription()],
    });

    const response = await callRoute(stripeWebhook, signed({ type: 'checkout.session.completed' }));

    expect(response.status).toBe(200);
    expect(counters.listCalls).toBe(0);
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).subscriptionStatus).toBe(
      'FREE'
    );
  });

  it('acknowledges an unhandled event type without touching any user', async () => {
    const user = await createUser({
      stripeCustomerId: CUSTOMER_ID,
      subscriptionStatus: 'FREE',
      trialEndsAt: null,
    });
    const counters = stubStripe({
      event: { id: 'evt_9', type: 'invoice.payment_succeeded', data: { object: {} } },
      subscriptions: [subscription()],
    });

    const response = await callRoute(stripeWebhook, signed({ type: 'invoice.payment_succeeded' }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true });
    expect(counters.listCalls).toBe(0);
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).subscriptionStatus).toBe(
      'FREE'
    );
  });

  it('acknowledges an event for a customer with no local user and writes nothing', async () => {
    stubStripe({
      event: {
        id: 'evt_10',
        type: 'customer.subscription.updated',
        data: { object: subscription({ customer: 'cus_unknown' }) },
      },
      subscriptions: [subscription({ customer: 'cus_unknown' })],
    });

    const response = await callRoute(
      stripeWebhook,
      signed({ type: 'customer.subscription.updated' })
    );

    expect(response.status).toBe(200);
    expect(await db.user.count()).toBe(0);
  });

  it('is idempotent when the same event is replayed', async () => {
    const periodEnd = unix(30 * 24 * HOUR);
    const user = await createUser({
      stripeCustomerId: CUSTOMER_ID,
      subscriptionStatus: 'FREE',
      trialEndsAt: null,
      billingTrialConsumedAt: null,
    });
    const sub = subscription({
      status: 'trialing',
      trial_end: unix(7 * 24 * HOUR),
      current_period_end: periodEnd,
    });
    stubStripe({
      event: { id: 'evt_11', type: 'customer.subscription.updated', data: { object: sub } },
      subscriptions: [sub],
    });

    const first = await callRoute(stripeWebhook, signed({ type: 'customer.subscription.updated' }));
    const afterFirst = await db.user.findUniqueOrThrow({ where: { id: user.id } });

    const second = await callRoute(
      stripeWebhook,
      signed({ type: 'customer.subscription.updated' })
    );
    const afterSecond = await db.user.findUniqueOrThrow({ where: { id: user.id } });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(afterSecond.subscriptionStatus).toBe(afterFirst.subscriptionStatus);
    expect(afterSecond.stripeSubscriptionId).toBe(afterFirst.stripeSubscriptionId);
    expect(afterSecond.stripeCurrentPeriodEnd?.getTime()).toBe(
      afterFirst.stripeCurrentPeriodEnd?.getTime()
    );
    expect(afterSecond.trialEndsAt?.getTime()).toBe(afterFirst.trialEndsAt?.getTime());
    // The first sync stamps the trial as consumed; a replay must not push it
    // forward, or a user could win a fresh trial by resending a webhook.
    expect(afterSecond.billingTrialConsumedAt?.getTime()).toBe(
      afterFirst.billingTrialConsumedAt?.getTime()
    );
  });

  it('records a scheduled cancellation without revoking access', async () => {
    const periodEnd = unix(15 * 24 * HOUR);
    const user = await createUser({ stripeCustomerId: CUSTOMER_ID, trialEndsAt: null });
    const sub = subscription({
      cancel_at_period_end: true,
      cancel_at: periodEnd,
      current_period_end: periodEnd,
    });
    stubStripe({
      event: { id: 'evt_12', type: 'customer.subscription.updated', data: { object: sub } },
      subscriptions: [sub],
    });

    const response = await callRoute(
      stripeWebhook,
      signed({ type: 'customer.subscription.updated' })
    );

    expect(response.status).toBe(200);
    const stored = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stored.subscriptionStatus).toBe('ACTIVE');
    expect(stored.stripeCancelAtPeriodEnd).toBe(true);
    expect(stored.stripeCancelAt?.getTime()).toBe(periodEnd * 1000);
    expect(stored.billingAccessEndedAt).toBeNull();
  });

  it('returns 500 when the sync itself fails', async () => {
    await createUser({ stripeCustomerId: CUSTOMER_ID });
    vi.mocked(getStripe as unknown as () => unknown).mockReturnValue({
      webhooks: {
        constructEvent: vi.fn(() => ({
          id: 'evt_13',
          type: 'customer.subscription.updated',
          data: { object: subscription() },
        })),
      },
      subscriptions: {
        list: vi.fn(async () => {
          throw new Error('Stripe is down');
        }),
      },
    });

    const response = await callRoute(
      stripeWebhook,
      signed({ type: 'customer.subscription.updated' })
    );

    // A 500 tells Stripe to retry, which is the correct behaviour for a
    // transient upstream failure.
    expect(response.status).toBe(500);
  });
});
