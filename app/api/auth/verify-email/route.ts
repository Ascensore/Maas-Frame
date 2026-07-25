import { NextRequest, NextResponse } from 'next/server';
import { consumeVerificationToken } from '@/lib/email-verification';
import { rateLimit } from '@/lib/rate-limit';
import { logError } from '@/lib/logger';
import { getPublicOrigin } from '@/lib/request-origin';

// A raw 32-byte hex token is exactly 64 characters.
const TOKEN_REGEX = /^[0-9a-f]{64}$/;

export async function GET(request: NextRequest) {
  // Redirect targets must be built from the public origin, not `request.url`:
  // behind a reverse proxy the latter is the container-internal address and the
  // user lands on a dead host even though verification succeeded.
  const origin = getPublicOrigin(request);
  const redirectTo = (path: string) => NextResponse.redirect(new URL(path, origin));

  try {
    // Rate-limit by IP to prevent token enumeration attacks.
    const limited = await rateLimit(request, 'verify-email');
    if (limited) return limited;

    const token = request.nextUrl.searchParams.get('token');

    if (!token || !TOKEN_REGEX.test(token.trim())) {
      return redirectTo('/login?error=InvalidVerificationToken');
    }

    const email = await consumeVerificationToken(token.trim());

    if (!email) {
      return redirectTo('/login?error=InvalidVerificationToken');
    }

    return redirectTo('/login?verified=true');
  } catch (err) {
    logError('Email verification error:', err);
    return redirectTo('/login?error=VerificationFailed');
  }
}
