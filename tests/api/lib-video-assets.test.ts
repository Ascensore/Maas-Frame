// Exercises lib/video-assets.ts directly.
//
// Two API suites (assets-authz, download-authz) already drive
// getVideoAssetAccessContext() through routes, but only ever at the granularity
// of a status code. That leaves the flags it computes indistinguishable from
// one another: a context that set all four booleans to `hasViewAccess` would
// pass every one of those tests. This file asserts on the flags themselves, and
// on the pure helpers around them that nothing else covers at all.

import { describe, expect, it } from 'vitest';
import { createShareSessionValue, getShareSessionCookieName } from '@/lib/share-session';
import {
  canDeleteAssetForViewer,
  extractAudioFileNameFromProxyUrl,
  extractAudioKeyFromProxyUrl,
  extractImageFileNameFromProxyUrl,
  extractImageKeyFromProxyUrl,
  extractVideoFileNameFromProxyUrl,
  extractVideoKeyFromProxyUrl,
  getVideoAssetAccessContext,
  mediaUrlToR2Key,
  sanitizeAssetDisplayName,
  SAFE_BUNNY_VIDEO_ID,
} from '@/lib/video-assets';
import { apiRequest } from '../helpers/request';
import { signedInAs, signedOut } from '../helpers/session';
import {
  addProjectMember,
  addWorkspaceMember,
  createExpiredUser,
  createShareLink,
  createUser,
  createVideo,
  seedProject,
} from '../factories';

const IMAGE_URL = '/api/upload/image/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1.png';
const AUDIO_URL = '/api/upload/audio/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2.webm';
const VIDEO_URL = '/api/upload/video/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3.mp4';

describe('sanitizeAssetDisplayName', () => {
  it('keeps an ordinary name unchanged', () => {
    expect(sanitizeAssetDisplayName('B-roll take 2.mp4', 'fallback')).toBe('B-roll take 2.mp4');
  });

  // Brackets and parentheses are stripped because the name is interpolated into
  // Markdown-ish notification bodies, where they would change the rendering.
  it('strips brackets and parentheses', () => {
    expect(sanitizeAssetDisplayName('[click](http://evil.test) shot', 'fallback')).toBe(
      'clickhttp://evil.test shot'
    );
  });

  // Control characters are stripped before whitespace is collapsed, so a
  // newline leaves no gap behind where it used to be.
  it('strips control characters', () => {
    expect(sanitizeAssetDisplayName('take\u00001\u007Fsecond\nthird', 'fallback')).toBe(
      'take1secondthird'
    );
  });

  it('collapses runs of whitespace and trims the ends', () => {
    expect(sanitizeAssetDisplayName('  take    two  \t three  ', 'fallback')).toBe(
      'take two three'
    );
  });

  it.each<[string | null | undefined, string]>([
    [null, 'a null value'],
    [undefined, 'an undefined value'],
    ['', 'an empty string'],
    ['   ', 'only whitespace'],
    ['[]()', 'only stripped characters'],
    [42 as unknown as string, 'a non-string value'],
  ])('falls back for %s (%s)', (value) => {
    expect(sanitizeAssetDisplayName(value, 'Comment Image')).toBe('Comment Image');
  });

  it('truncates at 200 characters', () => {
    const result = sanitizeAssetDisplayName('x'.repeat(500), 'fallback');

    expect(result).toHaveLength(200);
    expect(result).toBe('x'.repeat(200));
  });
});

