import { describe, expect, it } from 'vitest';
import { isFileBackedProvider, isReadyFileBackedVideo } from '@/lib/rough-cut/load';

describe('isFileBackedProvider', () => {
  it('is only r2 and bunny, never embeds', () => {
    expect(isFileBackedProvider('r2')).toBe(true);
    expect(isFileBackedProvider('bunny')).toBe(true);
    expect(isFileBackedProvider('gdrive')).toBe(false);
    expect(isFileBackedProvider('youtube')).toBe(false);
  });
});

describe('isReadyFileBackedVideo', () => {
  it('requires a storage backend that has finished importing', () => {
    expect(isReadyFileBackedVideo({ metadata: {}, versions: [{ providerId: 'r2' }] })).toBe(true);
    expect(
      isReadyFileBackedVideo({
        metadata: { import_status: 'ready' },
        versions: [{ providerId: 'r2' }],
      })
    ).toBe(true);
    expect(
      isReadyFileBackedVideo({
        metadata: { import_status: 'pending' },
        versions: [{ providerId: 'r2' }],
      })
    ).toBe(false);
    expect(
      isReadyFileBackedVideo({
        metadata: { import_status: 'failed' },
        versions: [{ providerId: 'r2' }],
      })
    ).toBe(false);
    expect(isReadyFileBackedVideo({ metadata: {}, versions: [{ providerId: 'gdrive' }] })).toBe(
      false
    );
    expect(isReadyFileBackedVideo({ metadata: {}, versions: [{ providerId: 'youtube' }] })).toBe(
      false
    );
    expect(isReadyFileBackedVideo({ metadata: {}, versions: [] })).toBe(false);
  });
});
