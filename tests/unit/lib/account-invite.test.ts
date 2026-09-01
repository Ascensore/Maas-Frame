import { describe, expect, it, vi } from 'vitest';
import {
  buildSetPasswordUrl,
  isValidInviteName,
  isValidPassword,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
} from '@/lib/account-invite';

describe('isValidPassword', () => {
  it('accepts an 8-character password and a 128-character password', () => {
    expect(isValidPassword('a'.repeat(MIN_PASSWORD_LENGTH))).toBe(true);
    expect(isValidPassword('a'.repeat(MAX_PASSWORD_LENGTH))).toBe(true);
  });

  it('rejects a 7-character password and a 129-character password', () => {
    expect(isValidPassword('a'.repeat(MIN_PASSWORD_LENGTH - 1))).toBe(false);
    expect(isValidPassword('a'.repeat(MAX_PASSWORD_LENGTH + 1))).toBe(false);
  });
});

describe('isValidInviteName', () => {
  it('treats a missing name as valid, because the field is optional', () => {
    expect(isValidInviteName(undefined)).toBe(true);
    expect(isValidInviteName(null)).toBe(true);
    expect(isValidInviteName('')).toBe(true);
    expect(isValidInviteName('  ')).toBe(true);
  });

  it('accepts a two-character name and a 100-character name', () => {
    expect(isValidInviteName('Ad')).toBe(true);
    expect(isValidInviteName('A'.repeat(100))).toBe(true);
  });

  it('rejects a one-character name and a 101-character name', () => {
    expect(isValidInviteName('A')).toBe(false);
    expect(isValidInviteName('A'.repeat(101))).toBe(false);
  });
});

describe('buildSetPasswordUrl', () => {
  it('builds the URL from NEXTAUTH_URL, not from a hardcoded host', () => {
    vi.stubEnv('NEXTAUTH_URL', 'https://reviews.example.com');
    expect(buildSetPasswordUrl('abc123')).toBe(
      'https://reviews.example.com/set-password?token=abc123'
    );
  });

  it('returns null when NEXTAUTH_URL is missing, rather than a localhost link', () => {
    vi.stubEnv('NEXTAUTH_URL', '');
    expect(buildSetPasswordUrl('abc123')).toBeNull();
  });
});
