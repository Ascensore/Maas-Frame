import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logError } from '@/lib/logger';

// Prisma's client errors are real classes, so `err.constructor.name` is what the
// sanitiser branches on. Reproducing them as classes rather than as plain objects
// with a `name` property is the only way to exercise the branch the way production
// reaches it.
class PrismaClientKnownRequestError extends Error {
  code: string;
  meta?: Record<string, unknown>;
  constructor(message: string, code: string, meta?: Record<string, unknown>) {
    super(message);
    this.name = 'PrismaClientKnownRequestError';
    this.code = code;
    this.meta = meta;
  }
}

class PrismaClientValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrismaClientValidationError';
  }
}

class PrismaClientInitializationError extends Error {
  errorCode: string;
  constructor(message: string) {
    super(message);
    this.name = 'PrismaClientInitializationError';
    this.errorCode = 'P1001';
  }
}

// A Stripe SDK error, shaped the way the sanitiser detects it: a string `type`
// alongside a numeric `statusCode`.
class StripeCardError extends Error {
  type = 'StripeCardError';
  statusCode = 402;
  constructor(message: string) {
    super(message);
    this.name = 'StripeCardError';
  }
}

// The kind of message a Prisma failure actually carries: the failing statement,
// the table and column names, and the literal values from the WHERE clause. None
// of this may reach a log sink.
const LEAKY_PRISMA_MESSAGE = [
  'Invalid `prisma.user.findUnique()` invocation:',
  'Raw query failed. Code: `42P01`.',
  'SELECT "public"."User"."id", "public"."User"."passwordHash" FROM "public"."User"',
  'WHERE "public"."User"."email" = \'victim@example.com\' LIMIT 1 OFFSET 0',
].join('\n');

// Swallows the output as well as capturing it, so the suite stays quiet.
function spyOnConsoleError() {
  return vi.spyOn(console, 'error').mockImplementation(() => {});
}

let errorSpy: ReturnType<typeof spyOnConsoleError>;

function loggedPayload(): unknown {
  expect(errorSpy).toHaveBeenCalledTimes(1);
  return errorSpy.mock.calls[0]![1];
}

function loggedText(): string {
  return JSON.stringify(loggedPayload() ?? null);
}

