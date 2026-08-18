import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { isAdminApiTokenRequest } from '@/lib/admin-api-token';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { conversionRates, getScoreboard } from '@/lib/analytics/scoreboard';
import { isProductAnalyticsEnabled } from '@/lib/feature-flags';
import { logError } from '@/lib/logger';

// The same numbers /admin/growth renders, as JSON, so the Monday digest can pull
// the scoreboard instead of somebody retyping it into a table.
export async function GET(request: NextRequest) {
  try {
    // A bearer token stands in for the admin session so the weekly digest can
    // read this without a browser. Unset by default, in which case the only way
    // in is still an admin session.
    if (!isAdminApiTokenRequest(request)) {
      const session = await auth();
      if (!session?.user?.id) {
        return apiErrors.unauthorized();
      }
      if (!session.user.isAdmin) {
        return apiErrors.forbidden('Admin access required');
      }
    }

    if (!isProductAnalyticsEnabled()) {
      return apiErrors.badRequest('Analytics are disabled by this host');
    }

    const weeksParam = Number(request.nextUrl.searchParams.get('weeks'));
    const scoreboard = await getScoreboard({
      weeks: Number.isSafeInteger(weeksParam) && weeksParam > 0 ? weeksParam : undefined,
    });

    const response = successResponse({
      ...scoreboard,
      weeks: scoreboard.weeks.map((week) => ({ ...week, rates: conversionRates(week) })),
    });
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error building the growth scoreboard:', error);
    return apiErrors.internalError('Failed to build the scoreboard');
  }
}
