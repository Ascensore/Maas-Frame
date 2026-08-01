// Reading the acquisition cookies, and recording the events that happen before
// an account exists.
//
// The proxy sets the cookies but cannot write rows (it runs on the edge). These
// helpers close that gap from Node, and are the reason no visitor event depends
// on client-side JavaScript running: a landing view is recorded by the server
// rendering the landing page, so an ad blocker has nothing to block. That is not
// a purity argument. Blocking rates differ by channel, and an undercounted
// denominator would make GitHub and Hacker News traffic look like it converts
// better than it does.

import type { AnalyticsEventName } from '@prisma/client';
import {
  ANONYMOUS_ID_COOKIE,
  FIRST_TOUCH_COOKIE,
  decodeFirstTouch,
  isValidAnonymousId,
  type FirstTouch,
} from '@/lib/analytics/cookies';
import { dailyEventKey, recordEvent, recordFirstTouch } from '@/lib/analytics/record';
import { isProductAnalyticsEnabled } from '@/lib/feature-flags';

/** Both `cookies()` from next/headers and `request.cookies` satisfy this. */
export interface AnalyticsCookieReader {
  get(name: string): { value: string } | undefined;
}

export interface VisitorContext {
  anonymousId: string | null;
  firstTouch: FirstTouch | null;
}

export function readVisitorContext(store: AnalyticsCookieReader): VisitorContext {
  const rawId = store.get(ANONYMOUS_ID_COOKIE)?.value;
  return {
    anonymousId: isValidAnonymousId(rawId) ? rawId : null,
    firstTouch: decodeFirstTouch(store.get(FIRST_TOUCH_COOKIE)?.value),
  };
}

const DIRECT_TOUCH: FirstTouch = {
  channel: 'DIRECT',
  utmSource: null,
  utmMedium: null,
  utmCampaign: null,
  referrerHost: null,
  landingPath: '/',
};

/**
 * Records an event for a visitor with no account, once per visitor per UTC day.
 *
 * The first touch row is written here rather than in the proxy because this is
 * the first moment the visitor is known to be a browser that kept the cookie.
 */
export async function recordVisitorEvent(
  name: AnalyticsEventName,
  visitor: VisitorContext
): Promise<void> {
  if (!isProductAnalyticsEnabled()) return;
  if (!visitor.anonymousId) return;

  const touch = visitor.firstTouch ?? DIRECT_TOUCH;

  await recordFirstTouch(visitor.anonymousId, touch);
  await recordEvent({
    name,
    dedupeKey: dailyEventKey(name, visitor.anonymousId),
    anonymousId: visitor.anonymousId,
    channel: touch.channel,
  });
}
