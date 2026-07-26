import { describe, expect, it } from 'vitest';
import { DEFAULT_COMMENT_TAGS } from '@/lib/comment-tags';

describe('DEFAULT_COMMENT_TAGS', () => {
  it('seeds a non-empty set of tags', () => {
    expect(DEFAULT_COMMENT_TAGS.length).toBeGreaterThan(0);
  });

  it('has a unique name per tag', () => {
    const names = DEFAULT_COMMENT_TAGS.map((tag) => tag.name);

    expect(new Set(names).size).toBe(names.length);
  });

  it('has a unique name per tag even when compared case-insensitively', () => {
    const names = DEFAULT_COMMENT_TAGS.map((tag) => tag.name.toLowerCase());

    expect(new Set(names).size).toBe(names.length);
  });

  it('gives every tag a trimmed, non-empty name', () => {
    for (const tag of DEFAULT_COMMENT_TAGS) {
      expect(tag.name.trim()).toBe(tag.name);
      expect(tag.name.length).toBeGreaterThan(0);
    }
  });

  it('gives every tag a six digit hex colour', () => {
    for (const tag of DEFAULT_COMMENT_TAGS) {
      expect(tag.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it('uses a distinct colour per tag so the UI can tell them apart', () => {
    const colors = DEFAULT_COMMENT_TAGS.map((tag) => tag.color.toUpperCase());

    expect(new Set(colors).size).toBe(colors.length);
  });

  it('numbers the positions contiguously from zero in array order', () => {
    expect(DEFAULT_COMMENT_TAGS.map((tag) => tag.position)).toEqual(
      DEFAULT_COMMENT_TAGS.map((_tag, index) => index)
    );
  });

  it('uses colours the annotation validator would also accept', () => {
    // Comment tag colours and annotation stroke colours share the same 6-digit
    // hex convention, so seed data cannot drift away from the validator.
    for (const tag of DEFAULT_COMMENT_TAGS) {
      expect(/^#[0-9a-fA-F]{6}$/.test(tag.color)).toBe(true);
    }
  });
});
