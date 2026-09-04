import { describe, expect, it } from 'vitest';
import { isWaitingForMediaWorker, ROUGH_CUT_WORKER_WAIT_MS } from '@/lib/rough-cut/workspace';

describe('isWaitingForMediaWorker', () => {
  const createdAt = '2026-09-04T10:00:00.000Z';
  const createdMs = Date.parse(createdAt);

  it('is true only for PENDING cuts older than 30 seconds', () => {
    expect(
      isWaitingForMediaWorker('PENDING', createdAt, createdMs + ROUGH_CUT_WORKER_WAIT_MS)
    ).toBe(true);
    expect(
      isWaitingForMediaWorker('PENDING', createdAt, createdMs + ROUGH_CUT_WORKER_WAIT_MS - 1)
    ).toBe(false);
    expect(
      isWaitingForMediaWorker('RUNNING', createdAt, createdMs + ROUGH_CUT_WORKER_WAIT_MS)
    ).toBe(false);
    expect(isWaitingForMediaWorker('READY', createdAt, createdMs + ROUGH_CUT_WORKER_WAIT_MS)).toBe(
      false
    );
    expect(isWaitingForMediaWorker('PENDING', 'not-a-date', createdMs)).toBe(false);
  });
});