beforeEach(() => {
  errorSpy = spyOnConsoleError();
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe('logError', () => {
  describe('Prisma errors', () => {
    it('redacts a Prisma message carrying raw SQL down to the error code', () => {
      logError(
        'user lookup failed',
        new PrismaClientKnownRequestError(LEAKY_PRISMA_MESSAGE, 'P2002')
      );

      expect(loggedPayload()).toEqual({
        type: 'PrismaError',
        code: 'P2002',
        message: 'Database error [P2002]',
      });
    });

    it('leaks no fragment of the original SQL, table names or WHERE values', () => {
      logError(
        'user lookup failed',
        new PrismaClientKnownRequestError(LEAKY_PRISMA_MESSAGE, 'P2002')
      );

      const text = loggedText();
      expect(text).not.toContain('SELECT');
      expect(text).not.toContain('passwordHash');
      expect(text).not.toContain('victim@example.com');
      expect(text).not.toContain('prisma.user.findUnique');
      expect(text).not.toContain('"public"."User"');
    });

    it('never logs the `meta` object, which repeats the offending field values', () => {
      const err = new PrismaClientKnownRequestError('Unique constraint failed', 'P2002', {
        target: ['email'],
        value: 'victim@example.com',
      });

      logError('create failed', err);

      expect(loggedText()).not.toContain('victim@example.com');
      expect(loggedPayload()).toEqual({
        type: 'PrismaError',
        code: 'P2002',
        message: 'Database error [P2002]',
      });
    });

    it('substitutes UNKNOWN when the Prisma error carries no code', () => {
      logError('validation failed', new PrismaClientValidationError(LEAKY_PRISMA_MESSAGE));

      expect(loggedPayload()).toEqual({
        type: 'PrismaError',
        code: 'UNKNOWN',
        message: 'Database error [UNKNOWN]',
      });
    });

    it('redacts a Prisma initialization error, whose message embeds the database url', () => {
      const err = new PrismaClientInitializationError(
        "Can't reach database server at `postgresql://admin:hunter2@db.internal:5432`"
      );

      logError('startup failed', err);

      const text = loggedText();
      expect(text).not.toContain('hunter2');
      expect(text).not.toContain('db.internal');
      // `errorCode`, not `code`, so the string branch does not match it.
      expect(loggedPayload()).toEqual({
        type: 'PrismaError',
        code: 'UNKNOWN',
        message: 'Database error [UNKNOWN]',
      });
    });

    it('ignores a non-string Prisma code rather than logging it', () => {
      const err = new PrismaClientKnownRequestError('boom', 'P2002');
      (err as unknown as Record<string, unknown>).code = 2002;

      logError('create failed', err);

      expect(loggedPayload()).toEqual({
        type: 'PrismaError',
        code: 'UNKNOWN',
        message: 'Database error [UNKNOWN]',
      });
    });

    it('prefers the Prisma branch over the Stripe branch when an error matches both', () => {
      const err = new PrismaClientKnownRequestError(LEAKY_PRISMA_MESSAGE, 'P2002');
      const anyErr = err as unknown as Record<string, unknown>;
      anyErr.type = 'invalid_request_error';
      anyErr.statusCode = 400;

      logError('ambiguous failure', err);

      // If the ordering flipped, `message: err.message` would ship the SQL.
      expect(loggedPayload()).toEqual({
        type: 'PrismaError',
        code: 'P2002',
        message: 'Database error [P2002]',
      });
    });

    // Documents a real limitation rather than an intended behaviour: the branch
    // keys on the constructor name, so an error that only claims to be a Prisma
    // error through `err.name` (a re-thrown, deserialised or minified one) falls
    // through to the generic branch and its message is logged verbatim.
    it('does not redact an error that is Prisma only by its `name` property', () => {
      const err = new Error(LEAKY_PRISMA_MESSAGE);
      err.name = 'PrismaClientKnownRequestError';

      logError('user lookup failed', err);

      expect(loggedPayload()).toEqual({ type: 'Error', message: LEAKY_PRISMA_MESSAGE });
    });
  });

  describe('Stripe errors', () => {
    it('keeps the message and records the http status as the code', () => {
      logError('charge failed', new StripeCardError('Your card was declined.'));

      expect(loggedPayload()).toEqual({
        type: 'StripeCardError',
        code: '402',
        message: 'Your card was declined.',
      });
    });

    it('reports the SDK `type` field rather than the class name', () => {
      const err = new StripeCardError('No such customer: cus_123');
      (err as unknown as Record<string, unknown>).type = 'invalid_request_error';

      logError('portal failed', err);

      expect(loggedPayload()).toMatchObject({ type: 'invalid_request_error', code: '402' });
    });

    it('falls through to the generic branch when statusCode is not numeric', () => {
      const err = new StripeCardError('Your card was declined.');
      (err as unknown as Record<string, unknown>).statusCode = '402';

      logError('charge failed', err);

      expect(loggedPayload()).toEqual({
        type: 'StripeCardError',
        message: 'Your card was declined.',
      });
    });

    it('falls through to the generic branch when `type` is not a string', () => {
      const err = new StripeCardError('Your card was declined.');
      (err as unknown as Record<string, unknown>).type = 7;

      logError('charge failed', err);

      expect(loggedPayload()).toEqual({
        type: 'StripeCardError',
        message: 'Your card was declined.',
      });
    });
  });

  describe('plain errors', () => {
    it('logs the type and message of an ordinary Error', () => {
      logError('something broke', new Error('boom'));

      expect(loggedPayload()).toEqual({ type: 'Error', message: 'boom' });
    });

    it('reports the subclass name as the type', () => {
      class UploadRejectedError extends Error {}

      logError('upload failed', new UploadRejectedError('too large'));

      expect(loggedPayload()).toEqual({ type: 'UploadRejectedError', message: 'too large' });
    });

    it('never includes the stack trace, which exposes absolute server paths', () => {
      const err = new Error('boom');
      err.stack = 'Error: boom\n    at /srv/openframe/app/api/projects/route.ts:42:11';

      logError('something broke', err);

      expect(loggedPayload()).not.toHaveProperty('stack');
      expect(loggedText()).not.toContain('/srv/openframe');
    });

    it('does not include a `cause`, which can wrap the original driver error', () => {
      const err = new Error('wrapped', { cause: new Error(LEAKY_PRISMA_MESSAGE) });

      logError('something broke', err);

      expect(loggedPayload()).toEqual({ type: 'Error', message: 'wrapped' });
      expect(loggedText()).not.toContain('SELECT');
    });

    it('handles a TypeError thrown by the runtime itself', () => {
      logError('bad access', new TypeError("Cannot read properties of undefined (reading 'id')"));

      expect(loggedPayload()).toEqual({
        type: 'TypeError',
        message: "Cannot read properties of undefined (reading 'id')",
      });
    });
  });

  describe('non-Error values', () => {
    // These were constructed by the caller, so they are already whatever the
    // caller decided to expose and are passed through untouched.
    it.each([
      ['a string', 'plain failure text'],
      ['a number', 42],
      ['a boolean', false],
      ['null', null],
      ['undefined', undefined],
    ])('passes %s through unchanged', (_label, value) => {
      logError('context', value);

      expect(loggedPayload()).toBe(value);
    });

    it('passes a structured object through by reference', () => {
      const payload = { status: 502, provider: 'bunny' };

      logError('upstream refused', payload);

      expect(loggedPayload()).toBe(payload);
    });

    it('passes an Error-shaped plain object through, since it is not an Error instance', () => {
      const payload = { name: 'PrismaClientKnownRequestError', message: LEAKY_PRISMA_MESSAGE };

      logError('context', payload);

      expect(loggedPayload()).toBe(payload);
    });
  });

  it('writes to console.error with the context string first and the payload second', () => {
    logError('projects.POST failed', new Error('boom'));

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]).toHaveLength(2);
    expect(errorSpy.mock.calls[0]![0]).toBe('projects.POST failed');
  });

  it('returns undefined rather than the sanitized payload', () => {
    expect(logError('context', new Error('boom'))).toBeUndefined();
  });
});
