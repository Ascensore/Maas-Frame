import type { VideoProvider, VideoMetadata, EmbedOptions, ThumbnailSize } from './types';

const FILE_ID_PATTERN = /^[a-zA-Z0-9_-]{20,80}$/;

function isDriveHost(hostname: string): boolean {
  return hostname === 'drive.google.com' || hostname === 'docs.google.com';
}

export function extractGoogleDriveFileId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }

  if (!isDriveHost(parsed.hostname)) {
    return null;
  }

  if (parsed.pathname.includes('/folders/')) {
    return null;
  }

  const fromPath = parsed.pathname.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (fromPath?.[1] && FILE_ID_PATTERN.test(fromPath[1])) {
    return fromPath[1];
  }

  const fromQuery = parsed.searchParams.get('id');
  if (fromQuery && FILE_ID_PATTERN.test(fromQuery)) {
    return fromQuery;
  }

  return null;
}

export const gdriveProvider: VideoProvider = {
  id: 'gdrive',
  name: 'Google Drive',
  icon: 'HardDrive',

  canHandle(url: string): boolean {
    return extractGoogleDriveFileId(url) !== null;
  },

  extractVideoId(url: string): string | null {
    return extractGoogleDriveFileId(url);
  },

  getEmbedUrl(videoId: string, options: EmbedOptions = {}): string {
    void options;
    return `https://drive.google.com/file/d/${videoId}/preview`;
  },

  getThumbnailUrl(videoId: string, size: ThumbnailSize = 'medium'): string {
    const width = size === 'small' ? 320 : size === 'large' || size === 'maxres' ? 1280 : 640;
    return `https://drive.google.com/thumbnail?id=${videoId}&sz=w${width}`;
  },

  async getMetadata(videoId: string): Promise<VideoMetadata> {
    return {
      title: 'Google Drive file',
      thumbnailUrl: this.getThumbnailUrl(videoId, 'medium'),
    };
  },
};
