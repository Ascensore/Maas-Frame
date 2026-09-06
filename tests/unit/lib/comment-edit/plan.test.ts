import { describe, expect, it } from 'vitest';
import { applyCommentEditPlan, type CommentEditSnapshot } from '@/lib/comment-edit/plan';

function snapshot(): CommentEditSnapshot {
  return {
    versionId: 'review-v1',
    content: 'Remove the pause',
    start: 2,
    end: 7,
    decisions: {
      version: 1,
      rate: { num: 25, den: 1, dropFrame: false },
      clips: [],
      edits: [
        {
          sourceVersionId: 'a',
          cameraRole: 'A',
          targetTrack: 1,
          inSeconds: 10,
          outSeconds: 15,
          timelineStartSeconds: 0,
          timelineEndSeconds: 5,
        },
        {
          sourceVersionId: 'b',
          cameraRole: 'B',
          targetTrack: 1,
          inSeconds: 20,
          outSeconds: 25,
          timelineStartSeconds: 5,
          timelineEndSeconds: 10,
        },
      ],
      markers: [
        {
          key: 'removed',
          kind: 'BROLL',
          title: 'removed',
          timelineSeconds: 4,
          durationSeconds: 1,
          reason: { code: 'MARKER_ILLUSTRATION', summary: 'show' },
        },
        {
          key: 'kept',
          kind: 'INFOGRAPHIC',
          title: 'kept',
          timelineSeconds: 8,
          durationSeconds: 1,
          reason: { code: 'MARKER_JARGON', summary: 'explain' },
        },
      ],
    },
  };
}
const cut = (start: number, end: number) => ({
  version: 1,
  operations: [{ op: 'cut', start, end }],
});

describe('comment edit timeline mapping', () => {
  it('cuts across two sources, repacks the program, and moves surviving markers', () => {
    const original = snapshot();
    const result = applyCommentEditPlan(original, cut(3, 6));
    expect(result.removedSeconds).toBe(3);
    expect(result.decisions.edits).toEqual([
      {
        sourceVersionId: 'a',
        cameraRole: 'A',
        targetTrack: 1,
        inSeconds: 10,
        outSeconds: 13,
        timelineStartSeconds: 0,
        timelineEndSeconds: 3,
      },
      {
        sourceVersionId: 'b',
        cameraRole: 'B',
        targetTrack: 1,
        inSeconds: 21,
        outSeconds: 25,
        timelineStartSeconds: 3,
        timelineEndSeconds: 7,
      },
    ]);
    expect(result.decisions.markers).toEqual([
      expect.objectContaining({ key: 'kept', timelineSeconds: 5 }),
    ]);
    expect(result.decisions.cuts).toEqual([
      expect.objectContaining({ sourceVersionId: 'a', inSeconds: 13, outSeconds: 15 }),
      expect.objectContaining({ sourceVersionId: 'b', inSeconds: 20, outSeconds: 21 }),
    ]);
    expect(original).toEqual(snapshot());
  });
  it('does not cut another occurrence of the same source range', () => {
    const input = snapshot();
    input.decisions.edits[1] = {
      ...input.decisions.edits[0],
      timelineStartSeconds: 5,
      timelineEndSeconds: 10,
    };
    const result = applyCommentEditPlan(input, cut(2, 3));
    expect(result.decisions.edits.at(-1)).toEqual(
      expect.objectContaining({
        inSeconds: 10,
        outSeconds: 15,
        timelineStartSeconds: 4,
        timelineEndSeconds: 9,
      })
    );
    expect(result.removedSeconds).toBe(1);
  });
  it('merges overlapping cuts against the original timeline instead of cutting twice', () => {
    const result = applyCommentEditPlan(snapshot(), {
      version: 1,
      operations: [
        { op: 'cut', start: 4, end: 7 },
        { op: 'cut', start: 2, end: 5 },
      ],
    });
    expect(result.removedSeconds).toBe(5);
    expect(
      result.decisions.edits.map((e) => [
        e.inSeconds,
        e.outSeconds,
        e.timelineStartSeconds,
        e.timelineEndSeconds,
      ])
    ).toEqual([
      [10, 12, 0, 2],
      [22, 25, 2, 5],
    ]);
  });
  it('keeps selected portions inside the range without deleting the rest of the video', () => {
    const result = applyCommentEditPlan(snapshot(), {
      version: 1,
      operations: [{ op: 'keep', start: 3, end: 6 }],
    });
    expect(result.removedSeconds).toBe(2);
    expect(result.decisions.edits.map((e) => [e.inSeconds, e.outSeconds])).toEqual([
      [10, 12],
      [13, 15],
      [20, 21],
      [22, 25],
    ]);
  });
  it.each([
    cut(1, 4),
    cut(4, 8),
    cut(4, 4),
    { version: 1, operations: [] },
    { version: 1, operations: [{ op: 'keep', start: 2, end: 7 }] },
    {
      version: 1,
      operations: [
        { op: 'cut', start: 2, end: 3 },
        { op: 'keep', start: 4, end: 5 },
      ],
    },
  ])('refuses an unsafe or ineffective plan: %j', (plan) => {
    expect(() => applyCommentEditPlan(snapshot(), plan)).toThrow();
  });
  it('refuses deleting the whole program', () => {
    expect(() => applyCommentEditPlan({ ...snapshot(), start: 0, end: 10 }, cut(0, 10))).toThrow(
      'entire video'
    );
  });
  it('snaps model timestamps to frame boundaries', () => {
    const result = applyCommentEditPlan(snapshot(), cut(2.011, 3.011));
    expect(result.decisions.edits[0].outSeconds).toBe(12);
    expect(result.decisions.edits[1].inSeconds).toBe(13);
  });
  it('clips a surviving marker at the next removed section and preserves point markers', () => {
    const input = snapshot();
    input.decisions.markers = [
      {
        key: 'overlap',
        kind: 'BROLL',
        title: 'show',
        timelineSeconds: 2,
        durationSeconds: 5,
        reason: { code: 'MARKER_ILLUSTRATION', summary: 'show' },
      },
      {
        key: 'point',
        kind: 'INFOGRAPHIC',
        title: 'explain',
        timelineSeconds: 8,
        durationSeconds: null,
        reason: { code: 'MARKER_JARGON', summary: 'explain' },
      },
    ];
    expect(applyCommentEditPlan(input, cut(3, 6)).decisions.markers).toEqual([
      expect.objectContaining({ key: 'overlap', timelineSeconds: 2, durationSeconds: 1 }),
      expect.objectContaining({ key: 'point', timelineSeconds: 5, durationSeconds: null }),
    ]);
  });
});
