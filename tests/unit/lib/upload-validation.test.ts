import { describe, expect, it } from 'vitest';
import {
  ALLOWED_IMAGE_MIME_TYPES,
  detectImageMime,
  firstBytesHex,
  getImageExtension,
  isAllowedImageType,
  normalizeImageMime,
} from '@/lib/image-upload-validation';
import {
  VIDEO_OBJECT_KEY_PREFIX,
  VIDEO_PROXY_PREFIX,
  buildVideoObjectKey,
  getVideoExtensionFromFileName,
  getVideoExtensionFromMime,
  isAllowedVideoFile,
  isPlayableVideoUrl,
  normalizeVideoMime,
  objectKeyToVideoProxyPath,
  resolveR2PlaybackUrl,
  resolveVideoContentType,
  videoProxyPathFromFilename,
  videoProxyPathToObjectKey,
} from '@/lib/video-upload-validation';

const UUID = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

describe('normalizeVideoMime', () => {
  it.each([
    ['video/mp4', 'video/mp4'],
    ['VIDEO/MP4', 'video/mp4'],
    ['video/mp4; codecs="avc1.42E01E"', 'video/mp4'],
    ['  video/webm  ', 'video/webm'],
    ['video/x-matroska', 'video/x-matroska'],
  ])('normalises %s to %s', (input, expected) => {
    expect(normalizeVideoMime(input)).toBe(expected);
  });

  it.each([
    ['undefined', undefined],
    ['an empty string', ''],
    ['image/png', 'image/png'],
    ['application/octet-stream', 'application/octet-stream'],
    ['text/html;video/mp4', 'text/html;video/mp4'],
  ])('returns null for %s', (_label, input) => {
    expect(normalizeVideoMime(input)).toBeNull();
  });
});

describe('getVideoExtensionFromMime', () => {
  it.each([
    ['video/mp4', 'mp4'],
    ['video/webm', 'webm'],
    ['video/ogg', 'ogg'],
    ['video/quicktime', 'mov'],
    ['video/x-matroska', 'mkv'],
    ['video/x-msvideo', 'avi'],
  ])('maps %s to %s', (mime, expected) => {
    expect(getVideoExtensionFromMime(mime)).toBe(expected);
  });

  it('returns null for an unmapped video mime', () => {
    expect(getVideoExtensionFromMime('video/3gpp')).toBeNull();
  });
});

describe('getVideoExtensionFromFileName', () => {
  it.each([
    ['clip.mp4', 'mp4'],
    ['clip.MP4', 'mp4'],
    ['clip.m4v', 'm4v'],
    ['archive.tar.mkv', 'mkv'],
    ['a.b.c.avi', 'avi'],
  ])('extracts %s as %s', (fileName, expected) => {
    expect(getVideoExtensionFromFileName(fileName)).toBe(expected);
  });

  it.each(['payload.exe', 'clip.svg', 'no-extension', '', 'clip.'])(
    'rejects the file name %s',
    (fileName) => {
      expect(getVideoExtensionFromFileName(fileName)).toBeNull();
    }
  );
});

describe('resolveVideoContentType', () => {
  it('keeps a matching mime and extension pair', () => {
    expect(resolveVideoContentType('clip.mp4', 'video/mp4')).toBe('video/mp4');
  });

  it('lets the file extension win when it disagrees with the declared mime', () => {
    expect(resolveVideoContentType('clip.mov', 'video/mp4')).toBe('video/quicktime');
  });

  it('resolves the m4v alias back to video/mp4 rather than treating it as a mismatch', () => {
    expect(resolveVideoContentType('clip.m4v', 'video/mp4')).toBe('video/mp4');
  });

  it('falls back to the extension when the browser sends application/octet-stream', () => {
    expect(resolveVideoContentType('clip.webm', 'application/octet-stream')).toBe('video/webm');
  });

  it('resolves from the extension alone when no mime is supplied', () => {
    expect(resolveVideoContentType('clip.mkv', undefined)).toBe('video/x-matroska');
  });

  it('returns null when neither the mime nor the extension is a known video', () => {
    expect(resolveVideoContentType('payload.exe', 'application/x-msdownload')).toBeNull();
  });

  // The declared mime is a client claim, so it cannot be what makes a file acceptable.
  it.each(['payload.exe', 'payload', 'payload.', 'payload.mp4.exe'])(
    'refuses %s however it declares itself',
    (fileName) => {
      expect(resolveVideoContentType(fileName, 'video/mp4')).toBeNull();
      expect(isAllowedVideoFile(fileName, 'video/mp4')).toBe(false);
    }
  );

  it('ignores a video mime that has no extension mapping of its own', () => {
    expect(resolveVideoContentType('clip.mp4', 'video/3gpp')).toBe('video/mp4');
  });
});

