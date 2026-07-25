import { headers } from 'next/headers';
import { checkRateLimit, getClientIpFromHeaders } from '@/lib/rate-limit';
import { createHash } from 'crypto';

/**
 * The invitation preview surfaces (`/invitations/accept` and `/register?invitationToken=`)
 * are reachable without a session and each render costs two database queries, so they are
 * throttled the same way the emailed verify-email link is.
 *
 * Two buckets: a generous per-IP one that bounds enumeration across many tokens, and a
 * tight per-IP+token one that stops repeated probing of a single invitation.
 *
 * Returns false when the caller should skip the lookup entirely.
 */
export async function isInvitationPreviewAllowed(token: string): Promise<boolean> {
  const ip = getClientIpFromHeaders(await headers());

  const perIp = await checkRateLimit(`invitation-preview:${ip}`, 'invitation-preview');
  if (!perIp.allowed) return false;

  // Hash the token so raw invitation secrets never reach the rate_limits table (and stay
  // within the 256-char key bound).
  const tokenHash = createHash('sha256').update(token).digest('hex').slice(0, 32);
  const perToken = await checkRateLimit(
    `invitation-preview:${ip}:${tokenHash}`,
    'invitation-preview-token'
  );

  return perToken.allowed;
}
