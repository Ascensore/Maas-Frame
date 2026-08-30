import { NextRequest } from 'next/server';
import { apiErrors } from '@/lib/api-response';
import { rateLimit } from '@/lib/rate-limit';
import { isS3VideoUploadsEnabled } from '@/lib/feature-flags';
import { loadC2cCaller } from '@/lib/c2c-token';
import { startR2ReviewUpload } from '@/lib/r2-review-upload';
import { logError } from '@/lib/logger';

export async function POST(request: NextRequest) {
  try {
    const limited = await rateLimit(request, 'mutate');
    if (limited) return limited;

    const caller = await loadC2cCaller(request);
    if (!caller) return apiErrors.unauthorized();

    if (!isS3VideoUploadsEnabled()) {
      return apiErrors.badRequest('S3 video uploads are disabled by this host');
    }

    const body = await request.json().catch(() => null);
    const fileName = typeof body?.fileName === 'string' ? body.fileName.trim() : '';
    const contentTypeInput = typeof body?.contentType === 'string' ? body.contentType.trim() : '';
    const sizeBytesRaw = body?.sizeBytes;

    if (!fileName) {
      return apiErrors.badRequest('fileName is required');
    }

    let sizeBytes: bigint;
    try {
      sizeBytes = BigInt(sizeBytesRaw);
      if (sizeBytes <= BigInt(0)) {
        return apiErrors.badRequest('sizeBytes must be a positive integer');
      }
    } catch {
      return apiErrors.badRequest('sizeBytes must be a positive integer');
    }

    return startR2ReviewUpload({
      userId: caller.createdById,
      projectId: caller.projectId,
      billedUserId: caller.billedUserId,
      fileName,
      contentTypeInput,
      sizeBytes,
    });
  } catch (error) {
    logError('Error initializing C2C R2 upload:', error);
    return apiErrors.internalError('Failed to initialize upload');
  }
}
