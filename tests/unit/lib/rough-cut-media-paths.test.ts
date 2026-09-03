import { describe, expect, it, vi } from 'vitest';
import { buildProjectDownloadManifest } from '@/lib/project-download';
import { assignClipExportFileNames, buildRoughCutTargetUrl } from '@/lib/rough-cut/media-paths';

vi.mock('@/lib/db', () => ({ db: {}, default: {}, disconnectDb: vi.fn() }));

describe('assignClipExportFileNames', () => {
  it('matches buildProjectDownloadManifest filenames for the same clips', () => {
    const videos = [
      {
        id: 'vid-a',
        title: 'Cam A',
        position: 1,
        versions: [
          {
            id: 'ver-a',
            versionNumber: 1,
            versionLabel: null,
            providerId: 'r2',
            videoId: 'videos/a.mp4',
            originalUrl: '/api/upload/video/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.mp4',
            sizeBytes: BigInt(1024),
          },
        ],
        assets: [],
      },
      {
        id: 'vid-b',
        title: 'Cam B',
        position: 0,
        versions: [
          {
            id: 'ver-b',
            versionNumber: 2,
            versionLabel: 'ISO',
            providerId: 'r2',
            videoId: 'videos/b.mov',
            originalUrl: '/api/upload/video/bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee.mov',
            sizeBytes: BigInt(2048),
          },
        ],
        assets: [],
      },
    ];

    const manifest = buildProjectDownloadManifest('Shoot', videos);
    const names = assignClipExportFileNames(
      videos.map((video) => {
        const version = video.versions[0]!;
        return {
          versionId: version.id,
          videoId: video.id,
          title: video.title,
          position: video.position,
          versionNumber: version.versionNumber,
          versionLabel: version.versionLabel,
          originalUrl: version.originalUrl,
        };
      })
    );

    const manifestNames = manifest.files.map((file) => file.fileName).sort();
    const exportNames = [...names.values()].sort();
    expect(exportNames).toEqual(manifestNames);
    expect(exportNames).toEqual(['01-Cam B-ISO.mov', '02-Cam A-v1.mp4']);
  });

  it('builds a relative target URL from the profile prefix', () => {
    expect(buildRoughCutTargetUrl('./media/', '01-Cam A-v1.mp4')).toBe('./media/01-Cam A-v1.mp4');
    expect(buildRoughCutTargetUrl('./media', 'clip.mov')).toBe('./media/clip.mov');
  });
});
