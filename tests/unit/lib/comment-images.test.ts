import { describe, expect, it } from 'vitest';
import { parseCommentImageUrls } from '@/lib/comment-images';

const A = '/api/upload/image/11111111-2222-3333-4444-555555555555.png';
const B = '/api/upload/image/66666666-7777-8888-9999-aaaaaaaaaaaa.jpg';
const C = '/api/upload/image/bbbbbbbb-cccc-dddd-eeee-ffffffffffff.webp';
const D = '/api/upload/image/12121212-3434-5656-7878-909090909090.gif';
const E = '/api/upload/image/abababab-cdcd-efef-0101-232323232323.png';
const F = '/api/upload/image/45454545-6767-8989-0a0a-1b1b1b1b1b1b.png';

describe('parseCommentImageUrls', () => {
  it('reads an ordered list', () => {
    expect(parseCommentImageUrls({ imageUrls: [A, B] })).toEqual({ urls: [A, B] });
  });

  it('treats a comment with no images as an empty list', () => {
    expect(parseCommentImageUrls({})).toEqual({ urls: [] });
    expect(parseCommentImageUrls({ imageUrls: [] })).toEqual({ urls: [] });
  });

  it('accepts the legacy single imageUrl as a one-element list', () => {
    expect(parseCommentImageUrls({ imageUrl: A })).toEqual({ urls: [A] });
  });

  it('ignores imageUrl once imageUrls is given, so the list wins', () => {
    expect(parseCommentImageUrls({ imageUrl: A, imageUrls: [B] })).toEqual({ urls: [B] });
  });

  it('collapses a URL repeated in one request', () => {
    expect(parseCommentImageUrls({ imageUrls: [A, B, A] })).toEqual({ urls: [A, B] });
  });

  it('allows exactly five images and refuses a sixth', () => {
    expect(parseCommentImageUrls({ imageUrls: [A, B, C, D, E] })).toEqual({
      urls: [A, B, C, D, E],
    });
    expect(parseCommentImageUrls({ imageUrls: [A, B, C, D, E, F] })).toEqual({
      error: 'A comment can have at most 5 images',
    });
  });

  it('counts the cap after de-duplication', () => {
    expect(parseCommentImageUrls({ imageUrls: [A, A, B, C, D, E] })).toEqual({
      urls: [A, B, C, D, E],
    });
  });

  it.each([
    ['a URL outside the upload API', 'https://evil.example.com/shot.png'],
    ['a path traversal', '/api/upload/image/../../etc/passwd'],
    ['an audio upload', '/api/upload/audio/11111111-2222-3333-4444-555555555555.webm'],
    ['a filename that is not a uuid', '/api/upload/image/shot.png'],
  ])('refuses %s', (_label, url) => {
    expect(parseCommentImageUrls({ imageUrls: [url] })).toEqual({
      error: 'Image URL must reference an uploaded image file',
    });
  });

  it('refuses a non-string entry', () => {
    expect(parseCommentImageUrls({ imageUrls: [A, 42] })).toEqual({
      error: 'Image URL must reference an uploaded image file',
    });
  });

  it('refuses imageUrls that is not an array', () => {
    expect(parseCommentImageUrls({ imageUrls: A })).toEqual({
      error: 'imageUrls must be an array of uploaded image URLs',
    });
  });

  it('refuses a legacy imageUrl that is not a valid upload URL', () => {
    expect(parseCommentImageUrls({ imageUrl: 'https://evil.example.com/shot.png' })).toEqual({
      error: 'Image URL must reference an uploaded image file',
    });
  });
});
