import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import {
  DEFAULT_TRIAL_PERIOD_DAYS,
  getOrCreateStripeCustomerId,
  getStripeCheckoutState,
} from '@/lib/billing';
import { rateLimit } from '@/lib/rate-limit';
import { isStripeFeatureEnabled } from '@/lib/feature-flags';
import { getStripe, getStripePriceId, isStripeConfigured } from '@/lib/stripe';
import { isTrustedSameOriginRequest } from '@/lib/request-origin';
import { logError } from '@/lib/logger';

function getAppOrigin(request: NextRequest) {
  if (isTrustedSameOriginRequest(request)) {
    const origin = request.headers.get('origin');
    if (origin) {
      return new URL(origin).origin;
    }
  }

  return request.nextUrl.origin;
}

export async function POST(request: NextRequest) {
  try {
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;

    if (!isTrustedSameOriginRequest(request)) {
      return apiErrors.forbidden('Invalid request origin');
    }

    const session = await auth();
    if (!session?.user?.id) {
      return apiErrors.unauthorized();
    }

    if (!isStripeFeatureEnabled()) {
      return apiErrors.badRequest('Stripe billing is disabled by this host');
    }

    if (!isStripeConfigured()) {
      return apiErrors.internalError('Stripe billing is not configured');
    }

    const checkoutState = await getStripeCheckoutState(session.user.id);
    // Block a fresh checkout whenever the customer already has a live subscription
    // (active/trialing OR a recoverable one like past_due/unpaid/incomplete).
    // Stripe Checkout in subscription mode always creates a NEW subscription, so
    // letting a past_due user through here duplicates their subscription instead
    // of recovering it. They should manage the existing one via the billing portal.
    if (checkoutState.hasRecoverableSubscription) {
      return apiErrors.badRequest(
        'A subscription already exists for this account. Manage it from the billing portal.'
      );
    }

    const stripe = getStripe();
    const priceId = getStripePriceId();
    const customerId = await getOrCreateStripeCustomerId(session.user.id);
    const appOrigin = getAppOrigin(request);

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: `${appOrigin}/settings?billing=success`,
      cancel_url: `${appOrigin}/settings?billing=canceled`,
      metadata: {
        userId: session.user.id,
      },
      subscription_data: {
        metadata: {
          userId: session.user.id,
        },
        ...(checkoutState.isTrialEligible ? { trial_period_days: DEFAULT_TRIAL_PERIOD_DAYS } : {}),
      },
    });

    if (!checkoutSession.url) {
      throw new Error('Stripe did not return a checkout URL');
    }

    const response = successResponse({ url: checkoutSession.url });
    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error creating Stripe checkout session:', error);
    return apiErrors.internalError('Failed to start checkout');
  }
}
