import { describe, expect, it } from 'vitest';
import { assembleDecisionList } from '@/lib/rough-cut/decision-list';
import {
  applyOverrides,
  applyOverridesWithReport,
  effectiveDecisions,
  emptyOverrides,
  extraCutKey,
  hasProgramChanges,
  needsRender,
  overrideSummary,
  overridesEqual,
  parseRoughCutOverrides,
  validateOverridesForDecisions,
  type ExtraCut,
  type RoughCutOverrides,
} from '@/lib/rough-cut/overrides';
import { cutIslandKey } from '@/lib/rough-cut/program';
import type {
  CameraClip,
  CutIsland,
  EditDecision,
  Marker,
  RoughCutDecisionList,
} from '@/lib/rough-cut/types';

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

function island(sourceVersionId: string, inSeconds: number, outSeconds: number): CutIsland {
  return {
    key: cutIslandKey(sourceVersionId, inSeconds, outSeconds, RATE),
    sourceVersionId,
    inSeconds,
    outSeconds,
    reason: { code: 'DEAD_AIR', summary: '2.0s of dead air' },
    transcriptText: null,
  };
}

function marker(key: string, timelineSeconds: number): Marker {
  return {
    key,
    kind: 'INFOGRAPHIC',
    timelineSeconds,
    durationSeconds: 2,
    title: key,
    reason: { code: 'MARKER_JARGON', summary: 'Jargon' },
  };
}

/** A linear cut of one clip: speech at 1–4 and 6–10, dead air 4–6 removed. */
function linearDecisions(markers?: Marker[]): RoughCutDecisionList {
  return assembleDecisionList({
    edits: [edit(0, 1, 4), edit(3, 6, 10)],
    clips: [clip('v1')],
    fileNames: new Map([['v1', '01-v1.mp4']]),
    mediaPathPrefix: './media/',
    rate: RATE,
    cuts: [island('v1', 4, 6)],
    markers,
  });
}

/** How much footage the program holds, independent of where it sits on the timeline. */
function programSeconds(edits: EditDecision[]): number {
  return edits.reduce((sum, entry) => sum + (entry.outSeconds - entry.inSeconds), 0);
}

