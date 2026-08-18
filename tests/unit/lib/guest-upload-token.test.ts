// The grant a share-link visitor gets for a direct upload.
//
// A guest's upload is billed to the workspace owner, not to the guest, so this
// token is the only thing tying what they declared and what they hold to the
// upload it was issued for. Two claims matter here beyond the existing subject
// binding: the provider's own video id, which is what makes releasing the hold
// on the guest's say-so safe, and the declared size, which is what the asset is
// charged until Bunny reports a figure of its own.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createGuestUploadToken,
  readGuestUploadGrant,
  verifyGuestUploadToken,
} from '@/lib/guest-upload-token';

const SUBJECT = {
  projectId: 'project-1',
  videoId: 'video-1',
  intent: 'bunny' as const,
  context: '203.0.113.7:public',
};

const BUNNY_VIDEO_ID = 'bunnyvideo-1-abcdefgh';

beforeEach(() => {
  vi.stubEnv('GUEST_UPLOAD_TOKEN_SECRET', 'test-guest-upload-token-secret');
});

describe('readGuestUploadGrant', () => {
  it('carries back the reservation and the declared size it was signed with', () => {
    const token = createGuestUploadToken({
      ...SUBJECT,
      providerVideoId: BUNNY_VIDEO_ID,
      reservationId: 'reservation-1',
      declaredSizeBytes: BigInt(4096),
    });

    expect(readGuestUploadGrant(token, SUBJECT, BUNNY_VIDEO_ID)).toEqual({
      reservationId: 'reservation-1',
      declaredSizeBytes: BigInt(4096),
    });
  });

  // The binding that makes a guest release safe: presenting this token to cancel
  // deletes the upload it stands for, so it cannot be used to drop the hold of
  // an upload that is still running.
  it('refuses a grant presented against a different provider video', () => {
    const token = createGuestUploadToken({
      ...SUBJECT,
      providerVideoId: BUNNY_VIDEO_ID,
      reservationId: 'reservation-1',
    });

    expect(readGuestUploadGrant(token, SUBJECT, 'bunnyvideo-2-abcdefgh')).toBeNull();
    expect(readGuestUploadGrant(token, SUBJECT, null)).toBeNull();
    expect(verifyGuestUploadToken(token, SUBJECT, 'bunnyvideo-2-abcdefgh')).toBe(false);
  });

  it('still refuses a grant for another subject, bound video or not', () => {
    const token = createGuestUploadToken({
      ...SUBJECT,
      providerVideoId: BUNNY_VIDEO_ID,
      reservationId: 'reservation-1',
    });

    expect(
      readGuestUploadGrant(token, { ...SUBJECT, videoId: 'video-2' }, BUNNY_VIDEO_ID)
    ).toBeNull();
    expect(readGuestUploadGrant(token, { ...SUBJECT, intent: 'image' }, BUNNY_VIDEO_ID)).toBeNull();
    expect(
      readGuestUploadGrant(token, { ...SUBJECT, context: '198.51.100.9:public' }, BUNNY_VIDEO_ID)
    ).toBeNull();
  });

  // The image and audio grants carry none of this, and a grant issued before the
  // claims existed keeps working rather than failing an upload in flight.
  it('reads a grant with no claims as holding nothing', () => {
    const token = createGuestUploadToken({ ...SUBJECT, intent: 'image' });
    const subject = { ...SUBJECT, intent: 'image' as const };

    expect(readGuestUploadGrant(token, subject)).toEqual({
      reservationId: null,
      declaredSizeBytes: null,
    });
    expect(verifyGuestUploadToken(token, subject, BUNNY_VIDEO_ID)).toBe(true);
  });

  it('refuses a forged signature', () => {
    const token = createGuestUploadToken({
      ...SUBJECT,
      providerVideoId: BUNNY_VIDEO_ID,
      reservationId: 'reservation-1',
    });
    const [payload] = token.split('.');

    expect(readGuestUploadGrant(`${payload}.forged`, SUBJECT, BUNNY_VIDEO_ID)).toBeNull();
  });

  it('reads a non-positive declared size as nothing declared', () => {
    const token = createGuestUploadToken({
      ...SUBJECT,
      providerVideoId: BUNNY_VIDEO_ID,
      declaredSizeBytes: BigInt(-1),
    });

    expect(readGuestUploadGrant(token, SUBJECT, BUNNY_VIDEO_ID)?.declaredSizeBytes).toBeNull();
  });
});
