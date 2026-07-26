import { captureVideoThumbnail } from '@/lib/client/video-thumbnail';
import { uploadBytesWithProgress, type UploadProgressHandler } from '@/lib/client/r2-video-upload';

export type R2AssetVideoInitResponse = {
  presignedPutUrl: string;
  objectKey: string;
  proxyUrl: string;
  uploadToken: string;
  reservationId: string | null;
  contentType: string;
  thumbnailPresignedPutUrl: string;
  thumbnailObjectKey: string;
  thumbnailProxyUrl: string;
};

export type R2AssetVideoUploadResult = R2AssetVideoInitResponse & {
  thumbnailUrl: string | null;
};

// uploadBytesWithProgress used to be duplicated here, progress arithmetic included. There
// is one copy now, in r2-video-upload.ts, which is where the multipart path already lives.

export async function initR2AssetVideoUpload(
  videoId: string,
  file: File
): Promise<R2AssetVideoInitResponse> {
  const initRes = await fetch(`/api/videos/${videoId}/assets/r2-init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fileName: file.name,
      contentType: file.type,
      sizeBytes: file.size,
    }),
  });

  const initPayload = (await initRes.json().catch(() => null)) as {
    data?: R2AssetVideoInitResponse;
    error?: string;
  } | null;
  if (!initRes.ok || !initPayload?.data) {
    throw new Error(initPayload?.error || 'Failed to initialize video upload');
  }

  return initPayload.data;
}

export async function cleanupPendingR2AssetVideoUpload(
  videoId: string,
  input: {
    objectKey: string;
    uploadToken: string;
    thumbnailObjectKey?: string | null;
  },
  keepalive = false
): Promise<void> {
  try {
    await fetch(`/api/videos/${videoId}/assets/r2-init`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        objectKey: input.objectKey,
        uploadToken: input.uploadToken,
        thumbnailObjectKey: input.thumbnailObjectKey ?? undefined,
      }),
      keepalive,
    });
  } catch (error) {
    console.error('Failed to cleanup pending R2 asset video upload:', error);
  }
}

export async function uploadAssetVideoToR2(
  videoId: string,
  file: File,
  options?: { onProgress?: UploadProgressHandler }
): Promise<R2AssetVideoUploadResult> {
  const init = await initR2AssetVideoUpload(videoId, file);

  const cleanupInput = {
    objectKey: init.objectKey,
    uploadToken: init.uploadToken,
    thumbnailObjectKey: init.thumbnailObjectKey,
  };

  try {
    await uploadBytesWithProgress(
      init.presignedPutUrl,
      file,
      init.contentType,
      options?.onProgress
    );
  } catch (error) {
    await cleanupPendingR2AssetVideoUpload(videoId, cleanupInput);
    throw error;
  }

  const thumbnailBlob = await captureVideoThumbnail(file);
  let thumbnailUrl: string | null = null;
  if (thumbnailBlob) {
    try {
      await uploadBytesWithProgress(init.thumbnailPresignedPutUrl, thumbnailBlob, 'image/jpeg');
      thumbnailUrl = init.thumbnailProxyUrl;
    } catch (error) {
      console.warn('Failed to upload asset video thumbnail:', error);
    }
  }

  return { ...init, thumbnailUrl };
}
