import { NextRequest } from 'next/server';
import { rateLimit } from '@/lib/rate-limit';
import { isTrustedSameOriginRequest } from '@/lib/request-origin';
import { readVisitorContext, recordVisitorEvent } from '@/lib/analytics/visitor';

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

  const limited = await rateLimit(request, 'analytics-beacon');
  if (limited) return limited;

  if (!isTrustedSameOriginRequest(request)) return noContent;

  const body = await request.json().catch(() => null);
  const name = typeof body?.name === 'string' ? body.name : '';
  if (!ALLOWED_EVENTS.has(name)) return noContent;

  await recordVisitorEvent('CTA_CLICKED', readVisitorContext(request.cookies));

  return noContent;
}
