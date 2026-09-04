import { describe, expect, it, vi } from 'vitest';
import { assembleDecisionList } from '@/lib/rough-cut/decision-list';
import { buildFcp7Xml, fcp7Rate } from '@/lib/rough-cut/fcp7-xml';
import type { CameraClip, EditDecision } from '@/lib/rough-cut/types';

vi.mock('@/lib/db', () => ({ db: {}, default: {}, disconnectDb: vi.fn() }));

function clip(role: string, versionId: string): CameraClip {
  return {
    videoId: `video-${versionId}`,
    versionId,
    title: `Cam ${role}`,
    role,
    position: 0,
    offsetSeconds: 0,
    durationSeconds: 10,
    frameRateNum: 24,
    frameRateDen: 1,
    dropFrame: false,
    startTimecode: null,
    originalUrl: '/api/upload/video/clip.mp4',
    versionNumber: 1,
    versionLabel: null,
  };
}

describe('fcp7Rate', () => {
  it('uses timebase 30 and ntsc TRUE for 30000/1001', () => {
    expect(fcp7Rate({ num: 30000, den: 1001, dropFrame: true })).toEqual({
      timebase: 30,
      ntsc: true,
    });
  });

  it('uses integer timebase and ntsc FALSE for 24 fps', () => {
    expect(fcp7Rate({ num: 24, den: 1, dropFrame: false })).toEqual({
      timebase: 24,
      ntsc: false,
    });
  });
});

describe('buildFcp7Xml', () => {
  it('produces the same XML whether or not edits carry reasons and the list carries cuts', () => {
    const clips = [clip('A', 'ver-a')];
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
      buildFcp7Xml({
        name: 'Rough Cut',
        decisions: assembleDecisionList({
          edits,
          clips,
          fileNames: new Map([['ver-a', '01-Cam A-v1.mp4']]),
          mediaPathPrefix: './media/',
          rate: { num: 24, den: 1, dropFrame: false },
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

    expect(annotated).toBe(plain);
  });

  it('writes xmeml with frame-denominated in/out and a shared file id', () => {
    const clips = [clip('A', 'ver-a')];
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
    ];
    const xml = buildFcp7Xml({
      name: 'Rough Cut',
      decisions: assembleDecisionList({
        edits,
        clips,
        fileNames: new Map([['ver-a', '01-Cam A-v1.mp4']]),
        mediaPathPrefix: './media/',
        rate: { num: 24, den: 1, dropFrame: false },
      }),
      clips,
      handleFrames: 0,
    });

    expect(xml).toContain('<xmeml version="5">');
    expect(xml).toContain('<timebase>24</timebase>');
    expect(xml).toContain('<ntsc>FALSE</ntsc>');
    expect(xml).toContain('<in>24</in>');
    expect(xml).toContain('<out>72</out>');
    expect(xml).toContain('<start>0</start>');
    expect(xml).toContain('<end>48</end>');
    expect(xml).toContain('file://localhost/./media/01-Cam%20A-v1.mp4');
    expect(xml).toContain('<file id="file-ver-a">');
    expect(xml).toContain('<file id="file-ver-a"/>');
    expect(xml).toContain('<displayformat>NDF</displayformat>');
    expect(xml).toContain('clipitem-stack-1');
  });
});
