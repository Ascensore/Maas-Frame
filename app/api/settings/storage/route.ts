import { auth } from '@/lib/auth';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { getStorageContextForUser, getUserStorageInfo } from '@/lib/storage-quota';
import { hasBillingAccess } from '@/lib/billing';
import { db } from '@/lib/db';

// GET /api/settings/storage
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return apiErrors.unauthorized();
  }

  // Only users with active billing (or on a self-hosted instance where billing
  // is disabled) should be able to enumerate their storage breakdown.
  const user = await db.user.findUnique({
    where: { id: session.user.id },
    select: {
      subscriptionStatus: true,
      trialEndsAt: true,
      stripeCurrentPeriodEnd: true,
      billingAccessEndedAt: true,
    },
  });

  if (!user || !hasBillingAccess(user)) {
    return apiErrors.forbidden();
  }

  const [info, storage] = await Promise.all([
    getUserStorageInfo(session.user.id),
    getStorageContextForUser(session.user.id),
  ]);

  const response = successResponse({
    usedBytes: info.usedBytes.toString(),
    limitBytes: info.limitBytes.toString(),
    percentage: info.percentage,
    // Which ceiling this is, so the card can name it and say what to do about it.
    // A trial has 3 GB because it has not subscribed; deleting files is the wrong
    // advice there, and "200 GB limit" was the wrong caption.
    isPaid: storage.isPaid,
  });

  // Cache for 60s — stale data is acceptable for a usage meter
  return withCacheControl(response, 'private, max-age=60');
}
