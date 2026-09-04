import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { connectCommentLiveListener } from '@/lib/comment-live';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
  end: vi.fn(),
}));

vi.mock('pg', () => ({
  Client: vi.fn(function MockClient() {
    return { connect: mocks.connect, query: mocks.query, end: mocks.end };
  }),
}));

describe('connectCommentLiveListener', () => {
  beforeEach(() => {
    vi.stubEnv('DATABASE_URL', 'postgresql://localhost:5432/openframe');
    mocks.connect.mockReset().mockResolvedValue(undefined);
    mocks.query.mockReset().mockResolvedValue({ rows: [] });
    mocks.end.mockReset().mockResolvedValue(undefined);
    vi.mocked(Client).mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('LISTENs on a quoted channel name', async () => {
    const result = await connectCommentLiveListener('clabcdefghijk012345678901');

    expect(result?.channel).toBe('ofc_clabcdefghijk012345678901');
    expect(mocks.query).toHaveBeenCalledWith('LISTEN "ofc_clabcdefghijk012345678901"');
    expect(mocks.end).not.toHaveBeenCalled();
  });

  it('quotes hyphens so LISTEN is not parsed as minus', async () => {
    await connectCommentLiveListener('abcd-efgh');

    expect(mocks.query).toHaveBeenCalledWith('LISTEN "ofc_abcd-efgh"');
  });

  it('closes the client when LISTEN fails so the pooler slot is released', async () => {
    mocks.query.mockRejectedValue(new Error('syntax error at or near "-"'));

    await expect(connectCommentLiveListener('clabcdefghijk012345678901')).rejects.toThrow(
      'syntax error at or near "-"'
    );
    expect(mocks.end).toHaveBeenCalledTimes(1);
  });

  it('closes the client when connect fails', async () => {
    mocks.connect.mockRejectedValue(new Error('max clients reached'));

    await expect(connectCommentLiveListener('clabcdefghijk012345678901')).rejects.toThrow(
      'max clients reached'
    );
    expect(mocks.end).toHaveBeenCalledTimes(1);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
