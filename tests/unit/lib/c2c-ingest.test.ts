import { describe, expect, it } from 'vitest';
import {
  c2cAuthHeaders,
  c2cCreateVideoBody,
  parseC2cIngestArgs,
  parseC2cWatchState,
  shouldIngestFileName,
  shouldSkipWatchedFile,
  titleFromIngestFileName,
} from '@/lib/c2c-ingest';

describe('parseC2cIngestArgs', () => {
  const token = `of_c2c_${'ab'.repeat(16)}`;

  it('reads flags and strips a trailing slash from the URL', () => {
    expect(
      parseC2cIngestArgs([
        '--base-url',
        'https://review.example/',
        '--token',
        token,
        '--file',
        'a.mov',
      ])
    ).toEqual({
      baseUrl: 'https://review.example',
      token,
      files: ['a.mov'],
      watchDir: null,
      title: null,
    });
  });

  it('falls back to env when flags are omitted', () => {
    expect(
      parseC2cIngestArgs(['--file', 'card/A001.mxf'], {
        OPENFRAME_BASE_URL: 'http://localhost:3000',
        C2C_TOKEN: token,
      })
    ).toMatchObject({ baseUrl: 'http://localhost:3000', token, files: ['card/A001.mxf'] });
  });

  it('rejects an of_live_ token', () => {
    const result = parseC2cIngestArgs([
      '--base-url',
      'http://localhost:3000',
      '--token',
      'of_live_notacameratoken0000000000000000',
      '--file',
      'a.mov',
    ]);
    expect(result).toEqual({
      error: 'pass a camera ingest token (--token or C2C_TOKEN), starting with of_c2c_',
    });
  });

  it('rejects --title unless there is exactly one file', () => {
    expect(
      parseC2cIngestArgs([
        '--base-url',
        'http://localhost:3000',
        '--token',
        token,
        '--title',
        'Cam A',
      ])
    ).toEqual({ error: '--title is only valid with exactly one --file' });
  });

  it('rejects an unknown flag', () => {
    expect(parseC2cIngestArgs(['--help'])).toEqual({ error: 'unknown argument: --help' });
  });
});

describe('titleFromIngestFileName', () => {
  it('strips the path and extension', () => {
    expect(titleFromIngestFileName('/cards/A/A001C001_240830_R1FA.mov')).toBe(
      'A001C001_240830_R1FA'
    );
  });
});

describe('shouldIngestFileName', () => {
  it('accepts review media and skips sidecars', () => {
    expect(shouldIngestFileName('clip.mov')).toBe(true);
    expect(shouldIngestFileName('still.jpg')).toBe(true);
    expect(shouldIngestFileName('notes.xml')).toBe(false);
  });
});

describe('c2cCreateVideoBody', () => {
  it('maps the init proxy path onto the create-video videoUrl field', () => {
    expect(
      c2cCreateVideoBody({
        title: 'A001',
        proxyUrl: '/api/upload/video/abc.mov',
        objectKey: 'videos/abc.mov',
        uploadToken: 'tok',
        duration: null,
      })
    ).toEqual({
      title: 'A001',
      videoUrl: '/api/upload/video/abc.mov',
      objectKey: 'videos/abc.mov',
      uploadToken: 'tok',
      duration: null,
    });
  });
});

describe('c2cAuthHeaders', () => {
  it('sends a Bearer token', () => {
    expect(c2cAuthHeaders('of_c2c_abc')).toEqual({
      Authorization: 'Bearer of_c2c_abc',
      'Content-Type': 'application/json',
    });
  });
});

describe('watch state', () => {
  it('round-trips a record and skips an unchanged file', () => {
    const parsed = parseC2cWatchState('{"clip.mov":{"sizeBytes":12,"mtimeMs":100}}');
    expect(parsed).toEqual({ 'clip.mov': { sizeBytes: 12, mtimeMs: 100 } });
    expect(shouldSkipWatchedFile(parsed['clip.mov'], 12, 100)).toBe(true);
    expect(shouldSkipWatchedFile(parsed['clip.mov'], 13, 100)).toBe(false);
    expect(shouldSkipWatchedFile(undefined, 12, 100)).toBe(false);
  });

  it('ignores malformed state', () => {
    expect(parseC2cWatchState('not json')).toEqual({});
    expect(parseC2cWatchState('[]')).toEqual({});
  });
});
