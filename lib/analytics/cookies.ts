// The two cookies the acquisition system sets, and how to read them back.
//
// Both are first party, both stay on this deployment's own domain, and neither
// is readable from JavaScript. They exist so that a visitor who arrives from a
// YouTube link on Tuesday and signs up on Friday is still counted against
// YouTube; there is no cross-site identifier and nothing is sent anywhere.
//
// Imported by the proxy, so this file must stay free of Prisma and of anything
// else that cannot run on the edge.

import type { AcquisitionChannel } from '@prisma/client';
import { sanitizeLandingPath, sanitizeTag, normalizeHost } from '@/lib/analytics/channel';

export const ANONYMOUS_ID_COOKIE = 'of_aid';
export const FIRST_TOUCH_COOKIE = 'of_ft';

export const ANONYMOUS_ID_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/** cuid-ish length bound. Values outside it are treated as absent, not repaired. */
const ANONYMOUS_ID_PATTERN = /^[a-z0-9]{16,64}$/;

export interface FirstTouch {
  channel: AcquisitionChannel;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  referrerHost: string | null;
  landingPath: string;
}

/** Short keys: this rides on every request, so the wire form stays compact. */
interface EncodedFirstTouch {
  c: string;
  s?: string;
  m?: string;
  k?: string;
  r?: string;
  p: string;
}

const CHANNELS: readonly AcquisitionChannel[] = [
  'DIRECT',
  'GITHUB',
  'YOUTUBE',
  'GOOGLE',
  'REVIEW_LINK',
  'REFERRAL',
  'OUTBOUND',
  'COMMUNITY',
  'OTHER',
];

export function isAcquisitionChannel(value: unknown): value is AcquisitionChannel {
  return typeof value === 'string' && (CHANNELS as readonly string[]).includes(value);
}

export function isValidAnonymousId(value: string | null | undefined): value is string {
  return typeof value === 'string' && ANONYMOUS_ID_PATTERN.test(value);
}

/** 26 lowercase base36 characters from the Web Crypto API, which the edge has. */
export function generateAnonymousId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let id = '';
  for (const byte of bytes) {
    id += byte.toString(36).padStart(2, '0');
  }
  return id;
}

export function encodeFirstTouch(touch: FirstTouch): string {
  const payload: EncodedFirstTouch = { c: touch.channel, p: touch.landingPath };
  if (touch.utmSource) payload.s = touch.utmSource;
  if (touch.utmMedium) payload.m = touch.utmMedium;
  if (touch.utmCampaign) payload.k = touch.utmCampaign;
  if (touch.referrerHost) payload.r = touch.referrerHost;
  return encodeURIComponent(JSON.stringify(payload));
}

/**
 * Parses the cookie back, re-sanitizing every field.
 *
 * The cookie is httpOnly but it still came from the client, so a hand-edited one
 * must not be able to put arbitrary text into a database column. Anything that
 * fails validation makes the whole value null: a half-trusted first touch is
 * worse than none.
 */
export function decodeFirstTouch(raw: string | null | undefined): FirstTouch | null {
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(raw));
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;
  const value = parsed as Record<string, unknown>;

  if (!isAcquisitionChannel(value.c)) return null;
  if (typeof value.p !== 'string') return null;

  return {
    channel: value.c,
    utmSource: sanitizeTag(typeof value.s === 'string' ? value.s : null),
    utmMedium: sanitizeTag(typeof value.m === 'string' ? value.m : null),
    utmCampaign: sanitizeTag(typeof value.k === 'string' ? value.k : null),
    referrerHost: normalizeHost(typeof value.r === 'string' ? value.r : null),
    landingPath: sanitizeLandingPath(value.p),
  };
}
