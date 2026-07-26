import bcrypt from 'bcryptjs';
import { BillingSubscriptionStatus, type Prisma, type User } from '@prisma/client';
import { db } from '@/lib/db';
import { nextSeq } from './seq';

const DAY_MS = 24 * 60 * 60 * 1000;

// Cheap on purpose. bcrypt at the production cost factor takes ~100ms, which is
// dead time repeated across every test that needs a user with a password.
const TEST_BCRYPT_ROUNDS = 4;

export interface CreateUserInput {
  name?: string;
  email?: string;
  /** Plain text. Hashed before insert, so the row never holds it. */
  password?: string;
  emailVerified?: Date | null;
  onboardingCompletedAt?: Date | null;
  trialEndsAt?: Date | null;
  billingTrialConsumedAt?: Date | null;
  subscriptionStatus?: BillingSubscriptionStatus;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  stripePriceId?: string | null;
  stripeCurrentPeriodEnd?: Date | null;
  stripeCancelAtPeriodEnd?: boolean;
  stripeCancelAt?: Date | null;
  billingAccessEndedAt?: Date | null;
}

/**
 * A user with billing access, via a trial that ends in seven days.
 *
 * That default matters: OPENFRAME_ENABLE_STRIPE is true in .env.test, so
 * hasBillingAccess() is armed and a user without any of trialEndsAt /
 * stripeCurrentPeriodEnd / an active status is locked out of their own
 * workspaces. Pass `trialEndsAt` in the past (or use createExpiredUser) to test
 * that gate.
 */
export async function createUser(input: CreateUserInput = {}): Promise<User> {
  const seq = nextSeq();

  const data: Prisma.UserCreateInput = {
    name: input.name ?? `User ${seq}`,
    email: input.email ?? `user-${seq}@example.com`,
    emailVerified: input.emailVerified === undefined ? new Date() : input.emailVerified,
    onboardingCompletedAt:
      input.onboardingCompletedAt === undefined ? new Date() : input.onboardingCompletedAt,
    trialEndsAt:
      input.trialEndsAt === undefined ? new Date(Date.now() + 7 * DAY_MS) : input.trialEndsAt,
    billingTrialConsumedAt: input.billingTrialConsumedAt ?? null,
    subscriptionStatus: input.subscriptionStatus ?? BillingSubscriptionStatus.FREE,
    stripeCustomerId: input.stripeCustomerId ?? null,
    stripeSubscriptionId: input.stripeSubscriptionId ?? null,
    stripePriceId: input.stripePriceId ?? null,
    stripeCurrentPeriodEnd: input.stripeCurrentPeriodEnd ?? null,
    stripeCancelAtPeriodEnd: input.stripeCancelAtPeriodEnd ?? false,
    stripeCancelAt: input.stripeCancelAt ?? null,
    billingAccessEndedAt: input.billingAccessEndedAt ?? null,
  };

  if (input.password !== undefined) {
    data.password = await bcrypt.hash(input.password, TEST_BCRYPT_ROUNDS);
  }

  return db.user.create({ data });
}

/**
 * A user whose trial ran out 30 days ago and who has no subscription, so
 * hasBillingAccess() is false and buildBillingAccessWhereInput() excludes them.
 */
export function createExpiredUser(input: CreateUserInput = {}): Promise<User> {
  const trialEndsAt = new Date(Date.now() - 30 * DAY_MS);
  return createUser({
    ...input,
    trialEndsAt,
    billingTrialConsumedAt: input.billingTrialConsumedAt ?? trialEndsAt,
    billingAccessEndedAt: input.billingAccessEndedAt ?? trialEndsAt,
  });
}

/** A user on a paid, active subscription rather than a trial. */
export function createSubscribedUser(input: CreateUserInput = {}): Promise<User> {
  const seq = nextSeq();
  return createUser({
    ...input,
    subscriptionStatus: input.subscriptionStatus ?? BillingSubscriptionStatus.ACTIVE,
    trialEndsAt: input.trialEndsAt ?? null,
    stripeCustomerId: input.stripeCustomerId ?? `cus_test_${seq}`,
    stripeSubscriptionId: input.stripeSubscriptionId ?? `sub_test_${seq}`,
    stripePriceId: input.stripePriceId ?? process.env.STRIPE_PRICE_ID ?? 'price_test',
    stripeCurrentPeriodEnd: input.stripeCurrentPeriodEnd ?? new Date(Date.now() + 30 * DAY_MS),
  });
}
