import { describe, expect, it } from 'vitest';
import { firstNameFromDisplayName } from '@/lib/display-name';

describe('firstNameFromDisplayName', () => {
  it.each([
    ['Ada Lovelace', 'Ada'],
    ['Ada', 'Ada'],
    ['  Ada  Lovelace ', 'Ada'],
    ['Ada Mary Lovelace', 'Ada'],
  ])('takes the first token of %j', (input, expected) => {
    expect(firstNameFromDisplayName(input)).toBe(expected);
  });

  it('returns null for missing or blank names', () => {
    expect(firstNameFromDisplayName(null)).toBeNull();
    expect(firstNameFromDisplayName(undefined)).toBeNull();
    expect(firstNameFromDisplayName('')).toBeNull();
    expect(firstNameFromDisplayName('   ')).toBeNull();
  });
});
