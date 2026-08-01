import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  decodeFirstTouch,
  encodeFirstTouch,
  generateAnonymousId,
  isAcquisitionChannel,
  isValidAnonymousId,
  readAnonymousIdCookie,
  readFirstTouchCookie,
  signAnonymousId,
  signFirstTouch,
  type FirstTouch,
} from '@/lib/analytics/cookies';
import { isCountableDocumentRequest, isLikelyBot } from '@/lib/analytics/bots';

beforeEach(() => {
  vi.stubEnv('NEXTAUTH_SECRET', 'cookie-test-secret');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The cookie body a forged value would have to carry, in the wire form the reader expects. */
function body(payload: unknown): string {
  return btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const TOUCH: FirstTouch = {
  channel: 'GITHUB',
  utmSource: 'github',
  utmMedium: 'readme',
  utmCampaign: 'launch',
  referrerHost: 'github.com',
  landingPath: '/vs/frameio',
};

describe('first touch cookie', () => {
  it('round-trips every field', () => {
    expect(decodeFirstTouch(encodeFirstTouch(TOUCH))).toEqual(TOUCH);
  });

  it('round-trips a touch with nothing but a channel', () => {
    const bare: FirstTouch = {
      channel: 'DIRECT',
      utmSource: null,
      utmMedium: null,
      utmCampaign: null,
      referrerHost: null,
      landingPath: '/',
    };
    expect(decodeFirstTouch(encodeFirstTouch(bare))).toEqual(bare);
  });

  it('rejects a hand-edited cookie carrying an unknown channel', () => {
    expect(decodeFirstTouch(body({ c: 'INVESTOR_DEMO', p: '/' }))).toBeNull();
  });

  it('re-sanitizes fields rather than trusting the cookie', () => {
    const decoded = decodeFirstTouch(
      body({ c: 'DIRECT', p: '/x', s: '<script>alert(1)</script>', r: 'not a host' })
    );
    expect(decoded?.utmSource).toBeNull();
    expect(decoded?.referrerHost).toBeNull();
  });

  it('re-sanitizes a landing path that could only have been hand-written', () => {
    expect(decodeFirstTouch(body({ c: 'DIRECT', p: '/<img src=x onerror=1>' }))?.landingPath).toBe(
      '/'
    );
  });

  it('returns null for garbage and for an absent cookie', () => {
    expect(decodeFirstTouch('%%%not-base64%%%')).toBeNull();
    expect(decodeFirstTouch(null)).toBeNull();
    expect(decodeFirstTouch(body(['DIRECT']))).toBeNull();
  });
});

describe('anonymous id', () => {
  it('generates an id the validator accepts', () => {
    expect(isValidAnonymousId(generateAnonymousId())).toBe(true);
  });

  it('generates a different id each time', () => {
    expect(generateAnonymousId()).not.toBe(generateAnonymousId());
  });

  it('rejects an id that is too short, too long or not base36', () => {
    expect(isValidAnonymousId('abc')).toBe(false);
    expect(isValidAnonymousId('a'.repeat(65))).toBe(false);
    expect(isValidAnonymousId('ABCDEF0123456789ABCD')).toBe(false);
    expect(isValidAnonymousId(undefined)).toBe(false);
  });
});

// Everything above tests the unsigned inner layer. Nothing outside the module
// uses it: a cookie is only a visitor once the signature says this deployment
// issued it, which is what stops a caller from inventing one with curl.
describe('signed cookies', () => {
  const TOUCH_TO_SIGN: FirstTouch = {
    channel: 'YOUTUBE',
    utmSource: 'yt',
    utmMedium: null,
    utmCampaign: null,
    referrerHost: 'youtube.com',
    landingPath: '/',
  };

  it('round-trips an id and a first touch', async () => {
    const id = generateAnonymousId();
    expect(await readAnonymousIdCookie(await signAnonymousId(id))).toBe(id);
    expect(await readFirstTouchCookie(await signFirstTouch(TOUCH_TO_SIGN))).toEqual(TOUCH_TO_SIGN);
  });

  it('rejects a well-formed id that carries no signature', async () => {
    expect(await readAnonymousIdCookie('a1b2c3d4e5f60718293a4b5c6d7e8f90')).toBeNull();
  });

  it('rejects a value whose body was edited under a valid signature', async () => {
    const signed = (await signAnonymousId(generateAnonymousId())) ?? '';
    const [mac] = signed.split('.');

    expect(await readAnonymousIdCookie(`${mac}.a1b2c3d4e5f60718293a4b5c6d7e8f90`)).toBeNull();
  });

  it('rejects a first touch re-signed to name another channel', async () => {
    const forgedBody = encodeFirstTouch({ ...TOUCH_TO_SIGN, channel: 'GITHUB' });
    const signed = (await signFirstTouch(TOUCH_TO_SIGN)) ?? '';
    const [mac] = signed.split('.');

    expect(await readFirstTouchCookie(`${mac}.${forgedBody}`)).toBeNull();
  });

  it('rejects a cookie signed with another deployment key', async () => {
    const signed = await signAnonymousId(generateAnonymousId());

    vi.stubEnv('NEXTAUTH_SECRET', 'someone-elses-secret');

    expect(await readAnonymousIdCookie(signed)).toBeNull();
  });

  it('signs nothing and accepts nothing when there is no secret', async () => {
    const signed = await signAnonymousId(generateAnonymousId());

    vi.stubEnv('NEXTAUTH_SECRET', undefined);
    vi.stubEnv('AUTH_SECRET', undefined);

    expect(await signAnonymousId(generateAnonymousId())).toBeNull();
    expect(await readAnonymousIdCookie(signed)).toBeNull();
  });

  it('rejects the empty, the truncated and the separator-less', async () => {
    expect(await readAnonymousIdCookie('')).toBeNull();
    expect(await readAnonymousIdCookie(undefined)).toBeNull();
    expect(await readAnonymousIdCookie('.')).toBeNull();
    expect(await readAnonymousIdCookie('a'.repeat(22))).toBeNull();
    expect(await readFirstTouchCookie('not-signed-at-all')).toBeNull();
  });
});

describe('isAcquisitionChannel', () => {
  it('accepts the nine buckets and nothing else', () => {
    expect(isAcquisitionChannel('REVIEW_LINK')).toBe(true);
    expect(isAcquisitionChannel('direct')).toBe(false);
    expect(isAcquisitionChannel(7)).toBe(false);
  });
});

describe('isLikelyBot', () => {
  it('passes a real browser through', () => {
    expect(
      isLikelyBot(
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36'
      )
    ).toBe(false);
  });

  it('catches crawlers, link previewers and scripts', () => {
    expect(isLikelyBot('Googlebot/2.1 (+http://www.google.com/bot.html)')).toBe(true);
    expect(isLikelyBot('facebookexternalhit/1.1')).toBe(true);
    expect(isLikelyBot('curl/8.4.0')).toBe(true);
    expect(isLikelyBot('python-requests/2.31.0')).toBe(true);
    expect(isLikelyBot('HeadlessChrome/120.0.0.0')).toBe(true);
  });

  it('treats a missing user agent as a bot', () => {
    expect(isLikelyBot('')).toBe(true);
    expect(isLikelyBot(null)).toBe(true);
  });
});

describe('isCountableDocumentRequest', () => {
  it('counts a real page load', () => {
    expect(isCountableDocumentRequest(new Headers({ 'sec-fetch-dest': 'document' }))).toBe(true);
  });

  it('does not count a prefetch of the register page', () => {
    expect(
      isCountableDocumentRequest(
        new Headers({ 'sec-fetch-dest': 'document', 'sec-purpose': 'prefetch;prerender' })
      )
    ).toBe(false);
    expect(
      isCountableDocumentRequest(
        new Headers({ 'sec-fetch-dest': 'document', 'next-router-prefetch': '1' })
      )
    ).toBe(false);
  });

  it('does not count an RSC navigation or a subresource', () => {
    expect(
      isCountableDocumentRequest(new Headers({ 'sec-fetch-dest': 'document', rsc: '1' }))
    ).toBe(false);
    expect(isCountableDocumentRequest(new Headers({ 'sec-fetch-dest': 'image' }))).toBe(false);
  });

  it('falls back to the accept header when fetch metadata is missing', () => {
    expect(isCountableDocumentRequest(new Headers({ accept: 'text/html,*/*' }))).toBe(true);
    expect(isCountableDocumentRequest(new Headers({ accept: 'application/json' }))).toBe(false);
    expect(isCountableDocumentRequest(new Headers())).toBe(false);
  });
});
