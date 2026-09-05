import { writeFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { renderShortFormCandidate, type RenderShortFormDeps } from '@/lib/short-form/render-job';
import { DEFAULT_SHORT_CAPTION_STYLE } from '@/lib/short-form';

type Query = { sql: string; params: unknown[] };

function harness(
  outputVideoId: string | null,
  options: { media?: 'probe-failure' | 'success'; linkRowCount?: number } = {}
) {
  const queries: Query[] = [];
  const run = vi.fn<RenderShortFormDeps['run']>(async (command, args) => {
    if (options.media !== 'success') return { stdout: '', stderr: 'probe failed', code: 1 };
    if (command === 'ffprobe') {
      return {
        stdout: JSON.stringify({
          streams: [{ width: 1920, height: 1080, r_frame_rate: '30/1' }],
        }),
        stderr: '',
        code: 0,
      };
    }
    if (args.some((value) => value.includes('print_format=json'))) {
      return {
        stdout: '',
        stderr:
          '{"input_i":"-20","input_tp":"-2","input_lra":"4","input_thresh":"-30","target_offset":"0"}',
        code: 0,
      };
    }
    await writeFile(String(args.at(-1)), Buffer.from('rendered-short'));
    return { stdout: '', stderr: '', code: 0 };
  });
  const downloadVersionMedia = vi.fn<RenderShortFormDeps['downloadVersionMedia']>(async () => {});
  const uploadObject = vi.fn<RenderShortFormDeps['uploadObject']>(async () => {});
  const query = async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    if (sql.includes('SELECT c.*')) {
      return {
        rows: [
          {
            id: 'short-1',
            status: outputVideoId ? 'FAILED' : 'APPROVED',
            output_video_id: outputVideoId,
            source_version_id: 'source-1',
            source_start_sec: 5,
            source_end_sec: 25,
            providerId: 'r2',
            videoId: 'videos/source.mp4',
            originalUrl: '/api/upload/video/source.mp4',
            project_id: 'project-1',
            folder_id: null,
            title: 'A finished short',
            social_caption: 'Publication copy',
            hashtags: ['#editing'],
            crop_mode: 'PADDED',
            crop_track: null,
            focus_x: null,
            focus_y: null,
            caption_style: DEFAULT_SHORT_CAPTION_STYLE,
          },
        ],
      };
    }
    if (sql.includes('FROM transcripts t JOIN transcript_segments')) {
      return {
        rows: [
          {
            language: 'en',
            start_sec: 5,
            end_sec: 7,
            text: 'Useful line.',
            words: [{ start: 5, end: 7, text: 'Useful line.' }],
          },
        ],
      };
    }
    if (sql.includes('FROM video_versions WHERE "videoParentId"')) {
      return { rows: [{ id: 'output-version-1' }] };
    }
    if (sql.includes('INSERT INTO transcripts')) return { rows: [{ id: 'transcript-1' }] };
    if (sql.includes('SELECT p."ownerId"')) return { rows: [{ owner_id: 'owner-1' }] };
    if (sql.includes('SET output_video_id = $2')) {
      return { rows: [], rowCount: options.linkRowCount ?? 1 };
    }
    return { rows: [], rowCount: 1 };
  };
  const deps: RenderShortFormDeps = {
    pool: {
      query,
      connect: async () => ({ query, release: () => {} }),
    } as unknown as Pool,
    run,
    downloadVersionMedia,
    uploadObject,
  };
  return { deps, queries, run, downloadVersionMedia, uploadObject };
}

