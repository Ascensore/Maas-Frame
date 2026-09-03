import { describe, expect, it } from 'vitest';
import { isDiarizationEnvEnabled, isTruthyEnvFlag } from '@/lib/rough-cut/env';

describe('isTruthyEnvFlag', () => {
  it('is true only for the string true, ignoring case and padding', () => {
    expect(isTruthyEnvFlag('true')).toBe(true);
    expect(isTruthyEnvFlag('TRUE')).toBe(true);
    expect(isTruthyEnvFlag(' true ')).toBe(true);
    expect(isTruthyEnvFlag('false')).toBe(false);
    expect(isTruthyEnvFlag('1')).toBe(false);
    expect(isTruthyEnvFlag('')).toBe(false);
    expect(isTruthyEnvFlag(undefined)).toBe(false);
  });
});

describe('isDiarizationEnvEnabled', () => {
  it('defaults off when the env is missing', () => {
    expect(isDiarizationEnvEnabled({})).toBe(false);
  });

  it('reads OPENFRAME_ENABLE_DIARIZATION from the given env object', () => {
    expect(isDiarizationEnvEnabled({ OPENFRAME_ENABLE_DIARIZATION: 'true' })).toBe(true);
    expect(isDiarizationEnvEnabled({ OPENFRAME_ENABLE_DIARIZATION: 'false' })).toBe(false);
  });
});
