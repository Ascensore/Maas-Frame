import { describe, expect, it } from 'vitest';
import { applyCameraGrammar, chaoticTurnIndexes } from '@/lib/rough-cut/camera-grammar';
import { parseRoughCutDecisionList } from '@/lib/rough-cut/decision-list';
import {
  cutIslandKey,
  mergeRanges,
  packTimeline,
  subtractTimelineRanges,
  toCutIsland,
} from '@/lib/rough-cut/program';
import type { AttributedTurn, EditDecision } from '@/lib/rough-cut/types';

const RATE = { num: 25, den: 1, dropFrame: false };

function edit(
  timelineStart: number,
  timelineEnd: number,
  inSeconds: number,
  sourceVersionId = 'v'
): EditDecision {
  return {
    timelineStartSeconds: timelineStart,
    timelineEndSeconds: timelineEnd,
    inSeconds,
    outSeconds: inSeconds + (timelineEnd - timelineStart),
    sourceVersionId,
    cameraRole: 'A',
    targetTrack: 1,
    reason: { code: 'KEPT', summary: 'Speech' },
  };
}

function turn(
  start: number,
  end: number,
  versionId: string,
  speaker: string | null,
  confidence = 2
): AttributedTurn {
  return { start, end, versionId, speaker, confidence };
}

describe('cut islands', () => {
  it('keys an island by source and frame-rounded range', () => {
    // secondsToFrames floors: 25.5 → 25, 87.5 → 87.
    expect(cutIslandKey('ver-a', 1.02, 3.5, RATE)).toBe('ver-a:25-87');
    expect(
      toCutIsland(
        { versionId: 'ver-a', start: 1.02, end: 3.5, code: 'DEAD_AIR', summary: 's', text: null },
        RATE
      )
    ).toEqual({
      key: 'ver-a:25-87',
      sourceVersionId: 'ver-a',
      inSeconds: 1.02,
      outSeconds: 3.5,
      reason: { code: 'DEAD_AIR', summary: 's' },
      transcriptText: null,
    });
  });
});

describe('subtractTimelineRanges', () => {
  it('splits an edit around a hole and drops what falls inside, keeping source in/out aligned', () => {
    const edits = [edit(0, 10, 5, 'a'), edit(10, 20, 0, 'b')];

    const result = subtractTimelineRanges(edits, [
      { start: 2, end: 4 },
      { start: 9, end: 12 },
      { start: 18, end: 25 },
    ]);

    expect(result).toEqual([
      { ...edit(0, 2, 5, 'a') },
      { ...edit(4, 9, 9, 'a') },
      { ...edit(12, 18, 2, 'b') },
    ]);
  });

  it('merges overlapping holes and leaves untouched edits alone', () => {
    expect(
      mergeRanges([
        { start: 5, end: 8 },
        { start: 1, end: 3 },
        { start: 2, end: 6 },
      ])
    ).toEqual([{ start: 1, end: 8 }]);
    expect(subtractTimelineRanges([edit(0, 5, 0)], [{ start: 6, end: 7 }])).toEqual([
      edit(0, 5, 0),
    ]);
    expect(subtractTimelineRanges([edit(0, 5, 0)], [{ start: 0, end: 5 }])).toEqual([]);
  });
});

describe('packTimeline', () => {
  it('packs edits back to back from zero, keeping order, durations and source ranges', () => {
    const packed = packTimeline([edit(4, 9, 9, 'a'), edit(12, 18, 2, 'b')]);
    expect(packed.map((entry) => [entry.timelineStartSeconds, entry.timelineEndSeconds])).toEqual([
      [0, 5],
      [5, 11],
    ]);
    expect(packed[1]).toMatchObject({ inSeconds: 2, outSeconds: 8 });
  });
});

describe('camera grammar', () => {
  it('holds wide when three speakers start inside six seconds, and not otherwise', () => {
    const turns = [
      turn(0, 2, 'a', 'S0'),
      turn(2.5, 4, 'b', 'S1'),
      turn(4.5, 6, 'c', 'S2'),
      turn(20, 25, 'a', 'S0'),
      turn(25.5, 30, 'b', 'S1'),
    ];

    expect([...chaoticTurnIndexes(turns)].sort()).toEqual([0, 1, 2]);
    expect(
      applyCameraGrammar(turns, {
        wideVersionId: 'wide',
        followSpeaker: true,
        holdWideOnChaos: true,
      })
    ).toEqual([
      { ...turns[0], versionId: 'wide', hold: 'chaos' },
      { ...turns[1], versionId: 'wide', hold: 'chaos' },
      { ...turns[2], versionId: 'wide', hold: 'chaos' },
      turns[3],
      turns[4],
    ]);
  });

  it('holds wide when most attributions in the window are uncertain', () => {
    const turns = [
      turn(0, 2, 'a', null, 1.05),
      turn(3, 5, 'b', null, 1.1),
      turn(6, 8, 'a', null, 3),
    ];
    expect([...chaoticTurnIndexes(turns)].sort()).toEqual([0, 1]);
  });

  it('holds the primary camera for every turn when the brief does not follow the speaker', () => {
    const turns = [turn(0, 2, 'a', 'S0'), turn(3, 5, 'b', 'S1')];
    expect(
      applyCameraGrammar(turns, {
        wideVersionId: 'wide',
        followSpeaker: false,
        holdWideOnChaos: true,
      })
    ).toEqual([
      { ...turns[0], versionId: 'wide', hold: 'primary' },
      { ...turns[1], versionId: 'wide', hold: 'primary' },
    ]);
    expect(
      applyCameraGrammar(turns, {
        wideVersionId: 'wide',
        followSpeaker: true,
        holdWideOnChaos: false,
      })
    ).toEqual(turns);
  });
});

describe('decision list schema', () => {
  const base = {
    version: 1,
    edits: [
      {
        timelineStartSeconds: 0,
        timelineEndSeconds: 2,
        inSeconds: 0,
        outSeconds: 2,
        sourceVersionId: 'v',
        cameraRole: 'A',
        targetTrack: 1,
      },
    ],
    clips: [
      {
        versionId: 'v',
        videoId: 'vid',
        role: 'A',
        offsetSeconds: 0,
        durationSeconds: 10,
        track: 2,
        fileName: 'a.mp4',
        targetUrl: './media/a.mp4',
      },
    ],
    rate: { num: 25, den: 1, dropFrame: false },
  };

  it('still parses a list written before reasons and cuts existed', () => {
    expect(parseRoughCutDecisionList(base)).toEqual(base);
  });

  it('accepts reasons and cut islands, and refuses an unknown code', () => {
    const withExtras = {
      ...base,
      edits: [{ ...base.edits[0], reason: { code: 'KEPT', summary: 'Speech' } }],
      cuts: [
        {
          key: 'v:50-75',
          sourceVersionId: 'v',
          inSeconds: 2,
          outSeconds: 3,
          reason: { code: 'DEAD_AIR', summary: '1.0s of dead air' },
          transcriptText: null,
        },
      ],
    };
    expect(parseRoughCutDecisionList(withExtras)).toEqual(withExtras);
    expect(
      parseRoughCutDecisionList({
        ...withExtras,
        cuts: [{ ...withExtras.cuts[0], reason: { code: 'BORING', summary: '' } }],
      })
    ).toBeNull();
  });
});
