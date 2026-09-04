import { describe, expect, it } from 'vitest';
import { isAudioFileName, mediaTypeFromFileName } from '@/lib/transcription/media-type';
import {
  canRunInlineTranscription,
  isTooLargeForInlineTranscription,
  r2ObjectKeyFromVersion,
  sourceFileExtension,
} from '@/lib/transcription/source';

describe('r2ObjectKeyFromVersion', () => {
  it('uses a videos/ object key stored on videoId', () => {
    expect(
      r2ObjectKeyFromVersion({
        providerId: 'r2',
        videoId: 'videos/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.mp4',
        originalUrl: 'https://example.com/unused',
      })
    ).toBe('videos/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.mp4');
  });

  it('uses a videos/ object key stored on originalUrl', () => {
    expect(
      r2ObjectKeyFromVersion({
        providerId: 'r2',
        videoId: 'not-an-object-key',
        originalUrl: 'videos/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.mp4',
      })
    ).toBe('videos/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.mp4');
  });

  it('derives the key from the app upload proxy path', () => {
    expect(
      r2ObjectKeyFromVersion({
        providerId: 'r2',
        videoId: 'not-an-object-key',
        originalUrl: '/api/upload/video/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.mp4',
      })
    ).toBe('videos/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.mp4');
  });

  it('derives the key from an absolute upload URL', () => {
    expect(
      r2ObjectKeyFromVersion({
        providerId: 'r2',
        videoId: 'not-an-object-key',
        originalUrl:
          'https://maas-frame.vercel.app/api/upload/video/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.mp4',
      })
    ).toBe('videos/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.mp4');
  });

  it('returns null for YouTube and Bunny versions', () => {
    expect(
      r2ObjectKeyFromVersion({
        providerId: 'youtube',
        videoId: 'dQw4w9wgGcQ',
        originalUrl: 'https://www.youtube.com/watch?v=dQw4w9wgGcQ',
      })
    ).toBeNull();
    expect(
      r2ObjectKeyFromVersion({
        providerId: 'bunny',
        videoId: 'guid-from-bunny',
        originalUrl: 'https://video.bunnycdn.com/guid-from-bunny',
      })
    ).toBeNull();
  });
});

describe('isTooLargeForInlineTranscription', () => {
  it('allows a 24 MiB file and rejects one byte over', () => {
    expect(isTooLargeForInlineTranscription(BigInt(25165824))).toBe(false);
    expect(isTooLargeForInlineTranscription(BigInt(25165825))).toBe(true);
  });
});

describe('mediaTypeFromFileName', () => {
  it('maps each accepted container extension to a concrete type', () => {
    expect(mediaTypeFromFileName('clip.mp4')).toBe('video/mp4');
    expect(mediaTypeFromFileName('clip.m4v')).toBe('video/mp4');
    expect(mediaTypeFromFileName('clip.webm')).toBe('video/webm');
    expect(mediaTypeFromFileName('mix.mp3')).toBe('audio/mpeg');
    expect(mediaTypeFromFileName('mix.WAV')).toBe('audio/wav');
    expect(mediaTypeFromFileName('mix.m4a')).toBe('audio/mp4');
    expect(mediaTypeFromFileName('mix.ogg')).toBe('audio/ogg');
    expect(mediaTypeFromFileName('mix.oga')).toBe('audio/ogg');
    expect(mediaTypeFromFileName('mix.flac')).toBe('audio/flac');
    expect(mediaTypeFromFileName('mix.aac')).toBe('audio/aac');
    expect(mediaTypeFromFileName('note.txt')).toBe('application/octet-stream');
  });
});

describe('isAudioFileName', () => {
  it('accepts audio extensions and rejects video or unknown names', () => {
    expect(isAudioFileName('mix.wav')).toBe(true);
    expect(isAudioFileName('mix.MP3')).toBe(true);
    expect(isAudioFileName('mix.m4a')).toBe(true);
    expect(isAudioFileName('mix.ogg')).toBe(true);
    expect(isAudioFileName('mix.flac')).toBe(true);
    expect(isAudioFileName('clip.mp4')).toBe(false);
    expect(isAudioFileName('clip.webm')).toBe(false);
    expect(isAudioFileName('clip.m4v')).toBe(false);
    expect(isAudioFileName('note.txt')).toBe(false);
  });
});

describe('canRunInlineTranscription', () => {
  it('allows small audio and rejects video, images, and oversized audio', () => {
    expect(canRunInlineTranscription('AUDIO')).toBe(true);
    expect(canRunInlineTranscription('AUDIO', BigInt(25165824))).toBe(true);
    expect(canRunInlineTranscription('AUDIO', BigInt(25165825))).toBe(false);
    expect(canRunInlineTranscription('VIDEO')).toBe(false);
    expect(canRunInlineTranscription('VIDEO', BigInt(1024))).toBe(false);
    expect(canRunInlineTranscription('IMAGE')).toBe(false);
  });
});

describe('sourceFileExtension', () => {
  it('keeps a dotted extension and defaults a nameless file to mp4', () => {
    expect(sourceFileExtension('cut.mp4')).toBe('.mp4');
    expect(sourceFileExtension('noext')).toBe('.mp4');
  });
});
