import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';
import { apiErrors, successResponse, withCacheControl } from '@/lib/api-response';
import { isAuthError, loadVersionForUser, withApiAuth } from '@/lib/v1-auth';
import { parseTimecode, reduceFrameRate, startTimecodeToSeconds } from '@/lib/timecode';
import { logError } from '@/lib/logger';

type RouteParams = { params: Promise<{ versionId: string }> };

const NLE_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

function parseNle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const nle = value.trim().toLowerCase();
  return NLE_PATTERN.test(nle) ? nle : null;
}

function offsetSecondsFor(row: {
  startTimecode: string;
  frameRateNum: number;
  frameRateDen: number;
  dropFrame: boolean;
}): number | null {
  return startTimecodeToSeconds(row.startTimecode, {
    num: row.frameRateNum,
    den: row.frameRateDen,
    dropFrame: row.dropFrame,
  });
}

function shape(row: {
  nle: string;
  sequenceName: string;
  startTimecode: string;
  frameRateNum: number;
  frameRateDen: number;
  dropFrame: boolean;
  updatedAt: Date;
}) {
  return {
    nle: row.nle,
    sequenceName: row.sequenceName,
    startTimecode: row.startTimecode,
    frameRateNum: row.frameRateNum,
    frameRateDen: row.frameRateDen,
    dropFrame: row.dropFrame,
    offsetSeconds: offsetSecondsFor(row),
    updatedAt: row.updatedAt,
  };
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'api-v1');
    if (limited) return limited;

    const authContext = await withApiAuth(request);
    if (isAuthError(authContext)) return authContext;

    const { versionId } = await params;
    const loaded = await loadVersionForUser(versionId, authContext.userId);
    if ('error' in loaded) return loaded.error;

    const nle = parseNle(new URL(request.url).searchParams.get('nle'));
    if (!nle) return apiErrors.badRequest('nle is required');

    const row = await db.sequenceLink.findUnique({
      where: {
        userId_versionId_nle: { userId: authContext.userId, versionId, nle },
      },
    });

    return withCacheControl(
      successResponse({ sequenceLink: row ? shape(row) : null }),
      'private, no-store'
    );
  } catch (error) {
    logError('Error fetching sequence link:', error);
    return apiErrors.internalError('Failed to fetch sequence link');
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const limited = await rateLimit(request, 'api-v1');
    if (limited) return limited;

    const authContext = await withApiAuth(request);
    if (isAuthError(authContext)) return authContext;

    const { versionId } = await params;
    const loaded = await loadVersionForUser(versionId, authContext.userId);
    if ('error' in loaded) return loaded.error;

    const body = await request.json().catch(() => null);
    const nle = parseNle(body?.nle);
    const sequenceName = typeof body?.sequenceName === 'string' ? body.sequenceName.trim() : '';
    const startTimecode = typeof body?.startTimecode === 'string' ? body.startTimecode.trim() : '';
    const frameRateNum = Number(body?.frameRateNum);
    const frameRateDen = Number(body?.frameRateDen);
    const dropFrame = Boolean(body?.dropFrame);

    if (!nle) return apiErrors.badRequest('nle is required');
    if (!sequenceName || sequenceName.length > 200) {
      return apiErrors.badRequest('sequenceName is required and must be at most 200 characters');
    }
    if (!parseTimecode(startTimecode)) {
      return apiErrors.badRequest('startTimecode must be SMPTE timecode');
    }
    if (!Number.isInteger(frameRateNum) || !Number.isInteger(frameRateDen)) {
      return apiErrors.badRequest('frameRateNum and frameRateDen must be positive integers');
    }
    let reduced;
    try {
      reduced = reduceFrameRate(frameRateNum, frameRateDen);
    } catch {
      return apiErrors.badRequest('frameRateNum and frameRateDen must be positive integers');
    }

    const row = await db.sequenceLink.upsert({
      where: {
        userId_versionId_nle: { userId: authContext.userId, versionId, nle },
      },
      create: {
        userId: authContext.userId,
        versionId,
        nle,
        sequenceName,
        startTimecode,
        frameRateNum: reduced.num,
        frameRateDen: reduced.den,
        dropFrame,
      },
      update: {
        sequenceName,
        startTimecode,
        frameRateNum: reduced.num,
        frameRateDen: reduced.den,
        dropFrame,
      },
    });

    return withCacheControl(successResponse({ sequenceLink: shape(row) }), 'private, no-store');
  } catch (error) {
    logError('Error saving sequence link:', error);
    return apiErrors.internalError('Failed to save sequence link');
  }
}
