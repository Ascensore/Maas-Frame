/**
 * The chosen subtitle language, remembered per video the way a player is expected to.
 *
 * Shared by both caption paths, so a viewer who turned Turkish on for a Bunny-hosted cut
 * gets Turkish again on the YouTube version of the same video.
 */

function preferenceKey(videoId: string): string {
  return `openframe:subtitle-language:${videoId}`;
}

export function readStoredSubtitleLanguage(videoId: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(preferenceKey(videoId));
  } catch {
    return null;
  }
}

export function writeStoredSubtitleLanguage(videoId: string, language: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (language) {
      window.localStorage.setItem(preferenceKey(videoId), language);
    } else {
      window.localStorage.removeItem(preferenceKey(videoId));
    }
  } catch {
    // A browser with storage disabled still gets subtitles, just not a remembered choice.
  }
}
