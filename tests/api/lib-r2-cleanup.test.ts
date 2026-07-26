// Exercises lib/r2-cleanup.ts, the module that decides which objects get
// removed from storage when a video, a project or a workspace is deleted.
//
// Everything here turns on one property: the module must only ever nominate an
// object that belongs to the entity being deleted. A widened `where` clause
// costs a customer their footage, and unlike a widened read it is not
// recoverable, so the first test in each collect* block is the negative one (a
// sibling's media is left alone) and the positive one comes second.
//
// tests/setup/api.ts stubs the named helpers in `@/lib/r2` but not `r2Client`,
// which is what deleteMediaFilesBestEffort() actually reaches for. The mock
// below replaces the client with a recorder, so a test can assert on the exact
// object keys the module chose. Nothing speaks S3.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupProjectMediaFiles,
  cleanupVideoMediaFiles,
  cleanupWorkspaceMediaFiles,
  collectProjectMediaUrls,
  collectVideoMediaUrls,
  collectWorkspaceMediaUrls,
  deleteMediaFilesBestEffort,
  mediaUrlToKey,
} from '@/lib/r2-cleanup';
import {
  createComment,
  createProject,
  createUser,
  createVersion,
  createVideo,
  createVideoAsset,
  createWorkspace,
  seedProject,
} from '../factories';

// vi.mock factories are hoisted above every const in the file, so the recorder
// and the bucket name have to be hoisted with them.
const r2 = vi.hoisted(() => ({
  bucket: 'openframe-cleanup-test-bucket',
  /** Every object key handed to a DeleteObjectCommand, in call order. */
  deletedKeys: [] as string[],
  /** Buckets seen alongside those keys. */
  deletedBuckets: [] as string[],
  /** Keys the fake client refuses, to drive the best-effort failure path. */
  rejectKeys: new Set<string>(),
  /** Commands that were not a DeleteObjectCommand, which would be a bug. */
  otherCommands: [] as string[],
}));

vi.mock('@/lib/r2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/r2')>();
  const { DeleteObjectCommand: Delete } = await import('@aws-sdk/client-s3');
  return {
    ...actual,
    R2_BUCKET_NAME: r2.bucket,
    r2Client: {
      send: async (command: { input?: { Bucket?: string; Key?: string } }) => {
        if (!(command instanceof Delete)) {
          r2.otherCommands.push(command.constructor.name);
          return {};
        }
        const key = command.input?.Key ?? '';
        if (r2.rejectKeys.has(key)) {
          throw new Error(`storage refused ${key}`);
        }
        r2.deletedKeys.push(key);
        r2.deletedBuckets.push(command.input?.Bucket ?? '');
        return {};
      },
    },
  };
});

