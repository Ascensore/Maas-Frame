import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import {
  burnInSubtitles,
  parseBurnInPayload,
  type BurnInDeps,
  type BurnInPayload,
  type BurnInSource,
} from '@/lib/rough-cut/burn-in-job';
import { parseBurnInStyle } from '@/lib/rough-cut/subtitle-style';

/**
 * The burn-in job against a fake pool and a fake ffmpeg. What matters here is
 * the cues it hands libass, that the render lands as another version of the
 * same video, and that the transcript and captions travel with it — re-timed
 * when the operator changed the playback rate — so the burned copy is still
 * searchable and reviewable without transcribing it again.
 */

type Query = { sql: string; params: unknown[] };
type Upload = { key: string; contentType: string; body: string };
type Ran = { command: string; args: string[] };
type Written = { path: string; text: string };

const OUTPUT_BYTES = 'mp4';
const SUBTITLE_URL = '/api/upload/subtitle/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.vtt';

/** What `readText` hands back for the caption-track source. */
const TRACK_VTT = [
  'WEBVTT',
  '',
  '00:00:00.000 --> 00:00:02.000',
  'hello there',
  '',
  '00:00:04.000 --> 00:00:06.000',
  'goodbye now',
  '',
].join('\n');

/** One line, three words a second apart and half a second long. */
function transcriptSegmentRows() {
  return [
    {
      start_sec: 0,
      end_sec: 3,
      speaker: null,
      text: 'one two three',
      words: [
        { start: 0, end: 0.5, text: 'one' },
        { start: 1, end: 1.5, text: 'two' },
        { start: 2, end: 2.5, text: 'three' },
      ],
    },
  ];
}

function styleOf(overrides: Record<string, unknown>) {
  const parsed = parseBurnInStyle(overrides);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

function payloadOf(overrides: Record<string, unknown>, source: BurnInSource): BurnInPayload {
  return { style: styleOf(overrides), source };
}

function harness(
  options: {
    /** `[]` stands for a version nobody ever transcribed. */
    transcripts?: Array<{ id: string; language: string }>;
    ffmpeg?: { code: number; stderr?: string };
  } = {}
) {
  const queries: Query[] = [];
  const runs: Ran[] = [];
  const downloads: string[] = [];
  const uploads: Upload[] = [];
  const written: Written[] = [];
  const media: Array<{ providerId: string; videoId: string; originalUrl: string }> = [];

  const query = async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    if (sql.includes('INSERT INTO transcripts')) return { rows: [{ id: 't-2' }] };
    // Ordered before the version lookup: the caption track's owner query joins
    // through video_versions as well.
    if (sql.includes('SELECT p."ownerId"')) return { rows: [{ owner_id: 'owner' }] };
    if (sql.includes('FROM video_versions vv')) {
      return {
        rows: [
          {
            id: 'ver-1',
            providerId: 'r2',
            videoId: 'videos/in.mp4',
            originalUrl: '/api/upload/video/in.mp4',
            videoParentId: 'vid-1',
            duration: 10,
            title: 'Talk',
          },
        ],
      };
    }
    if (sql.includes('SELECT "sourceUrl"')) {
      return { rows: [{ sourceUrl: SUBTITLE_URL, language: 'en' }] };
    }
    if (sql.includes('FROM transcripts')) {
      return { rows: options.transcripts ?? [{ id: 't-1', language: 'en' }] };
    }
    if (sql.includes('SELECT start_sec')) return { rows: transcriptSegmentRows() };
    if (sql.includes('SELECT id FROM videos')) return { rows: [{ id: 'vid-1' }] };
    if (sql.includes('COALESCE(MAX("versionNumber")')) return { rows: [{ max: 1 }] };
    return { rows: [] };
  };

  const deps: BurnInDeps = {
    // The version flip and the transcript write each run on a connected client.
    // It shares this `query`, so BEGIN/COMMIT land in `queries` in order.
    pool: {
      query,
      connect: async () => ({ query, release: () => {} }),
    } as unknown as Pool,
    run: async (command, args) => {
      runs.push({ command, args });
      if (command === 'ffprobe') {
        return {
          stdout: JSON.stringify({ streams: [{ codec_type: 'video', width: 1280, height: 720 }] }),
          stderr: '',
          code: 0,
        };
      }
      return { stdout: '', stderr: options.ffmpeg?.stderr ?? '', code: options.ffmpeg?.code ?? 0 };
    },
    downloadObject: async (key) => {
      downloads.push(key);
    },
    uploadObject: async (key, body, contentType) => {
      uploads.push({ key, contentType, body: body.toString('utf8') });
    },
    downloadVersionMedia: async (version) => {
      media.push(version);
    },
    readOutput: async () => Buffer.from(OUTPUT_BYTES),
    readText: async () => TRACK_VTT,
    writeText: async (path, text) => {
      written.push({ path, text });
    },
  };

  const find = (needle: string) => queries.find((entry) => entry.sql.includes(needle));
  const all = (needle: string) => queries.filter((entry) => entry.sql.includes(needle));

  return { deps, queries, runs, downloads, uploads, written, media, find, all };
}