describe('isAllowedVideoFile', () => {
  it.each([
    ['clip.mp4', 'video/mp4'],
    ['clip.mov', undefined],
    ['clip.avi', 'application/octet-stream'],
  ])('accepts %s with mime %s', (fileName, mime) => {
    expect(isAllowedVideoFile(fileName, mime)).toBe(true);
  });

  it.each([
    ['script.js', 'text/javascript'],
    ['image.png', 'image/png'],
    ['no-extension', undefined],
  ])('rejects %s with mime %s', (fileName, mime) => {
    expect(isAllowedVideoFile(fileName, mime)).toBe(false);
  });
});

describe('video object key and proxy path helpers', () => {
  it('round-trips a well-formed filename through both directions', () => {
    const filename = `${UUID}.mp4`;
    const objectKey = buildVideoObjectKey(filename);
    const proxyPath = objectKeyToVideoProxyPath(objectKey);

    expect(objectKey).toBe(`${VIDEO_OBJECT_KEY_PREFIX}${filename}`);
    expect(proxyPath).toBe(`${VIDEO_PROXY_PREFIX}${filename}`);
    expect(videoProxyPathToObjectKey(proxyPath!)).toBe(objectKey);
  });

  it('accepts an uppercase uuid', () => {
    const path = videoProxyPathFromFilename(`${UUID.toUpperCase()}.MP4`);
    expect(videoProxyPathToObjectKey(path)).toBe(`videos/${UUID.toUpperCase()}.MP4`);
  });

  it.each([
    ['a traversal segment', `${VIDEO_PROXY_PREFIX}../../etc/passwd`],
    ['a nested path', `${VIDEO_PROXY_PREFIX}sub/${UUID}.mp4`],
    ['a non-uuid basename', `${VIDEO_PROXY_PREFIX}clip.mp4`],
    ['a missing extension', `${VIDEO_PROXY_PREFIX}${UUID}`],
    ['a truncated uuid', `${VIDEO_PROXY_PREFIX}${UUID.slice(0, 35)}.mp4`],
    ['an uppercase extension with punctuation', `${VIDEO_PROXY_PREFIX}${UUID}.mp4?x=1`],
    ['the wrong prefix', `/api/upload/image/${UUID}.mp4`],
    ['an absolute url', `https://evil.com${VIDEO_PROXY_PREFIX}${UUID}.mp4`],
  ])('videoProxyPathToObjectKey rejects %s', (_label, path) => {
    expect(videoProxyPathToObjectKey(path)).toBeNull();
  });

  it.each([
    ['the wrong prefix', `uploads/${UUID}.mp4`],
    ['a traversal segment', 'videos/../../secret.mp4'],
    ['a non-uuid basename', 'videos/clip.mp4'],
  ])('objectKeyToVideoProxyPath rejects %s', (_label, key) => {
    expect(objectKeyToVideoProxyPath(key)).toBeNull();
  });
});

describe('resolveR2PlaybackUrl', () => {
  it('passes an existing proxy path through untouched', () => {
    const originalUrl = `${VIDEO_PROXY_PREFIX}${UUID}.mp4`;
    expect(resolveR2PlaybackUrl({ videoId: 'ignored', originalUrl })).toBe(originalUrl);
  });

  it('converts a stored object key in originalUrl into a proxy path', () => {
    expect(resolveR2PlaybackUrl({ videoId: 'ignored', originalUrl: `videos/${UUID}.mp4` })).toBe(
      `${VIDEO_PROXY_PREFIX}${UUID}.mp4`
    );
  });

  it('falls back to an object key held in videoId', () => {
    expect(
      resolveR2PlaybackUrl({ videoId: `videos/${UUID}.webm`, originalUrl: 'https://cdn/x.webm' })
    ).toBe(`${VIDEO_PROXY_PREFIX}${UUID}.webm`);
  });

  it('returns the original url when neither field carries an object key', () => {
    expect(
      resolveR2PlaybackUrl({ videoId: 'abc123', originalUrl: 'https://cdn.example.com/x.mp4' })
    ).toBe('https://cdn.example.com/x.mp4');
  });

  it('prefers originalUrl over videoId when both look like object keys', () => {
    expect(
      resolveR2PlaybackUrl({ videoId: `videos/${UUID}.webm`, originalUrl: `videos/${UUID}.mp4` })
    ).toBe(`${VIDEO_PROXY_PREFIX}${UUID}.mp4`);
  });

  it('prefers a READY review proxy over the camera master', () => {
    const master = `${VIDEO_PROXY_PREFIX}${UUID}.mov`;
    const proxy = `${VIDEO_PROXY_PREFIX}aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.mp4`;
    expect(
      resolveR2PlaybackUrl({
        videoId: 'ignored',
        originalUrl: master,
        proxyUrl: proxy,
        proxyStatus: 'READY',
      })
    ).toBe(proxy);
  });

  it('keeps the master while the review proxy is still cooking', () => {
    const master = `${VIDEO_PROXY_PREFIX}${UUID}.mov`;
    expect(
      resolveR2PlaybackUrl({
        videoId: 'ignored',
        originalUrl: master,
        proxyUrl: `${VIDEO_PROXY_PREFIX}aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.mp4`,
        proxyStatus: 'PENDING',
      })
    ).toBe(master);
  });
});

