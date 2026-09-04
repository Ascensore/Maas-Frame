import { describe, expect, it } from 'vitest';
import {
  canAutoTranscribe,
  hasKnownReviewMagicBytes,
  reviewKindFromFileName,
  reviewKindFromUploadPath,
  reviewPlayerMode,
  resolveReviewUpload,
  shouldEnqueueProbe,
  shouldEnqueueTranscribe,
} from '@/lib/review-kind';

describe('reviewKindFromFileName', () => {
  it('classifies a still by its extension', () => {
    expect(reviewKindFromFileName('hero.jpg')).toBe('IMAGE');
    expect(reviewKindFromFileName('hero.jpeg')).toBe('IMAGE');
    expect(reviewKindFromFileName('hero.png')).toBe('IMAGE');
    expect(reviewKindFromFileName('hero.webp')).toBe('IMAGE');
    expect(reviewKindFromFileName('hero.gif')).toBe('IMAGE');
  });

  it('classifies a deck, a mix, and a picture file', () => {
    expect(reviewKindFromFileName('deck.pdf')).toBe('PDF');
    expect(reviewKindFromFileName('mix.wav')).toBe('AUDIO');
    expect(reviewKindFromFileName('cut.mp4')).toBe('VIDEO');
  });

  it('rejects a name that is not a review file', () => {
    expect(reviewKindFromFileName('payload.exe')).toBeNull();
    expect(reviewKindFromFileName('notes.txt')).toBeNull();
    expect(reviewKindFromFileName('')).toBeNull();
  });
});

describe('resolveReviewUpload', () => {
  it('lets the extension win over a mismatched declared mime', () => {
    expect(resolveReviewUpload('still.png', 'video/mp4')).toEqual({
      contentType: 'image/png',
      kind: 'IMAGE',
      extension: 'png',
    });
  });

  it('accepts a jpeg still', () => {
    expect(resolveReviewUpload('hero.jpg', 'image/jpeg')).toEqual({
      contentType: 'image/jpeg',
      kind: 'IMAGE',
      extension: 'jpg',
    });
  });

  it('accepts a pdf deck', () => {
    expect(resolveReviewUpload('deck.pdf', 'application/pdf')).toEqual({
      contentType: 'application/pdf',
      kind: 'PDF',
      extension: 'pdf',
    });
  });

  it('accepts a wav mix', () => {
    expect(resolveReviewUpload('mix.wav', undefined)).toEqual({
      contentType: 'audio/wav',
      kind: 'AUDIO',
      extension: 'wav',
    });
  });

  it('still accepts an mp4', () => {
    expect(resolveReviewUpload('cut.mp4', 'video/mp4')).toEqual({
      contentType: 'video/mp4',
      kind: 'VIDEO',
      extension: 'mp4',
    });
  });

  it('refuses an executable that claims to be a png', () => {
    expect(resolveReviewUpload('payload.exe', 'image/png')).toBeNull();
  });
});

describe('media job gates', () => {
  it('probes file-backed video and audio, not stills, pdfs, or youtube', () => {
    expect(shouldEnqueueProbe('VIDEO', 'r2')).toBe(true);
    expect(shouldEnqueueProbe('AUDIO', 'r2')).toBe(true);
    expect(shouldEnqueueProbe('VIDEO', 'bunny')).toBe(true);
    expect(shouldEnqueueProbe('AUDIO', 'bunny')).toBe(true);
    expect(shouldEnqueueProbe('IMAGE', 'r2')).toBe(false);
    expect(shouldEnqueueProbe('IMAGE', 'bunny')).toBe(false);
    expect(shouldEnqueueProbe('PDF', 'r2')).toBe(false);
    expect(shouldEnqueueProbe('VIDEO', 'youtube')).toBe(false);
  });

  it('transcribes file-backed video and audio when the flag is on', () => {
    expect(shouldEnqueueTranscribe('VIDEO', 'r2', true)).toBe(true);
    expect(shouldEnqueueTranscribe('AUDIO', 'r2', true)).toBe(true);
    expect(shouldEnqueueTranscribe('VIDEO', 'bunny', true)).toBe(true);
    expect(shouldEnqueueTranscribe('AUDIO', 'bunny', true)).toBe(true);
    expect(shouldEnqueueTranscribe('VIDEO', 'r2', false)).toBe(false);
    expect(shouldEnqueueTranscribe('IMAGE', 'r2', true)).toBe(false);
    expect(shouldEnqueueTranscribe('PDF', 'r2', true)).toBe(false);
    expect(shouldEnqueueTranscribe('VIDEO', 'youtube', true)).toBe(false);
  });

  it('treats only r2 and bunny video or audio as auto-transcribable', () => {
    expect(canAutoTranscribe('VIDEO', 'r2')).toBe(true);
    expect(canAutoTranscribe('AUDIO', 'r2')).toBe(true);
    expect(canAutoTranscribe('VIDEO', 'bunny')).toBe(true);
    expect(canAutoTranscribe('AUDIO', 'bunny')).toBe(true);
    expect(canAutoTranscribe('IMAGE', 'r2')).toBe(false);
    expect(canAutoTranscribe('PDF', 'r2')).toBe(false);
    expect(canAutoTranscribe('VIDEO', 'youtube')).toBe(false);
    expect(canAutoTranscribe('AUDIO', 'youtube')).toBe(false);
  });
});

