'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  readStoredSubtitleLanguage,
  writeStoredSubtitleLanguage,
} from '@/components/video-page/hooks/subtitle-preference';
import type { Subtitle } from '@/components/video-page/types';
import { readClientApiError } from '@/lib/client/api-error';
import { getSubtitleExtension } from '@/lib/subtitle-validation';
import { getTranscriptUploadExtension, isTranscriptSegmentTimed } from '@/lib/transcript-import';

interface UseSubtitlesParams {
  videoId: string;
  versionId: string | null;
  videoRef: RefObject<HTMLVideoElement | null>;
  /** Only the providers we play through our own element can carry a track. */
  supportsSubtitles: boolean;
}

/**
 * The primary subtag, lowercased: `en-US` and `EN` are the same language for
 * the purpose of deciding whether a transcript answers the request.
 */
function primarySubtag(tag: string): string {
  return tag.trim().toLowerCase().split('-')[0] ?? '';
}

/**
 * What the version's transcript can offer. `ok: false` is a probe that did not
 * answer — a network failure or a broken payload — which is deliberately not
 * the same as "there is no transcript": silently spending an AI transcription
 * because a GET timed out is the bug this distinction exists to prevent.
 */
type TranscriptProbe = { ok: true; captionable: { language: string } | null } | { ok: false };

/**
 * The version's transcript, when it is finished and carries at least one timed
 * line. That is everything a caption file needs, so there is nothing left to
 * transcribe.
 */
async function probeCaptionableTranscript(versionId: string): Promise<TranscriptProbe> {
  try {
    const res = await fetch(`/api/versions/${versionId}/transcript`, { cache: 'no-store' });
    if (!res.ok) return { ok: false };
    const payload = await res.json().catch(() => null);
    if (!payload || typeof payload !== 'object' || !('data' in payload)) return { ok: false };
    const transcript = (
      payload as {
        data?: { transcript?: { status?: string; language?: string; segments?: unknown } | null };
      }
    ).data?.transcript;
    if (!transcript || transcript.status !== 'READY') return { ok: true, captionable: null };
    const segments = Array.isArray(transcript.segments) ? transcript.segments : [];
    const timed = segments.some(
      (segment) =>
        typeof segment === 'object' &&
        segment !== null &&
        isTranscriptSegmentTimed(segment as { startSec: number; endSec: number })
    );
    if (!timed) return { ok: true, captionable: null };
    return {
      ok: true,
      captionable: {
        language: typeof transcript.language === 'string' ? transcript.language : '',
      },
    };
  } catch {
    return { ok: false };
  }
}

/**
 * A wiped track is remounted at most this many times per version. A file that really is
 * empty cannot reach storage (the upload route refuses one), so the cap only exists so a
 * surprise can never turn into a fetch loop.
 */
const MAX_TRACK_REPAIRS = 3;

