import { SAFE_IMAGE_PROXY_PATH } from '@/lib/image-upload-validation';

/**
 * How many images a single comment (or reply) may carry. Pasting a batch of
 * screenshots is the normal case, so the cap is there to bound the upload
 * burst and the row width, not to make the feature scarce.
 */
export const MAX_COMMENT_IMAGES = 5;

export type CommentImageUrlsResult = { urls: string[] } | { error: string };

/**
 * Normalize whatever a client sent for a comment's images into an ordered,
 * de-duplicated list of upload URLs.
 *
 * Accepts the legacy single `imageUrl` alongside the `imageUrls` list so an
 * older client keeps working. Returns a message rather than throwing, because
 * every caller turns it straight into a 400.
 */
export function parseCommentImageUrls(input: {
  imageUrl?: unknown;
  imageUrls?: unknown;
}): CommentImageUrlsResult {
  const { imageUrl, imageUrls } = input;

  let raw: unknown[];
  if (imageUrls !== undefined && imageUrls !== null) {
    if (!Array.isArray(imageUrls)) {
      return { error: 'imageUrls must be an array of uploaded image URLs' };
    }
    raw = imageUrls;
  } else if (imageUrl !== undefined && imageUrl !== null) {
    raw = [imageUrl];
  } else {
    raw = [];
  }

  const urls: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string' || !SAFE_IMAGE_PROXY_PATH.test(value)) {
      return { error: 'Image URL must reference an uploaded image file' };
    }
    // The same file twice would trip the unique index on comment_images and
    // charge the account twice for one object, so collapse it here instead.
    if (!urls.includes(value)) urls.push(value);
  }

  if (urls.length > MAX_COMMENT_IMAGES) {
    return { error: `A comment can have at most ${MAX_COMMENT_IMAGES} images` };
  }

  return { urls };
}