describe('proxy URL extraction', () => {
  it('derives the image key and file name from a canonical image URL', () => {
    expect(extractImageKeyFromProxyUrl(IMAGE_URL)).toBe(
      'images/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1.png'
    );
    expect(extractImageFileNameFromProxyUrl(IMAGE_URL)).toBe(
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1.png'
    );
  });

  it('derives the audio key and file name from a canonical audio URL', () => {
    expect(extractAudioKeyFromProxyUrl(AUDIO_URL)).toBe(
      'voice/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2.webm'
    );
    expect(extractAudioFileNameFromProxyUrl(AUDIO_URL)).toBe(
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2.webm'
    );
  });

  it('derives the video key and file name from a canonical video URL', () => {
    expect(extractVideoKeyFromProxyUrl(VIDEO_URL)).toBe(
      'videos/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3.mp4'
    );
    expect(extractVideoFileNameFromProxyUrl(VIDEO_URL)).toBe(
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3.mp4'
    );
  });

  // Each extractor is anchored on its own prefix, so a URL of one media type
  // must not resolve through another type's extractor.
  it('refuses a URL from a different media prefix', () => {
    expect(extractImageKeyFromProxyUrl(AUDIO_URL)).toBeNull();
    expect(extractAudioKeyFromProxyUrl(VIDEO_URL)).toBeNull();
    expect(extractVideoKeyFromProxyUrl(IMAGE_URL)).toBeNull();
  });

  it.each([
    ['/api/upload/image/../../videos/live.mp4', 'a traversal segment'],
    ['https://evil.test/api/upload/image/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1.png', 'a host'],
    ['/api/upload/image/not-a-uuid.png', 'a non-uuid basename'],
    ['/api/upload/image/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1.png/extra', 'a trailing segment'],
    ['', 'an empty string'],
  ])('refuses to derive an image key from %s (%s)', (url) => {
    expect(extractImageKeyFromProxyUrl(url)).toBeNull();
    expect(extractImageFileNameFromProxyUrl(url)).toBeNull();
  });
});

