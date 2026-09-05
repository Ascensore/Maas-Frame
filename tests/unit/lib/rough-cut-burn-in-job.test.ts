import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
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

/** The statements a transaction assertion cares about, in the order they ran. */
function label(sql: string): string | null {
  const trimmed = sql.trim();
  if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(trimmed)) return trimmed;
  if (trimmed.includes('FOR UPDATE')) return 'lock video';
  if (trimmed.includes('COALESCE(MAX("versionNumber")')) return 'max version';
  if (trimmed.includes('UPDATE video_versions')) return 'deactivate';
  if (trimmed.includes('INSERT INTO video_versions')) return 'insert version';
  if (trimmed.includes('INSERT INTO transcripts')) return 'upsert transcript';
  if (trimmed.includes('DELETE FROM transcript_segments')) return 'delete segments';
  if (trimmed.includes('INSERT INTO transcript_segments')) return 'insert segments';
  return null;
}

function harness(
  options: {
    /** `[]` stands for a version nobody ever transcribed. */
    transcripts?: Array<{ id: string; language: string }>;
    ffmpeg?: { code: number; stderr?: string };
    /** What ffprobe lists; the default is a normal video with sound. */
    streams?: Array<Record<string, unknown>>;
    /** How ffprobe itself behaves, for the runs where it does not work. */
    probe?: { code?: number; stdout?: string; stderr?: string };
    /** The `sourceUrl` the caption-track row holds. */
    trackUrl?: string;
    /** The file `readText` hands back for a caption-track source. */
    trackVtt?: string;
    /** The transcript_segments rows; the default is one timed line. */
    segments?: Array<Record<string, unknown>>;
    /** `[]` stands for a video deleted between the enqueue and the render. */
    videos?: Array<{ id: string }>;
    /** Makes the carried-forward transcript fail without failing the render. */
    failTranscriptInsert?: boolean;
  } = {}
) {
  const queries: Query[] = [];
  const runs: Ran[] = [];
  const downloads: string[] = [];
  const uploads: Upload[] = [];
  const written: Written[] = [];
  const removed: string[] = [];
  const deleted: string[] = [];
  const media: Array<{ providerId: string; videoId: string; originalUrl: string }> = [];

  const query = async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    if (sql.includes('INSERT INTO transcripts')) {
      if (options.failTranscriptInsert) throw new Error('transcripts unique violation');
      return { rows: [{ id: 't-2' }] };
    }
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
      return { rows: [{ sourceUrl: options.trackUrl ?? SUBTITLE_URL, language: 'en' }] };
    }
    if (sql.includes('FROM transcripts')) {
      return { rows: options.transcripts ?? [{ id: 't-1', language: 'en' }] };
    }
    if (sql.includes('SELECT start_sec')) {
      return { rows: options.segments ?? transcriptSegmentRows() };
    }
    if (sql.includes('SELECT id FROM videos')) return { rows: options.videos ?? [{ id: 'vid-1' }] };
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
          stdout:
            options.probe?.stdout ??
            JSON.stringify({
              streams: options.streams ?? [
                { codec_type: 'video', width: 1280, height: 720 },
                { codec_type: 'audio', channels: 2 },
              ],
            }),
          stderr: options.probe?.stderr ?? '',
          code: options.probe?.code ?? 0,
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
    deleteObject: async (key) => {
      deleted.push(key);
    },
    readOutput: async () => Buffer.from(OUTPUT_BYTES),
    readText: async () => options.trackVtt ?? TRACK_VTT,
    writeText: async (path, text) => {
      written.push({ path, text });
    },
    removeDir: async (path) => {
      removed.push(path);
    },
  };

  const find = (needle: string) => queries.find((entry) => entry.sql.includes(needle));
  const all = (needle: string) => queries.filter((entry) => entry.sql.includes(needle));
  const flow = () => queries.map((entry) => label(entry.sql)).filter((entry) => entry !== null);

  return {
    deps,
    queries,
    runs,
    downloads,
    uploads,
    written,
    removed,
    deleted,
    media,
    find,
    all,
    flow,
  };
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

    // The transcript the payload named, read from this version and no other.
    const transcriptQuery = h.find('FROM transcripts WHERE');
    expect(transcriptQuery?.params).toEqual(['t-1', 'ver-1']);
    expect(transcriptQuery?.sql).toContain('version_id = $2');
    expect(transcriptQuery?.sql).toContain("status = 'READY'");

    // The version flip and the transcript rows each land in one transaction.
    expect(h.flow()).toEqual([
      'BEGIN',
      'lock video',
      'max version',
      'deactivate',
      'insert version',
      'COMMIT',
      'BEGIN',
      'upsert transcript',
      'delete segments',
      'insert segments',
      'COMMIT',
    ]);

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

    // The working directory goes, and it is the one the job actually used.
    expect(h.removed).toHaveLength(1);
    expect(h.written[0]!.path.startsWith(`${h.removed[0]}/`)).toBe(true);
  });

  it('re-times the copied transcript when the playback rate is not 1', async () => {
    const h = harness();

    await burnInSubtitles(
      h.deps,
      'ver-1',
      payloadOf({ maxWordsPerCue: 2, playbackRate: 2 }, { kind: 'transcript', transcriptId: 't-1' })
    );

    const args = h.runs[1]!.args;
    expect(args[args.indexOf('-filter_complex') + 1]).toMatch(
      /^\[0:v:0\]setpts=PTS\/2,ass='.+\.ass'\[v\];\[0:a:0\]atempo=2\[a\]$/
    );
    expect(args.slice(args.indexOf('-map'))).toContain('[a]');
    // The cues are half as late as the words they came from.
    expect(h.written[0]!.text.split('\n').filter((line) => line.startsWith('Dialogue:'))).toEqual([
      'Dialogue: 0,0:00:00.00,0:00:00.75,Default,,0,0,0,,one two',
      'Dialogue: 0,0:00:01.00,0:00:01.60,Default,,0,0,0,,three',
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
    // Every row is read before a byte of media is: a version with nothing to
    // burn fails in a second rather than after pulling a camera master down.
    expect(empty.media).toEqual([]);
    const fallback = empty.find('FROM transcripts WHERE');
    expect(fallback?.params).toEqual(['ver-1']);
    expect(fallback?.sql).toContain('version_id = $1');
    expect(fallback?.sql).toContain("status = 'READY'");
    expect(fallback?.sql).toContain('ORDER BY created_at ASC');

    // A stored URL that is not one our upload API wrote names no object we
    // could fetch, and is refused instead of being turned into a key.
    const bogus = harness({ trackUrl: '/api/upload/subtitle/../../secrets.vtt' });
    await expect(
      burnInSubtitles(bogus.deps, 'ver-1', payloadOf({}, { kind: 'subtitle', subtitleId: 's-1' }))
    ).rejects.toThrow(/does not point at a subtitle file/);
    expect(bogus.downloads).toEqual([]);
  });

  it('fails the job when ffmpeg fails and creates nothing', async () => {
    const h = harness({ ffmpeg: { code: 1, stderr: 'boom' } });

    await expect(
      burnInSubtitles(h.deps, 'ver-1', payloadOf({}, { kind: 'transcript', transcriptId: 't-1' }))
    ).rejects.toThrow(/boom/);

    expect(h.all('INSERT INTO video_versions')).toHaveLength(0);
    expect(h.uploads).toEqual([]);
    expect(h.all('INSERT INTO media_jobs')).toHaveLength(0);
    // A failed render still takes its working directory with it.
    expect(h.removed).toHaveLength(1);
  });

  it('re-times a silent source without naming an audio stream', async () => {
    const h = harness({ streams: [{ codec_type: 'video', width: 1280, height: 720 }] });

    await burnInSubtitles(
      h.deps,
      'ver-1',
      payloadOf({ playbackRate: 2 }, { kind: 'transcript', transcriptId: 't-1' })
    );

    // Every stream is listed, so the job knows there is no audio to re-time.
    expect(h.runs[0]!.args).toContain('-show_streams');
    expect(h.runs[0]!.args).not.toContain('-select_streams');
    const args = h.runs[1]!.args;
    expect(args[args.indexOf('-filter_complex') + 1]).toMatch(
      /^\[0:v:0\]setpts=PTS\/2,ass='.+\.ass'\[v\]$/
    );
    expect(args).not.toContain('[a]');
    expect(args.join(' ')).not.toContain('atempo');
    // The render still happened, so the version is there.
    expect(h.all('INSERT INTO video_versions')).toHaveLength(1);
  });
  it('refuses a transcript with no timings instead of rendering an empty burn', async () => {
    // What a .txt or .docx upload leaves behind: READY, one row per paragraph,
    // every one of them 0-0 with no word timings. Burned as-is, every cue would
    // start and end at the same instant, libass would draw nothing, and the job
    // would report a successful render of an unchanged picture.
    const h = harness({
      segments: [
        { start_sec: 0, end_sec: 0, speaker: null, text: 'A paragraph from a script.', words: [] },
        { start_sec: 0, end_sec: 0, speaker: null, text: 'And the one after it.', words: [] },
      ],
    });

    await expect(
      burnInSubtitles(h.deps, 'ver-1', payloadOf({}, { kind: 'transcript', transcriptId: 't-1' }))
    ).rejects.toThrow(/no timings to burn in/);

    expect(h.media).toEqual([]);
    expect(h.runs).toEqual([]);
    expect(h.uploads).toEqual([]);
    expect(h.all('INSERT INTO video_versions')).toHaveLength(0);
    expect(h.all('INSERT INTO media_jobs')).toHaveLength(0);
  });

  it('takes WebVTT markup and entities out of a track before drawing it', async () => {
    // parseSubtitleCues keeps this markup on purpose — its output is written
    // for a browser VTT parser — but libass draws every character it is given.
    const h = harness({
      trackVtt:
        'WEBVTT\n\n00:00:00.000 --> 00:00:03.000\n<v Alice><i>Whispering</i> now &amp; then\n',
    });

    await burnInSubtitles(
      h.deps,
      'ver-1',
      payloadOf({ maxWordsPerCue: 6 }, { kind: 'subtitle', subtitleId: 's-1' })
    );

    expect(h.written[0]!.text.split('\n').filter((line) => line.startsWith('Dialogue:'))).toEqual([
      'Dialogue: 0,0:00:00.00,0:00:03.00,Default,,0,0,0,,Whispering now & then',
    ]);
    expect(h.find('INSERT INTO transcripts')?.params[3]).toBe('Whispering now & then');
  });

  it('carries a track forward as the operator wrote it, not as it was burned in', async () => {
    const h = harness();

    await burnInSubtitles(
      h.deps,
      'ver-1',
      payloadOf({ maxWordsPerCue: 1, uppercase: true }, { kind: 'subtitle', subtitleId: 's-1' })
    );

    // One word to a caption, shouted, because that is what was asked for.
    expect(h.written[0]!.text.split('\n').filter((line) => line.startsWith('Dialogue:'))).toEqual([
      'Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,HELLO',
      'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,THERE',
      'Dialogue: 0,0:00:04.00,0:00:05.00,Default,,0,0,0,,GOODBYE',
      'Dialogue: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,NOW',
    ]);
    // The transcript on the new version is the track's own lines, in their own
    // case: it is read and searched, not drawn.
    expect(h.find('INSERT INTO transcripts')?.params[3]).toBe('hello there goodbye now');
    const [, starts, ends, , texts] = h.find('INSERT INTO transcript_segments')?.params as [
      string,
      number[],
      number[],
      Array<string | null>,
      string[],
    ];
    expect(starts).toEqual([0, 4]);
    expect(ends).toEqual([2, 6]);
    expect(texts).toEqual(['hello there', 'goodbye now']);
  });

  it('measures a rotated clip the way ffmpeg will present it', async () => {
    // A phone records landscape and tags the quarter turn instead of
    // transposing. ffmpeg's autorotate runs before the ass filter, so the frame
    // libass draws on is 1080x1920 whatever the stream says it stores.
    const h = harness({
      streams: [
        {
          codec_type: 'video',
          width: 1920,
          height: 1080,
          side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }],
        },
        { codec_type: 'audio', channels: 2 },
      ],
    });

    await burnInSubtitles(
      h.deps,
      'ver-1',
      payloadOf({}, { kind: 'transcript', transcriptId: 't-1' })
    );

    expect(h.written[0]!.text).toContain('PlayResX: 1080');
    expect(h.written[0]!.text).toContain('PlayResY: 1920');
  });

  it('sizes the captions to the picture rather than to cover art', async () => {
    const h = harness({
      streams: [
        { codec_type: 'video', width: 600, height: 600, disposition: { attached_pic: 1 } },
        { codec_type: 'video', width: 1920, height: 1080, disposition: { attached_pic: 0 } },
        { codec_type: 'audio', channels: 2 },
      ],
    });

    await burnInSubtitles(
      h.deps,
      'ver-1',
      payloadOf({}, { kind: 'transcript', transcriptId: 't-1' })
    );

    expect(h.written[0]!.text).toContain('PlayResX: 1920');
    expect(h.written[0]!.text).toContain('PlayResY: 1080');
  });

  it('fails the job when ffprobe does instead of guessing a frame size', async () => {
    const broken = harness({ probe: { code: 1, stderr: 'moov atom not found' } });
    await expect(
      burnInSubtitles(
        broken.deps,
        'ver-1',
        payloadOf({}, { kind: 'transcript', transcriptId: 't-1' })
      )
    ).rejects.toThrow(/moov atom not found/);
    expect(broken.runs.map((entry) => entry.command)).toEqual(['ffprobe']);
    expect(broken.uploads).toEqual([]);
    expect(broken.all('INSERT INTO video_versions')).toHaveLength(0);

    const garbled = harness({ probe: { stdout: 'ffprobe version 7.1' } });
    await expect(
      burnInSubtitles(
        garbled.deps,
        'ver-1',
        payloadOf({}, { kind: 'transcript', transcriptId: 't-1' })
      )
    ).rejects.toThrow(/could not read/);
    expect(garbled.uploads).toEqual([]);
  });

  it('takes the uploaded file back when the video it belongs to is gone', async () => {
    // The upload happens before the row that names it, so a video deleted
    // between the enqueue and the render leaves an object nothing points at —
    // and pg-boss retries the whole encode into a fresh key.
    const h = harness({ videos: [] });

    await expect(
      burnInSubtitles(h.deps, 'ver-1', payloadOf({}, { kind: 'transcript', transcriptId: 't-1' }))
    ).rejects.toThrow(/video this version belongs to is gone/);

    const uploaded = h.uploads.find((upload) => upload.key.startsWith('videos/'));
    expect(uploaded).toBeDefined();
    expect(h.deleted).toEqual([uploaded!.key]);
    expect(h.all('INSERT INTO video_versions')).toHaveLength(0);
    expect(h.all('INSERT INTO media_jobs')).toHaveLength(0);
  });

  it('keeps the render when the carried-forward transcript cannot be written', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness({ failTranscriptInsert: true });

    try {
      await burnInSubtitles(
        h.deps,
        'ver-1',
        payloadOf({}, { kind: 'transcript', transcriptId: 't-1' })
      );

      const versionInsert = h.find('INSERT INTO video_versions');
      expect(versionInsert).toBeDefined();
      expect(h.find('INSERT INTO media_jobs')?.params).toEqual([versionInsert!.params[0]]);
      // The version owns the file now, so nothing is taken back.
      expect(h.deleted).toEqual([]);
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
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
