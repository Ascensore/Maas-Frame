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
  it('produces the same timeline whether or not edits carry reasons and the list carries cuts', () => {
    const clips = [clip('A', 'ver-a', 10)];
    const edit: EditDecision = {
      timelineStartSeconds: 0,
      timelineEndSeconds: 2,
      inSeconds: 1,
      outSeconds: 3,
      sourceVersionId: 'ver-a',
      cameraRole: 'A',
      targetTrack: 1,
    };
    const build = (
      edits: EditDecision[],
      cuts?: Parameters<typeof assembleDecisionList>[0]['cuts']
    ) =>
      buildOtioTimeline({
        name: 'Rough Cut',
        decisions: assembleDecisionList({
          edits,
          clips,
          fileNames: new Map([['ver-a', '01-Cam A-v1.mp4']]),
          mediaPathPrefix: './media/',
          rate: RATE,
          cuts,
        }),
        clips,
        handleFrames: 0,
      });

    const plain = build([edit]);
    const annotated = build(
      [{ ...edit, reason: { code: 'KEPT', summary: 'Speech' } }],
      [
        {
          key: 'ver-a:72-96',
          sourceVersionId: 'ver-a',
          inSeconds: 3,
          outSeconds: 4,
          reason: { code: 'DEAD_AIR', summary: '1.0s of dead air' },
          transcriptText: null,
        },
      ]
    );

    expect(annotated).toEqual(plain);
    expect(plain.tracks.children[0]).not.toHaveProperty('markers');
  });

  it('writes program markers on the Program track and cut markers only when asked', () => {
    const clips = [clip('A', 'ver-a', 12)];
    const edits: EditDecision[] = [
      {
        timelineStartSeconds: 0,
        timelineEndSeconds: 4,
        inSeconds: 2,
        outSeconds: 6,
        sourceVersionId: 'ver-a',
        cameraRole: 'A',
        targetTrack: 1,
      },
      {
        timelineStartSeconds: 4,
        timelineEndSeconds: 6,
        inSeconds: 8,
        outSeconds: 10,
        sourceVersionId: 'ver-a',
        cameraRole: 'A',
        targetTrack: 1,
      },
    ];
    const decisions = assembleDecisionList({
      edits,
      clips,
      fileNames: new Map([['ver-a', '01-Cam A-v1.mp4']]),
      mediaPathPrefix: './media/',
      rate: RATE,
      cuts: [
        {
          key: 'ver-a:144-192',
          sourceVersionId: 'ver-a',
          inSeconds: 6,
          outSeconds: 8,
          reason: { code: 'DEAD_AIR', summary: '2.0s of dead air between thoughts' },
          transcriptText: null,
        },
      ],
      markers: [
        {
          key: 'ver-a:INFOGRAPHIC:72',
          kind: 'INFOGRAPHIC',
          timelineSeconds: 1,
          durationSeconds: 2.5,
          title: 'Infographic: KPI',
          reason: { code: 'MARKER_JARGON', summary: '“KPI” in “our KPI dashboard”' },
        },
        {
          key: 'ver-a:BROLL:120',
          kind: 'BROLL',
          timelineSeconds: 5,
          durationSeconds: null,
          title: 'B-roll: here is',
          reason: { code: 'MARKER_ILLUSTRATION', summary: '“here is”' },
        },
      ],
    });
    const build = (includeCuts?: boolean) =>
      buildOtioTimeline({ name: 'Rough Cut', decisions, clips, handleFrames: 0, includeCuts });

    const program = build().tracks.children[0]!;
    expect(program.markers?.[1]).toMatchObject({ name: 'B-roll: here is', color: 'GREEN' });
    expect(program.markers?.[1]?.marked_range.duration.value).toBe(0);
    expect(program.markers?.slice(0, 1)).toEqual([
      {
        OTIO_SCHEMA: 'Marker.2',
        name: 'Infographic: KPI',
        color: 'BLUE',
        marked_range: {
          OTIO_SCHEMA: 'TimeRange.1',
          start_time: { OTIO_SCHEMA: 'RationalTime.1', value: 24, rate: 24 },
          duration: { OTIO_SCHEMA: 'RationalTime.1', value: 60, rate: 24 },
        },
        comment: '“KPI” in “our KPI dashboard”',
        metadata: {
          openframe: {
            key: 'ver-a:INFOGRAPHIC:72',
            kind: 'INFOGRAPHIC',
            reason: { code: 'MARKER_JARGON', summary: '“KPI” in “our KPI dashboard”' },
          },
        },
      },
    ]);
    expect(build().tracks.children[1]?.markers).toBeUndefined();

    const withCuts = build(true).tracks.children[0]!.markers!;
    expect(
      withCuts.map((marker) => [marker.name, marker.color, marker.marked_range.start_time.value])
    ).toEqual([
      ['Infographic: KPI', 'BLUE', 24],
      ['Cut: 2.0s of dead air between thoughts', 'RED', 96],
      ['B-roll: here is', 'GREEN', 120],
    ]);
    expect(withCuts[1]?.marked_range.duration.value).toBe(0);
  });

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