describe('mediaUrlToR2Key', () => {
  it('derives an image key and a voice key from canonical URLs', () => {
    expect(mediaUrlToR2Key(IMAGE_URL)).toBe('images/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1.png');
    expect(mediaUrlToR2Key(AUDIO_URL)).toBe('voice/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2.webm');
  });

  it('returns null for a URL that is not an image or audio proxy path', () => {
    expect(mediaUrlToR2Key(VIDEO_URL)).toBeNull();
    expect(mediaUrlToR2Key('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBeNull();
  });

  // Documented, not endorsed. Unlike extractImageKeyFromProxyUrl this one
  // matches on a substring with no shape check, so the key it produces is
  // attacker-shaped whenever the URL is. The module has no callers today; if
  // one appears it must use the extract* helpers instead. See the report.
  it('accepts a substring match that the anchored extractor rejects', () => {
    const hostile = 'https://evil.test/api/upload/image/../../videos/live.mp4';

    expect(extractImageKeyFromProxyUrl(hostile)).toBeNull();
    expect(mediaUrlToR2Key(hostile)).toBe('images/../../videos/live.mp4');
  });
});

describe('SAFE_BUNNY_VIDEO_ID', () => {
  it.each([
    ['abcd1234', true],
    ['a-b_c-d1', true],
    ['abcd123', false],
    ['abcd 1234', false],
    ['abcd/1234', false],
    ['../secret', false],
    ['a'.repeat(129), false],
    ['a'.repeat(128), true],
  ])('matches %s: %s', (value, expected) => {
    expect(SAFE_BUNNY_VIDEO_ID.test(value)).toBe(expected);
  });
});

describe('canDeleteAssetForViewer', () => {
  const managed = {
    canManageAssets: true,
    viewerUserId: null,
    viewerGuestIdentityId: null,
  };
  const signedIn = {
    canManageAssets: false,
    viewerUserId: 'user-1',
    viewerGuestIdentityId: null,
  };
  const guest = {
    canManageAssets: false,
    viewerUserId: null,
    viewerGuestIdentityId: 'guest-1',
  };

  it('lets a manager delete an asset they did not upload', () => {
    expect(
      canDeleteAssetForViewer(
        { uploadedByUserId: 'someone-else', uploadedByGuestIdentityId: null },
        managed
      )
    ).toBe(true);
  });

  it('lets a signed-in uploader delete their own asset', () => {
    expect(
      canDeleteAssetForViewer(
        { uploadedByUserId: 'user-1', uploadedByGuestIdentityId: null },
        signedIn
      )
    ).toBe(true);
  });

  it('refuses a signed-in non-manager somebody else asset', () => {
    expect(
      canDeleteAssetForViewer(
        { uploadedByUserId: 'user-2', uploadedByGuestIdentityId: null },
        signedIn
      )
    ).toBe(false);
  });

  it('lets a guest delete the asset their own guest identity uploaded', () => {
    expect(
      canDeleteAssetForViewer(
        { uploadedByUserId: null, uploadedByGuestIdentityId: 'guest-1' },
        guest
      )
    ).toBe(true);
  });

  it('refuses a guest another guest asset', () => {
    expect(
      canDeleteAssetForViewer(
        { uploadedByUserId: null, uploadedByGuestIdentityId: 'guest-2' },
        guest
      )
    ).toBe(false);
  });

  // The `!viewer.viewerUserId` guard: a signed-in caller is judged on their user
  // id alone, so a stale guest cookie carried alongside a session cannot widen
  // what they may delete.
  it('ignores a matching guest identity when the viewer is signed in', () => {
    expect(
      canDeleteAssetForViewer(
        { uploadedByUserId: null, uploadedByGuestIdentityId: 'guest-1' },
        { canManageAssets: false, viewerUserId: 'user-1', viewerGuestIdentityId: 'guest-1' }
      )
    ).toBe(false);
  });

  // Two nulls are not a match. Without the truthiness checks an anonymous
  // viewer would be able to delete every anonymously uploaded asset.
  it('refuses when both sides have no identity at all', () => {
    expect(
      canDeleteAssetForViewer(
        { uploadedByUserId: null, uploadedByGuestIdentityId: null },
        { canManageAssets: false, viewerUserId: null, viewerGuestIdentityId: null }
      )
    ).toBe(false);
  });

  it('refuses when the asset has no uploader and the viewer is an identified guest', () => {
    expect(
      canDeleteAssetForViewer({ uploadedByUserId: null, uploadedByGuestIdentityId: null }, guest)
    ).toBe(false);
  });
});

describe('getVideoAssetAccessContext', () => {
  function shareCookies(videoId: string, token: string, passwordVerified = false) {
    return {
      [getShareSessionCookieName(videoId)]: createShareSessionValue(
        token,
        videoId,
        passwordVerified
      ),
    };
  }

  it('returns null for a video that does not exist', async () => {
    signedOut();

    expect(
      await getVideoAssetAccessContext(apiRequest('/api/videos/nope/assets'), 'nope')
    ).toBeNull();
  });

  it('denies everything to an anonymous caller on a private project', async () => {
    const scenario = await seedProject({ visibility: 'PRIVATE' });
    const video = await createVideo({ projectId: scenario.project.id });
    signedOut();

    const context = await getVideoAssetAccessContext(
      apiRequest(`/api/videos/${video.id}/assets`),
      video.id
    );

    expect(context).not.toBeNull();
    expect(context?.hasViewAccess).toBe(false);
    expect(context?.canUploadAssets).toBe(false);
    expect(context?.canDownloadAssets).toBe(false);
    expect(context?.canManageAssets).toBe(false);
    expect(context?.viewerUserId).toBeNull();
  });

  it('grants everything to the project owner and echoes the project shape back', async () => {
    const scenario = await seedProject({ visibility: 'PRIVATE', allowDownloads: false });
    const video = await createVideo({ projectId: scenario.project.id, title: 'Cut 3' });
    signedInAs(scenario.owner);

    const context = await getVideoAssetAccessContext(
      apiRequest(`/api/videos/${video.id}/assets`),
      video.id
    );

    expect(context?.hasViewAccess).toBe(true);
    expect(context?.canUploadAssets).toBe(true);
    // An editor may always download, whatever allowDownloads says.
    expect(context?.canDownloadAssets).toBe(true);
    expect(context?.canManageAssets).toBe(true);
    expect(context?.viewerUserId).toBe(scenario.owner.id);
    expect(context?.viewerGuestIdentityId).toBeNull();
    expect(context?.video.id).toBe(video.id);
    expect(context?.video.title).toBe('Cut 3');
    expect(context?.video.projectId).toBe(scenario.project.id);
    expect(context?.video.project.workspace.id).toBe(scenario.workspace.id);
    expect(context?.video.project.workspace.ownerId).toBe(scenario.owner.id);
  });

  it('denies everything to a signed-in stranger', async () => {
    const scenario = await seedProject({ visibility: 'PRIVATE' });
    const video = await createVideo({ projectId: scenario.project.id });
    signedInAs(await createUser());

    const context = await getVideoAssetAccessContext(
      apiRequest(`/api/videos/${video.id}/assets`),
      video.id
    );

    expect(context?.hasViewAccess).toBe(false);
    expect(context?.canUploadAssets).toBe(false);
    expect(context?.canDownloadAssets).toBe(false);
  });

  // canManageAssets is `access.canEdit`, which a COMMENTATOR does not have; the
  // other three flags are separate computations and must not collapse onto it.
  it('gives a project COMMENTATOR view and upload but not manage', async () => {
    const scenario = await seedProject({ visibility: 'PRIVATE', allowDownloads: false });
    const video = await createVideo({ projectId: scenario.project.id });
    const commentator = await createUser();
    await addProjectMember({
      projectId: scenario.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const context = await getVideoAssetAccessContext(
      apiRequest(`/api/videos/${video.id}/assets`),
      video.id
    );

    expect(context?.hasViewAccess).toBe(true);
    expect(context?.canUploadAssets).toBe(true);
    expect(context?.canManageAssets).toBe(false);
    // allowDownloads is off and the viewer cannot edit, so no export.
    expect(context?.canDownloadAssets).toBe(false);
  });

  it('lets a non-editing member download once the project allows downloads', async () => {
    const scenario = await seedProject({ visibility: 'PRIVATE', allowDownloads: true });
    const video = await createVideo({ projectId: scenario.project.id });
    const commentator = await createUser();
    await addProjectMember({
      projectId: scenario.project.id,
      userId: commentator.id,
      role: 'COMMENTATOR',
    });
    signedInAs(commentator);

    const context = await getVideoAssetAccessContext(
      apiRequest(`/api/videos/${video.id}/assets`),
      video.id
    );

    expect(context?.canDownloadAssets).toBe(true);
  });

  it('denies a workspace member once the workspace owner loses billing access', async () => {
    const expiredOwner = await createExpiredUser();
    const scenario = await seedProject({ visibility: 'PRIVATE', ownerUser: expiredOwner });
    const video = await createVideo({ projectId: scenario.project.id });
    const member = await createUser();
    await addWorkspaceMember({
      workspaceId: scenario.workspace.id,
      userId: member.id,
      role: 'COMMENTATOR',
    });
    signedInAs(member);

    const context = await getVideoAssetAccessContext(
      apiRequest(`/api/videos/${video.id}/assets`),
      video.id
    );

    expect(context?.hasViewAccess).toBe(false);
    expect(context?.canUploadAssets).toBe(false);
  });

  it('grants view but not upload to an anonymous holder of a VIEW share link', async () => {
    const scenario = await seedProject({ visibility: 'PRIVATE' });
    const video = await createVideo({ projectId: scenario.project.id });
    const link = await createShareLink({
      projectId: scenario.project.id,
      videoId: video.id,
      permission: 'VIEW',
      allowGuests: true,
    });
    signedOut();

    const context = await getVideoAssetAccessContext(
      apiRequest(`/api/videos/${video.id}/assets`, {
        cookies: shareCookies(video.id, link.token),
      }),
      video.id
    );

    expect(context?.hasViewAccess).toBe(true);
    expect(context?.canUploadAssets).toBe(false);
    expect(context?.canDownloadAssets).toBe(false);
    expect(context?.canManageAssets).toBe(false);
  });

  it('grants upload to an anonymous holder of a COMMENT share link that allows guests', async () => {
    const scenario = await seedProject({ visibility: 'PRIVATE' });
    const video = await createVideo({ projectId: scenario.project.id });
    const link = await createShareLink({
      projectId: scenario.project.id,
      videoId: video.id,
      permission: 'COMMENT',
      allowGuests: true,
    });
    signedOut();

    const context = await getVideoAssetAccessContext(
      apiRequest(`/api/videos/${video.id}/assets`, {
        cookies: shareCookies(video.id, link.token),
      }),
      video.id,
      'COMMENT'
    );

    expect(context?.hasViewAccess).toBe(true);
    expect(context?.canUploadAssets).toBe(true);
    expect(context?.canManageAssets).toBe(false);
  });

  // allowGuests off means the link only works for someone with an account, and
  // the upload flag is where that shows up for an anonymous caller.
  it('refuses upload to an anonymous COMMENT share when guests are not allowed', async () => {
    const scenario = await seedProject({ visibility: 'PRIVATE' });
    const video = await createVideo({ projectId: scenario.project.id });
    const link = await createShareLink({
      projectId: scenario.project.id,
      videoId: video.id,
      permission: 'COMMENT',
      allowGuests: false,
    });
    signedOut();

    const context = await getVideoAssetAccessContext(
      apiRequest(`/api/videos/${video.id}/assets`, {
        cookies: shareCookies(video.id, link.token),
      }),
      video.id,
      'COMMENT'
    );

    expect(context?.canUploadAssets).toBe(false);
  });

  it('grants download through a share link that allows downloads', async () => {
    const scenario = await seedProject({ visibility: 'PRIVATE', allowDownloads: false });
    const video = await createVideo({ projectId: scenario.project.id });
    const link = await createShareLink({
      projectId: scenario.project.id,
      videoId: video.id,
      permission: 'VIEW',
      allowGuests: true,
      allowDownloads: true,
    });
    signedOut();

    const context = await getVideoAssetAccessContext(
      apiRequest(`/api/videos/${video.id}/assets`, {
        cookies: shareCookies(video.id, link.token),
      }),
      video.id
    );

    expect(context?.canDownloadAssets).toBe(true);
  });

  // The cookie is bound to a video id and HMAC-signed, so a session minted for
  // one video must not carry over to another.
  it('ignores a share cookie minted for a different video', async () => {
    const scenario = await seedProject({ visibility: 'PRIVATE' });
    const video = await createVideo({ projectId: scenario.project.id });
    const otherVideo = await createVideo({ projectId: scenario.project.id });
    const link = await createShareLink({
      projectId: scenario.project.id,
      videoId: otherVideo.id,
      permission: 'COMMENT',
      allowGuests: true,
    });
    signedOut();

    const context = await getVideoAssetAccessContext(
      apiRequest(`/api/videos/${video.id}/assets`, {
        cookies: shareCookies(otherVideo.id, link.token),
      }),
      video.id,
      'COMMENT'
    );

    expect(context?.hasViewAccess).toBe(false);
    expect(context?.canUploadAssets).toBe(false);
  });

  it('reads the guest identity for an anonymous caller and drops it for a signed-in one', async () => {
    const scenario = await seedProject({ visibility: 'PUBLIC' });
    const video = await createVideo({ projectId: scenario.project.id });
    // A signed cookie is the only shape getGuestIdentityFromRequest accepts, so
    // it is minted the same way the comment routes mint it.
    const { NextResponse } = await import('next/server');
    const { setGuestIdentityCookie } = await import('@/lib/guest-identity');
    const carrier = NextResponse.json({});
    setGuestIdentityCookie(carrier, 'guest-identity-under-test');
    const cookieValue = carrier.cookies.get('openframe_guest_identity')?.value ?? '';
    const cookies = { openframe_guest_identity: cookieValue };

    signedOut();
    const anonymous = await getVideoAssetAccessContext(
      apiRequest(`/api/videos/${video.id}/assets`, { cookies }),
      video.id
    );
    expect(anonymous?.viewerGuestIdentityId).toBe('guest-identity-under-test');
    expect(anonymous?.viewerUserId).toBeNull();

    signedInAs(scenario.owner);
    const authenticated = await getVideoAssetAccessContext(
      apiRequest(`/api/videos/${video.id}/assets`, { cookies }),
      video.id
    );
    expect(authenticated?.viewerUserId).toBe(scenario.owner.id);
    expect(authenticated?.viewerGuestIdentityId).toBeNull();
  });

  it('gives an anonymous caller view access to a PUBLIC project but no upload or manage', async () => {
    const scenario = await seedProject({ visibility: 'PUBLIC' });
    const video = await createVideo({ projectId: scenario.project.id });
    signedOut();

    const context = await getVideoAssetAccessContext(
      apiRequest(`/api/videos/${video.id}/assets`),
      video.id
    );

    expect(context?.hasViewAccess).toBe(true);
    expect(context?.canUploadAssets).toBe(false);
    expect(context?.canManageAssets).toBe(false);
    expect(context?.canDownloadAssets).toBe(false);
  });
});
