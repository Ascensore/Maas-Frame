import { describe, expect, it } from 'vitest';
import { isWaitingForMediaWorker, isWaitingForTranscript } from '@/lib/rough-cut/workspace';

describe('isWaitingForMediaWorker', () => {
  const createdAt = '2026-09-04T10:00:00.000Z';
  const createdMs = Date.parse(createdAt);

  it('is true only for PENDING cuts older than 30 seconds', () => {
    expect(isWaitingForMediaWorker('PENDING', createdAt, createdMs + 30000)).toBe(true);
    expect(isWaitingForMediaWorker('PENDING', createdAt, createdMs + 29999)).toBe(false);
    expect(isWaitingForMediaWorker('RUNNING', createdAt, createdMs + 30000)).toBe(false);
    expect(isWaitingForMediaWorker('READY', createdAt, createdMs + 30000)).toBe(false);
    expect(isWaitingForMediaWorker('PENDING', 'not-a-date', createdMs)).toBe(false);
  });
});

describe('isWaitingForTranscript', () => {
  it('is true only for a RUNNING cut carrying the waiting warning', () => {
    const waiting = [{ code: 'waiting-for-transcript' }];
    expect(isWaitingForTranscript('RUNNING', waiting)).toBe(true);
    expect(isWaitingForTranscript('RUNNING', [{ code: 'weak-transcript' }])).toBe(false);
    expect(isWaitingForTranscript('RUNNING', null)).toBe(false);
    expect(isWaitingForTranscript('PENDING', waiting)).toBe(false);
    expect(isWaitingForTranscript('READY', waiting)).toBe(false);
  });
});
