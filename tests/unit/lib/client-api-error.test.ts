import { describe, expect, it } from 'vitest';
import { readClientApiError } from '@/lib/client/api-error';

/**
 * The message four hooks put on screen when a request fails. Every branch here
 * is a shape one of our own routes actually answers with, and getting one of
 * them wrong shows the caller a generic fallback in place of the reason.
 */
describe('readClientApiError', () => {
  it('reads the string an API route wrote', () => {
    expect(readClientApiError({ error: 'Storage quota exceeded' }, 'Failed')).toBe(
      'Storage quota exceeded'
    );
  });

  it('reads a nested { error: { message } } rather than falling back', () => {
    // What an unwrapped validation error looks like by the time it reaches the
    // client. Reading only the top-level string would hide the one sentence
    // that says what is wrong with the request.
    expect(readClientApiError({ error: { message: 'text: Too big' } }, 'Failed')).toBe(
      'text: Too big'
    );
  });

  it('falls back for every shape that carries no message', () => {
    const fallback = 'Failed to save the line';
    // A body that was not JSON parses to null; the rest are answers with an
    // `error` that says nothing a person can read.
    expect(readClientApiError(null, fallback)).toBe(fallback);
    expect(readClientApiError(undefined, fallback)).toBe(fallback);
    expect(readClientApiError('Internal Server Error', fallback)).toBe(fallback);
    expect(readClientApiError({}, fallback)).toBe(fallback);
    expect(readClientApiError({ error: '   ' }, fallback)).toBe(fallback);
    expect(readClientApiError({ error: { message: '  ' } }, fallback)).toBe(fallback);
    expect(readClientApiError({ error: { code: 'E_NOPE' } }, fallback)).toBe(fallback);
    expect(readClientApiError({ error: 42 }, fallback)).toBe(fallback);
  });
});
