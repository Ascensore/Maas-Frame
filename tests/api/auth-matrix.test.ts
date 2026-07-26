// A sweep over every route module under app/api asserting that an
// unauthenticated caller can never reach a 2xx.
//
// Three properties make this more than a smoke test:
//
//  1. The routes are enumerated by walking app/api on disk and cross-checked
//     against the table below. Add a route and this file fails until someone
//     classifies it as guarded or public. That is the point: the classification
//     is a reviewable diff, not an omission nobody notices.
//
//  2. Every id in the table is a real row, seeded per test. A matrix built on
//     made-up ids passes even with the authorization deleted, because the route
//     404s before it ever checks anything. Here the project exists, the video
//     exists, the comment exists, and the only reason the call fails is the
//     access check.
//
//  3. A 500 counts as a failure. Rejecting an anonymous caller by crashing is
//     not rejecting it.
//
// The project is PRIVATE and no share-session cookie is sent, so nothing here
// is legitimately reachable without a session.

import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { REPO_ROOT } from '../helpers/env';
import { apiRequest, callRoute, type RouteHandler } from '../helpers/request';
import { signedInAs, signedOut } from '../helpers/session';
import {
  addProjectMember,
  addWorkspaceMember,
  createApprovalRequest,
  createComment,
  createCommentTag,
  createProject,
  createShareLink,
  createUser,
  createVersion,
  createVideo,
  createVideoAsset,
  createWorkspace,
  createInvitation,
} from '../factories';

import * as adminFeedbackRoute from '@/app/api/admin/feedback/[feedbackId]/route';
import * as adminRefreshR2Route from '@/app/api/admin/stats/refresh-r2/route';
import * as approvalCancelRoute from '@/app/api/approvals/[requestId]/cancel/route';
import * as approvalDecisionRoute from '@/app/api/approvals/[requestId]/decision/route';
import * as billingCheckoutRoute from '@/app/api/billing/checkout/route';
import * as billingPortalRoute from '@/app/api/billing/portal/route';
import * as billingRoute from '@/app/api/billing/route';
import * as commentRoute from '@/app/api/comments/[commentId]/route';
import * as feedbackRoute from '@/app/api/feedback/route';
import * as feedbackUploadRoute from '@/app/api/feedback/upload/route';
import * as onboardingCompleteRoute from '@/app/api/onboarding/complete/route';
import * as approvalCandidatesRoute from '@/app/api/projects/[projectId]/approval-candidates/route';
import * as projectDownloadRoute from '@/app/api/projects/[projectId]/download/route';
import * as projectInvitationRoute from '@/app/api/projects/[projectId]/members/invitations/[invitationId]/route';
import * as projectMemberRoute from '@/app/api/projects/[projectId]/members/[memberId]/route';
import * as projectMembersRoute from '@/app/api/projects/[projectId]/members/route';
import * as projectRoute from '@/app/api/projects/[projectId]/route';
import * as projectTagsRoute from '@/app/api/projects/[projectId]/tags/route';
import * as projectTagRoute from '@/app/api/projects/[projectId]/tags/[tagId]/route';
import * as videosBulkDeleteRoute from '@/app/api/projects/[projectId]/videos/bulk-delete/route';
import * as videosBunnyInitRoute from '@/app/api/projects/[projectId]/videos/bunny-init/route';
import * as videosMoveRoute from '@/app/api/projects/[projectId]/videos/move/route';
import * as videosR2CompleteRoute from '@/app/api/projects/[projectId]/videos/r2-complete/route';
import * as videosR2InitRoute from '@/app/api/projects/[projectId]/videos/r2-init/route';
import * as projectVideosRoute from '@/app/api/projects/[projectId]/videos/route';
import * as projectVideoRoute from '@/app/api/projects/[projectId]/videos/[videoId]/route';
import * as videoShareRoute from '@/app/api/projects/[projectId]/videos/[videoId]/share/route';
import * as videoVersionsRoute from '@/app/api/projects/[projectId]/videos/[videoId]/versions/route';
import * as videoVersionRoute from '@/app/api/projects/[projectId]/videos/[videoId]/versions/[versionId]/route';
import * as projectsRoute from '@/app/api/projects/route';
import * as searchRoute from '@/app/api/search/route';
import * as settingsNotificationsRoute from '@/app/api/settings/notifications/route';
import * as settingsStorageRoute from '@/app/api/settings/storage/route';
import * as uploadAudioFileRoute from '@/app/api/upload/audio/[filename]/route';
import * as uploadAudioRoute from '@/app/api/upload/audio/route';
import * as uploadImageFileRoute from '@/app/api/upload/image/[filename]/route';
import * as uploadImageRoute from '@/app/api/upload/image/route';
import * as uploadVideoFileRoute from '@/app/api/upload/video/[filename]/route';
import * as versionApprovalsRoute from '@/app/api/versions/[versionId]/approvals/route';
import * as commentsExportRoute from '@/app/api/versions/[versionId]/comments/export/route';
import * as versionCommentsRoute from '@/app/api/versions/[versionId]/comments/route';
import * as versionDownloadRoute from '@/app/api/versions/[versionId]/download/route';
import * as assetDownloadRoute from '@/app/api/videos/[videoId]/assets/[assetId]/download/route';
import * as assetRoute from '@/app/api/videos/[videoId]/assets/[assetId]/route';
import * as assetsBunnyInitRoute from '@/app/api/videos/[videoId]/assets/bunny-init/route';
import * as assetsR2InitRoute from '@/app/api/videos/[videoId]/assets/r2-init/route';
import * as assetsRoute from '@/app/api/videos/[videoId]/assets/route';
import * as watchProgressRoute from '@/app/api/watch/[videoId]/progress/route';
import * as watchRoute from '@/app/api/watch/[videoId]/route';
import * as watchUploadTokenRoute from '@/app/api/watch/[videoId]/upload-token/route';
import * as workspacesRoute from '@/app/api/workspaces/route';
import * as workspaceInvitationRoute from '@/app/api/workspaces/[workspaceId]/members/invitations/[invitationId]/route';
import * as workspaceMemberRoute from '@/app/api/workspaces/[workspaceId]/members/[memberId]/route';
import * as workspaceMembersRoute from '@/app/api/workspaces/[workspaceId]/members/route';
import * as workspaceRoute from '@/app/api/workspaces/[workspaceId]/route';

