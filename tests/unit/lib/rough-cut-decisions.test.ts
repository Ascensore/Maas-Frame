import { describe, expect, it } from 'vitest';
import { computeLinearDecisions, computeRoughCutDecisions } from '@/lib/rough-cut/decisions';
import type { AttributedTurn, CameraClip } from '@/lib/rough-cut/types';

function clip(overrides: Partial<CameraClip> & Pick<CameraClip, 'versionId' | 'role'>): CameraClip {
  return {
    videoId: `video-${overrides.versionId}`,
    title: overrides.role,
    position: 0,
    offsetSeconds: 0,
    durationSeconds: 30,
    frameRateNum: 24,
    frameRateDen: 1,
    dropFrame: false,
    startTimecode: null,
    originalUrl: '/api/upload/video/clip.mp4',
    versionNumber: 1,
    versionLabel: null,
    ...overrides,
  };
}

function turn(start: number, end: number, versionId: string): AttributedTurn {
  return { start, end, versionId, speaker: null, confidence: 1 };
}

const CAM_A = 'ver-a';
const CAM_B = 'ver-b';
const WIDE = 'ver-wide';

const CLIPS = [
  clip({ versionId: CAM_A, role: 'A', position: 0 }),
  clip({ versionId: CAM_B, role: 'B', position: 1 }),
  clip({ versionId: WIDE, role: 'WIDE', position: 2 }),
];

const PROFILE = {
  minShotSeconds: 1.5,
  safetyPauseSeconds: 2,
  maxShotSeconds: null as number | null,
  overlapBehaviour: 'WIDE' as const,
  wideVersionId: WIDE,
};

function cameraAt(edits: ReturnType<typeof computeRoughCutDecisions>, time: number): string | null {
  const hit = edits.find(
    (edit) => edit.timelineStartSeconds <= time + 1e-6 && time < edit.timelineEndSeconds
  );
  return hit?.sourceVersionId ?? null;
}

