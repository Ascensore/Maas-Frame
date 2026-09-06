import { describe, it, expect } from 'vitest';
import {
  applyCommentEditPlan,
  applyCommentEditBatch,
  commentEditSnapshotSchema,
  type CommentEditSnapshot,
} from '@/lib/comment-edit/plan';
import { graphicsAss, effectFfmpegArgs } from '@/lib/rough-cut/effect-render';
import { effectiveDecisions } from '@/lib/rough-cut/overrides';
import type { TimelineEffect } from '@/lib/rough-cut/effects';

const preset = {
  id: 'lower-third' as const,
  version: 1 as const,
  name: 'Brand',
  accent: '#123456',
  foreground: '#FFFFFF',
  background: '#000000',
};
const clip = {
  versionId: 'a',
  videoId: 'v',
  role: 'A',
  offsetSeconds: 0,
  durationSeconds: 30,
  track: 1,
  fileName: 'a.mp4',
  targetUrl: 'a.mp4',
};
function snapshot(): CommentEditSnapshot {
  return {
    versionId: 'reviewed',
    content: 'Add illustration',
    start: 2,
    end: 6,
    presets: [preset],
    assets: [{ versionId: 'b', title: 'Beach', duration: 8, clip: { ...clip, versionId: 'b' } }],
    decisions: {
      version: 1,
      rate: { num: 25, den: 1, dropFrame: false },
      clips: [clip],
      edits: [
        {
          sourceVersionId: 'a',
          cameraRole: 'A',
          targetTrack: 1,
          inSeconds: 10,
          outSeconds: 20,
          timelineStartSeconds: 0,
          timelineEndSeconds: 10,
        },
      ],
    },
  };
}
const graphic = {
  op: 'graphic',
  presetId: 'lower-third',
  title: 'Hello',
  subtitle: 'World',
  start: 2,
  end: 5,
};
const broll = { op: 'broll', assetVersionId: 'b', sourceIn: 1, start: 2, end: 5 };
const plan = (...operations: unknown[]) => ({ version: 1, operations });