// ---------------------------------------------------------------------------
// The count guard
// ---------------------------------------------------------------------------
// Bump this only together with a new entry in ROUTE_CASES or in PUBLIC_ROUTES.
const EXPECTED_ROUTE_MODULE_COUNT = 60;

/**
 * Routes that are public by design, and why. Everything else must reject an
 * anonymous caller. Moving a file into this set is the visible diff that says
 * "this endpoint is now reachable without a session".
 */
const PUBLIC_ROUTES: ReadonlyMap<string, string> = new Map([
  [
    'auth/[...nextauth]/route.ts',
    // The NextAuth handler itself: sign-in, callback and CSRF endpoints. It has
    // to be reachable by a caller who has no session yet, by definition.
    'NextAuth sign-in/callback handler',
  ],
  [
    'auth/register/route.ts',
    // Account creation. Gated by OPENFRAME_REQUIRE_INVITE_CODE plus an IP rate
    // limit rather than by a session. Covered in tests/api/register.test.ts.
    'account creation, gated by the invite code',
  ],
  [
    'auth/verify-email/route.ts',
    // Reached by clicking a link in an email, before the user can sign in.
    // Authenticated by the one-time token in the query string.
    'email verification link, authenticated by a single-use token',
  ],
  [
    'auth/verify-email/resend/route.ts',
    // A user who cannot sign in because they are unverified has no session to
    // present. Rate limited by IP, and answers identically for unknown emails
    // so it cannot be used to enumerate accounts.
    'resend of the verification email, for users who cannot sign in yet',
  ],
  [
    'stripe/webhook/route.ts',
    // Called by Stripe, not by a browser. Authenticated by the HMAC signature
    // in the stripe-signature header. Covered in
    // tests/api/stripe-webhook.test.ts, including the rejection of a bad one.
    'Stripe webhook, authenticated by an HMAC signature',
  ],
]);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const IMAGE_FILENAME = '11111111-1111-4111-8111-111111111111.png';
const AUDIO_FILENAME = '22222222-2222-4222-8222-222222222222.webm';
const VIDEO_FILENAME = '33333333-3333-4333-8333-333333333333.mp4';

