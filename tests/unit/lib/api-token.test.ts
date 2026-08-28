import { describe, expect, it } from 'vitest';
import { extractBearerToken, generateApiToken, hashApiToken } from '@/lib/api-token';

describe('generateApiToken', () => {
  it('returns a of_live_ token whose hash matches hashApiToken', () => {
    const token = generateApiToken();
    expect(token.raw.startsWith('of_live_')).toBe(true);
    expect(token.hash).toBe(hashApiToken(token.raw));
    expect(token.prefix).toBe(token.raw.slice(0, 'of_live_'.length + 8));
    expect(token.hash).toHaveLength(64);
  });

  it('never repeats', () => {
    expect(generateApiToken().raw).not.toBe(generateApiToken().raw);
  });
});

describe('extractBearerToken', () => {
  it('reads a well-formed header', () => {
    const token = generateApiToken().raw;
    expect(extractBearerToken(`Bearer ${token}`)).toBe(token);
    expect(extractBearerToken(`bearer ${token}`)).toBe(token);
  });

  it('rejects missing, short, or non-bearer values', () => {
    expect(extractBearerToken(null)).toBeNull();
    expect(extractBearerToken('Basic abc')).toBeNull();
    expect(extractBearerToken('Bearer short')).toBeNull();
    expect(extractBearerToken('Bearer of_live_abcd')).toBeNull();
  });
});
