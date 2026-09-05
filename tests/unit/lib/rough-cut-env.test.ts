import { describe, expect, it } from 'vitest';
import {
  isDiarizationEnvEnabled,
  isTranscriptionEnvEnabled,
  isTruthyEnvFlag,
} from '@/lib/rough-cut/env';

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

describe('isTranscriptionEnvEnabled', () => {
  it('is on unless the flag is literally false', () => {
    expect(isTranscriptionEnvEnabled({})).toBe(true);
    expect(isTranscriptionEnvEnabled({ OPENFRAME_ENABLE_TRANSCRIPTION: 'true' })).toBe(true);
    expect(isTranscriptionEnvEnabled({ OPENFRAME_ENABLE_TRANSCRIPTION: 'FALSE' })).toBe(false);
    expect(isTranscriptionEnvEnabled({ OPENFRAME_ENABLE_TRANSCRIPTION: ' false ' })).toBe(false);
    expect(isTranscriptionEnvEnabled({ OPENFRAME_ENABLE_TRANSCRIPTION: '0' })).toBe(true);
  });
});