function ranges(edits: EditDecision[]): number[][] {
  return edits.map((entry) => [
    entry.timelineStartSeconds,
    entry.timelineEndSeconds,
    entry.inSeconds,
    entry.outSeconds,
  ]);
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
    expect(parseRoughCutOverrides({ version: 1, cuts: {}, nope: true })).toBeNull();
  });

  it('gives every stored extra cut a key of its own and normalises its note', () => {
    const parsed = parseRoughCutOverrides({
      version: 1,
      extraCuts: [
        { sourceVersionId: 'v1', inSeconds: 2, outSeconds: 3 },
        { sourceVersionId: 'v1', inSeconds: 4, outSeconds: 5, note: ' slow ' },
        { key: 'manual:v1:250-275', sourceVersionId: 'v1', inSeconds: 10, outSeconds: 11 },
      ],
    });
    expect(parsed?.extraCuts).toEqual([
      { key: 'stored:v1:2-3', sourceVersionId: 'v1', inSeconds: 2, outSeconds: 3, note: null },
      { key: 'stored:v1:4-5', sourceVersionId: 'v1', inSeconds: 4, outSeconds: 5, note: 'slow' },
      {
        key: 'manual:v1:250-275',
        sourceVersionId: 'v1',
        inSeconds: 10,
        outSeconds: 11,
        note: null,
      },
    ]);
  });

  it('keeps a keyless stored cut apart from the frame key that shares its numbers', () => {
    // 2–3 s at 25 fps is frames 50–75, the numbers a keyless row at 50–75
    // seconds carries; only the prefix keeps the two cuts apart.
    const parsed = parseRoughCutOverrides({
      version: 1,
      extraCuts: [{ sourceVersionId: 'v1', inSeconds: 50, outSeconds: 75 }],
    });
    expect(parsed?.extraCuts[0]?.key).toBe('stored:v1:50-75');
    expect(parsed?.extraCuts[0]?.key).not.toBe(extraCutKey('v1', 2, 3, RATE));
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
    expect(foreign).toEqual({ ok: false, error: 'extraCuts: v9 is not a clip of this cut' });
    const pastEnd = validateOverridesForDecisions(
      { version: 1, extraCuts: [{ sourceVersionId: 'v1', inSeconds: 29, outSeconds: 31 }] },
      decisions
    );
    expect(pastEnd).toEqual({ ok: false, error: 'extraCuts: 31s is past the end of the clip' });
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

  it('snaps a stored range to the frames its key names', () => {
    const decisions = linearDecisions();
    // 2.02s and 3.02s are still frames 50 and 75 at 25fps: the same cut, drawn
    // half a frame later. Both come back as the frame-exact 2s and 3s.
    const rough = validateOverridesForDecisions(
      { version: 1, extraCuts: [{ sourceVersionId: 'v1', inSeconds: 2.02, outSeconds: 3.02 }] },
      decisions
    );
    const exact = validateOverridesForDecisions(
      { version: 1, extraCuts: [{ sourceVersionId: 'v1', inSeconds: 2, outSeconds: 3 }] },
      decisions
    );
    expect(rough.ok && rough.value.extraCuts).toEqual([
      { key: 'manual:v1:50-75', sourceVersionId: 'v1', inSeconds: 2, outSeconds: 3, note: null },
    ]);
    expect(rough.ok && exact.ok && overridesEqual(rough.value, exact.value)).toBe(true);
  });

  it('refuses a range that is reversed or shorter than the minimum', () => {
    const decisions = linearDecisions();
    expect(
      validateOverridesForDecisions(
        { version: 1, extraCuts: [{ sourceVersionId: 'v1', inSeconds: 4, outSeconds: 2 }] },
        decisions
      )
    ).toEqual({ ok: false, error: 'extraCuts: a cut cannot end (2s) before it starts (4s)' });
    expect(
      validateOverridesForDecisions(
        { version: 1, extraCuts: [{ sourceVersionId: 'v1', inSeconds: 2, outSeconds: 2.05 }] },
        decisions
      )
    ).toEqual({ ok: false, error: 'extraCuts: a cut must be at least 0.1s long' });
    // 0.3 - 0.2 is 0.09999999999999998, and a cut drawn as exactly the minimum
    // is not a cut below it.
    const exactlyMinimum = validateOverridesForDecisions(
      { version: 1, extraCuts: [{ sourceVersionId: 'v1', inSeconds: 0.2, outSeconds: 0.3 }] },
      decisions
    );
    expect(exactlyMinimum.ok).toBe(true);
  });

  it('lets a cut past the end through when the clip has no known duration', () => {
    // A clip that never got probed is stored as 0s long. That is unknown, not
    // empty, so the end-of-clip bound does not apply and every cut on it stands.
    const decisions = assembleDecisionList({
      edits: [edit(0, 1, 4)],
      clips: [{ ...clip('v1'), durationSeconds: 0 }],
      fileNames: new Map([['v1', '01-v1.mp4']]),
      mediaPathPrefix: './media/',
      rate: RATE,
    });
    const result = validateOverridesForDecisions(
      { version: 1, extraCuts: [{ sourceVersionId: 'v1', inSeconds: 100, outSeconds: 101 }] },
      decisions
    );
    expect(result.ok && result.value.extraCuts.map((cut) => cut.key)).toEqual([
      'manual:v1:2500-2525',
    ]);
  });

  it('refuses a body the schema does not allow, naming the field', () => {
    const decisions = linearDecisions();
    const negative = validateOverridesForDecisions(
      { version: 1, extraCuts: [{ sourceVersionId: 'v1', inSeconds: -1, outSeconds: 2 }] },
      decisions
    );
    expect(negative.ok).toBe(false);
    expect(negative.ok === false && negative.error).toMatch(/^extraCuts\.0\.inSeconds: /);

    const strayTop = validateOverridesForDecisions({ version: 1, cuts: {}, nope: true }, decisions);
    expect(strayTop.ok === false && strayTop.error).toContain('nope');

    const strayInner = validateOverridesForDecisions(
      {
        version: 1,
        extraCuts: [{ sourceVersionId: 'v1', inSeconds: 1, outSeconds: 2, nope: true }],
      },
      decisions
    );
    expect(strayInner.ok === false && strayInner.error).toMatch(/^extraCuts\.0: .*nope/);

    // 301 characters, one over the 300 the note allows.
    const longNote = validateOverridesForDecisions(
      {
        version: 1,
        extraCuts: [{ sourceVersionId: 'v1', inSeconds: 1, outSeconds: 2, note: 'x'.repeat(301) }],
      },
      decisions
    );
    expect(longNote.ok === false && longNote.error).toMatch(/^extraCuts\.0\.note: /);

    // 201 cuts, one over the 200 a body may carry.
    const tooMany = validateOverridesForDecisions(
      {
        version: 1,
        extraCuts: Array.from({ length: 201 }, () => ({
          sourceVersionId: 'v1',
          inSeconds: 1,
          outSeconds: 2,
        })),
      },
      decisions
    );
    expect(tooMany.ok === false && tooMany.error).toMatch(/^extraCuts: /);
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

  it('treats a restore of a key this run no longer has as no change at all', () => {
    const decisions = linearDecisions();
    const stale = { ...emptyOverrides(), cuts: { 'v1:900-950': 'restore' as const } };
    expect(hasProgramChanges(stale)).toBe(true);
    expect(hasProgramChanges(stale, decisions)).toBe(false);
    expect(applyOverrides(decisions, stale)).toBe(decisions);
    expect(applyOverridesWithReport(decisions, stale).staleCutKeys).toEqual(['v1:900-950']);
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

  it('never puts back material the program already holds', () => {
    // computeLinearDecisions keeps a clip in full when no island clears
    // minShotSeconds, and records the cuts all the same: the 4–6 island is
    // already inside the kept 0–30, so restoring it must change nothing.
    const decisions = assembleDecisionList({
      edits: [edit(0, 0, 30)],
      clips: [clip('v1')],
      fileNames: new Map([['v1', '01-v1.mp4']]),
      mediaPathPrefix: './media/',
      rate: RATE,
      cuts: [island('v1', 4, 6)],
    });
    const applied = applyOverridesWithReport(decisions, {
      ...emptyOverrides(),
      cuts: { [ISLAND]: 'restore' },
    });
    expect(ranges(applied.decisions.edits)).toEqual([[0, 30, 0, 30]]);
    expect(programSeconds(applied.decisions.edits)).toBe(30);
    expect(applied.restoredKeys).toEqual([ISLAND]);
  });

  it('restores a key the decision list holds twice exactly once', () => {
    const decisions = assembleDecisionList({
      edits: [edit(0, 1, 4), edit(3, 6, 10)],
      clips: [clip('v1')],
      fileNames: new Map([['v1', '01-v1.mp4']]),
      mediaPathPrefix: './media/',
      rate: RATE,
      cuts: [island('v1', 4, 6), island('v1', 4, 6)],
    });
    const applied = applyOverridesWithReport(decisions, {
      ...emptyOverrides(),
      cuts: { [ISLAND]: 'restore' },
    });
    // 7s of program plus the 2s island, once: 9, never 11.
    expect(programSeconds(applied.decisions.edits)).toBe(9);
    expect(ranges(applied.decisions.edits)).toEqual([[0, 9, 1, 10]]);
    expect(applied.restoredKeys).toEqual([ISLAND]);
  });

  it('skips an island whose source is not a clip of this run', () => {
    const decisions = assembleDecisionList({
      edits: [edit(0, 1, 4), edit(3, 6, 10)],
      clips: [clip('v1')],
      fileNames: new Map([['v1', '01-v1.mp4']]),
      mediaPathPrefix: './media/',
      rate: RATE,
      cuts: [island('gone', 4, 6)],
    });
    const applied = applyOverridesWithReport(decisions, {
      ...emptyOverrides(),
      cuts: { 'gone:100-150': 'restore' },
    });
    expect(applied.skippedIslands).toEqual(['gone:100-150']);
    expect(applied.restoredKeys).toEqual([]);
    expect(ranges(applied.decisions.edits)).toEqual([
      [0, 3, 1, 4],
      [3, 7, 6, 10],
    ]);
  });

  it('splits an edit around an extra cut', () => {
    const decisions = linearDecisions();
    const applied = applyOverridesWithReport(decisions, {
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
    expect(ranges(applied.decisions.edits)).toEqual([
      [0, 3, 1, 4],
      [3, 4, 6, 7],
      [4, 6, 8, 10],
    ]);
    expect(applied.extraCutsApplied).toBe(1);
  });

  it('reports an extra cut drawn over material that was already gone', () => {
    const decisions = linearDecisions();
    const applied = applyOverridesWithReport(decisions, {
      ...emptyOverrides(),
      extraCuts: [
        {
          key: extraCutKey('v1', 4, 6, RATE),
          sourceVersionId: 'v1',
          inSeconds: 4,
          outSeconds: 6,
          note: null,
        },
      ],
    });
    expect(applied.extraCutsApplied).toBe(0);
    expect(programSeconds(applied.decisions.edits)).toBe(7);
  });

  it('moves markers with the footage they point at and drops the ones inside a cut', () => {
    // On the original program: 1s is source 2s (kept), 4.5s is source 7.5s
    // (inside the 7–8 cut), 6s is source 9s (kept, and 1s earlier afterwards).
    const decisions = linearDecisions([marker('m-a', 1), marker('m-b', 4.5), marker('m-c', 6)]);
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
    expect(result.markers?.map((entry) => [entry.key, entry.timelineSeconds])).toEqual([
      ['m-a', 1],
      ['m-c', 5],
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
      cuts: [island('wide', 5, 7)],
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
      staleKeys: [],
    });
    expect(
      overridesEqual(overrides, { version: 1, cuts: { [ISLAND]: 'restore' }, extraCuts: [] })
    ).toBe(true);
    expect(overridesEqual(overrides, null)).toBe(false);
    expect(overridesEqual(null, null)).toBe(true);
    expect(overridesEqual(null, emptyOverrides())).toBe(true);
  });

  it('reports a decision on an island this run no longer has as stale', () => {
    const decisions = linearDecisions();
    const overrides = {
      ...emptyOverrides(),
      cuts: { [ISLAND]: 'keep' as const, 'v1:900-950': 'restore' as const },
    };
    expect(overrideSummary(decisions, overrides)).toEqual({
      restored: 0,
      kept: 1,
      extraCuts: 0,
      originalSeconds: 7,
      programSeconds: 7,
      staleKeys: ['v1:900-950'],
    });
  });

  it('ignores key order, extra cut order and notes, but not the decisions themselves', () => {
    const cut = (key: string, inSeconds: number, note: string | null = null): ExtraCut => ({
      key,
      sourceVersionId: 'v1',
      inSeconds,
      outSeconds: inSeconds + 1,
      note,
    });
    const overrides = (
      cuts: RoughCutOverrides['cuts'],
      extraCuts: ExtraCut[]
    ): RoughCutOverrides => ({ version: 1, cuts, extraCuts });

    const a = overrides({ 'v1:0-25': 'restore', 'v1:50-75': 'keep' }, [
      cut('manual:v1:50-75', 2),
      cut('manual:v1:100-125', 4),
    ]);
    const reordered = overrides({ 'v1:50-75': 'keep', 'v1:0-25': 'restore' }, [
      cut('manual:v1:100-125', 4),
      cut('manual:v1:50-75', 2, 'a note'),
    ]);
    expect(overridesEqual(a, reordered)).toBe(true);
    // Same cut, seconds from before ranges were snapped: the key is the identity.
    expect(
      overridesEqual(a, overrides(a.cuts, [cut('manual:v1:50-75', 2.02), a.extraCuts[1]!]))
    ).toBe(true);
    expect(
      overridesEqual(a, overrides({ 'v1:0-25': 'keep', 'v1:50-75': 'keep' }, a.extraCuts))
    ).toBe(false);
    expect(overridesEqual(a, overrides(a.cuts, [a.extraCuts[0]!]))).toBe(false);
    // A draft that drew the same cut twice holds one decision, not two.
    expect(
      overridesEqual(a, overrides(a.cuts, [...a.extraCuts, cut('manual:v1:50-75', 2, 'again')]))
    ).toBe(true);
  });
});

describe('needsRender', () => {
  const decisions = linearDecisions();
  const overrides = (cuts: RoughCutOverrides['cuts'], extraCuts: ExtraCut[] = []) => ({
    version: 1 as const,
    cuts,
    extraCuts,
  });
  const manual = (inSeconds: number): ExtraCut => ({
    key: extraCutKey('v1', inSeconds, inSeconds + 1, RATE),
    sourceVersionId: 'v1',
    inSeconds,
    outSeconds: inSeconds + 1,
    note: null,
  });

  it('does not ask for a render for decisions that cannot change a frame', () => {
    // Keeping a cut is agreeing with the render that already happened.
    expect(needsRender(decisions, overrides({ [ISLAND]: 'keep' }), null)).toBe(false);
    expect(needsRender(decisions, null, overrides({ [ISLAND]: 'keep' }))).toBe(false);
    // And an island this run no longer has is a decision nothing can apply.
    expect(needsRender(decisions, overrides({ 'v1:900-950': 'restore' }), null)).toBe(false);
    expect(needsRender(decisions, null, null)).toBe(false);
    expect(needsRender(decisions, emptyOverrides(), null)).toBe(false);
  });

  it('asks for a render when the program would come out different', () => {
    expect(needsRender(decisions, overrides({ [ISLAND]: 'restore' }), null)).toBe(true);
    expect(needsRender(decisions, overrides({}, [manual(2)]), null)).toBe(true);
    // Undoing a restore that was rendered is a change too.
    expect(needsRender(decisions, null, overrides({ [ISLAND]: 'restore' }))).toBe(true);
  });

  it('does not ask for a render when the rendered decisions already match', () => {
    const saved = overrides({ [ISLAND]: 'restore' }, [manual(2)]);
    expect(needsRender(decisions, saved, saved)).toBe(false);
    // Key order, notes and a keep added on one side change nothing.
    expect(
      needsRender(decisions, { ...saved, cuts: { ...saved.cuts, 'v1:900-950': 'keep' } }, saved)
    ).toBe(false);
    expect(needsRender(decisions, saved, overrides(saved.cuts, [manual(2)]))).toBe(false);
    // A different extra cut is a different program.
    expect(needsRender(decisions, saved, overrides(saved.cuts, [manual(3)]))).toBe(true);
  });
});

describe('effectiveDecisions', () => {
  it('leaves a run with no overrides exactly as it was', () => {
    const decisions = linearDecisions();
    expect(effectiveDecisions(decisions, null)).toEqual(decisions);
  });

  it('drops a restored island from the cut list and adds the cuts the reviewer drew', () => {
    const decisions = linearDecisions();
    const effective = effectiveDecisions(decisions, {
      version: 1,
      cuts: { [ISLAND]: 'restore' },
      extraCuts: [
        {
          key: extraCutKey('v1', 2, 3, RATE),
          sourceVersionId: 'v1',
          inSeconds: 2,
          outSeconds: 3,
          note: 'fluffed the line',
        },
      ],
    });

    expect(effective.cuts).toEqual([
      {
        key: extraCutKey('v1', 2, 3, RATE),
        sourceVersionId: 'v1',
        inSeconds: 2,
        outSeconds: 3,
        reason: { code: 'REVIEWER', summary: 'fluffed the line' },
        transcriptText: null,
      },
    ]);
    // The program is the applied one: the island back in, the manual cut out.
    expect(ranges(effective.edits)).toEqual([
      [0, 1, 1, 2],
      [1, 8, 3, 10],
    ]);
  });

  it('describes an unexplained cut, and leaves out an empty cut list altogether', () => {
    const decisions = linearDecisions();
    const effective = effectiveDecisions(decisions, {
      version: 1,
      cuts: {},
      extraCuts: [
        {
          key: extraCutKey('v1', 2, 3, RATE),
          sourceVersionId: 'v1',
          inSeconds: 2,
          outSeconds: 3,
          note: null,
        },
      ],
    });
    expect(effective.cuts?.map((cut) => [cut.key, cut.reason.summary])).toEqual([
      [ISLAND, '2.0s of dead air'],
      [extraCutKey('v1', 2, 3, RATE), 'Removed by the reviewer'],
    ]);

    const noIslands = assembleDecisionList({
      edits: [edit(0, 1, 4)],
      clips: [clip('v1')],
      fileNames: new Map([['v1', '01-v1.mp4']]),
      mediaPathPrefix: './media/',
      rate: RATE,
    });
    expect('cuts' in effectiveDecisions(noIslands, emptyOverrides())).toBe(false);
    // A run whose only island the reviewer put back has nothing left to mark.
    expect(
      'cuts' in
        effectiveDecisions(decisions, { ...emptyOverrides(), cuts: { [ISLAND]: 'restore' } })
    ).toBe(false);
  });
});
