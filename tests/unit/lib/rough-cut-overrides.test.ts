import { describe, expect, it } from 'vitest';
import { assembleDecisionList } from '@/lib/rough-cut/decision-list';
import {
  applyOverrides,
  emptyOverrides,
  extraCutKey,
  hasProgramChanges,
  overrideSummary,
  overridesEqual,
  parseRoughCutOverrides,
  validateOverridesForDecisions,
} from '@/lib/rough-cut/overrides';
import { cutIslandKey } from '@/lib/rough-cut/program';
import type { CameraClip, EditDecision, RoughCutDecisionList } from '@/lib/rough-cut/types';

const RATE = { num: 25, den: 1, dropFrame: false };

function clip(versionId: string, offsetSeconds = 0, role = 'A'): CameraClip {
  return {
    videoId: `video-${versionId}`,
    versionId,
    title: versionId,
    role,
    position: 0,
    offsetSeconds,
    durationSeconds: 30,
    frameRateNum: 25,
    frameRateDen: 1,
    dropFrame: false,
    startTimecode: null,
    originalUrl: `/api/upload/video/${versionId}.mp4`,
    versionNumber: 1,
    versionLabel: null,
  };
}

function edit(
  timelineStart: number,
  inSeconds: number,
  outSeconds: number,
  sourceVersionId = 'v1',
  cameraRole = 'A'
): EditDecision {
  return {
    timelineStartSeconds: timelineStart,
    timelineEndSeconds: timelineStart + (outSeconds - inSeconds),
    inSeconds,
    outSeconds,
    sourceVersionId,
    cameraRole,
    targetTrack: 1,
    reason: { code: 'KEPT', summary: 'Speech' },
  };
}

/** A linear cut of one clip: speech at 1–4 and 6–10, dead air 4–6 removed. */
function linearDecisions(): RoughCutDecisionList {
  return assembleDecisionList({
    edits: [edit(0, 1, 4), edit(3, 6, 10)],
    clips: [clip('v1')],
    fileNames: new Map([['v1', '01-v1.mp4']]),
    mediaPathPrefix: './media/',
    rate: RATE,
    cuts: [
      {
        key: cutIslandKey('v1', 4, 6, RATE),
        sourceVersionId: 'v1',
        inSeconds: 4,
        outSeconds: 6,
        reason: { code: 'DEAD_AIR', summary: '2.0s of dead air' },
        transcriptText: null,
      },
    ],
  });
}

const ISLAND = cutIslandKey('v1', 4, 6, RATE);

describe('parseRoughCutOverrides', () => {
  it('reads a stored value and refuses anything malformed', () => {
    expect(parseRoughCutOverrides(null)).toBeNull();
    expect(parseRoughCutOverrides({ version: 1, cuts: { [ISLAND]: 'restore' } })).toEqual({
      version: 1,
      cuts: { [ISLAND]: 'restore' },
      extraCuts: [],
    });
    expect(parseRoughCutOverrides({ version: 2, cuts: {} })).toBeNull();
    expect(parseRoughCutOverrides({ version: 1, cuts: { [ISLAND]: 'delete' } })).toBeNull();
  });
});

describe('validateOverridesForDecisions', () => {
  it('rejects a key the run does not have and a cut outside its clips', () => {
    const decisions = linearDecisions();
    const unknown = validateOverridesForDecisions(
      { version: 1, cuts: { 'v1:0-1': 'restore' } },
      decisions
    );
    expect(unknown).toEqual({ ok: false, error: 'Unknown cut keys: v1:0-1' });
    const foreign = validateOverridesForDecisions(
      { version: 1, extraCuts: [{ sourceVersionId: 'v9', inSeconds: 1, outSeconds: 2 }] },
      decisions
    );
    expect(foreign.ok).toBe(false);
    const pastEnd = validateOverridesForDecisions(
      { version: 1, extraCuts: [{ sourceVersionId: 'v1', inSeconds: 29, outSeconds: 31 }] },
      decisions
    );
    expect(pastEnd.ok).toBe(false);
  });

  it('derives extra cut keys itself and drops duplicates', () => {
    const decisions = linearDecisions();
    const result = validateOverridesForDecisions(
      {
        version: 1,
        cuts: { [ISLAND]: 'keep' },
        extraCuts: [
          {
            key: 'client-made-this-up',
            sourceVersionId: 'v1',
            inSeconds: 2,
            outSeconds: 3,
            note: ' too slow ',
          },
          { sourceVersionId: 'v1', inSeconds: 2, outSeconds: 3 },
        ],
      },
      decisions
    );
    expect(result).toEqual({
      ok: true,
      value: {
        version: 1,
        cuts: { [ISLAND]: 'keep' },
        extraCuts: [
          {
            key: extraCutKey('v1', 2, 3, RATE),
            sourceVersionId: 'v1',
            inSeconds: 2,
            outSeconds: 3,
            note: 'too slow',
          },
        ],
      },
    });
    // 2s and 3s at 25fps are frames 50 and 75.
    expect(extraCutKey('v1', 2, 3, RATE)).toBe('manual:v1:50-75');
  });
});

