import { describe, expect, it, vi } from 'vitest';
import { assembleDecisionList } from '@/lib/rough-cut/decision-list';
import { buildOtioTimeline } from '@/lib/rough-cut/otio';
import type { CameraClip, EditDecision } from '@/lib/rough-cut/types';

vi.mock('@/lib/db', () => ({ db: {}, default: {}, disconnectDb: vi.fn() }));

const RATE = { num: 24, den: 1, dropFrame: false };

function clip(role: string, versionId: string, durationSeconds: number): CameraClip {
  return {
    videoId: `video-${versionId}`,
    versionId,
    title: `Cam ${role}`,
    role,
    position: role === 'A' ? 0 : 1,
    offsetSeconds: 0,
    durationSeconds,
    frameRateNum: 24,
    frameRateDen: 1,
    dropFrame: false,
    startTimecode: null,
    originalUrl: '/api/upload/video/clip.mp4',
    versionNumber: 1,
    versionLabel: null,
  };
}

describe('buildOtioTimeline', () => {
  it('emits a Timeline with a Program track and one stacked track per camera', () => {
    const clips = [clip('A', 'ver-a', 10), clip('B', 'ver-b', 10)];
    const edits: EditDecision[] = [
      {
        timelineStartSeconds: 0,
        timelineEndSeconds: 2,
        inSeconds: 1,
        outSeconds: 3,
        sourceVersionId: 'ver-a',
        cameraRole: 'A',
        targetTrack: 1,
      },
      {
        timelineStartSeconds: 2,
        timelineEndSeconds: 5,
        inSeconds: 2,
        outSeconds: 5,
        sourceVersionId: 'ver-b',
        cameraRole: 'B',
        targetTrack: 1,
      },
    ];
    const decisions = assembleDecisionList({
      edits,
      clips,
      fileNames: new Map([
        ['ver-a', '01-Cam A-v1.mp4'],
        ['ver-b', '02-Cam B-v1.mp4'],
      ]),
      mediaPathPrefix: './media/',
      rate: RATE,
    });

    const timeline = buildOtioTimeline({
      name: 'Rough Cut',
      decisions,
      clips,
      handleFrames: 0,
    });

    expect(timeline.OTIO_SCHEMA).toBe('Timeline.1');
    expect(timeline.tracks.children).toHaveLength(3);
    expect(timeline.tracks.children[0]?.name).toBe('Program');
    expect(timeline.tracks.children[0]?.children).toHaveLength(2);

    const firstClip = timeline.tracks.children[0]?.children[0];
    expect(firstClip?.OTIO_SCHEMA).toBe('Clip.1');
    expect(firstClip && firstClip.OTIO_SCHEMA === 'Clip.1').toBe(true);
    if (firstClip && firstClip.OTIO_SCHEMA === 'Clip.1') {
      expect(firstClip.source_range.start_time).toEqual({
        OTIO_SCHEMA: 'RationalTime.1',
        value: 24,
        rate: 24,
      });
      expect(firstClip.source_range.duration).toEqual({
        OTIO_SCHEMA: 'RationalTime.1',
        value: 48,
        rate: 24,
      });
      expect(firstClip.media_reference.target_url).toBe('./media/01-Cam A-v1.mp4');
    }

    const secondClip = timeline.tracks.children[0]?.children[1];
    expect(secondClip?.OTIO_SCHEMA).toBe('Clip.1');
    if (secondClip && secondClip.OTIO_SCHEMA === 'Clip.1') {
      expect(secondClip.source_range.start_time.value).toBe(48);
      expect(secondClip.source_range.duration.value).toBe(72);
      expect(secondClip.media_reference.target_url).toBe('./media/02-Cam B-v1.mp4');
    }

    const stackedA = timeline.tracks.children[1];
    expect(stackedA?.name).toBe('A');
    expect(stackedA?.children[0]?.OTIO_SCHEMA).toBe('Clip.1');
    if (stackedA?.children[0]?.OTIO_SCHEMA === 'Clip.1') {
      expect(stackedA.children[0].media_reference.target_url).toBe('./media/01-Cam A-v1.mp4');
    }
    expect(timeline.tracks.children[2]?.name).toBe('B');
  });
});
