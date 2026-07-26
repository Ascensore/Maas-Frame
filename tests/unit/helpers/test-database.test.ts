import { describe, expect, it } from 'vitest';

import { assertTestDatabase } from '../../helpers/test-database';

const CREDENTIALS = 'openframe:hunter2';

function url(database: string, host = 'localhost:5432'): string {
  return `postgresql://${CREDENTIALS}@${host}/${database}?schema=public`;
}

describe('assertTestDatabase', () => {
  it.each([
    ['the name the compose file and CI both use', 'openframe_test'],
    ['a per-suite database from a parallel api run', 'openframe_test_api'],
    ['a dash instead of an underscore', 'openframe-test'],
    ['a leading test segment', 'test_openframe'],
    ['nothing but the word itself', 'test'],
    ['an upper-case spelling', 'openframe_TEST'],
  ])('accepts %s', (_label, database) => {
    expect(() => assertTestDatabase(url(database))).not.toThrow();
  });

  it.each([
    ['the production database', 'openframe'],
    ['a name that merely starts with the letters', 'testimonials'],
    ['a name that merely ends with them', 'latest'],
    ['an empty database name', ''],
  ])('rejects %s', (_label, database) => {
    expect(() => assertTestDatabase(url(database))).toThrow(/Refusing to run the test setup/);
  });

  it('rejects a remote host just the same when the name is not a test one', () => {
    expect(() => assertTestDatabase(url('openframe', '157.90.147.190:3799'))).toThrow(
      /database "openframe" on 157\.90\.147\.190/
    );
  });

  it('points at the missing .env.test, which is what actually causes this', () => {
    expect(() => assertTestDatabase(url('openframe'))).toThrow(
      /cp \.env\.test\.example \.env\.test/
    );
  });

  it('keeps the password out of the message, which ends up in logs', () => {
    expect(() => assertTestDatabase(url('openframe'))).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('hunter2') })
    );
  });

  it('decodes a percent-encoded database name before judging it', () => {
    expect(() => assertTestDatabase(url('openframe%5Ftest'))).not.toThrow();
  });

  it('refuses a connection string it cannot parse rather than assuming the best', () => {
    expect(() => assertTestDatabase('not-a-url')).toThrow(/not a valid connection string/);
  });
});