interface Fixtures {
  userId: string;
  workspaceId: string;
  workspaceMemberId: string;
  workspaceInvitationId: string;
  projectId: string;
  projectMemberId: string;
  projectInvitationId: string;
  tagId: string;
  videoId: string;
  versionId: string;
  commentId: string;
  assetId: string;
  approvalRequestId: string;
  feedbackId: string;
}

async function seedFixtures(): Promise<Fixtures> {
  const owner = await createUser();
  const collaborator = await createUser();

  const workspace = await createWorkspace({ ownerId: owner.id });
  const workspaceMember = await addWorkspaceMember({
    workspaceId: workspace.id,
    userId: collaborator.id,
  });
  const workspaceInvitation = await createInvitation({
    invitedById: owner.id,
    scope: 'WORKSPACE',
    workspaceId: workspace.id,
  });

  // PRIVATE on purpose. A PUBLIC project grants anonymous read access through
  // computeProjectAccess(), which would make several of the GET routes return
  // 200 for entirely legitimate reasons and hide the ones that should not.
  const project = await createProject({
    ownerId: owner.id,
    workspaceId: workspace.id,
    visibility: 'PRIVATE',
    allowDownloads: true,
  });
  const projectMember = await addProjectMember({
    projectId: project.id,
    userId: collaborator.id,
  });
  const projectInvitation = await createInvitation({
    invitedById: owner.id,
    scope: 'PROJECT',
    projectId: project.id,
  });
  const tag = await createCommentTag({ projectId: project.id });

  const video = await createVideo({ projectId: project.id });
  const version = await createVersion({
    videoParentId: video.id,
    providerId: 'r2',
    providerVideoId: `videos/${VIDEO_FILENAME}`,
    originalUrl: `/api/upload/video/${VIDEO_FILENAME}`,
    sizeBytes: BigInt(1024),
  });
  const comment = await createComment({ versionId: version.id, authorId: owner.id });

  const asset = await createVideoAsset({
    videoId: video.id,
    billedUserId: owner.id,
    sourceUrl: `/api/upload/image/${IMAGE_FILENAME}`,
  });
  // A second asset so /api/upload/audio/[filename] resolves to a real row too.
  await createVideoAsset({
    videoId: video.id,
    billedUserId: owner.id,
    kind: 'AUDIO',
    provider: 'R2_AUDIO',
    sourceUrl: `/api/upload/audio/${AUDIO_FILENAME}`,
  });

  await createShareLink({ projectId: project.id, videoId: video.id, permission: 'COMMENT' });

  const approvalRequest = await createApprovalRequest({
    versionId: version.id,
    requestedById: owner.id,
    approverIds: [collaborator.id],
  });

  const feedback = await db.userFeedback.create({
    data: {
      userId: owner.id,
      type: 'FEEDBACK',
      title: 'Matrix fixture feedback',
      message: 'Seeded so the admin delete route has a real row to refuse.',
    },
  });

  return {
    userId: owner.id,
    workspaceId: workspace.id,
    workspaceMemberId: workspaceMember.id,
    workspaceInvitationId: workspaceInvitation.id,
    projectId: project.id,
    projectMemberId: projectMember.id,
    projectInvitationId: projectInvitation.id,
    tagId: tag.id,
    videoId: video.id,
    versionId: version.id,
    commentId: comment.id,
    assetId: asset.id,
    approvalRequestId: approvalRequest.id,
    feedbackId: feedback.id,
  };
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

type ParamRecord = Record<string, string | string[]>;

interface RouteCase {
  /** Path of the route module relative to app/api. */
  file: string;
  module: Record<string, unknown>;
  url: (fixtures: Fixtures) => string;
  params?: (fixtures: Fixtures) => ParamRecord;
  /** JSON body for the non-GET methods. A valid `{}` by default, so that a
   *  route which parses before authorizing rejects rather than crashes. */
  body?: unknown;
  /** Replaces `body`, for the routes that read request.formData(). */
  rawBody?: (fixtures: Fixtures) => BodyInit;
  headers?: Record<string, string>;
}

/**
 * A multipart body that gets past the shape checks in the two upload routes and
 * reaches their access check.
 *
 * This is not decoration. Both routes validate the request before they
 * authorize: /api/upload/image bails with "Missing Content-Length header" at its
 * first line, and /api/upload/audio bails with "No audio file provided" before
 * checkProjectAccess() is ever called. An empty FormData therefore produced a
 * 400 for an anonymous caller *and* an identical 400 for the workspace owner,
 * which means the assertion below held with the authorization deleted. Sending a
 * real file and a real videoId is what makes the 403 come from the access check.
 */
function uploadForm(field: 'image' | 'audio', fixtures: Fixtures): FormData {
  const form = new FormData();
  form.append(field, new File([new Uint8Array([1, 2, 3, 4])], `anon.${field}`));
  form.append('videoId', fixtures.videoId);
  return form;
}

const ROUTE_CASES: readonly RouteCase[] = [
  {
    file: 'admin/feedback/[feedbackId]/route.ts',
    module: adminFeedbackRoute,
    url: (f) => `/api/admin/feedback/${f.feedbackId}`,
    params: (f) => ({ feedbackId: f.feedbackId }),
  },
  {
    file: 'admin/stats/refresh-r2/route.ts',
    module: adminRefreshR2Route,
    url: () => '/api/admin/stats/refresh-r2',
  },
  {
    file: 'approvals/[requestId]/cancel/route.ts',
    module: approvalCancelRoute,
    url: (f) => `/api/approvals/${f.approvalRequestId}/cancel`,
    params: (f) => ({ requestId: f.approvalRequestId }),
  },
  {
    file: 'approvals/[requestId]/decision/route.ts',
    module: approvalDecisionRoute,
    url: (f) => `/api/approvals/${f.approvalRequestId}/decision`,
    params: (f) => ({ requestId: f.approvalRequestId }),
    body: { decision: 'APPROVED' },
  },
  {
    file: 'billing/checkout/route.ts',
    module: billingCheckoutRoute,
    url: () => '/api/billing/checkout',
    headers: { origin: 'http://localhost:3000' },
  },
  {
    file: 'billing/portal/route.ts',
    module: billingPortalRoute,
    url: () => '/api/billing/portal',
    headers: { origin: 'http://localhost:3000' },
  },
  { file: 'billing/route.ts', module: billingRoute, url: () => '/api/billing' },
  {
    file: 'comments/[commentId]/route.ts',
    module: commentRoute,
    url: (f) => `/api/comments/${f.commentId}`,
    params: (f) => ({ commentId: f.commentId }),
    body: { content: 'edited by an anonymous caller' },
  },
  {
    file: 'feedback/route.ts',
    module: feedbackRoute,
    url: () => '/api/feedback',
    body: { type: 'FEEDBACK', title: 'anon', message: 'anon' },
  },
  {
    file: 'feedback/upload/route.ts',
    module: feedbackUploadRoute,
    url: () => '/api/feedback/upload',
    rawBody: () => new FormData(),
  },
  {
    file: 'onboarding/complete/route.ts',
    module: onboardingCompleteRoute,
    url: () => '/api/onboarding/complete',
  },
  {
    file: 'projects/[projectId]/approval-candidates/route.ts',
    module: approvalCandidatesRoute,
    url: (f) => `/api/projects/${f.projectId}/approval-candidates`,
    params: (f) => ({ projectId: f.projectId }),
  },
  {
    file: 'projects/[projectId]/download/route.ts',
    module: projectDownloadRoute,
    url: (f) => `/api/projects/${f.projectId}/download`,
    params: (f) => ({ projectId: f.projectId }),
  },
  {
    file: 'projects/[projectId]/members/invitations/[invitationId]/route.ts',
    module: projectInvitationRoute,
    url: (f) => `/api/projects/${f.projectId}/members/invitations/${f.projectInvitationId}`,
    params: (f) => ({ projectId: f.projectId, invitationId: f.projectInvitationId }),
  },
  {
    file: 'projects/[projectId]/members/[memberId]/route.ts',
    module: projectMemberRoute,
    url: (f) => `/api/projects/${f.projectId}/members/${f.projectMemberId}`,
    params: (f) => ({ projectId: f.projectId, memberId: f.projectMemberId }),
    body: { role: 'ADMIN' },
  },
  {
    file: 'projects/[projectId]/members/route.ts',
    module: projectMembersRoute,
    url: (f) => `/api/projects/${f.projectId}/members`,
    params: (f) => ({ projectId: f.projectId }),
    body: { email: 'anon@example.com', role: 'ADMIN' },
  },
  {
    file: 'projects/[projectId]/route.ts',
    module: projectRoute,
    url: (f) => `/api/projects/${f.projectId}`,
    params: (f) => ({ projectId: f.projectId }),
    body: { name: 'renamed by an anonymous caller' },
  },
  {
    file: 'projects/[projectId]/tags/route.ts',
    module: projectTagsRoute,
    url: (f) => `/api/projects/${f.projectId}/tags`,
    params: (f) => ({ projectId: f.projectId }),
    body: { name: 'Anon', color: '#ff0000' },
  },
  {
    file: 'projects/[projectId]/tags/[tagId]/route.ts',
    module: projectTagRoute,
    url: (f) => `/api/projects/${f.projectId}/tags/${f.tagId}`,
    params: (f) => ({ projectId: f.projectId, tagId: f.tagId }),
    body: { name: 'Anon' },
  },
  {
    file: 'projects/[projectId]/videos/bulk-delete/route.ts',
    module: videosBulkDeleteRoute,
    url: (f) => `/api/projects/${f.projectId}/videos/bulk-delete`,
    params: (f) => ({ projectId: f.projectId }),
    body: { videoIds: ['does-not-matter'] },
  },
  {
    file: 'projects/[projectId]/videos/bunny-init/route.ts',
    module: videosBunnyInitRoute,
    url: (f) => `/api/projects/${f.projectId}/videos/bunny-init`,
    params: (f) => ({ projectId: f.projectId }),
    body: { title: 'anon' },
  },
  {
    file: 'projects/[projectId]/videos/move/route.ts',
    module: videosMoveRoute,
    url: (f) => `/api/projects/${f.projectId}/videos/move`,
    params: (f) => ({ projectId: f.projectId }),
    body: { videoIds: ['x'], targetProjectId: 'y' },
  },
  {
    file: 'projects/[projectId]/videos/r2-complete/route.ts',
    module: videosR2CompleteRoute,
    url: (f) => `/api/projects/${f.projectId}/videos/r2-complete`,
    params: (f) => ({ projectId: f.projectId }),
    body: { objectKey: 'x', uploadToken: 'y' },
  },
  {
    file: 'projects/[projectId]/videos/r2-init/route.ts',
    module: videosR2InitRoute,
    url: (f) => `/api/projects/${f.projectId}/videos/r2-init`,
    params: (f) => ({ projectId: f.projectId }),
    body: { fileName: 'a.mp4', sizeBytes: '1024', contentType: 'video/mp4' },
  },
  {
    file: 'projects/[projectId]/videos/route.ts',
    module: projectVideosRoute,
    url: (f) => `/api/projects/${f.projectId}/videos`,
    params: (f) => ({ projectId: f.projectId }),
    body: { title: 'anon', videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
  },
  {
    file: 'projects/[projectId]/videos/[videoId]/route.ts',
    module: projectVideoRoute,
    url: (f) => `/api/projects/${f.projectId}/videos/${f.videoId}`,
    params: (f) => ({ projectId: f.projectId, videoId: f.videoId }),
    body: { title: 'renamed by an anonymous caller' },
  },
  {
    file: 'projects/[projectId]/videos/[videoId]/share/route.ts',
    module: videoShareRoute,
    url: (f) => `/api/projects/${f.projectId}/videos/${f.videoId}/share`,
    params: (f) => ({ projectId: f.projectId, videoId: f.videoId }),
    body: { allowGuests: true },
  },
  {
    file: 'projects/[projectId]/videos/[videoId]/versions/route.ts',
    module: videoVersionsRoute,
    url: (f) => `/api/projects/${f.projectId}/videos/${f.videoId}/versions`,
    params: (f) => ({ projectId: f.projectId, videoId: f.videoId }),
    body: { videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
  },
  {
    file: 'projects/[projectId]/videos/[videoId]/versions/[versionId]/route.ts',
    module: videoVersionRoute,
    url: (f) => `/api/projects/${f.projectId}/videos/${f.videoId}/versions/${f.versionId}`,
    params: (f) => ({ projectId: f.projectId, videoId: f.videoId, versionId: f.versionId }),
    body: { versionLabel: 'anon' },
  },
  {
    file: 'projects/route.ts',
    module: projectsRoute,
    url: () => '/api/projects',
    body: { name: 'anon project', workspaceId: 'anything' },
  },
  { file: 'search/route.ts', module: searchRoute, url: () => '/api/search?q=test' },
  {
    file: 'settings/notifications/route.ts',
    module: settingsNotificationsRoute,
    url: () => '/api/settings/notifications',
    body: { emailEnabled: true },
  },
  {
    file: 'settings/storage/route.ts',
    module: settingsStorageRoute,
    url: () => '/api/settings/storage',
  },
  {
    file: 'upload/audio/[filename]/route.ts',
    module: uploadAudioFileRoute,
    url: () => `/api/upload/audio/${AUDIO_FILENAME}`,
    params: () => ({ filename: AUDIO_FILENAME }),
  },
  {
    file: 'upload/audio/route.ts',
    module: uploadAudioRoute,
    url: () => '/api/upload/audio',
    rawBody: (f) => uploadForm('audio', f),
  },
  {
    file: 'upload/image/[filename]/route.ts',
    module: uploadImageFileRoute,
    url: () => `/api/upload/image/${IMAGE_FILENAME}`,
    params: () => ({ filename: IMAGE_FILENAME }),
  },
  {
    file: 'upload/image/route.ts',
    module: uploadImageRoute,
    url: () => '/api/upload/image',
    rawBody: (f) => uploadForm('image', f),
    // The route rejects a missing Content-Length before it does anything else,
    // and constructing a Request from a FormData does not set one.
    headers: { 'content-length': '2048' },
  },
  {
    file: 'upload/video/[filename]/route.ts',
    module: uploadVideoFileRoute,
    url: () => `/api/upload/video/${VIDEO_FILENAME}`,
    params: () => ({ filename: VIDEO_FILENAME }),
  },
  {
    file: 'versions/[versionId]/approvals/route.ts',
    module: versionApprovalsRoute,
    url: (f) => `/api/versions/${f.versionId}/approvals`,
    params: (f) => ({ versionId: f.versionId }),
    body: { approverIds: ['someone'] },
  },
  {
    file: 'versions/[versionId]/comments/export/route.ts',
    module: commentsExportRoute,
    url: (f) => `/api/versions/${f.versionId}/comments/export`,
    params: (f) => ({ versionId: f.versionId }),
  },
  {
    file: 'versions/[versionId]/comments/route.ts',
    module: versionCommentsRoute,
    url: (f) => `/api/versions/${f.versionId}/comments`,
    params: (f) => ({ versionId: f.versionId }),
    body: { content: 'anonymous comment', timestamp: 1, guestName: 'Anon' },
  },
  {
    file: 'versions/[versionId]/download/route.ts',
    module: versionDownloadRoute,
    url: (f) => `/api/versions/${f.versionId}/download`,
    params: (f) => ({ versionId: f.versionId }),
  },
  {
    file: 'videos/[videoId]/assets/[assetId]/download/route.ts',
    module: assetDownloadRoute,
    url: (f) => `/api/videos/${f.videoId}/assets/${f.assetId}/download`,
    params: (f) => ({ videoId: f.videoId, assetId: f.assetId }),
  },
  {
    file: 'videos/[videoId]/assets/[assetId]/route.ts',
    module: assetRoute,
    url: (f) => `/api/videos/${f.videoId}/assets/${f.assetId}`,
    params: (f) => ({ videoId: f.videoId, assetId: f.assetId }),
  },
  {
    file: 'videos/[videoId]/assets/bunny-init/route.ts',
    module: assetsBunnyInitRoute,
    url: (f) => `/api/videos/${f.videoId}/assets/bunny-init`,
    params: (f) => ({ videoId: f.videoId }),
    // This entry cannot be made load-bearing here, and it was verified to hold
    // with `if (!context.canUploadAssets)` replaced by `if (false)`: Bunny
    // uploads are unconfigured in the test environment, so the route answers 400
    // one line below the guard whether or not the guard is there. The real
    // coverage for it is in tests/api/assets-authz.test.ts, which asserts the
    // exact 403 for a stranger next to the exact 400 for a member.
    body: { fileName: 'a.mp4' },
  },
  {
    file: 'videos/[videoId]/assets/r2-init/route.ts',
    module: assetsR2InitRoute,
    url: (f) => `/api/videos/${f.videoId}/assets/r2-init`,
    params: (f) => ({ videoId: f.videoId }),
    body: { fileName: 'a.mp4', sizeBytes: '1024', contentType: 'video/mp4' },
  },
  {
    file: 'videos/[videoId]/assets/route.ts',
    module: assetsRoute,
    url: (f) => `/api/videos/${f.videoId}/assets`,
    params: (f) => ({ videoId: f.videoId }),
    // The body carries no `provider`, so POST answers 400 "Invalid provider"
    // just below the access check. Verified: with
    // `if (!context.canUploadAssets)` replaced by `if (false)` this entry still
    // passes. Sending a real provider would not fix it, because every branch
    // that could reach 201 needs a live R2 or YouTube call. The exact-status
    // coverage lives in tests/api/assets-authz.test.ts instead. The GET half of
    // this module is genuinely load-bearing here: it 403s on the access check.
    body: { kind: 'IMAGE', sourceUrl: `/api/upload/image/${IMAGE_FILENAME}` },
  },
  {
    file: 'watch/[videoId]/progress/route.ts',
    module: watchProgressRoute,
    url: (f) => `/api/watch/${f.videoId}/progress`,
    params: (f) => ({ videoId: f.videoId }),
    body: { progress: 10, duration: 100 },
  },
  {
    file: 'watch/[videoId]/route.ts',
    module: watchRoute,
    url: (f) => `/api/watch/${f.videoId}`,
    params: (f) => ({ videoId: f.videoId }),
  },
  {
    file: 'watch/[videoId]/upload-token/route.ts',
    module: watchUploadTokenRoute,
    url: (f) => `/api/watch/${f.videoId}/upload-token`,
    params: (f) => ({ videoId: f.videoId }),
    body: { intent: 'image' },
    headers: { origin: 'http://localhost:3000' },
  },
  {
    file: 'workspaces/route.ts',
    module: workspacesRoute,
    url: () => '/api/workspaces',
    body: { name: 'anon workspace' },
  },
  {
    file: 'workspaces/[workspaceId]/members/invitations/[invitationId]/route.ts',
    module: workspaceInvitationRoute,
    url: (f) => `/api/workspaces/${f.workspaceId}/members/invitations/${f.workspaceInvitationId}`,
    params: (f) => ({ workspaceId: f.workspaceId, invitationId: f.workspaceInvitationId }),
  },
  {
    file: 'workspaces/[workspaceId]/members/[memberId]/route.ts',
    module: workspaceMemberRoute,
    url: (f) => `/api/workspaces/${f.workspaceId}/members/${f.workspaceMemberId}`,
    params: (f) => ({ workspaceId: f.workspaceId, memberId: f.workspaceMemberId }),
    body: { role: 'ADMIN' },
  },
  {
    file: 'workspaces/[workspaceId]/members/route.ts',
    module: workspaceMembersRoute,
    url: (f) => `/api/workspaces/${f.workspaceId}/members`,
    params: (f) => ({ workspaceId: f.workspaceId }),
    body: { email: 'anon@example.com', role: 'ADMIN' },
  },
  {
    file: 'workspaces/[workspaceId]/route.ts',
    module: workspaceRoute,
    url: (f) => `/api/workspaces/${f.workspaceId}`,
    params: (f) => ({ workspaceId: f.workspaceId }),
    body: { name: 'renamed by an anonymous caller' },
  },
];

const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

function discoverRouteModules(): string[] {
  const apiDir = path.join(REPO_ROOT, 'app', 'api');
  const found: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.name === 'route.ts') {
        found.push(path.relative(apiDir, absolute));
      }
    }
  };

  walk(apiDir);
  return found.sort();
}