describe('AI graphic and B-roll plans', () => {
  it('adds a versioned graphic with frozen brand colors without cutting speech', () => {
    const input = snapshot();
    const output = applyCommentEditPlan(input, plan(graphic));
    expect(output.removedSeconds).toBe(0);
    expect(output.decisions.edits).toEqual(input.decisions.edits);
    expect(output.decisions.effects).toEqual([
      { kind: 'graphic', start: 2, end: 5, preset, title: 'Hello', subtitle: 'World' },
    ]);
    expect(input.decisions.effects).toBeUndefined();
  });
  it('restricts B-roll to snapshotted source ids and source duration', () => {
    expect(() =>
      applyCommentEditPlan(snapshot(), plan({ ...broll, assetVersionId: 'foreign' }))
    ).toThrow('available B-roll');
    expect(() => applyCommentEditPlan(snapshot(), plan({ ...broll, sourceIn: 7 }))).toThrow(
      'source duration'
    );
    expect(applyCommentEditPlan(snapshot(), plan(broll)).decisions.effects).toEqual([
      {
        kind: 'broll',
        start: 2,
        end: 5,
        sourceIn: 1,
        sourceVersionId: 'b',
        preset: 'cover-muted-v1',
      },
    ]);
  });
  it('refuses unknown templates, unsafe colors, out-of-range graphics and competing visual layers', () => {
    expect(
      commentEditSnapshotSchema.safeParse({
        ...snapshot(),
        presets: [{ ...preset, accent: 'red;movie=/tmp/a' }],
      }).success
    ).toBe(false);
    expect(() => applyCommentEditPlan({ ...snapshot(), presets: [] }, plan(graphic))).toThrow(
      'preset'
    );
    expect(() => applyCommentEditPlan(snapshot(), plan({ ...graphic, start: 1 }))).toThrow(
      'marked range'
    );
    expect(() => applyCommentEditPlan(snapshot(), plan(broll, { ...broll, sourceIn: 2 }))).toThrow(
      'compete'
    );
  });
  it('splits overlays through a cut and keeps their source progress', () => {
    const result = applyCommentEditPlan(snapshot(), plan(broll, { op: 'cut', start: 3, end: 4 }));
    expect(result.removedSeconds).toBe(1);
    expect(result.decisions.effects).toEqual([
      {
        kind: 'broll',
        start: 2,
        end: 3,
        sourceIn: 1,
        sourceVersionId: 'b',
        preset: 'cover-muted-v1',
      },
      {
        kind: 'broll',
        start: 3,
        end: 4,
        sourceIn: 3,
        sourceVersionId: 'b',
        preset: 'cover-muted-v1',
      },
    ]);
  });
  it('moves existing graphics after a later AI cut and manual source cut', () => {
    const input = snapshot();
    input.decisions.effects = [
      { kind: 'graphic', start: 4, end: 6, preset, title: 'Hello', subtitle: '' },
    ];
    expect(
      applyCommentEditPlan(input, plan({ op: 'cut', start: 2, end: 3 })).decisions.effects?.[0]
    ).toMatchObject({ start: 3, end: 5 });
    expect(
      effectiveDecisions(input.decisions, {
        version: 1,
        cuts: {},
        extraCuts: [
          { key: 'cut', sourceVersionId: 'a', inSeconds: 12, outSeconds: 13, note: null },
        ],
      }).effects?.[0]
    ).toMatchObject({ start: 3, end: 5 });
  });
  it('removes the final existing overlay when all its footage is cut away', () => {
    const input = snapshot();
    input.decisions.effects = [
      { kind: 'graphic', start: 2, end: 3, preset, title: 'Gone', subtitle: '' },
      {
        kind: 'broll',
        start: 2,
        end: 3,
        sourceVersionId: 'b',
        sourceIn: 0,
        preset: 'cover-muted-v1',
      },
    ];
    expect(
      applyCommentEditPlan(input, plan({ op: 'cut', start: 2, end: 3 })).decisions.effects
    ).toEqual([]);
  });
  it('combines cuts and keep feedback once so later comments do not drift', () => {
    const first = snapshot();
    const second = { ...snapshot(), start: 6, end: 9 };
    const result = applyCommentEditBatch(
      [first, second],
      [plan({ op: 'cut', start: 2, end: 3 }), plan({ op: 'keep', start: 7, end: 8 })]
    );
    expect(result.removedSeconds).toBe(3);
    expect(result.decisions.edits.map((e) => [e.inSeconds, e.outSeconds])).toEqual([
      [10, 12],
      [13, 16],
      [17, 18],
      [19, 20],
    ]);
  });
  it('refuses overlapping comments, different provenance, and one unsafe member without a partial result', () => {
    expect(() =>
      applyCommentEditBatch([snapshot(), snapshot()], [plan(graphic), plan(broll)])
    ).toThrow('overlap');
    expect(() =>
      applyCommentEditBatch([snapshot(), { ...snapshot(), versionId: 'other' }], [])
    ).toThrow('same source');
    expect(() =>
      applyCommentEditBatch(
        [snapshot(), { ...snapshot(), start: 6, end: 9 }],
        [plan(graphic), plan({ op: 'cut', start: 2, end: 3 })]
      )
    ).toThrow('marked range');
  });
});

describe('effect rendering', () => {
  const effects: TimelineEffect[] = [
    {
      kind: 'broll',
      start: 2,
      end: 5,
      sourceIn: 1,
      sourceVersionId: 'b',
      preset: 'cover-muted-v1',
    },
    {
      kind: 'graphic',
      start: 2,
      end: 5,
      title: '{\\pos(0,0)}Title\nBreak',
      subtitle: '{\\pos(1,2)}More\nText',
      preset,
    },
  ];
  it('maps speech exclusively from the base program and bounds the overlay lifetime', () => {
    const args = effectFfmpegArgs({
      input: 'base.mp4',
      output: 'out.mp4',
      effects,
      files: new Map([['b', 'beach.mp4']]),
      width: 1920,
      height: 1080,
      assPath: '/tmp/graphic.ass',
    });
    expect(args.slice(args.indexOf('-ss'), args.indexOf('-ss') + 6)).toEqual([
      '-ss',
      '1',
      '-t',
      '3',
      '-i',
      'beach.mp4',
    ]);
    expect(args[args.indexOf('-filter_complex') + 1]).toContain(
      "overlay=eof_action=pass:repeatlast=0:enable='gte(t,2)*lt(t,5)'"
    );
    expect(args.filter((_, i) => args[i - 1] === '-map')).toEqual(['[styled]', '0:a?']);
    expect(args[args.indexOf('-c:a') + 1]).toBe('copy');
  });
  it('renders template animation and escapes feedback formatting instead of executing it', () => {
    const ass = graphicsAss(effects);
    expect(ass).toContain('0:00:02.00,0:00:05.00');
    expect(ass).toContain('\\move(64,820,96,820,0,240)');
    expect(ass).toContain('&H563412&');
    expect(ass).not.toContain('{\\pos(0,0)}');
    expect(ass).toContain('｛＼pos(0,0)｝Title Break');
    expect(ass).not.toContain('{\\pos(1,2)}');
    expect(ass).toContain('｛＼pos(1,2)｝More Text');
  });
});
