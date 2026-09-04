import { cueToTimedSegment, MAX_TRANSCRIPT_SEGMENTS } from '@/lib/transcript-import';
import type { TranscriptImportSegment } from '@/lib/transcript-import';

/**
 * Public Android InnerTube key shipped in the YouTube Android client.
 * Caption `baseUrl`s from this client are signed and not PoToken-gated;
 * the WEB watch-page URLs currently return HTTP 200 with an empty body.
 */
const ANDROID_INNERTUBE_API_KEY = 'AIzaSyA8eiZmM1FaDVzG9iA6a3KkGta6yW4nOTA';
const ANDROID_CLIENT_VERSION = '20.10.38';
const ANDROID_USER_AGENT = `com.google.android.youtube/${ANDROID_CLIENT_VERSION} (Linux; U; Android 11) gzip`;

export const YOUTUBE_TRANSCRIPT_PROVIDER = 'youtube';

export const YOUTUBE_VIDEO_ID = /^[\w-]{11}$/;

export type YoutubeCaptionTrack = {
  baseUrl?: string;
  languageCode?: string;
  kind?: string;
};

export type YoutubeJson3Event = {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: Array<{ utf8?: string; tOffsetMs?: number }>;
};

export type YoutubeTranscriptResult =
  | { ok: true; language: string; segments: TranscriptImportSegment[] }
  | { ok: false; error: string };

export function isYoutubeVideoId(value: string): boolean {
  return YOUTUBE_VIDEO_ID.test(value);
}

export function pickYoutubeCaptionTrack(
  tracks: YoutubeCaptionTrack[],
  language: string
): YoutubeCaptionTrack | null {
  if (tracks.length === 0) return null;
  const wanted = language.trim().toLowerCase();
  const matching = wanted
    ? tracks.filter((track) => {
        const code = track.languageCode?.toLowerCase() ?? '';
        return code === wanted || code.startsWith(`${wanted}-`);
      })
    : [];
  const pool = matching.length > 0 ? matching : tracks;
  return pool.find((track) => track.kind !== 'asr') ?? pool[0] ?? null;
}

export function parseYoutubeJson3Events(events: YoutubeJson3Event[]): TranscriptImportSegment[] {
  const segments: TranscriptImportSegment[] = [];

  for (const event of events) {
    if (typeof event.tStartMs !== 'number') continue;
    const words: Array<{ start: number; end: number; text: string }> = [];
    for (const seg of event.segs ?? []) {
      const text = (seg.utf8 ?? '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const start =
        (event.tStartMs + (typeof seg.tOffsetMs === 'number' ? seg.tOffsetMs : 0)) / 1000;
      words.push({ start, end: start, text });
    }
    if (words.length === 0) continue;

    const start = event.tStartMs / 1000;
    const durationMs = typeof event.dDurationMs === 'number' ? event.dDurationMs : 0;
    const end =
      durationMs > 0 ? (event.tStartMs + durationMs) / 1000 : words[words.length - 1].start + 0.4;
    if (!(end > start)) continue;

    const slice = (end - start) / words.length;
    const timedWords = words.map((word, index) => ({
      text: word.text,
      start: start + index * slice,
      end: index === words.length - 1 ? end : start + (index + 1) * slice,
    }));

    const segment = cueToTimedSegment({
      start,
      end,
      text: timedWords.map((word) => word.text).join(' '),
    });
    if (!segment) continue;
    segment.words = timedWords;
    segments.push(segment);
    if (segments.length >= MAX_TRANSCRIPT_SEGMENTS) break;
  }

  return segments;
}

function captionUrlForJson3(baseUrl: string): string {
  if (/[?&]fmt=/.test(baseUrl)) {
    return baseUrl.replace(/([?&]fmt=)[^&]*/i, '$1json3');
  }
  return `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}fmt=json3`;
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`YouTube returned ${response.status}`);
  }
  const text = await response.text();
  if (!text.trim()) {
    throw new Error('YouTube returned an empty caption response');
  }
  return JSON.parse(text) as unknown;
}

export async function fetchYoutubeTranscript(
  videoId: string,
  language = 'en'
): Promise<YoutubeTranscriptResult> {
  if (!isYoutubeVideoId(videoId)) {
    return { ok: false, error: 'This YouTube version has no usable video id' };
  }

  try {
    const player = (await fetchJson(
      `https://www.youtube.com/youtubei/v1/player?prettyPrint=false&key=${ANDROID_INNERTUBE_API_KEY}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': ANDROID_USER_AGENT,
        },
        body: JSON.stringify({
          context: {
            client: {
              clientName: 'ANDROID',
              clientVersion: ANDROID_CLIENT_VERSION,
              androidSdkVersion: 30,
              hl: language || 'en',
              gl: 'US',
            },
          },
          videoId,
          contentCheckOk: true,
          racyCheckOk: true,
        }),
      }
    )) as {
      playabilityStatus?: { status?: string };
      captions?: {
        playerCaptionsTracklistRenderer?: { captionTracks?: YoutubeCaptionTrack[] };
      };
    };

    if (player.playabilityStatus?.status && player.playabilityStatus.status !== 'OK') {
      return { ok: false, error: 'This YouTube video cannot be transcribed' };
    }

    const tracks = player.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    const track = pickYoutubeCaptionTrack(tracks, language);
    if (!track?.baseUrl) {
      return {
        ok: false,
        error: 'This YouTube video has no captions to import',
      };
    }

    const captionBody = (await fetchJson(captionUrlForJson3(track.baseUrl), {
      headers: { 'user-agent': ANDROID_USER_AGENT },
    })) as { events?: YoutubeJson3Event[] };

    const segments = parseYoutubeJson3Events(captionBody.events ?? []);
    if (segments.length === 0) {
      return { ok: false, error: 'This YouTube video has no captions to import' };
    }

    return {
      ok: true,
      language: track.languageCode?.toLowerCase() || language || 'en',
      segments,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'YouTube transcript request failed';
    return { ok: false, error: message };
  }
}
