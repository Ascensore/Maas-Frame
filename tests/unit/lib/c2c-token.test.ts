import { describe, expect, it } from 'vitest';
import { extractC2cBearerToken, generateC2cToken, hashC2cToken } from '@/lib/c2c-token';

describe('generateC2cToken', () => {
  it('returns an of_c2c_ token whose hash matches hashC2cToken', () => {
    const token = generateC2cToken();
    expect(token.raw.startsWith('of_c2c_')).toBe(true);
    expect(token.hash).toBe(hashC2cToken(token.raw));
    expect(token.prefix).toBe(token.raw.slice(0, 'of_c2c_'.length + 8));
    expect(token.hash).toHaveLength(64);
  });

  it('hashes with SHA-256 of the raw token', () => {
    expect(hashC2cToken('of_c2c_fixed_input_for_hash')).toBe(
      'f51762da1b651650f3f873171e8b4782f76c26842645f24a29757c570e1fd001'
    );
  });

  it('never repeats', () => {
    expect(generateC2cToken().raw).not.toBe(generateC2cToken().raw);
  });
});

describe('extractC2cBearerToken', () => {
  it('reads a well-formed header', () => {
    const token = generateC2cToken().raw;
    expect(extractC2cBearerToken(`Bearer ${token}`)).toBe(token);
    expect(extractC2cBearerToken(`bearer ${token}`)).toBe(token);
  });

  it('rejects missing, short, live-API, or non-bearer values', () => {
    expect(extractC2cBearerToken(null)).toBeNull();
    expect(extractC2cBearerToken('Basic abc')).toBeNull();
    expect(extractC2cBearerToken('Bearer short')).toBeNull();
    expect(extractC2cBearerToken('Bearer of_c2c_abcd')).toBeNull();
    expect(
      extractC2cBearerToken(
        'Bearer of_live_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
      )
    ).toBeNull();
  });
});
