import { NextRequest } from 'next/server';
import { rateLimit } from '@/lib/rate-limit';
import { isTrustedSameOriginRequest } from '@/lib/request-origin';
import { readRequestVisitor, recordVisitorEvent } from '@/lib/analytics/visitor';
import { isProductAnalyticsEnabled } from '@/lib/feature-flags';

// The one funnel event that cannot be observed from the server: a click on a
// call to action, which never reaches us as a request of its own.
//
// Everything else in the funnel is recorded where it actually happens, so this
// endpoint accepts exactly one event name. An anonymous caller must not be able
// to post `SUBSCRIPTION_STARTED` into the scoreboard, and the cheapest way to
// guarantee that is to make the allowed set a single literal.
const ALLOWED_EVENTS = new Set(['cta_clicked']);

export async function POST(request: NextRequest) {
  // Answers 204 whatever happens. This endpoint reports nothing back to the page
  // that called it, so there is no reason to tell a caller which of their
  // attempts landed.
  const noContent = new Response(null, {
    status: 204,
    headers: { 'Cache-Control': 'private, no-store' },
  });

  // Both cheap and both free of side effects, so they come before the limiter.
  // Checking the flag here rather than only inside the recorder keeps a host who
  // never turned analytics on from paying a rate-limit write for every anonymous
  // POST to an endpoint they are not using.
  if (!isProductAnalyticsEnabled()) return noContent;
  if (!isTrustedSameOriginRequest(request)) return noContent;

  // 204 rather than the limiter's 429: a beacon has nobody to tell, and a
  // flooder should not be handed a signal for when the window resets.
  const limited = await rateLimit(request, 'analytics-beacon');
  if (limited) return noContent;

  const body = await request.json().catch(() => null);
  const name = typeof body?.name === 'string' ? body.name : '';
  if (!ALLOWED_EVENTS.has(name)) return noContent;

  await recordVisitorEvent('CTA_CLICKED', await readRequestVisitor(request));

  return noContent;
}