beforeEach(() => {
  r2.deletedKeys.length = 0;
  r2.deletedBuckets.length = 0;
  r2.otherCommands.length = 0;
  r2.rejectKeys.clear();
  // Non-canonical URLs are reported through console.error by design; keep the
  // suite output readable without hiding a genuine failure.
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

// Canonical proxy URLs and the storage keys they map to. Both sides are written
// out rather than derived, so a change to the prefix scheme fails here loudly.
const OWN_COMMENT_IMAGE = '/api/upload/image/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1.png';
const OWN_COMMENT_IMAGE_KEY = 'images/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1.png';
const OWN_COMMENT_VOICE = '/api/upload/audio/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2.webm';
const OWN_COMMENT_VOICE_KEY = 'voice/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2.webm';
const OWN_ASSET_IMAGE = '/api/upload/image/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3.png';
const OWN_ASSET_IMAGE_KEY = 'images/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3.png';
const OWN_VERSION_VIDEO = '/api/upload/video/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4.mp4';
const OWN_VERSION_VIDEO_KEY = 'videos/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4.mp4';
const OWN_VERSION_THUMB = '/api/upload/image/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5.jpg';

// Media belonging to a live neighbour. None of these keys may ever appear in
// r2.deletedKeys when the neighbour is out of scope.
const OTHER_COMMENT_IMAGE = '/api/upload/image/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1.png';
const OTHER_COMMENT_IMAGE_KEY = 'images/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1.png';
const OTHER_ASSET_IMAGE = '/api/upload/image/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2.png';
const OTHER_VERSION_VIDEO = '/api/upload/video/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3.mp4';
const OTHER_VERSION_VIDEO_KEY = 'videos/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3.mp4';

/** A video with one r2 version carrying `videoUrl`, plus a commented image. */
async function seedMediaVideo(input: {
  projectId: string;
  ownerId: string;
  videoUrl: string;
  commentImageUrl: string;
  assetUrl: string;
}) {
  const video = await createVideo({ projectId: input.projectId });
  const version = await createVersion({
    videoParentId: video.id,
    providerId: 'r2',
    originalUrl: input.videoUrl,
  });
  await createComment({ versionId: version.id, imageUrl: input.commentImageUrl });
  await createVideoAsset({
    videoId: video.id,
    billedUserId: input.ownerId,
    provider: 'R2_IMAGE',
    sourceUrl: input.assetUrl,
  });
  return { video, version };
}

describe('mediaUrlToKey', () => {
  it.each([
    [OWN_COMMENT_IMAGE, OWN_COMMENT_IMAGE_KEY],
    [OWN_COMMENT_VOICE, OWN_COMMENT_VOICE_KEY],
    [OWN_VERSION_VIDEO, OWN_VERSION_VIDEO_KEY],
  ])('maps the canonical proxy URL %s to %s', (url, key) => {
    expect(mediaUrlToKey(url)).toBe(key);
  });

  // The regexes are anchored for exactly this reason: a key derived from a
  // caller-supplied path is a key that can point at somebody else's object.
  it.each([
    ['/api/upload/image/../../videos/live.mp4', 'a traversal segment'],
    ['/api/upload/audio/../images/live.png', 'a traversal segment in the audio branch'],
    ['/api/upload/video/../../etc/passwd', 'a traversal segment in the video branch'],
    ['https://evil.test/api/upload/image/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1.png', 'a host'],
    ['/api/upload/image/not-a-uuid.png', 'a non-uuid basename'],
    ['/api/upload/image/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'no extension'],
    ['/api/upload/image/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1.png?x=1', 'a query string'],
    ['/api/upload/image/', 'an empty basename'],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'an unrelated provider URL'],
    ['', 'an empty string'],
  ])('refuses to derive a key from %s (%s)', (url) => {
    expect(mediaUrlToKey(url)).toBeNull();
  });
});

describe('deleteMediaFilesBestEffort', () => {
  it('deletes each distinct key once against the configured bucket', async () => {
    const result = await deleteMediaFilesBestEffort([
      OWN_COMMENT_IMAGE,
      OWN_COMMENT_VOICE,
      // The same URL twice: one DELETE is enough, and a second one is a wasted
      // request against a key that no longer exists.
      OWN_COMMENT_IMAGE,
    ]);

    expect(r2.deletedKeys).toEqual([OWN_COMMENT_IMAGE_KEY, OWN_COMMENT_VOICE_KEY]);
    expect(new Set(r2.deletedBuckets)).toEqual(new Set([r2.bucket]));
    expect(r2.otherCommands).toEqual([]);
    expect(result).toEqual({ attempted: 2, failed: 0, failedKeys: [] });
  });

  it('skips non-canonical URLs and does not count them as attempted', async () => {
    const result = await deleteMediaFilesBestEffort([
      OWN_COMMENT_IMAGE,
      '/api/upload/image/../../videos/live.mp4',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    ]);

    expect(r2.deletedKeys).toEqual([OWN_COMMENT_IMAGE_KEY]);
    expect(result.attempted).toBe(1);
    expect(result.failed).toBe(0);
  });

  // The caller turns this into a warning on the response rather than a 500, so
  // one dead object must not abort the rest of the sweep.
  it('reports a refused key and still deletes the others', async () => {
    r2.rejectKeys.add(OWN_COMMENT_IMAGE_KEY);

    const result = await deleteMediaFilesBestEffort([
      OWN_COMMENT_IMAGE,
      OWN_COMMENT_VOICE,
      OWN_VERSION_VIDEO,
    ]);

    expect(r2.deletedKeys).toEqual([OWN_COMMENT_VOICE_KEY, OWN_VERSION_VIDEO_KEY]);
    expect(result).toEqual({
      attempted: 3,
      failed: 1,
      failedKeys: [OWN_COMMENT_IMAGE_KEY],
    });
  });

  it('does nothing for an empty list', async () => {
    const result = await deleteMediaFilesBestEffort([]);

    expect(r2.deletedKeys).toEqual([]);
    expect(result).toEqual({ attempted: 0, failed: 0, failedKeys: [] });
  });
});

describe('collectVideoMediaUrls', () => {
  // The load-bearing test of this file. A neighbouring video in the same
  // project is live; none of its media may be nominated for deletion.
  it('leaves the media of another video in the same project alone', async () => {
    const scenario = await seedProject();
    const { video } = await seedMediaVideo({
      projectId: scenario.project.id,
      ownerId: scenario.owner.id,
      videoUrl: OWN_VERSION_VIDEO,
      commentImageUrl: OWN_COMMENT_IMAGE,
      assetUrl: OWN_ASSET_IMAGE,
    });
    await seedMediaVideo({
      projectId: scenario.project.id,
      ownerId: scenario.owner.id,
      videoUrl: OTHER_VERSION_VIDEO,
      commentImageUrl: OTHER_COMMENT_IMAGE,
      assetUrl: OTHER_ASSET_IMAGE,
    });

    const urls = await collectVideoMediaUrls(video.id);

    expect(new Set(urls)).toEqual(new Set([OWN_VERSION_VIDEO, OWN_COMMENT_IMAGE, OWN_ASSET_IMAGE]));
    expect(urls).not.toContain(OTHER_VERSION_VIDEO);
    expect(urls).not.toContain(OTHER_COMMENT_IMAGE);
    expect(urls).not.toContain(OTHER_ASSET_IMAGE);
  });

  it('collects comment voice and image URLs, R2 image assets and r2 version media', async () => {
    const scenario = await seedProject();
    const video = await createVideo({ projectId: scenario.project.id });
    const version = await createVersion({
      videoParentId: video.id,
      providerId: 'r2',
      originalUrl: OWN_VERSION_VIDEO,
      thumbnailUrl: OWN_VERSION_THUMB,
    });
    await createComment({
      versionId: version.id,
      imageUrl: OWN_COMMENT_IMAGE,
      voiceUrl: OWN_COMMENT_VOICE,
    });
    await createVideoAsset({
      videoId: video.id,
      billedUserId: scenario.owner.id,
      provider: 'R2_IMAGE',
      sourceUrl: OWN_ASSET_IMAGE,
    });

    const urls = await collectVideoMediaUrls(video.id);

    expect(new Set(urls)).toEqual(
      new Set([
        OWN_VERSION_VIDEO,
        OWN_VERSION_THUMB,
        OWN_COMMENT_IMAGE,
        OWN_COMMENT_VOICE,
        OWN_ASSET_IMAGE,
      ])
    );
  });

  // A youtube or bunny version's originalUrl is not an object this deployment
  // owns, and a BUNNY asset is cleaned up through the Bunny API instead.
  it('ignores versions from other providers and assets that are not R2 images', async () => {
    const scenario = await seedProject();
    const video = await createVideo({ projectId: scenario.project.id });
    await createVersion({
      videoParentId: video.id,
      versionNumber: 1,
      providerId: 'youtube',
      originalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      thumbnailUrl: 'https://img.youtube.com/vi/dQw4w9WgXcQ/hq.jpg',
    });
    await createVersion({
      videoParentId: video.id,
      versionNumber: 2,
      providerId: 'r2',
      originalUrl: OWN_VERSION_VIDEO,
    });
    await createVideoAsset({
      videoId: video.id,
      billedUserId: scenario.owner.id,
      provider: 'BUNNY',
      providerVideoId: 'bunny-asset-1',
      sourceUrl: OTHER_ASSET_IMAGE,
    });

    const urls = await collectVideoMediaUrls(video.id);

    expect(urls).toEqual([OWN_VERSION_VIDEO]);
  });

  it('returns nothing for a video whose only version is hosted elsewhere', async () => {
    const scenario = await seedProject();
    const video = await createVideo({ projectId: scenario.project.id });
    await createVersion({
      videoParentId: video.id,
      providerId: 'youtube',
      originalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    });

    expect(await collectVideoMediaUrls(video.id)).toEqual([]);
  });
});

describe('collectProjectMediaUrls', () => {
  it('leaves the media of another project in the same workspace alone', async () => {
    const scenario = await seedProject();
    const sibling = await createProject({
      ownerId: scenario.owner.id,
      workspaceId: scenario.workspace.id,
    });
    await seedMediaVideo({
      projectId: scenario.project.id,
      ownerId: scenario.owner.id,
      videoUrl: OWN_VERSION_VIDEO,
      commentImageUrl: OWN_COMMENT_IMAGE,
      assetUrl: OWN_ASSET_IMAGE,
    });
    await seedMediaVideo({
      projectId: sibling.id,
      ownerId: scenario.owner.id,
      videoUrl: OTHER_VERSION_VIDEO,
      commentImageUrl: OTHER_COMMENT_IMAGE,
      assetUrl: OTHER_ASSET_IMAGE,
    });

    const urls = await collectProjectMediaUrls(scenario.project.id);

    expect(new Set(urls)).toEqual(new Set([OWN_VERSION_VIDEO, OWN_COMMENT_IMAGE, OWN_ASSET_IMAGE]));
  });

  it('collects across every video in the project', async () => {
    const scenario = await seedProject();
    await seedMediaVideo({
      projectId: scenario.project.id,
      ownerId: scenario.owner.id,
      videoUrl: OWN_VERSION_VIDEO,
      commentImageUrl: OWN_COMMENT_IMAGE,
      assetUrl: OWN_ASSET_IMAGE,
    });
    await seedMediaVideo({
      projectId: scenario.project.id,
      ownerId: scenario.owner.id,
      videoUrl: OTHER_VERSION_VIDEO,
      commentImageUrl: OTHER_COMMENT_IMAGE,
      assetUrl: OTHER_ASSET_IMAGE,
    });

    const urls = await collectProjectMediaUrls(scenario.project.id);

    expect(urls).toHaveLength(6);
    expect(new Set(urls)).toEqual(
      new Set([
        OWN_VERSION_VIDEO,
        OWN_COMMENT_IMAGE,
        OWN_ASSET_IMAGE,
        OTHER_VERSION_VIDEO,
        OTHER_COMMENT_IMAGE,
        OTHER_ASSET_IMAGE,
      ])
    );
  });
});

describe('collectWorkspaceMediaUrls', () => {
  it('leaves the media of another workspace alone', async () => {
    const owner = await createUser();
    const workspace = await createWorkspace({ ownerId: owner.id });
    const project = await createProject({ ownerId: owner.id, workspaceId: workspace.id });
    // Same owner, different workspace: the scoping has to come from the join,
    // not from who happens to be billed.
    const otherWorkspace = await createWorkspace({ ownerId: owner.id });
    const otherProject = await createProject({
      ownerId: owner.id,
      workspaceId: otherWorkspace.id,
    });
    await seedMediaVideo({
      projectId: project.id,
      ownerId: owner.id,
      videoUrl: OWN_VERSION_VIDEO,
      commentImageUrl: OWN_COMMENT_IMAGE,
      assetUrl: OWN_ASSET_IMAGE,
    });
    await seedMediaVideo({
      projectId: otherProject.id,
      ownerId: owner.id,
      videoUrl: OTHER_VERSION_VIDEO,
      commentImageUrl: OTHER_COMMENT_IMAGE,
      assetUrl: OTHER_ASSET_IMAGE,
    });

    const urls = await collectWorkspaceMediaUrls(workspace.id);

    expect(new Set(urls)).toEqual(new Set([OWN_VERSION_VIDEO, OWN_COMMENT_IMAGE, OWN_ASSET_IMAGE]));
  });
});

// The three cleanup* wrappers are what the delete routes call, so they are the
// place to assert on keys rather than URLs: this is the last hop before an
// object stops existing.
describe('cleanupVideoMediaFiles', () => {
  it('deletes only the target video objects and leaves the sibling video objects in storage', async () => {
    const scenario = await seedProject();
    const { video } = await seedMediaVideo({
      projectId: scenario.project.id,
      ownerId: scenario.owner.id,
      videoUrl: OWN_VERSION_VIDEO,
      commentImageUrl: OWN_COMMENT_IMAGE,
      assetUrl: OWN_ASSET_IMAGE,
    });
    await seedMediaVideo({
      projectId: scenario.project.id,
      ownerId: scenario.owner.id,
      videoUrl: OTHER_VERSION_VIDEO,
      commentImageUrl: OTHER_COMMENT_IMAGE,
      assetUrl: OTHER_ASSET_IMAGE,
    });

    await cleanupVideoMediaFiles(video.id);

    expect(new Set(r2.deletedKeys)).toEqual(
      new Set([OWN_VERSION_VIDEO_KEY, OWN_COMMENT_IMAGE_KEY, OWN_ASSET_IMAGE_KEY])
    );
    expect(r2.deletedKeys).not.toContain(OTHER_VERSION_VIDEO_KEY);
    expect(r2.deletedKeys).not.toContain(OTHER_COMMENT_IMAGE_KEY);
  });
});

describe('cleanupProjectMediaFiles', () => {
  it('deletes only the target project objects', async () => {
    const scenario = await seedProject();
    const sibling = await createProject({
      ownerId: scenario.owner.id,
      workspaceId: scenario.workspace.id,
    });
    await seedMediaVideo({
      projectId: scenario.project.id,
      ownerId: scenario.owner.id,
      videoUrl: OWN_VERSION_VIDEO,
      commentImageUrl: OWN_COMMENT_IMAGE,
      assetUrl: OWN_ASSET_IMAGE,
    });
    await seedMediaVideo({
      projectId: sibling.id,
      ownerId: scenario.owner.id,
      videoUrl: OTHER_VERSION_VIDEO,
      commentImageUrl: OTHER_COMMENT_IMAGE,
      assetUrl: OTHER_ASSET_IMAGE,
    });

    await cleanupProjectMediaFiles(scenario.project.id);

    expect(new Set(r2.deletedKeys)).toEqual(
      new Set([OWN_VERSION_VIDEO_KEY, OWN_COMMENT_IMAGE_KEY, OWN_ASSET_IMAGE_KEY])
    );
  });
});

describe('cleanupWorkspaceMediaFiles', () => {
  it('deletes only the target workspace objects', async () => {
    const owner = await createUser();
    const workspace = await createWorkspace({ ownerId: owner.id });
    const project = await createProject({ ownerId: owner.id, workspaceId: workspace.id });
    const otherWorkspace = await createWorkspace({ ownerId: owner.id });
    const otherProject = await createProject({
      ownerId: owner.id,
      workspaceId: otherWorkspace.id,
    });
    await seedMediaVideo({
      projectId: project.id,
      ownerId: owner.id,
      videoUrl: OWN_VERSION_VIDEO,
      commentImageUrl: OWN_COMMENT_IMAGE,
      assetUrl: OWN_ASSET_IMAGE,
    });
    await seedMediaVideo({
      projectId: otherProject.id,
      ownerId: owner.id,
      videoUrl: OTHER_VERSION_VIDEO,
      commentImageUrl: OTHER_COMMENT_IMAGE,
      assetUrl: OTHER_ASSET_IMAGE,
    });

    await cleanupWorkspaceMediaFiles(workspace.id);

    expect(new Set(r2.deletedKeys)).toEqual(
      new Set([OWN_VERSION_VIDEO_KEY, OWN_COMMENT_IMAGE_KEY, OWN_ASSET_IMAGE_KEY])
    );
    expect(r2.deletedKeys).not.toContain(OTHER_VERSION_VIDEO_KEY);
  });
});
