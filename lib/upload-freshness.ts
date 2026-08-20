import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { r2Client, R2_BUCKET_NAME } from '@/lib/r2';

/**
 * How long an uploaded file may sit in R2 before the row that would claim it has
 * to exist. Anything older is treated as an expired upload, so a URL cannot be
 * replayed later to attach a file the caller no longer has a right to.
 */
export const UNATTACHED_UPLOAD_TTL_MS = 15 * 60 * 1000;

export type AttachmentCheck = { isFresh: boolean; sizeBytes: bigint };

/**
 * Confirm an upload URL points at an object that was written just now, and
 * report its size so the caller can bill it against a quota.
 */
export async function isFreshAttachment(
  url: string,
  kind: 'audio' | 'image'
): Promise<AttachmentCheck> {
  const prefix = kind === 'audio' ? '/api/upload/audio/' : '/api/upload/image/';
  if (!url.startsWith(prefix)) return { isFresh: false, sizeBytes: BigInt(0) };

  const filename = url.slice(prefix.length);
  const key = kind === 'audio' ? `voice/${filename}` : `images/${filename}`;

  try {
    const head = await r2Client.send(
      new HeadObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
      })
    );
    if (!head.LastModified) return { isFresh: false, sizeBytes: BigInt(0) };
    const isFresh = Date.now() - head.LastModified.getTime() <= UNATTACHED_UPLOAD_TTL_MS;
    return { isFresh, sizeBytes: BigInt(head.ContentLength ?? 0) };
  } catch {
    return { isFresh: false, sizeBytes: BigInt(0) };
  }
}