describe('renderShortFormCandidate', () => {
  it('resumes post-processing an already linked output without rendering a duplicate', async () => {
    const h = harness('output-video-1');

    await renderShortFormCandidate(h.deps, 'short-1');

    expect(h.run).not.toHaveBeenCalled();
    expect(h.downloadVersionMedia).not.toHaveBeenCalled();
    expect(h.uploadObject).toHaveBeenCalledWith(
      expect.stringMatching(/^subtitles\//),
      expect.any(Buffer),
      'text/vtt'
    );
    expect(
      h.queries.find((entry) => entry.sql.includes('INSERT INTO transcripts'))?.params.slice(0, 3)
    ).toEqual(['output-version-1', 'en', 'rough-cut-short']);
    expect(h.queries.filter((entry) => entry.sql.includes('INSERT INTO media_jobs'))).toHaveLength(
      1
    );
    expect(
      h.queries.find(
        (entry) =>
          entry.sql.includes("status = 'READY'") && entry.sql.includes('short_form_candidates')
      )?.params
    ).toEqual(['short-1']);
  });

  it('marks only this candidate failed when media probing fails', async () => {
    const h = harness(null);

    await expect(renderShortFormCandidate(h.deps, 'short-1')).rejects.toThrow('probe failed');

    expect(h.downloadVersionMedia).toHaveBeenCalledTimes(1);
    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.uploadObject).not.toHaveBeenCalled();
    expect(
      h.queries.find(
        (entry) =>
          entry.sql.includes("status = 'FAILED'") && entry.sql.includes('short_form_candidates')
      )?.params
    ).toEqual(['short-1', 'probe failed']);
  });

  it('renders, uploads, and atomically links a new output before post-processing it', async () => {
    const h = harness(null, { media: 'success' });

    await renderShortFormCandidate(h.deps, 'short-1');

    expect(h.run.mock.calls.map(([command]) => command)).toEqual(['ffprobe', 'ffmpeg', 'ffmpeg']);
    expect(h.uploadObject).toHaveBeenCalledWith(
      expect.stringMatching(/^videos\/.*\.mp4$/),
      Buffer.from('rendered-short'),
      'video/mp4'
    );
    expect(h.uploadObject).toHaveBeenCalledWith(
      expect.stringMatching(/^subtitles\//),
      expect.any(Buffer),
      'text/vtt'
    );
    const videoInsert = h.queries.findIndex((entry) => entry.sql.includes('INSERT INTO videos'));
    const link = h.queries.findIndex((entry) => entry.sql.includes('SET output_video_id = $2'));
    const commit = h.queries.findIndex(
      (entry, index) => index > link && entry.sql.trim() === 'COMMIT'
    );
    expect(videoInsert).toBeGreaterThan(-1);
    expect(link).toBeGreaterThan(videoInsert);
    expect(commit).toBeGreaterThan(link);
    expect(h.queries[link]!.sql).toContain('AND output_video_id IS NULL');
    expect(
      h.queries.find(
        (entry) =>
          entry.sql.includes("status = 'READY'") && entry.sql.includes('short_form_candidates')
      )?.params[0]
    ).toBe('short-1');
    expect(h.queries.filter((entry) => entry.sql.includes('INSERT INTO media_jobs'))).toHaveLength(
      1
    );
  });

  it('rolls back the output video transaction when another render already linked it', async () => {
    const h = harness(null, { media: 'success', linkRowCount: 0 });

    await expect(renderShortFormCandidate(h.deps, 'short-1')).rejects.toThrow(
      'Short output was already linked'
    );

    const link = h.queries.findIndex((entry) => entry.sql.includes('SET output_video_id = $2'));
    const rollback = h.queries.findIndex(
      (entry, index) => index > link && entry.sql.trim() === 'ROLLBACK'
    );
    expect(link).toBeGreaterThan(-1);
    expect(rollback).toBeGreaterThan(link);
    expect(h.queries.some((entry) => entry.sql.includes('INSERT INTO transcripts'))).toBe(false);
    expect(
      h.queries.find(
        (entry) =>
          entry.sql.includes("status = 'FAILED'") && entry.sql.includes('short_form_candidates')
      )?.params
    ).toEqual(['short-1', 'Short output was already linked']);
  });
});
