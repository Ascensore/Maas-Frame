import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { rateLimit } from '@/lib/rate-limit';
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

  const limited = await rateLimit(request, 'onboarding-complete');
  if (limited) return limited;

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
