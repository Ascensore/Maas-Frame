import { describe, expect, it } from 'vitest';
import { reviewWatermarkForProject, reviewWatermarkLabel } from '@/lib/review-watermark';

describe('reviewWatermarkLabel', () => {
  it('joins a name and an email', () => {
    expect(reviewWatermarkLabel({ name: '  Ada Lovelace  ', email: ' ada@example.com ' })).toBe(
      'Ada Lovelace · ada@example.com'
    );
  });

  it('falls back to email, then name, then a guest identity prefix, each source alone', () => {
    expect(reviewWatermarkLabel({ email: 'ada@example.com' })).toBe('ada@example.com');
    expect(reviewWatermarkLabel({ name: 'Ada' })).toBe('Ada');
    expect(reviewWatermarkLabel({ guestName: ' Pat ' })).toBe('Pat');
    expect(reviewWatermarkLabel({ guestIdentityId: 'abcdefghijklmnop' })).toBe('Guest abcdefgh');
  });

  it('prefers a signed-in name over guestName and guest identity', () => {
    expect(
      reviewWatermarkLabel({
        name: 'Ada',
        guestName: 'Pat',
        guestIdentityId: 'abcdefghijklmnop',
      })
    ).toBe('Ada');
    expect(reviewWatermarkLabel({ guestName: 'Pat', guestIdentityId: 'abcdefghijklmnop' })).toBe(
      'Pat'
    );
  });

  it('uses Guest when nothing identifying is present', () => {
    expect(reviewWatermarkLabel({})).toBe('Guest');
  });
});

describe('reviewWatermarkForProject', () => {
  it('returns null when the project does not watermark reviews', () => {
    expect(reviewWatermarkForProject(false, { name: 'Ada', email: 'ada@example.com' })).toBeNull();
  });

  it('returns the viewer label when the project watermarks reviews', () => {
    expect(reviewWatermarkForProject(true, { name: 'Ada', email: 'ada@example.com' })).toBe(
      'Ada · ada@example.com'
    );
  });
});
