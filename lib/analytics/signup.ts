// Signup is the seam where an anonymous visitor becomes an account, so it is the
// one place the two halves of the funnel are joined. Both ways of creating an
// account (the credentials form and an OAuth provider) go through here, because
// a channel that only shows up for one of them is worse than no channel at all.

import { eventKey, recordEvent, attachAcquisitionToUser } from '@/lib/analytics/record';
import { NO_VISITOR, readVisitorContext, type VisitorContext } from '@/lib/analytics/visitor';
import { isProductAnalyticsEnabled } from '@/lib/feature-flags';

/**
 * The visitor context of the request being handled.
 *
 * For the OAuth path there is no NextRequest to read: the account is created by
 * the adapter, from inside a NextAuth event. `cookies()` still resolves there,
 * and when it does not the signup is simply recorded without a channel rather
 * than not recorded at all.
 */
export async function readVisitorContextFromHeaders(): Promise<VisitorContext> {
  if (!isProductAnalyticsEnabled()) return NO_VISITOR;
  try {
    const { cookies, headers } = await import('next/headers');
    return await readVisitorContext(await cookies(), await headers());
  } catch {
    return NO_VISITOR;
  }
}

export async function recordSignupCompleted(params: {
  userId: string;
  visitor: VisitorContext;
}): Promise<void> {
  if (!isProductAnalyticsEnabled()) return;

  await attachAcquisitionToUser({
    userId: params.userId,
    anonymousId: params.visitor.anonymousId,
    touch: params.visitor.firstTouch,
  });

  await recordEvent({
    name: 'SIGNUP_COMPLETED',
    dedupeKey: eventKey('SIGNUP_COMPLETED', params.userId),
    userId: params.userId,
    anonymousId: params.visitor.anonymousId,
  });
}