export function useSubtitles({
  videoId,
  versionId,
  videoRef,
  supportsSubtitles,
}: UseSubtitlesParams) {
  const [subtitles, setSubtitles] = useState<Subtitle[]>([]);
  const [canManageSubtitles, setCanManageSubtitles] = useState(false);
  const [activeLanguage, setActiveLanguage] = useState<string | null>(null);
  const [isUploadingSubtitle, setIsUploadingSubtitle] = useState(false);
  const [isGeneratingSubtitles, setIsGeneratingSubtitles] = useState(false);
  const pendingGenerateLanguageRef = useRef<string | null>(null);
  const generateInFlightRef = useRef(false);

  // Bumped to remount the <track> elements when something empties them. See the effect
  // below for what does that and why remounting is the fix.
  const [trackEpoch, setTrackEpoch] = useState(0);

  // The stored preference is applied once per version, not on every list refresh: turning
  // subtitles off and then deleting an unrelated track must not switch them back on.
  const appliedPreferenceForVersionRef = useRef<string | null>(null);
  const loadedLanguagesRef = useRef<Set<string>>(new Set());
  const repairCountRef = useRef(0);

  useEffect(() => {
    loadedLanguagesRef.current.clear();
    repairCountRef.current = 0;
    pendingGenerateLanguageRef.current = null;
    generateInFlightRef.current = false;
    setIsGeneratingSubtitles(false);
  }, [versionId]);

  const refresh = useCallback(async () => {
    if (!versionId) {
      setSubtitles([]);
      setCanManageSubtitles(false);
      return;
    }

    try {
      const res = await fetch(
        `/api/videos/${videoId}/subtitles?versionId=${encodeURIComponent(versionId)}`,
        { cache: 'no-store' }
      );
      if (!res.ok) return;
      const payload = await res.json();
      const list: Subtitle[] = Array.isArray(payload?.data?.subtitles)
        ? payload.data.subtitles
        : [];
      setSubtitles(list);
      setCanManageSubtitles(Boolean(payload?.data?.canManageSubtitles));
    } catch {
      // A failed list leaves the player without tracks, which is the same as having none.
    }
  }, [versionId, videoId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!versionId) return;
    if (appliedPreferenceForVersionRef.current === versionId) return;
    if (subtitles.length === 0) return;

    appliedPreferenceForVersionRef.current = versionId;
    const stored = readStoredSubtitleLanguage(videoId);
    if (stored && subtitles.some((subtitle) => subtitle.language === stored)) {
      setActiveLanguage(stored);
    }
  }, [subtitles, versionId, videoId]);

  // A track that is no longer in the list cannot stay selected.
  useEffect(() => {
    if (!activeLanguage) return;
    if (subtitles.some((subtitle) => subtitle.language === activeLanguage)) return;
    setActiveLanguage(null);
  }, [activeLanguage, subtitles]);

  /**
   * React renders the <track> elements; their display mode is set here rather than through
   * the `default` attribute, which the browser only honours on first load and which would
   * fight the user's choice on every re-render.
   *
   * The second job here is repair. hls.js empties every text track on the media element,
   * ours included, each time it loads a manifest (`_cleanTracks()` in its timeline
   * controller). That fires on the initial load and again on every source switch, so a
   * viewer who flips quality would watch the subtitles vanish for good: the file has
   * already been fetched, so the browser never parses it a second time. Remounting the
   * track element under a new key is what makes it fetch again.
   */
  useEffect(() => {
    if (!supportsSubtitles) return;
    const videoEl = videoRef.current;
    if (!videoEl) return;

    const findActiveTrack = (): TextTrack | null => {
      if (!activeLanguage) return null;
      const tracks = videoEl.textTracks;
      for (let index = 0; index < tracks.length; index += 1) {
        if (tracks[index].language === activeLanguage) return tracks[index];
      }
      return null;
    };

    const applyModes = () => {
      const tracks = videoEl.textTracks;
      for (let index = 0; index < tracks.length; index += 1) {
        const track = tracks[index];
        const shouldShow = Boolean(activeLanguage) && track.language === activeLanguage;
        track.mode = shouldShow ? 'showing' : 'disabled';
        if (!shouldShow) continue;

        // The control bar sits over the bottom of the frame in fullscreen, so cues are
        // lifted clear of it instead of landing underneath.
        const cues = track.cues;
        if (!cues) continue;
        for (let cueIndex = 0; cueIndex < cues.length; cueIndex += 1) {
          const cue = cues[cueIndex] as VTTCue;
          if (typeof cue.line !== 'undefined') {
            cue.snapToLines = true;
            cue.line = -3;
          }
        }
      }
    };

    const markLoaded = (event: Event) => {
      const element = event.currentTarget as HTMLTrackElement;
      loadedLanguagesRef.current.add(element.srclang);
      applyModes();
    };

    const repairIfEmptied = () => {
      if (!activeLanguage) return;
      // Before the file has loaded a track legitimately has no cues, so only a track we
      // have seen load and that is now empty counts as wiped.
      if (!loadedLanguagesRef.current.has(activeLanguage)) return;
      const track = findActiveTrack();
      if (!track || (track.cues?.length ?? 0) > 0) return;
      if (repairCountRef.current >= MAX_TRACK_REPAIRS) return;

      repairCountRef.current += 1;
      loadedLanguagesRef.current.delete(activeLanguage);
      setTrackEpoch((epoch) => epoch + 1);
    };

    applyModes();

    // A track's cues are null until the browser has fetched the file, which it only does
    // once the track is not disabled. The lift above therefore has to run again on load.
    const trackElements = Array.from(videoEl.querySelectorAll('track'));
    trackElements.forEach((element) => element.addEventListener('load', markLoaded));
    videoEl.textTracks.addEventListener('addtrack', applyModes);
    // `loadeddata` catches a source switch while paused; `timeupdate` catches everything
    // else within a quarter of a second of playback.
    videoEl.addEventListener('loadeddata', repairIfEmptied);
    videoEl.addEventListener('timeupdate', repairIfEmptied);

    return () => {
      trackElements.forEach((element) => element.removeEventListener('load', markLoaded));
      videoEl.textTracks.removeEventListener('addtrack', applyModes);
      videoEl.removeEventListener('loadeddata', repairIfEmptied);
      videoEl.removeEventListener('timeupdate', repairIfEmptied);
    };
  }, [activeLanguage, subtitles, supportsSubtitles, trackEpoch, videoRef, versionId]);

  const selectSubtitleLanguage = useCallback(
    (language: string | null) => {
      setActiveLanguage(language);
      writeStoredSubtitleLanguage(videoId, language);
      appliedPreferenceForVersionRef.current = versionId;
    },
    [versionId, videoId]
  );

  const uploadSubtitle = useCallback(
    async (file: File, language: string, label: string): Promise<string | null> => {
      if (!versionId) return 'No version selected';

      const captionExt = getSubtitleExtension(file.name);
      const transcriptExt = getTranscriptUploadExtension(file.name);
      if (!captionExt && !transcriptExt) {
        return 'Upload a .srt, .vtt, .txt, or .docx file';
      }

      setIsUploadingSubtitle(true);
      try {
        if (captionExt) {
          const formData = new FormData();
          formData.append('subtitle', file);
          formData.append('versionId', versionId);
          formData.append('language', language);
          formData.append('label', label);

          const res = await fetch(`/api/videos/${videoId}/subtitles`, {
            method: 'POST',
            body: formData,
          });
          const payload = await res.json().catch(() => null);
          if (!res.ok) {
            return readClientApiError(payload, 'Failed to upload subtitle');
          }
        } else {
          const form = new FormData();
          form.append('transcript', file);
          form.append('language', language);
          const res = await fetch(`/api/versions/${versionId}/transcript/upload`, {
            method: 'POST',
            body: form,
          });
          const payload = await res.json().catch(() => null);
          if (!res.ok) {
            return readClientApiError(payload, 'Failed to upload transcript');
          }
        }

        await refresh();
        if (captionExt) {
          selectSubtitleLanguage(language.toLowerCase());
        }
        return null;
      } catch {
        return captionExt ? 'Failed to upload subtitle' : 'Failed to upload transcript';
      } finally {
        setIsUploadingSubtitle(false);
      }
    },
    [refresh, selectSubtitleLanguage, versionId, videoId]
  );

  const generateSubtitles = useCallback(
    async (language: string): Promise<string | null> => {
      if (!versionId) return 'No version selected';
      if (generateInFlightRef.current || isGeneratingSubtitles) {
        return 'Subtitle generation is already running';
      }

      generateInFlightRef.current = true;
      try {
        // "Generate AI" on a version that already has a transcript used to run
        // the transcription again, which cost the AI budget to arrive back at
        // words we already had. Build the track from the transcript instead —
        // but only when it is in the language being asked for, since a Turkish
        // transcript is no basis for the English track the operator picked.
        const probe = await probeCaptionableTranscript(versionId);
        if (!probe.ok) {
          generateInFlightRef.current = false;
          return 'Could not check this version for an existing transcript';
        }
        const existing = probe.captionable;
        if (existing && primarySubtag(existing.language) === primarySubtag(language)) {
          const captionRes = await fetch(`/api/versions/${versionId}/transcript/captions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ language: existing.language }),
          });
          const captionPayload = await captionRes.json().catch(() => null);
          generateInFlightRef.current = false;
          if (!captionRes.ok) {
            return readClientApiError(
              captionPayload,
              'Failed to build captions from the transcript'
            );
          }
          const built = (captionPayload as { data?: { subtitle?: { language?: unknown } } } | null)
            ?.data?.subtitle?.language;
          const selected = (typeof built === 'string' && built) || existing.language || language;
          await refresh();
          selectSubtitleLanguage(selected.toLowerCase());
          return null;
        }

        const res = await fetch(`/api/versions/${versionId}/transcript`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ language }),
        });
        const payload = await res.json().catch(() => null);
        if (!res.ok) {
          generateInFlightRef.current = false;
          return readClientApiError(payload, 'Failed to start AI subtitles');
        }
        pendingGenerateLanguageRef.current = language.toLowerCase();
        setIsGeneratingSubtitles(true);
        return null;
      } catch {
        generateInFlightRef.current = false;
        return 'Failed to start AI subtitles';
      }
    },
    [isGeneratingSubtitles, refresh, selectSubtitleLanguage, versionId]
  );

  useEffect(() => {
    if (!isGeneratingSubtitles || !versionId) return;

    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(`/api/versions/${versionId}/transcript`, { cache: 'no-store' });
        const payload = await res.json().catch(() => null);
        if (cancelled) return;
        const status = payload?.data?.transcript?.status as string | undefined;
        if (status === 'READY') {
          const language = pendingGenerateLanguageRef.current;
          pendingGenerateLanguageRef.current = null;
          generateInFlightRef.current = false;
          setIsGeneratingSubtitles(false);
          await refresh();
          if (language) selectSubtitleLanguage(language);
          return;
        }
        if (status === 'FAILED') {
          pendingGenerateLanguageRef.current = null;
          generateInFlightRef.current = false;
          setIsGeneratingSubtitles(false);
        }
      } catch {
        // The next interval retries; a single failed poll is not the job failing.
      }
    };

    void poll();
    const timer = window.setInterval(() => {
      void poll();
    }, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [isGeneratingSubtitles, refresh, selectSubtitleLanguage, versionId]);

  const deleteSubtitle = useCallback(
    async (subtitleId: string): Promise<string | null> => {
      try {
        const res = await fetch(`/api/videos/${videoId}/subtitles/${subtitleId}`, {
          method: 'DELETE',
        });
        if (!res.ok) {
          const payload = await res.json().catch(() => null);
          return payload?.error?.message || payload?.error || 'Failed to delete subtitle';
        }
        await refresh();
        return null;
      } catch {
        return 'Failed to delete subtitle';
      }
    },
    [refresh, videoId]
  );

  return useMemo(
    () => ({
      subtitles,
      canManageSubtitles,
      activeSubtitleLanguage: activeLanguage,
      subtitleTrackKey: String(trackEpoch),
      selectSubtitleLanguage,
      uploadSubtitle,
      deleteSubtitle,
      generateSubtitles,
      isUploadingSubtitle,
      isGeneratingSubtitles,
      refreshSubtitles: refresh,
    }),
    [
      activeLanguage,
      canManageSubtitles,
      deleteSubtitle,
      generateSubtitles,
      isGeneratingSubtitles,
      isUploadingSubtitle,
      refresh,
      selectSubtitleLanguage,
      subtitles,
      trackEpoch,
      uploadSubtitle,
    ]
  );
}