describe('computeRoughCutDecisions', () => {
  it('cuts to the camera of the active speaker', () => {
    const edits = computeRoughCutDecisions(CLIPS, [turn(2, 8, CAM_A), turn(8, 14, CAM_B)], PROFILE);

    const live = edits.filter((edit) => edit.timelineStartSeconds >= 2);
    expect(live[0]).toMatchObject({
      sourceVersionId: CAM_A,
      inSeconds: 2,
      outSeconds: 8,
      targetTrack: 1,
    });
    expect(live[1]).toMatchObject({
      sourceVersionId: CAM_B,
      inSeconds: 8,
      outSeconds: 14,
    });
  });

  it('cuts to the wide during a pause longer than safetyPauseSeconds', () => {
    const edits = computeRoughCutDecisions(CLIPS, [turn(0, 3, CAM_A), turn(8, 12, CAM_B)], PROFILE);

    const pause = edits.find(
      (edit) => edit.timelineStartSeconds >= 3 - 1e-6 && edit.timelineStartSeconds < 8
    );
    expect(pause?.sourceVersionId).toBe(WIDE);
    expect(pause?.timelineEndSeconds).toBe(8);
  });

  it('holds the previous camera during a pause shorter than safetyPauseSeconds', () => {
    const edits = computeRoughCutDecisions(CLIPS, [turn(0, 4, CAM_A), turn(5, 9, CAM_B)], {
      ...PROFILE,
      minShotSeconds: 0.5,
    });

    expect(cameraAt(edits, 4.5)).toBe(CAM_A);
  });

  it('cuts to the wide when two speakers overlap and overlapBehaviour is WIDE', () => {
    const edits = computeRoughCutDecisions(CLIPS, [turn(0, 10, CAM_A), turn(4, 8, CAM_B)], {
      ...PROFILE,
      minShotSeconds: 0.5,
    });

    expect(cameraAt(edits, 6)).toBe(WIDE);
  });

  it('holds the previous camera when overlapBehaviour is HOLD', () => {
    const edits = computeRoughCutDecisions(CLIPS, [turn(0, 10, CAM_A), turn(4, 8, CAM_B)], {
      ...PROFILE,
      overlapBehaviour: 'HOLD',
      minShotSeconds: 0.5,
    });

    expect(cameraAt(edits, 6)).toBe(CAM_A);
  });

  it('stays on the first active speaker when overlapBehaviour is SPEAKER', () => {
    const edits = computeRoughCutDecisions(CLIPS, [turn(0, 10, CAM_A), turn(4, 8, CAM_B)], {
      ...PROFILE,
      overlapBehaviour: 'SPEAKER',
      minShotSeconds: 0.5,
    });

    expect(cameraAt(edits, 6)).toBe(CAM_A);
    expect(cameraAt(edits, 6)).not.toBe(WIDE);
  });

  it('merges a shot shorter than minShotSeconds into the previous shot', () => {
    const edits = computeRoughCutDecisions(
      CLIPS,
      [turn(0, 5, CAM_A), turn(5, 5.4, CAM_B), turn(5.4, 10, CAM_A)],
      { ...PROFILE, minShotSeconds: 1.5, safetyPauseSeconds: 10 }
    );

    expect(edits.some((edit) => edit.sourceVersionId === CAM_B)).toBe(false);
    expect(edits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceVersionId: CAM_A,
          timelineStartSeconds: 0,
          timelineEndSeconds: 10,
        }),
      ])
    );
  });

  it('splits a shot longer than maxShotSeconds and inserts a wide cutaway', () => {
    const edits = computeRoughCutDecisions(CLIPS, [turn(0, 20, CAM_A)], {
      ...PROFILE,
      minShotSeconds: 1.5,
      maxShotSeconds: 8,
      safetyPauseSeconds: 10,
    });

    expect(edits.length).toBeGreaterThan(1);
    expect(edits[0]).toMatchObject({ sourceVersionId: CAM_A, timelineStartSeconds: 0 });
    expect(edits[0]!.timelineEndSeconds).toBe(8);
    expect(edits[1]?.sourceVersionId).toBe(WIDE);
    expect(edits[1]!.timelineEndSeconds - edits[1]!.timelineStartSeconds).toBe(1.5);
    expect(edits[1]?.reason).toEqual({
      code: 'MAX_SHOT',
      summary: 'Cutaway after the maximum shot length',
    });
    expect(edits[0]?.reason).toEqual({ code: 'SPEAKER_SWITCH', summary: 'Speaker on A' });
  });

  it('keeps a held turn on the wide camera even when another speaker overlaps it', () => {
    const held: AttributedTurn = { ...turn(2, 8, WIDE), hold: 'chaos' };
    const edits = computeRoughCutDecisions(CLIPS, [held, turn(4, 6, CAM_A)], {
      ...PROFILE,
      overlapBehaviour: 'SPEAKER',
    });

    // Every segment lands on the wide camera, so the program is one shot whose
    // reason is the deliberate hold rather than the safety pauses around it.
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({
      sourceVersionId: WIDE,
      timelineStartSeconds: 0,
      timelineEndSeconds: 30,
      reason: { code: 'HOLD_WIDE', summary: 'Several people at once; holding wide' },
    });
  });

  it('absorbs a short pause into the speaker’s shot and explains the safety shot', () => {
    const edits = computeRoughCutDecisions(CLIPS, [turn(2, 8, CAM_A), turn(9, 14, CAM_A)], PROFILE);

    expect(edits.map((edit) => [edit.sourceVersionId, edit.reason])).toEqual([
      [WIDE, { code: 'HOLD_WIDE', summary: 'No one is speaking for 2.0s; safety shot' }],
      [CAM_A, { code: 'SPEAKER_SWITCH', summary: 'Speaker on A' }],
      [WIDE, { code: 'HOLD_WIDE', summary: 'No one is speaking for 16.0s; safety shot' }],
    ]);
    expect(edits[1]).toMatchObject({ timelineStartSeconds: 2, timelineEndSeconds: 14 });
  });

  it('maps source in/out relative to a clip offset', () => {
    const offsetClips = [
      clip({ versionId: CAM_A, role: 'A', position: 0, offsetSeconds: 2, durationSeconds: 20 }),
      clip({ versionId: WIDE, role: 'WIDE', position: 2, durationSeconds: 30 }),
    ];
    const edits = computeRoughCutDecisions(offsetClips, [turn(2, 8, CAM_A)], {
      ...PROFILE,
      minShotSeconds: 0.5,
      safetyPauseSeconds: 10,
    });
    const live = edits.find((edit) => edit.sourceVersionId === CAM_A);
    expect(live).toMatchObject({
      timelineStartSeconds: 2,
      timelineEndSeconds: 8,
      inSeconds: 0,
      outSeconds: 6,
    });
  });

  it('returns no edits when there are no clips', () => {
    expect(computeRoughCutDecisions([], [turn(0, 2, CAM_A)], PROFILE)).toEqual([]);
  });
});

