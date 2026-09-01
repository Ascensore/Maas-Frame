import { afterEach, describe, expect, it, vi } from 'vitest';
import { dbPoolIdleTimeoutMillis, dbPoolMax } from '@/lib/db-pool';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('dbPoolMax', () => {
  it('uses a single connection on Vercel', () => {
    vi.stubEnv('VERCEL', '1');
    expect(dbPoolMax()).toBe(1);
  });

  it('uses a pool of 20 off Vercel', () => {
    vi.stubEnv('VERCEL', undefined);
    expect(dbPoolMax()).toBe(20);
  });
});

describe('dbPoolIdleTimeoutMillis', () => {
  it('releases idle Vercel clients after 5 seconds', () => {
    vi.stubEnv('VERCEL', '1');
    expect(dbPoolIdleTimeoutMillis()).toBe(5000);
  });

  it('keeps idle clients for 30 seconds off Vercel', () => {
    vi.stubEnv('VERCEL', undefined);
    expect(dbPoolIdleTimeoutMillis()).toBe(30000);
  });
});
