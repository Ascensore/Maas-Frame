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
//
// Recording server-side also means an anonymous request can write rows, so the
// three filters that decide whether a request counts live here rather than only
// in the proxy: the signature on the cookie, the bot and prefetch checks, and a
// per-client ceiling. In the proxy they only govern which cookies get issued,
// which is not the same thing as which rows get written.

import type { AnalyticsEventName } from '@prisma/client';
import {
  ANONYMOUS_ID_COOKIE,
  FIRST_TOUCH_COOKIE,
  readAnonymousIdCookie,
  readFirstTouchCookie,
  type FirstTouch,
} from '@/lib/analytics/cookies';
import { isCountableDocumentRequest, isLikelyBot } from '@/lib/analytics/bots';
import { dailyEventKey, recordEvent, recordFirstTouch } from '@/lib/analytics/record';
import { isProductAnalyticsEnabled } from '@/lib/feature-flags';
import {
  RATE_LIMIT_CONFIGS,
  checkRateLimit,
  getClientIpFromHeaders,
  isClientIpTrustworthy,
} from '@/lib/rate-limit';

/** Both `cookies()` from next/headers and `request.cookies` satisfy this. */
export interface AnalyticsCookieReader {
  get(name: string): { value: string } | undefined;
}

export interface VisitorContext {
  anonymousId: string | null;
  firstTouch: FirstTouch | null;
  /** Carried so the ceiling below can be applied after the response, not during it. */
  clientIp: string | null;
}

export const NO_VISITOR: VisitorContext = { anonymousId: null, firstTouch: null, clientIp: null };

/**
 * The visitor behind a set of cookies, or an empty context.
 *
 * Both cookies are verified, so an id that reaches a database column is one this
 * deployment issued. A forged one is not repaired or partially trusted, it is
 * simply not a visitor.
 */
export async function readVisitorContext(
  store: AnalyticsCookieReader,
  headers?: Headers
): Promise<VisitorContext> {
  if (!isProductAnalyticsEnabled()) return NO_VISITOR;

  const anonymousId = await readAnonymousIdCookie(store.get(ANONYMOUS_ID_COOKIE)?.value);
  if (!anonymousId) return NO_VISITOR;

  return {
    anonymousId,
    firstTouch: await readFirstTouchCookie(store.get(FIRST_TOUCH_COOKIE)?.value),
    clientIp: headers ? getClientIpFromHeaders(headers) : null,
  };
}

/**
 * The visitor behind a page render.
 *
 * Applies the same two header checks the proxy does, because they mean different
 * things in the two places. In the proxy they decide who gets a cookie; here they
 * decide what counts. A returning visitor already holds a cookie, so without this
 * Next prefetching /register as a CTA scrolls into view would record a signup
 * start for a page nobody opened.
 */
export async function readPageVisitor(): Promise<VisitorContext> {
  if (!isProductAnalyticsEnabled()) return NO_VISITOR;

  const { cookies, headers } = await import('next/headers');
  const requestHeaders = await headers();
  if (!isCountableDocumentRequest(requestHeaders)) return NO_VISITOR;
  if (isLikelyBot(requestHeaders.get('user-agent'))) return NO_VISITOR;

  return readVisitorContext(await cookies(), requestHeaders);
}

/**
 * The visitor behind an API request.
 *
 * No document check: a beacon is `sec-fetch-dest: empty` by definition, and the
 * routes that call this are reached by a form submission rather than by a
 * navigation.
 */
export async function readRequestVisitor(request: {
  cookies: AnalyticsCookieReader;
  headers: Headers;
}): Promise<VisitorContext> {
  if (!isProductAnalyticsEnabled()) return NO_VISITOR;
  if (isLikelyBot(request.headers.get('user-agent'))) return NO_VISITOR;
  return readVisitorContext(request.cookies, request.headers);
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
 * A ceiling on how many visitors one client can invent per hour.
 *
 * A fresh signed cookie is one request away: drop the cookie, ask for the
 * landing page again, and the proxy mints another id. The signature stops a
 * caller from choosing an id, and this stops them from collecting an unbounded
 * number of real ones. Skipped when the client IP is not real, where the bucket
 * would be shared by everybody and would throttle the site rather than the
 * flood.
 */
async function withinVisitorCeiling(clientIp: string | null): Promise<boolean> {
  if (!clientIp || !isClientIpTrustworthy()) return true;

  const config = RATE_LIMIT_CONFIGS['analytics-visitor'];
  const result = await checkRateLimit(clientIp, 'analytics-visitor', config);
  return result.allowed;
}

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
  if (!(await withinVisitorCeiling(visitor.clientIp))) return;

  const touch = visitor.firstTouch ?? DIRECT_TOUCH;

  await recordFirstTouch(visitor.anonymousId, touch);
  await recordEvent({
    name,
    dedupeKey: dailyEventKey(name, visitor.anonymousId),
    anonymousId: visitor.anonymousId,
    channel: touch.channel,
  });
}
