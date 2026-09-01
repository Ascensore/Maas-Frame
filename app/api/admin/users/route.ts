import { NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { inviteUser } from '@/lib/account-invite';
import { checkRateLimit, rateLimitHeaders, RATE_LIMIT_CONFIGS } from '@/lib/rate-limit';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { logError } from '@/lib/logger';

export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return apiErrors.unauthorized();
    }
    if (!session.user.isAdmin) {
      return apiErrors.forbidden('Admin access required');
    }

    const rateLimit = await checkRateLimit(
      `admin-invite-user:${session.user.id}`,
      'admin-invite-user'
    );
    if (!rateLimit.allowed) {
      return apiErrors.rateLimited('Too many invitations. Please try again later.');
    }

    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return apiErrors.badRequest('Invalid JSON body');
    }

    const email = 'email' in body ? (body as { email: unknown }).email : undefined;
    const name = 'name' in body ? (body as { name: unknown }).name : undefined;
    if (name !== undefined && name !== null && typeof name !== 'string') {
      return apiErrors.badRequest('Name must be between 2 and 100 characters');
    }

    const result = await inviteUser({
      email: typeof email === 'string' ? email : '',
      name: typeof name === 'string' ? name : null,
      inviterName: session.user.name || session.user.email || 'An administrator',
    });

    if (!result.ok) {
      if (result.reason === 'invalid-email') {
        return apiErrors.validationError('Invalid email format');
      }
      if (result.reason === 'invalid-name') {
        return apiErrors.badRequest('Name must be between 2 and 100 characters');
      }
      if (result.reason === 'already-active') {
        return apiErrors.conflict('An account with this email already exists');
      }
      return apiErrors.internalError('Account invites are not configured');
    }

    const response = successResponse(
      {
        user: result.user,
        emailSent: result.emailSent,
        resent: result.resent,
        setupUrl: result.setupUrl,
      },
      result.resent ? 200 : 201
    );

    const headers = rateLimitHeaders(
      rateLimit,
      RATE_LIMIT_CONFIGS['admin-invite-user'].maxRequests
    );
    Object.entries(headers).forEach(([key, value]) => {
      response.headers.set(key, value);
    });

    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error inviting user:', error);
    return apiErrors.internalError('Failed to invite user');
  }
}