describe('computeLinearDecisions', () => {
  it('drops silence and concatenates remaining speech', () => {
    const edits = computeLinearDecisions(
      [clip({ versionId: CAM_A, role: 'A', durationSeconds: 20 })],
      [turn(1, 4, CAM_A), turn(10, 14, CAM_A)],
      { minShotSeconds: 1.5 }
    );
    expect(edits).toEqual([
      {
        timelineStartSeconds: 0,
        timelineEndSeconds: 3,
        inSeconds: 1,
        outSeconds: 4,
        sourceVersionId: CAM_A,
        cameraRole: 'A',
        targetTrack: 1,
        reason: { code: 'KEPT', summary: 'Speech' },
      },
      {
        timelineStartSeconds: 3,
        timelineEndSeconds: 7,
        inSeconds: 10,
        outSeconds: 14,
        sourceVersionId: CAM_A,
        cameraRole: 'A',
        targetTrack: 1,
        reason: { code: 'KEPT', summary: 'Speech' },
      },
    ]);
  });

  it('drops takes shorter than minShotSeconds', () => {
    const edits = computeLinearDecisions(
      [clip({ versionId: CAM_A, role: 'A', durationSeconds: 20 })],
      [turn(0, 0.4, CAM_A), turn(5, 9, CAM_A)],
      { minShotSeconds: 1.5 }
    );
    expect(edits).toEqual([
      {
        timelineStartSeconds: 0,
        timelineEndSeconds: 4,
        inSeconds: 5,
        outSeconds: 9,
        sourceVersionId: CAM_A,
        cameraRole: 'A',
        targetTrack: 1,
        reason: { code: 'KEPT', summary: 'Speech' },
      },
    ]);
  });

  it('keeps each clip in full when no speech is detected', () => {
    const edits = computeLinearDecisions(
      [
        clip({ versionId: CAM_A, role: 'A', durationSeconds: 10 }),
        clip({ versionId: CAM_B, role: 'B', durationSeconds: 5 }),
      ],
      [],
      { minShotSeconds: 1.5 }
    );
    expect(edits).toEqual([
      {
        timelineStartSeconds: 0,
        timelineEndSeconds: 10,
        inSeconds: 0,
        outSeconds: 10,
        sourceVersionId: CAM_A,
        cameraRole: 'A',
        targetTrack: 1,
        reason: { code: 'KEPT', summary: 'Speech' },
      },
      {
        timelineStartSeconds: 10,
        timelineEndSeconds: 15,
        inSeconds: 0,
        outSeconds: 5,
        sourceVersionId: CAM_B,
        cameraRole: 'B',
        targetTrack: 1,
        reason: { code: 'KEPT', summary: 'Speech' },
      },
    ]);
  });
});