describe('burnInSubtitles', () => {
  it('burns the transcript into a new version and carries transcript and captions forward', async () => {
    const h = harness();

    await burnInSubtitles(
      h.deps,
      'ver-1',
      payloadOf({ maxWordsPerCue: 2 }, { kind: 'transcript', transcriptId: 't-1' })
    );

    // The master is fetched once, measured, then encoded.
    expect(h.media).toEqual([
      { providerId: 'r2', videoId: 'videos/in.mp4', originalUrl: '/api/upload/video/in.mp4' },
    ]);
    expect(h.runs.map((entry) => entry.command)).toEqual(['ffprobe', 'ffmpeg']);
    const args = h.runs[1]!.args;
    expect(args[args.indexOf('-vf') + 1]).toMatch(/^ass='.+\.ass'$/);

    // Two words to a cue, at the size ffprobe reported rather than a guess.
    const ass = h.written[0]!.text;
    expect(ass).toContain('PlayResX: 1280');
    expect(ass).toContain('PlayResY: 720');
    const dialogue = ass.split('\n').filter((line) => line.startsWith('Dialogue:'));
    expect(dialogue).toEqual([
      'Dialogue: 0,0:00:00.00,0:00:01.50,Default,,0,0,0,,one two',
      'Dialogue: 0,0:00:02.00,0:00:02.60,Default,,0,0,0,,three',
    ]);

    const video = h.uploads.filter((upload) => upload.key.startsWith('videos/'));
    expect(video).toHaveLength(1);
    expect(video[0]!.contentType).toBe('video/mp4');

    // Another version of the same video, not a second video.
    expect(h.all('INSERT INTO videos')).toHaveLength(0);
    expect(h.find('UPDATE video_versions')?.params).toEqual(['vid-1']);
    const versionInsert = h.find('INSERT INTO video_versions');
    const newVersionId = String(versionInsert?.params[0]);
    expect(versionInsert?.params[1]).toBe(2);
    expect(versionInsert?.params[2]).toBe('Subtitled');
    expect(versionInsert?.params[3]).toBe(video[0]!.key);
    expect(versionInsert?.params[5]).toBe('Talk');
    expect(versionInsert?.params[7]).toBe('vid-1');
    expect(versionInsert?.params[8]).toBe(10);

    // The transcript rides along, so the burned copy is searchable without
    // being sent to a transcription provider again.
    expect(h.find('INSERT INTO transcripts')?.params).toEqual([
      newVersionId,
      'en',
      'burn-in',
      'one two three',
    ]);
    const segmentInserts = h.all('INSERT INTO transcript_segments');
    expect(segmentInserts).toHaveLength(1);
    const [transcriptId, starts, ends, , texts, words] = segmentInserts[0]!.params as [
      string,
      number[],
      number[],
      Array<string | null>,
      string[],
      string[],
      number[],
    ];
    expect(transcriptId).toBe('t-2');
    expect(starts).toEqual([0]);
    expect(ends).toEqual([3]);
    expect(texts).toEqual(['one two three']);
    expect(words.map((entry) => JSON.parse(entry))).toEqual([
      [
        { start: 0, end: 0.5, text: 'one' },
        { start: 1, end: 1.5, text: 'two' },
        { start: 2, end: 2.5, text: 'three' },
      ],
    ]);

    const subtitles = h.uploads.filter((upload) => upload.key.startsWith('subtitles/'));
    expect(subtitles).toHaveLength(1);
    expect(subtitles[0]!.contentType).toBe('text/vtt');
    expect(h.find('INSERT INTO video_subtitles')?.params.slice(0, 3)).toEqual([
      newVersionId,
      'en',
      'Transcript (en)',
    ]);

    const probe = h.find('INSERT INTO media_jobs');
    expect(probe?.sql).toContain('PROBE_MEDIA');
    expect(probe?.params).toEqual([newVersionId]);
  });

  it('re-times the copied transcript when the playback rate is not 1', async () => {
    const h = harness();

    await burnInSubtitles(
      h.deps,
      'ver-1',
      payloadOf({ maxWordsPerCue: 2, playbackRate: 2 }, { kind: 'transcript', transcriptId: 't-1' })
    );

    const args = h.runs[1]!.args;
    expect(args[args.indexOf('-filter_complex') + 1]).toContain('setpts=PTS/2');
    // The cues are half as late as the words they came from.
    expect(h.written[0]!.text.split('\n').filter((line) => line.startsWith('Dialogue:'))).toEqual([
      'Dialogue: 0,0:00:00.00,0:00:00.75,Default,,0,0,0,,one two',
      'Dialogue: 0,0:00:01.00,0:00:01.30,Default,,0,0,0,,three',
    ]);

    const versionInsert = h.find('INSERT INTO video_versions');
    expect(versionInsert?.params[2]).toBe('Subtitled 2x');
    expect(versionInsert?.params[8]).toBe(5);

    const [, starts, ends, , , words] = h.find('INSERT INTO transcript_segments')?.params as [
      string,
      number[],
      number[],
      Array<string | null>,
      string[],
      string[],
      number[],
    ];
    expect(starts).toEqual([0]);
    expect(ends).toEqual([1.5]);
    expect(words.map((entry) => JSON.parse(entry))).toEqual([
      [
        { start: 0, end: 0.25, text: 'one' },
        { start: 0.5, end: 0.75, text: 'two' },
        { start: 1, end: 1.25, text: 'three' },
      ],
    ]);
  });

  it('uses a caption track when asked and fails clearly with no source', async () => {
    const h = harness();

    await burnInSubtitles(
      h.deps,
      'ver-1',
      payloadOf({ maxWordsPerCue: 4 }, { kind: 'subtitle', subtitleId: 's-1' })
    );

    expect(h.find('SELECT "sourceUrl"')?.params).toEqual(['s-1', 'ver-1']);
    expect(h.downloads).toEqual(['subtitles/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.vtt']);
    // The track's own cues, spread word by word and regrouped: the second cue
    // starts four seconds in, where the file says it does.
    expect(h.written[0]!.text.split('\n').filter((line) => line.startsWith('Dialogue:'))).toEqual([
      'Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,hello there',
      'Dialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,goodbye now',
    ]);
    // Copied onto the new version as its transcript, in the track's language.
    expect(h.find('INSERT INTO transcripts')?.params.slice(1, 4)).toEqual([
      'en',
      'burn-in',
      'hello there goodbye now',
    ]);

    const empty = harness({ transcripts: [] });
    await expect(
      burnInSubtitles(
        empty.deps,
        'ver-1',
        payloadOf({}, { kind: 'transcript', transcriptId: null })
      )
    ).rejects.toThrow(/no transcript or caption track/);
    expect(empty.runs).toEqual([]);
    expect(empty.all('INSERT INTO video_versions')).toHaveLength(0);
  });

  it('fails the job when ffmpeg fails and creates nothing', async () => {
    const h = harness({ ffmpeg: { code: 1, stderr: 'boom' } });

    await expect(
      burnInSubtitles(h.deps, 'ver-1', payloadOf({}, { kind: 'transcript', transcriptId: 't-1' }))
    ).rejects.toThrow(/boom/);

    expect(h.all('INSERT INTO video_versions')).toHaveLength(0);
    expect(h.uploads).toEqual([]);
    expect(h.all('INSERT INTO media_jobs')).toHaveLength(0);
  });
});

describe('parseBurnInPayload', () => {
  it('accepts the two sources and refuses anything else', () => {
    expect(
      parseBurnInPayload({
        style: { maxWordsPerCue: 3 },
        source: { kind: 'subtitle', subtitleId: 's-1' },
      })
    ).toMatchObject({
      style: { maxWordsPerCue: 3, font: 'dejavu-sans' },
      source: { kind: 'subtitle', subtitleId: 's-1' },
    });
    // A transcript source without an id means "whichever one this version has".
    expect(parseBurnInPayload({ style: {}, source: { kind: 'transcript' } })?.source).toEqual({
      kind: 'transcript',
      transcriptId: null,
    });

    expect(parseBurnInPayload(null)).toBeNull();
    expect(parseBurnInPayload({ style: {} })).toBeNull();
    expect(parseBurnInPayload({ style: {}, source: { kind: 'guess' } })).toBeNull();
    expect(parseBurnInPayload({ style: {}, source: { kind: 'subtitle' } })).toBeNull();
    // Out of the style schema's range, so it never reaches ffmpeg.
    expect(
      parseBurnInPayload({ style: { playbackRate: 9 }, source: { kind: 'transcript' } })
    ).toBeNull();
  });
});
