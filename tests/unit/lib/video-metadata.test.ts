import { describe, expect, it } from 'vitest';
import { parseVideoMetadata } from '@/lib/video-metadata';

describe('parseVideoMetadata', () => {
  it('accepts an empty object', () => {
    expect(parseVideoMetadata({})).toEqual({ ok: true, value: {} });
  });

  it('trims keys and values', () => {
    expect(parseVideoMetadata({ '  Scene  ': '  12A  ' })).toEqual({
      ok: true,
      value: { Scene: '12A' },
    });
  });

  it('accepts a handful of string fields', () => {
    expect(
      parseVideoMetadata({
        Scene: '12A',
        Take: '3',
        Camera: 'A',
      })
    ).toEqual({
      ok: true,
      value: { Scene: '12A', Take: '3', Camera: 'A' },
    });
  });

  it('refuses an array, null, or a nested object', () => {
    expect(parseVideoMetadata([])).toEqual({
      ok: false,
      error: 'Metadata must be an object of string fields',
    });
    expect(parseVideoMetadata(null)).toEqual({
      ok: false,
      error: 'Metadata must be an object of string fields',
    });
    expect(parseVideoMetadata({ Scene: { nested: true } })).toEqual({
      ok: false,
      error: 'Metadata values must be strings',
    });
  });

  it('refuses a non-string value', () => {
    expect(parseVideoMetadata({ Take: 3 })).toEqual({
      ok: false,
      error: 'Metadata values must be strings',
    });
  });

  it('refuses an empty or illegal key', () => {
    expect(parseVideoMetadata({ '': 'x' }).ok).toBe(false);
    expect(parseVideoMetadata({ ' Scene ': 'x' }).ok).toBe(true);
    expect(parseVideoMetadata({ $$inject: 'x' }).ok).toBe(false);
  });

  it('refuses more than 20 fields', () => {
    const tooMany: Record<string, string> = {};
    for (let i = 0; i < 21; i += 1) {
      tooMany[`Field${i}`] = 'v';
    }
    expect(parseVideoMetadata(tooMany)).toEqual({
      ok: false,
      error: 'Metadata may have at most 20 fields',
    });
  });

  it('accepts 20 fields, a 40-character key, and a 200-character value', () => {
    const atCap: Record<string, string> = {};
    for (let i = 0; i < 20; i += 1) {
      atCap[`Field${i}`] = 'v';
    }
    expect(parseVideoMetadata(atCap).ok).toBe(true);
    expect(parseVideoMetadata({ ['K'.repeat(40)]: 'ok' })).toEqual({
      ok: true,
      value: { ['K'.repeat(40)]: 'ok' },
    });
    expect(parseVideoMetadata({ Note: 'n'.repeat(200) })).toEqual({
      ok: true,
      value: { Note: 'n'.repeat(200) },
    });
  });

  it('refuses a value longer than 200 characters', () => {
    expect(parseVideoMetadata({ Note: 'n'.repeat(201) })).toEqual({
      ok: false,
      error: 'Metadata values must be 200 characters or fewer',
    });
  });
});
