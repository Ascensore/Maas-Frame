import { NextRequest } from 'next/server';
import { completeSetPassword } from '@/lib/account-invite';
import {
  checkRateLimit,
  getClientIp,
  rateLimitHeaders,
  RATE_LIMIT_CONFIGS,
} from '@/lib/rate-limit';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { logError } from '@/lib/logger';

export async function POST(request: NextRequest) {
  try {
    const clientIp = getClientIp(request);
    const rateLimit = await checkRateLimit(`set-password:${clientIp}`, 'set-password');
    if (!rateLimit.allowed) {
      return apiErrors.rateLimited('Too many attempts. Please try again later.');
    }

    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return apiErrors.badRequest('Invalid JSON body');
    }

    const token = 'token' in body ? (body as { token: unknown }).token : undefined;
    const password = 'password' in body ? (body as { password: unknown }).password : undefined;
    const name = 'name' in body ? (body as { name: unknown }).name : undefined;

    if (typeof token !== 'string' || !token.trim()) {
      return apiErrors.badRequest('A set-password token is required');
    }
    if (typeof password !== 'string') {
      return apiErrors.badRequest('Password must be between 8 and 128 characters');
    }
    if (name !== undefined && name !== null && typeof name !== 'string') {
      return apiErrors.badRequest('Name must be between 2 and 100 characters');
    }

    const result = await completeSetPassword({
      token: token.trim(),
      password,
      name: typeof name === 'string' ? name : null,
    });

    if (!result.ok) {
      if (result.reason === 'invalid-password') {
        return apiErrors.badRequest('Password must be between 8 and 128 characters');
      }
      if (result.reason === 'invalid-name') {
        return apiErrors.badRequest('Name must be between 2 and 100 characters');
      }
      if (result.reason === 'already-active') {
        return apiErrors.conflict('This account already has a password. Sign in instead.');
      }
      return apiErrors.badRequest('This invite link is invalid or has expired.');
    }

    const response = successResponse({
      message: 'Password set. You can sign in now.',
      email: result.email,
    });

    const headers = rateLimitHeaders(rateLimit, RATE_LIMIT_CONFIGS['set-password'].maxRequests);
    Object.entries(headers).forEach(([key, value]) => {
      response.headers.set(key, value);
    });

    return withCacheControl(response, 'private, no-store');
  } catch (error) {
    logError('Error setting password:', error);
    return apiErrors.internalError('Failed to set password');
  }
}
