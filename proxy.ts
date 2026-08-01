import { NextRequest, NextResponse } from 'next/server';
import { buildContentSecurityPolicy } from '@/lib/content-security-policy';
import {
  classifyChannel,
  extractReferrerHost,
  sanitizeLandingPath,
  sanitizeTag,
} from '@/lib/analytics/channel';
import {
  ANONYMOUS_ID_COOKIE,
  ANONYMOUS_ID_MAX_AGE_SECONDS,
  FIRST_TOUCH_COOKIE,
  encodeFirstTouch,
  generateAnonymousId,
  isValidAnonymousId,
} from '@/lib/analytics/cookies';
import { isCountableDocumentRequest, isLikelyBot } from '@/lib/analytics/bots';
import { isProductAnalyticsEnabled } from '@/lib/feature-flags';

// Runs on the edge, so nothing here touches the database. It only decides who a
// visitor is and what brought them, then hands both downstream as cookies. The
// rows are written by the pages, which run in Node.
function applyAcquisitionCookies(request: NextRequest, response: NextResponse): void {
  if (!isProductAnalyticsEnabled()) return;
  if (!isCountableDocumentRequest(request.headers)) return;
  if (isLikelyBot(request.headers.get('user-agent'))) return;

  const cookieOptions = {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: request.nextUrl.protocol === 'https:',
    path: '/',
    maxAge: ANONYMOUS_ID_MAX_AGE_SECONDS,
  };

  const existingId = request.cookies.get(ANONYMOUS_ID_COOKIE)?.value;
  if (!isValidAnonymousId(existingId)) {
    const anonymousId = generateAnonymousId();
    // Set on the request as well as the response: without this the page rendering
    // *this* request cannot see the id, and the first landing view of every new
    // visitor, the one carrying the campaign tags, goes unrecorded.
    request.cookies.set(ANONYMOUS_ID_COOKIE, anonymousId);
    response.cookies.set(ANONYMOUS_ID_COOKIE, anonymousId, cookieOptions);
  }

  if (request.cookies.get(FIRST_TOUCH_COOKIE)) return;

  const params = request.nextUrl.searchParams;
  const referrerHost = extractReferrerHost(
    request.headers.get('referer'),
    request.nextUrl.hostname
  );
  const utmSource = sanitizeTag(params.get('utm_source'));
  const utmMedium = sanitizeTag(params.get('utm_medium'));

  const firstTouch = encodeFirstTouch({
    channel: classifyChannel({ utmSource, utmMedium, referrerHost }),
    utmSource,
    utmMedium,
    utmCampaign: sanitizeTag(params.get('utm_campaign')),
    referrerHost,
    landingPath: sanitizeLandingPath(request.nextUrl.pathname),
  });

  request.cookies.set(FIRST_TOUCH_COOKIE, firstTouch);
  response.cookies.set(FIRST_TOUCH_COOKIE, firstTouch, cookieOptions);
}

export function proxy(request: NextRequest) {
  const response = NextResponse.next({ request });
  response.headers.set('Content-Security-Policy', buildContentSecurityPolicy());
  applyAcquisitionCookies(request, response);
  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     */
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
