import {
  buildVersionFileName,
  sanitizeDownloadFileName,
  uniqueDownloadFileName,
} from '../export-file-names';

export type ClipForExportName = {
  versionId: string;
  videoId: string;
  title: string;
  position: number;
  versionNumber: number;
  versionLabel: string | null;
  originalUrl: string;
};

/**
 * File names the NLE will look for on disk. These MUST match the names
 * `buildProjectDownloadManifest` writes for the same clips, or every clip
 * imports offline.
 */
export function assignClipExportFileNames(clips: ClipForExportName[]): Map<string, string> {
  const sorted = [...clips].sort(
    (a, b) => a.position - b.position || a.videoId.localeCompare(b.videoId)
  );
  const usedNames = new Set<string>();
  const names = new Map<string, string>();
  sorted.forEach((clip, index) => {
    const videoIndex = index + 1;
    const videoTitle = sanitizeDownloadFileName(clip.title) || `video-${videoIndex}`;
    const baseName = buildVersionFileName(videoIndex, videoTitle, {
      versionNumber: clip.versionNumber,
      versionLabel: clip.versionLabel,
      originalUrl: clip.originalUrl,
    });
    names.set(clip.versionId, uniqueDownloadFileName(baseName, usedNames));
  });
  return names;
}

export function normalizeMediaPathPrefix(prefix: string): string {
  const trimmed = prefix.trim() || './media/';
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

export function buildRoughCutTargetUrl(prefix: string, fileName: string): string {
  return `${normalizeMediaPathPrefix(prefix)}${fileName}`;
}
