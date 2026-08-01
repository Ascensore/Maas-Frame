import { describe, it, expect } from 'vitest';
import {
  decodeFirstTouch,
  encodeFirstTouch,
  generateAnonymousId,
  isAcquisitionChannel,
  isValidAnonymousId,
  type FirstTouch,
} from '@/lib/analytics/cookies';
import { isCountableDocumentRequest, isLikelyBot } from '@/lib/analytics/bots';

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
    const forged = encodeURIComponent(JSON.stringify({ c: 'INVESTOR_DEMO', p: '/' }));
    expect(decodeFirstTouch(forged)).toBeNull();
  });

  it('re-sanitizes fields rather than trusting the cookie', () => {
    const forged = encodeURIComponent(
      JSON.stringify({ c: 'DIRECT', p: '/x', s: '<script>alert(1)</script>', r: 'not a host' })
    );
    const decoded = decodeFirstTouch(forged);
    expect(decoded?.utmSource).toBeNull();
    expect(decoded?.referrerHost).toBeNull();
  });

  it('returns null for garbage and for an absent cookie', () => {
    expect(decodeFirstTouch('%%%not-json%%%')).toBeNull();
    expect(decodeFirstTouch(null)).toBeNull();
    expect(decodeFirstTouch(encodeURIComponent(JSON.stringify(['DIRECT'])))).toBeNull();
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
