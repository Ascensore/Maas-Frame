import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCleanupWarnings, logCleanupWarnings } from '@/lib/cleanup-warnings';

function bunny(attempted: number, failed: number, failedIds: string[] = []) {
  return { attempted, failed, failedIds };
}

function r2(attempted: number, failed: number, failedKeys: string[] = []) {
  return { attempted, failed, failedKeys };
}

describe('buildCleanupWarnings', () => {
  it('returns undefined when nothing was attempted', () => {
    expect(buildCleanupWarnings({})).toBeUndefined();
  });

  it('returns undefined when both providers succeeded', () => {
    expect(buildCleanupWarnings({ bunny: bunny(3, 0), r2: r2(5, 0) })).toBeUndefined();
  });

  it('returns undefined when nothing was attempted on either provider', () => {
    expect(buildCleanupWarnings({ bunny: bunny(0, 0), r2: r2(0, 0) })).toBeUndefined();
  });

  it('reports only Bunny when only Bunny failed', () => {
    expect(buildCleanupWarnings({ bunny: bunny(4, 1, ['vid-1']), r2: r2(2, 0) })).toEqual({
      bunny: { attempted: 4, failed: 1 },
    });
  });

  it('reports only R2 when only R2 failed', () => {
    expect(buildCleanupWarnings({ bunny: bunny(4, 0), r2: r2(2, 2, ['a', 'b']) })).toEqual({
      r2: { attempted: 2, failed: 2 },
    });
  });

  it('reports both providers when both failed', () => {
    expect(buildCleanupWarnings({ bunny: bunny(4, 1), r2: r2(2, 2) })).toEqual({
      bunny: { attempted: 4, failed: 1 },
      r2: { attempted: 2, failed: 2 },
    });
  });

  it('drops the failed id lists from the client-facing summary', () => {
    const warnings = buildCleanupWarnings({ bunny: bunny(1, 1, ['secret-video-id']) });

    expect(JSON.stringify(warnings)).not.toContain('secret-video-id');
    expect(Object.keys(warnings!.bunny!).sort()).toEqual(['attempted', 'failed']);
  });

  it('reports a failure even when the attempted count is inconsistent', () => {
    expect(buildCleanupWarnings({ r2: r2(0, 1) })).toEqual({ r2: { attempted: 0, failed: 1 } });
  });
});

describe('logCleanupWarnings', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  const context = { entityType: 'video', entityId: 'video-1' };

  it('logs nothing when both providers succeeded', () => {
    logCleanupWarnings(context, { bunny: bunny(2, 0), r2: r2(2, 0) });

    expect(consoleError).not.toHaveBeenCalled();
  });

  it('logs nothing when no provider result is supplied', () => {
    logCleanupWarnings(context, {});

    expect(consoleError).not.toHaveBeenCalled();
  });

  it('logs one entry per failing provider with the entity context', () => {
    logCleanupWarnings(context, { bunny: bunny(3, 1, ['vid-1']), r2: r2(4, 2, ['k1', 'k2']) });

    expect(consoleError).toHaveBeenCalledTimes(2);
    expect(consoleError.mock.calls[0][1]).toMatchObject({
      entityType: 'video',
      entityId: 'video-1',
      provider: 'bunny',
      operation: 'delete',
      attempted: 3,
      failed: 1,
      failedIds: ['vid-1'],
    });
    expect(consoleError.mock.calls[1][1]).toMatchObject({
      provider: 'r2',
      attempted: 4,
      failed: 2,
      failedKeys: ['k1', 'k2'],
    });
  });

  it('truncates the failed id list to ten entries', () => {
    const ids = Array.from({ length: 25 }, (_unused, i) => `vid-${i}`);
    logCleanupWarnings(context, { bunny: bunny(25, 25, ids) });

    const logged = consoleError.mock.calls[0][1] as { failedIds: string[] };
    expect(logged.failedIds).toHaveLength(10);
    expect(logged.failedIds[0]).toBe('vid-0');
    expect(logged.failedIds[9]).toBe('vid-9');
  });

  it('truncates the failed key list to ten entries', () => {
    const keys = Array.from({ length: 11 }, (_unused, i) => `key-${i}`);
    logCleanupWarnings(context, { r2: r2(11, 11, keys) });

    expect((consoleError.mock.calls[0][1] as { failedKeys: string[] }).failedKeys).toHaveLength(10);
  });

  it('uses a stable message prefix so the logs can be grepped', () => {
    logCleanupWarnings(context, { r2: r2(1, 1, ['k']) });

    expect(consoleError.mock.calls[0][0]).toBe('External cleanup warning');
  });
});