describe('auth matrix', () => {
  const discovered = discoverRouteModules();

  it('classifies every route module that exists on disk', () => {
    const classified = new Set<string>([
      ...ROUTE_CASES.map((entry) => entry.file),
      ...PUBLIC_ROUTES.keys(),
    ]);

    const unclassified = discovered.filter((file) => !classified.has(file));
    const stale = [...classified].filter((file) => !discovered.includes(file)).sort();

    // The failure message is the whole value of this assertion: whoever added
    // the route needs to know what to do about it.
    expect(
      { unclassified, stale },
      'A route module under app/api is missing from tests/api/auth-matrix.test.ts. ' +
        'Add it to ROUTE_CASES (the normal case: it requires a session), or to ' +
        'PUBLIC_ROUTES with a comment saying why anonymous access is intended.'
    ).toEqual({ unclassified: [], stale: [] });
  });

  it('still has exactly the expected number of route modules', () => {
    expect(discovered).toHaveLength(EXPECTED_ROUTE_MODULE_COUNT);
    expect(ROUTE_CASES.length + PUBLIC_ROUTES.size).toBe(EXPECTED_ROUTE_MODULE_COUNT);
  });

  it('exports at least one HTTP method from every guarded route module', () => {
    const withoutHandlers = ROUTE_CASES.filter(
      (entry) => !HTTP_METHODS.some((method) => typeof entry.module[method] === 'function')
    ).map((entry) => entry.file);

    expect(withoutHandlers).toEqual([]);
  });

  describe('unauthenticated callers', () => {
    let fixtures: Fixtures;

    beforeEach(async () => {
      signedOut();
      fixtures = await seedFixtures();
    });

    for (const entry of ROUTE_CASES) {
      it(`never returns 2xx for ${entry.file}`, async () => {
        const methods = HTTP_METHODS.filter((method) => typeof entry.module[method] === 'function');
        expect(methods.length).toBeGreaterThan(0);

        const observed: Record<string, number> = {};

        for (const method of methods) {
          const handler = entry.module[method] as RouteHandler<ParamRecord>;
          const sendsBody = method !== 'GET' && method !== 'HEAD';

          const request = apiRequest(entry.url(fixtures), {
            method,
            headers: entry.headers,
            ...(sendsBody
              ? entry.rawBody
                ? { rawBody: entry.rawBody(fixtures) }
                : { body: entry.body ?? {} }
              : {}),
          });

          const response = await callRoute(handler, request, entry.params?.(fixtures) ?? {});
          observed[method] = response.status;
        }

        for (const [method, status] of Object.entries(observed)) {
          expect(
            status >= 200 && status < 300,
            `${method} ${entry.file} returned ${status} to an anonymous caller`
          ).toBe(false);

          // A crash is not a rejection. If this trips, the route threw on the
          // way to its access check instead of refusing cleanly.
          expect(status, `${method} ${entry.file} crashed instead of refusing`).not.toBe(500);
        }
      });
    }
  });

  it('documents a reason for every public route, and each one still exists', () => {
    for (const [file, reason] of PUBLIC_ROUTES) {
      expect(reason.length, `${file} needs a reason`).toBeGreaterThan(10);
      expect(fs.existsSync(path.join(REPO_ROOT, 'app', 'api', file))).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // Signed in, but not an admin
  // -------------------------------------------------------------------------
  // The sweep above only proves that app/api/admin/** refuses a caller with no
  // session, and `!session?.user?.isAdmin` is true for a null session for the
  // wrong reason. Nothing else in the suite touches `isAdmin` at all, so
  // rewriting that guard as `!session?.user?.id` would leave every one of these
  // tests green while handing the admin endpoints to any signed-in user. These
  // two cases are what separate "no session" from "not an admin".
  describe('admin routes reject a signed-in non-admin', () => {
    let fixtures: Fixtures;

    beforeEach(async () => {
      fixtures = await seedFixtures();
    });

    it('refuses DELETE /api/admin/feedback/[feedbackId] and keeps the row', async () => {
      signedInAs({ id: fixtures.userId, isAdmin: false });

      const response = await callRoute(
        adminFeedbackRoute.DELETE as unknown as RouteHandler<ParamRecord>,
        apiRequest(`/api/admin/feedback/${fixtures.feedbackId}`, { method: 'DELETE' }),
        { feedbackId: fixtures.feedbackId }
      );

      expect(response.status).toBe(403);
      expect(await db.userFeedback.count({ where: { id: fixtures.feedbackId } })).toBe(1);
    });

    it('refuses POST /api/admin/stats/refresh-r2', async () => {
      signedInAs({ id: fixtures.userId, isAdmin: false });

      const response = await callRoute(
        adminRefreshR2Route.POST as RouteHandler<ParamRecord>,
        apiRequest('/api/admin/stats/refresh-r2', { method: 'POST', body: {} })
      );

      expect(response.status).toBe(403);
    });
  });
});