describe('reviewPlayerMode', () => {
  it('shows a still, a pdf, and native media without breaking youtube', () => {
    expect(reviewPlayerMode('IMAGE', 'r2')).toBe('image');
    expect(reviewPlayerMode('PDF', 'r2')).toBe('pdf');
    expect(reviewPlayerMode('AUDIO', 'r2')).toBe('native-video');
    expect(reviewPlayerMode('AUDIO', 'youtube')).toBe('native-video');
    expect(reviewPlayerMode('VIDEO', 'r2')).toBe('native-video');
    expect(reviewPlayerMode('VIDEO', 'bunny')).toBe('native-video');
    expect(reviewPlayerMode('VIDEO', 'youtube')).toBe('embed');
  });
});

describe('hasKnownReviewMagicBytes', () => {
  it('accepts a jpeg still and refuses it when the name says mp4', () => {
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(hasKnownReviewMagicBytes('hero.jpg', jpeg)).toBe(true);
    expect(hasKnownReviewMagicBytes('cut.mp4', jpeg)).toBe(false);
  });

  it('accepts a png still and a pdf header', () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const pdf = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(hasKnownReviewMagicBytes('still.png', png)).toBe(true);
    expect(hasKnownReviewMagicBytes('deck.pdf', pdf)).toBe(true);
    expect(hasKnownReviewMagicBytes('still.png', pdf)).toBe(false);
    expect(hasKnownReviewMagicBytes('still.png', jpeg)).toBe(false);
  });

  it('accepts a wav mix and refuses a wav header on an mp4 name', () => {
    const wav = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
    expect(hasKnownReviewMagicBytes('mix.wav', wav)).toBe(true);
    expect(hasKnownReviewMagicBytes('cut.mp4', wav)).toBe(false);
  });

  it('still accepts an mp4 ftyp box', () => {
    const mp4 = new Uint8Array(12);
    mp4.set([0x66, 0x74, 0x79, 0x70], 4);
    expect(hasKnownReviewMagicBytes('cut.mp4', mp4)).toBe(true);
  });

  it('refuses an executable no matter the claimed name', () => {
    const exe = Uint8Array.from([0x4d, 0x5a, 0x90, 0x00]);
    expect(hasKnownReviewMagicBytes('hero.jpg', exe)).toBe(false);
    expect(hasKnownReviewMagicBytes('payload.exe', exe)).toBe(false);
  });
});

describe('reviewKindFromUploadPath', () => {
  it('reads the kind from an r2 proxy path and leaves youtube as video', () => {
    expect(reviewKindFromUploadPath('/api/upload/video/abc.jpg', 'r2')).toBe('IMAGE');
    expect(reviewKindFromUploadPath('/api/upload/video/abc.pdf', 'r2')).toBe('PDF');
    expect(reviewKindFromUploadPath('/api/upload/video/abc.wav', 'r2')).toBe('AUDIO');
    expect(reviewKindFromUploadPath('/api/upload/video/hero.jpg', 'youtube')).toBe('VIDEO');
  });
});
