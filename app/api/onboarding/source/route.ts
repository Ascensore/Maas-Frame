import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { RATE_LIMIT_CONFIGS, checkRateLimit, rateLimitHeaders } from '@/lib/rate-limit';
import { setSelfReportedSource } from '@/lib/analytics/record';
import { isAcquisitionChannel } from '@/lib/analytics/cookies';
import { isProductAnalyticsEnabled } from '@/lib/feature-flags';

// "How did you hear about us?", answered on the first onboarding screen.
//
// It is stored beside the cookie-derived channel rather than instead of it. The
// cookie is precise but loses cross-device visits and cleared browsers; the
// answer survives both, and it is the only thing that can name a channel no UTM
// tag ever carries, like being told about it by a friend.
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiErrors.unauthorized();
  }

  // Keyed by account, like /api/onboarding/complete beside it. An IP key would
  // be the wrong bucket twice over: without TRUSTED_PROXY_MODE every caller
  // resolves to 127.0.0.1, so five answers an hour would be five for the whole
  // deployment, and with it a shared office address would lock out everyone
  // after one colleague answered.
  const config = RATE_LIMIT_CONFIGS['onboarding-source'];
  const limit = await checkRateLimit(session.user.id, 'onboarding-source', config);
  if (!limit.allowed) {
    return new Response(JSON.stringify({ error: 'Too many requests. Please try again later.' }), {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        ...rateLimitHeaders(limit, config.maxRequests),
      },
    });
  }

  if (!isProductAnalyticsEnabled()) {
    return apiErrors.badRequest('Analytics are disabled by this host');
  }

  const body = await request.json().catch(() => null);
  const source = body?.source;
  if (!isAcquisitionChannel(source)) {
    return apiErrors.badRequest('Unknown source');
  }

  const note = typeof body?.note === 'string' ? body.note : null;

  await setSelfReportedSource({ userId: session.user.id, selfReported: source, note });

  const response = successResponse({ recorded: true });
  return withCacheControl(response, 'private, no-store');
}