describe('applyOverrides', () => {
  it('returns the same list when nothing changes the program', () => {
    const decisions = linearDecisions();
    expect(applyOverrides(decisions, null)).toBe(decisions);
    expect(applyOverrides(decisions, { ...emptyOverrides(), cuts: { [ISLAND]: 'keep' } })).toBe(
      decisions
    );
    expect(hasProgramChanges({ ...emptyOverrides(), cuts: { [ISLAND]: 'keep' } })).toBe(false);
  });

  it('puts a restored island back in source order, merges it with its neighbours and re-packs', () => {
    const decisions = linearDecisions();
    const before = decisions.edits.map((entry) => ({ ...entry }));
    const result = applyOverrides(decisions, {
      ...emptyOverrides(),
      cuts: { [ISLAND]: 'restore' },
    });
    // 1–4, the restored 4–6 and 6–10 are one continuous run of the same source
    // and camera, so they become a single 1–10 edit, 9s long, packed from zero.
    expect(result.edits).toEqual([
      expect.objectContaining({
        timelineStartSeconds: 0,
        timelineEndSeconds: 9,
        inSeconds: 1,
        outSeconds: 10,
        reason: { code: 'KEPT', summary: 'Restored by the reviewer' },
      }),
    ]);
    expect(result.cuts).toEqual(decisions.cuts);
    // Pure: the run's own decision list is left exactly as it was.
    expect(decisions.edits).toEqual(before);
  });

  it('splits an edit around an extra cut', () => {
    const decisions = linearDecisions();
    const result = applyOverrides(decisions, {
      ...emptyOverrides(),
      extraCuts: [
        {
          key: extraCutKey('v1', 7, 8, RATE),
          sourceVersionId: 'v1',
          inSeconds: 7,
          outSeconds: 8,
          note: null,
        },
      ],
    });
    expect(
      result.edits.map((entry) => [
        entry.timelineStartSeconds,
        entry.timelineEndSeconds,
        entry.inSeconds,
        entry.outSeconds,
      ])
    ).toEqual([
      [0, 3, 1, 4],
      [3, 4, 6, 7],
      [4, 6, 8, 10],
    ]);
  });

  it('orders a multicam restore by the clip offset, not by source time alone', () => {
    // The cam clip starts 6s after the wide one, so its 2–5 edit sits at axis
    // 8–11: after the wide island at axis 5, even though 2 < 5 in source time.
    const decisions = assembleDecisionList({
      edits: [edit(0, 0, 5, 'wide', 'WIDE'), edit(5, 2, 5, 'cam', 'A')],
      clips: [clip('wide', 0, 'WIDE'), clip('cam', 6, 'A')],
      fileNames: new Map([
        ['wide', '01-wide.mp4'],
        ['cam', '02-cam.mp4'],
      ]),
      mediaPathPrefix: './media/',
      rate: RATE,
      cuts: [
        {
          key: cutIslandKey('wide', 5, 7, RATE),
          sourceVersionId: 'wide',
          inSeconds: 5,
          outSeconds: 7,
          reason: { code: 'DEAD_AIR', summary: '2.0s of dead air' },
          transcriptText: null,
        },
      ],
    });
    const result = applyOverrides(decisions, {
      ...emptyOverrides(),
      cuts: { [cutIslandKey('wide', 5, 7, RATE)]: 'restore' },
    });
    expect(
      result.edits.map((entry) => [
        entry.sourceVersionId,
        entry.timelineStartSeconds,
        entry.timelineEndSeconds,
        entry.inSeconds,
      ])
    ).toEqual([
      ['wide', 0, 7, 0],
      ['cam', 7, 10, 2],
    ]);
  });
});

describe('overrideSummary / overridesEqual', () => {
  it('counts decisions and program length', () => {
    const decisions = linearDecisions();
    const overrides = { ...emptyOverrides(), cuts: { [ISLAND]: 'restore' as const } };
    expect(overrideSummary(decisions, overrides)).toEqual({
      restored: 1,
      kept: 0,
      extraCuts: 0,
      originalSeconds: 7,
      programSeconds: 9,
    });
    expect(
      overridesEqual(overrides, { version: 1, cuts: { [ISLAND]: 'restore' }, extraCuts: [] })
    ).toBe(true);
    expect(overridesEqual(overrides, null)).toBe(false);
    expect(overridesEqual(null, null)).toBe(true);
    expect(overridesEqual(null, emptyOverrides())).toBe(true);
  });
});