describe('isPlayableVideoUrl', () => {
  it.each([
    `${VIDEO_PROXY_PREFIX}${UUID}.mp4`,
    'https://cdn.example.com/clip.mp4',
    'http://localhost:9000/bucket/clip.mp4',
    'https://cdn.example.com/anything-at-all',
  ])('accepts %s', (url) => {
    expect(isPlayableVideoUrl(url)).toBe(true);
  });

  it.each([
    `${VIDEO_PROXY_PREFIX}../../etc/passwd`,
    `${VIDEO_PROXY_PREFIX}clip.mp4`,
    'javascript:alert(1)',
    'data:video/mp4;base64,AAAA',
    'blob:https://example.com/uuid',
    `videos/${UUID}.mp4`,
    '',
  ])('rejects %s', (url) => {
    expect(isPlayableVideoUrl(url)).toBe(false);
  });
});

describe('normalizeImageMime', () => {
  it.each([
    ['image/jpg', 'image/jpeg'],
    ['image/pjpeg', 'image/jpeg'],
    ['image/jpeg', 'image/jpeg'],
    ['image/png', 'image/png'],
    ['image/svg+xml', 'image/svg+xml'],
  ])('maps %s to %s', (input, expected) => {
    expect(normalizeImageMime(input)).toBe(expected);
  });

  it('does not normalise a case-variant alias', () => {
    expect(normalizeImageMime('IMAGE/JPG')).toBe('IMAGE/JPG');
  });
});

describe('isAllowedImageType', () => {
  // The list is written out here rather than spread from
  // ALLOWED_IMAGE_MIME_TYPES. isAllowedImageType() is a `.includes()` over that
  // same constant, so driving it.each() from the constant made the test data and
  // the code under test the same thing: dropping 'image/gif' from
  // lib/image-upload-validation.ts deleted the case that would have caught it and
  // left the file green while GIF uploads stopped working. getImageExtension()
  // reads a separate map, so nothing else in the suite noticed either.
  it.each(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])('accepts %s', (mime) => {
    expect(isAllowedImageType(mime)).toBe(true);
  });

  it('allows exactly those four types and nothing else', () => {
    expect([...ALLOWED_IMAGE_MIME_TYPES]).toEqual([
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/gif',
    ]);
  });

  it.each(['image/svg+xml', 'image/jpg', 'image/avif', 'image/bmp', 'text/html', ''])(
    'rejects %s',
    (mime) => {
      expect(isAllowedImageType(mime)).toBe(false);
    }
  );
});

describe('detectImageMime', () => {
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  const gif87 = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 0x01]);
  const gif89 = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01]);
  const webp = Uint8Array.from([
    0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
  ]);

  it.each([
    ['a JPEG SOI marker', jpeg, 'image/jpeg'],
    ['a PNG signature', png, 'image/png'],
    ['a GIF87a header', gif87, 'image/gif'],
    ['a GIF89a header', gif89, 'image/gif'],
    ['a RIFF/WEBP header', webp, 'image/webp'],
  ])('detects %s', (_label, buffer, expected) => {
    expect(detectImageMime(buffer)).toBe(expected);
  });

  it.each([
    ['an empty buffer', Uint8Array.from([])],
    ['a one byte buffer', Uint8Array.from([0xff])],
    ['a truncated PNG signature', Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a])],
    [
      'a GIF header with the wrong version digit',
      Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x35, 0x61]),
    ],
    [
      'RIFF without the WEBP fourcc',
      Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x41, 0x56, 0x49, 0x20]),
    ],
    ['a truncated RIFF container', Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00])],
    ['an SVG document', new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" />')],
    ['an ELF binary', Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01])],
  ])('returns null for %s', (_label, buffer) => {
    expect(detectImageMime(buffer)).toBeNull();
  });
});

describe('getImageExtension', () => {
  it.each([
    ['image/jpeg', 'jpg'],
    ['image/png', 'png'],
    ['image/webp', 'webp'],
    ['image/gif', 'gif'],
  ] as const)('maps %s to %s', (mime, expected) => {
    expect(getImageExtension(mime)).toBe(expected);
  });

  it('has an extension for every allowed mime type', () => {
    for (const mime of ALLOWED_IMAGE_MIME_TYPES) {
      expect(getImageExtension(mime)).toMatch(/^[a-z]+$/);
    }
  });
});

describe('firstBytesHex', () => {
  it('renders each byte as two lowercase hex digits separated by spaces', () => {
    expect(firstBytesHex(Uint8Array.from([0x00, 0x0f, 0xff, 0xa9]))).toBe('00 0f ff a9');
  });

  it('caps the output at 16 bytes by default', () => {
    const buffer = Uint8Array.from({ length: 32 }, (_unused, i) => i);
    expect(firstBytesHex(buffer).split(' ')).toHaveLength(16);
  });

  it('honours an explicit length', () => {
    const buffer = Uint8Array.from([0x01, 0x02, 0x03, 0x04]);
    expect(firstBytesHex(buffer, 2)).toBe('01 02');
  });

  it('returns an empty string for an empty buffer', () => {
    expect(firstBytesHex(Uint8Array.from([]))).toBe('');
  });
});
