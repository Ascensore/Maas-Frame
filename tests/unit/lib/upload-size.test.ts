import { describe, expect, it } from 'vitest';
import { formatSizeLimit, parseDeclaredUploadSize } from '@/lib/upload-size';

const MAX = BigInt(5) * BigInt(1024) * BigInt(1024) * BigInt(1024);

function size(result: ReturnType<typeof parseDeclaredUploadSize>): bigint | null {
  return 'sizeBytes' in result ? result.sizeBytes : null;
}

describe('parseDeclaredUploadSize', () => {
  it('accepts a size sent as a string, which is how a client sends bytes it cannot hold in a number', () => {
    expect(size(parseDeclaredUploadSize('4294967296', MAX))).toBe(BigInt(4294967296));
  });

  it('accepts a size sent as a number', () => {
    expect(size(parseDeclaredUploadSize(1024, MAX))).toBe(BigInt(1024));
  });

  it('rejects a missing size', () => {
    expect(parseDeclaredUploadSize(undefined, MAX)).toEqual({
      error: 'sizeBytes must be a positive integer',
    });
  });

  // Zero was the old behaviour of every Bunny init: it asked the quota whether
  // it could store nothing, and the answer was always yes.
  it('rejects zero', () => {
    expect(parseDeclaredUploadSize(0, MAX)).toEqual({
      error: 'sizeBytes must be a positive integer',
    });
  });

  it('rejects a negative size', () => {
    expect(parseDeclaredUploadSize(-1, MAX)).toEqual({
      error: 'sizeBytes must be a positive integer',
    });
  });

  it('rejects a fractional size rather than rounding it', () => {
    expect(parseDeclaredUploadSize(1.5, MAX)).toEqual({
      error: 'sizeBytes must be a positive integer',
    });
  });

  it('rejects text that is not a number', () => {
    expect(parseDeclaredUploadSize('a lot', MAX)).toEqual({
      error: 'sizeBytes must be a positive integer',
    });
  });

  it('rejects a size over the ceiling, naming the ceiling so the client knows what fits', () => {
    expect(parseDeclaredUploadSize(MAX + BigInt(1), MAX)).toEqual({
      error: 'File exceeds the maximum allowed upload size (5 GB)',
    });
  });

  it('accepts a size exactly at the ceiling', () => {
    expect(size(parseDeclaredUploadSize(MAX, MAX))).toBe(MAX);
  });
});

describe('formatSizeLimit', () => {
  it('drops the decimal on a whole number of gigabytes', () => {
    expect(formatSizeLimit(BigInt(160) * BigInt(1024) ** BigInt(3))).toBe('160 GB');
  });

  it('keeps one decimal where the share of a small quota is not whole', () => {
    expect(
      formatSizeLimit((BigInt(3) * BigInt(1024) ** BigInt(3) * BigInt(80)) / BigInt(100))
    ).toBe('2.4 GB');
  });

  it('falls back to megabytes below a gigabyte, where "0.0 GB" would say nothing', () => {
    expect(formatSizeLimit(BigInt(500) * BigInt(1024) * BigInt(1024))).toBe('500 MB');
  });
});
