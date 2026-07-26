import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import {
  createR2UploadToken,
  parseR2UploadToken,
  verifyR2UploadToken,
  type R2UploadTokenSubject,
} from '@/lib/r2-upload-token';

const SECRET = 'r2-upload-token-test-secret';
const OTHER_SECRET = 'a-completely-different-secret';
const NOW = new Date('2026-01-15T12:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const ONE_HOUR = 60 * 60;

const SUBJECT = {
  userId: 'user-1',
  projectId: 'project-1',
  objectKey: 'projects/project-1/videos/video-1/source.mp4',
  sessionId: 'session-1',
  tokenId: 'token-1',
  thumbnailObjectKey: 'projects/project-1/videos/video-1/thumb.jpg',
} satisfies R2UploadTokenSubject & {
  sessionId: string;
  tokenId: string;
  thumbnailObjectKey: string;
};

/**
 * Mints a token over an arbitrary payload with a valid signature. Signatures are
 * never hardcoded here: they depend on the secret, so every expectation is about
 * behaviour. This exists only to reach the payload-shape checks, which a forged
 * signature can never get past.
 */
function signArbitrary(payload: unknown, secret = SECRET): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

/**
 * Signs raw JSON text rather than an object. JSON.stringify cannot emit a
 * non-finite number, so this is the only way to hand verify() a payload whose
 * `iat` or `exp` parses back as Infinity: a decimal exponent that overflows to
 * it, which JSON.parse accepts and turns into Infinity.
 */
function signRawJson(json: string, secret = SECRET): string {
  const encoded = Buffer.from(json, 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function wellFormedPayload(overrides: Record<string, unknown> = {}) {
  return {
    typ: 'r2-upload',
    uid: SUBJECT.userId,
    pid: SUBJECT.projectId,
    key: SUBJECT.objectKey,
    sid: SUBJECT.sessionId,
    jti: SUBJECT.tokenId,
    tkey: SUBJECT.thumbnailObjectKey,
    iat: NOW_SECONDS,
    exp: NOW_SECONDS + ONE_HOUR,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv('R2_UPLOAD_TOKEN_SECRET', SECRET);
  vi.stubEnv('NEXTAUTH_SECRET', undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('createR2UploadToken', () => {
  it('produces a two-part token separated by a dot', () => {
    expect(createR2UploadToken(SUBJECT).split('.')).toHaveLength(2);
  });

  it('encodes the subject and the issue and expiry times into the payload', () => {
    const payload = parseR2UploadToken(createR2UploadToken(SUBJECT));

    expect(payload).toEqual({
      typ: 'r2-upload',
      uid: 'user-1',
      pid: 'project-1',
      key: 'projects/project-1/videos/video-1/source.mp4',
      sid: 'session-1',
      jti: 'token-1',
      tkey: 'projects/project-1/videos/video-1/thumb.jpg',
      iat: NOW_SECONDS,
      exp: NOW_SECONDS + ONE_HOUR,
    });
  });

  it('defaults to a one hour lifetime', () => {
    const payload = parseR2UploadToken(createR2UploadToken(SUBJECT));

    expect(payload!.exp - payload!.iat).toBe(3600);
  });

  it('honours an explicit ttl', () => {
    const payload = parseR2UploadToken(createR2UploadToken(SUBJECT, 90));

    expect(payload!.exp - payload!.iat).toBe(90);
  });

  it('uses base64url, so the token survives a query string unescaped', () => {
    const token = createR2UploadToken(SUBJECT);

    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(token)).toBe(token);
  });

  it('prefers R2_UPLOAD_TOKEN_SECRET over NEXTAUTH_SECRET', () => {
    vi.stubEnv('NEXTAUTH_SECRET', OTHER_SECRET);
    const token = createR2UploadToken(SUBJECT);

    // Verifying with only NEXTAUTH_SECRET available must fail, which it can only
    // do if the dedicated variable was the one that signed.
    vi.stubEnv('R2_UPLOAD_TOKEN_SECRET', undefined);
    expect(verifyR2UploadToken(token, SUBJECT)).toBe(false);
  });

  it('falls back to NEXTAUTH_SECRET when the dedicated secret is unset', () => {
    vi.stubEnv('R2_UPLOAD_TOKEN_SECRET', undefined);
    vi.stubEnv('NEXTAUTH_SECRET', OTHER_SECRET);

    expect(verifyR2UploadToken(createR2UploadToken(SUBJECT), SUBJECT)).toBe(true);
  });

  it('refuses to mint a token when no secret is configured at all', () => {
    vi.stubEnv('R2_UPLOAD_TOKEN_SECRET', undefined);
    vi.stubEnv('NEXTAUTH_SECRET', undefined);

    expect(() => createR2UploadToken(SUBJECT)).toThrow(
      'Missing R2_UPLOAD_TOKEN_SECRET or NEXTAUTH_SECRET.'
    );
  });
});

describe('verifyR2UploadToken', () => {
  it('accepts a freshly signed token for the subject it was minted for', () => {
    expect(verifyR2UploadToken(createR2UploadToken(SUBJECT), SUBJECT)).toBe(true);
  });

  it('rejects a token whose payload was tampered with', () => {
    const token = createR2UploadToken(SUBJECT);
    const [encodedPayload, signature] = token.split('.');
    const payload = JSON.parse(Buffer.from(encodedPayload!, 'base64url').toString('utf8'));
    payload.pid = 'project-victim';
    const forged = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

    expect(verifyR2UploadToken(`${forged}.${signature}`, SUBJECT)).toBe(false);
  });

  it('rejects a token whose signature was tampered with', () => {
    const token = createR2UploadToken(SUBJECT);
    const [encodedPayload, signature] = token.split('.');
    const flipped = (signature![0] === 'A' ? 'B' : 'A') + signature!.slice(1);

    expect(verifyR2UploadToken(`${encodedPayload}.${flipped}`, SUBJECT)).toBe(false);
  });

  it('rejects a token signed under a different secret', () => {
    const token = createR2UploadToken(SUBJECT);

    vi.stubEnv('R2_UPLOAD_TOKEN_SECRET', OTHER_SECRET);

    expect(verifyR2UploadToken(token, SUBJECT)).toBe(false);
  });

  it('rejects a token that has expired', () => {
    const token = createR2UploadToken(SUBJECT, 60);

    vi.setSystemTime(new Date(NOW.getTime() + 61_000));

    expect(verifyR2UploadToken(token, SUBJECT)).toBe(false);
  });

  it('still accepts a token in its final second', () => {
    const token = createR2UploadToken(SUBJECT, 60);

    vi.setSystemTime(new Date(NOW.getTime() + 59_000));

    expect(verifyR2UploadToken(token, SUBJECT)).toBe(true);
  });

  it('accepts a token at the exact expiry second and rejects it one second later', () => {
    const token = createR2UploadToken(SUBJECT, 60);

    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    expect(verifyR2UploadToken(token, SUBJECT)).toBe(true);

    vi.setSystemTime(new Date(NOW.getTime() + 61_000));
    expect(verifyR2UploadToken(token, SUBJECT)).toBe(false);
  });

  it('rejects a token minted with a zero ttl once the clock moves on', () => {
    const token = createR2UploadToken(SUBJECT, 0);

    vi.setSystemTime(new Date(NOW.getTime() + 1_000));

    expect(verifyR2UploadToken(token, SUBJECT)).toBe(false);
  });

  it.each([
    ['a different user', { userId: 'user-2' }],
    ['a different project', { projectId: 'project-2' }],
    ['a different object key', { objectKey: 'projects/project-1/videos/video-2/source.mp4' }],
    ['a different upload session', { sessionId: 'session-2' }],
    ['a different token id', { tokenId: 'token-2' }],
    ['a different thumbnail key', { thumbnailObjectKey: 'projects/other/thumb.jpg' }],
  ])('rejects a valid token presented for %s', (_label, override) => {
    const token = createR2UploadToken(SUBJECT);

    expect(verifyR2UploadToken(token, { ...SUBJECT, ...override })).toBe(false);
  });

  it('rejects an object key that differs only by a traversal segment', () => {
    const token = createR2UploadToken(SUBJECT);

    expect(
      verifyR2UploadToken(token, {
        ...SUBJECT,
        objectKey: 'projects/project-1/videos/video-1/../video-2/source.mp4',
      })
    ).toBe(false);
  });

  it('skips the optional session, token id and thumbnail checks when the caller omits them', () => {
    const token = createR2UploadToken(SUBJECT);

    expect(
      verifyR2UploadToken(token, {
        userId: SUBJECT.userId,
        projectId: SUBJECT.projectId,
        objectKey: SUBJECT.objectKey,
      })
    ).toBe(true);
  });

  it.each([
    ['an empty string', ''],
    ['whitespace', '   '],
    ['a single segment', 'notatoken'],
    ['three segments', 'a.b.c'],
    ['a missing signature', 'YWJj.'],
    ['a missing payload', '.c2ln'],
    ['two empty segments', '.'],
    ['a jwt-shaped token', 'eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOiJ1c2VyLTEifQ.sig'],
    ['punctuation only', '!!!.???'],
  ])('refuses %s rather than throwing', (_label, token) => {
    expect(() => verifyR2UploadToken(token, SUBJECT)).not.toThrow();
    expect(verifyR2UploadToken(token, SUBJECT)).toBe(false);
  });

  it('refuses a signature of the wrong length without letting timingSafeEqual throw', () => {
    const [encodedPayload] = createR2UploadToken(SUBJECT).split('.');

    // crypto.timingSafeEqual throws on unequal buffer lengths, so the length
    // guard in front of it is load bearing.
    expect(() => verifyR2UploadToken(`${encodedPayload}.short`, SUBJECT)).not.toThrow();
    expect(verifyR2UploadToken(`${encodedPayload}.short`, SUBJECT)).toBe(false);
  });

  it('refuses a correctly signed payload that is not JSON', () => {
    const encoded = Buffer.from('not json at all', 'utf8').toString('base64url');
    const signature = crypto.createHmac('sha256', SECRET).update(encoded).digest('base64url');

    expect(verifyR2UploadToken(`${encoded}.${signature}`, SUBJECT)).toBe(false);
  });

  it('refuses a correctly signed payload that is a JSON scalar rather than an object', () => {
    expect(verifyR2UploadToken(signArbitrary('user-1'), SUBJECT)).toBe(false);
    expect(verifyR2UploadToken(signArbitrary(null), SUBJECT)).toBe(false);
    expect(verifyR2UploadToken(signArbitrary(42), SUBJECT)).toBe(false);
  });

  it.each([['typ'], ['uid'], ['pid'], ['key'], ['sid'], ['jti'], ['tkey'], ['iat'], ['exp']])(
    'refuses a correctly signed payload missing %s',
    (field) => {
      const payload = wellFormedPayload();
      delete (payload as Record<string, unknown>)[field];

      expect(verifyR2UploadToken(signArbitrary(payload), SUBJECT)).toBe(false);
    }
  );

  it('refuses a correctly signed token minted for a different token type', () => {
    // Stops a bunny-upload grant, signed with the same NEXTAUTH_SECRET fallback,
    // from being replayed against the R2 path.
    expect(
      verifyR2UploadToken(signArbitrary(wellFormedPayload({ typ: 'bunny-upload' })), SUBJECT)
    ).toBe(false);
  });

  it.each([
    ['exp', 'Infinity', Number.POSITIVE_INFINITY],
    ['exp', 'NaN', Number.NaN],
    ['iat', 'Infinity', Number.POSITIVE_INFINITY],
  ])(
    'refuses a correctly signed payload whose %s arrives as null, having been minted as %s',
    (field, _label, value) => {
      // Named for what it actually exercises. JSON.stringify writes both Infinity
      // and NaN as `null`, so the payload reaches verify() with a null and is
      // rejected one line earlier, by the `typeof === 'number'` check. The
      // Number.isFinite guard is never consulted on this path; the case below is
      // the one that reaches it.
      const token = signArbitrary(wellFormedPayload({ [field]: value }));

      expect(
        JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString())[field]
      ).toBeNull();
      expect(verifyR2UploadToken(token, SUBJECT)).toBe(false);
    }
  );

  it.each([['iat'], ['exp']])(
    'refuses a correctly signed payload whose %s is a JSON literal that overflows to Infinity',
    (field) => {
      // The one way a non-finite number survives the wire: `1e999` is legal JSON
      // and JSON.parse turns it into Infinity, which passes the typeof check and
      // leaves Number.isFinite as the only thing standing. For exp that matters,
      // because Infinity < now is false, so without the guard the token would
      // verify and never expire. Minting one still needs the server secret, so
      // this is defence in depth rather than a reachable forgery.
      const json = JSON.stringify(wellFormedPayload()).replace(
        new RegExp(`"${field}":\\d+`),
        `"${field}":1e999`
      );

      expect(JSON.parse(json)[field]).toBe(Number.POSITIVE_INFINITY);
      expect(verifyR2UploadToken(signRawJson(json), SUBJECT)).toBe(false);
    }
  );

  it('refuses a correctly signed payload whose exp is a numeric string', () => {
    const token = signArbitrary(wellFormedPayload({ exp: String(NOW_SECONDS + ONE_HOUR) }));

    expect(verifyR2UploadToken(token, SUBJECT)).toBe(false);
  });

  it('returns false rather than throwing when the server has no secret configured', () => {
    const token = createR2UploadToken(SUBJECT);

    vi.stubEnv('R2_UPLOAD_TOKEN_SECRET', undefined);
    vi.stubEnv('NEXTAUTH_SECRET', undefined);

    // A misconfigured server is indistinguishable from a forged token here.
    expect(verifyR2UploadToken(token, SUBJECT)).toBe(false);
  });
});

describe('parseR2UploadToken', () => {
  it('returns the payload of a valid token', () => {
    expect(parseR2UploadToken(createR2UploadToken(SUBJECT))).toMatchObject({
      typ: 'r2-upload',
      uid: 'user-1',
    });
  });

  it('returns null for a token signed under a different secret', () => {
    const token = createR2UploadToken(SUBJECT);

    vi.stubEnv('R2_UPLOAD_TOKEN_SECRET', OTHER_SECRET);

    expect(parseR2UploadToken(token)).toBeNull();
  });

  it('returns null for an expired token', () => {
    const token = createR2UploadToken(SUBJECT, 60);

    vi.setSystemTime(new Date(NOW.getTime() + 61_000));

    expect(parseR2UploadToken(token)).toBeNull();
  });

  it('returns null for garbage input rather than throwing', () => {
    expect(parseR2UploadToken('')).toBeNull();
    expect(parseR2UploadToken('a.b.c')).toBeNull();
    expect(parseR2UploadToken('%%%.%%%')).toBeNull();
  });

  it('does not check the payload against any subject, leaving that to the caller', () => {
    // parseR2UploadToken only proves authenticity and freshness. Routes that use
    // it directly must compare the fields themselves.
    const payload = parseR2UploadToken(createR2UploadToken(SUBJECT));

    expect(payload!.uid).toBe('user-1');
  });
});
