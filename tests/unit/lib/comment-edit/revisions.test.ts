import { describe, it, expect } from 'vitest';
import { previousCommentPlan, describeCommentPlan } from '@/lib/comment-edit/revisions';
import type { CommentEditSnapshot } from '@/lib/comment-edit/plan';

describe('revision plans', () => {
  const first = { version: 1, operations: [{ op: 'cut', start: 1, end: 2 }] };
  const second = { version: 1, operations: [{ op: 'keep', start: 6, end: 7 }] };
  it('selects explicit comment plans and refuses to infer a missing batch member', () => {
    expect(
      previousCommentPlan({ plansByCommentId: { a: first, b: second }, editPlan: first }, 'b')
    ).toEqual(second);
    expect(
      previousCommentPlan({ plansByCommentId: { a: first }, editPlan: first }, 'b')
    ).toBeNull();
    expect(previousCommentPlan({ plans: [first, second], editPlan: first }, 'b')).toBeNull();
    expect(previousCommentPlan({ plans: [first, second] }, 'b', ['a', 'b'])).toEqual(second);
    expect(previousCommentPlan({ plans: [first, second] }, 'b', ['b'])).toBeNull();
    expect(
      previousCommentPlan(
        { editPlan: { version: 1, operations: [{ op: 'cut', start: -1, end: 2 }] } },
        'a'
      )
    ).toBeNull();
    expect(previousCommentPlan({ editPlan: first }, 'a')).toEqual(first);
  });
  it('describes cut, keep, graphics, and B-roll using frozen labels and original times', () => {
    const snapshot = {
      presets: [{ id: 'brand', name: 'Brand title' }],
      assets: [{ versionId: 'office', title: 'Office tour' }],
    } as unknown as CommentEditSnapshot;
    expect(
      describeCommentPlan(
        {
          version: 1,
          operations: [
            { op: 'cut', start: 1, end: 2 },
            { op: 'keep', start: 3, end: 4 },
            {
              op: 'graphic',
              start: 4,
              end: 6,
              presetId: 'brand',
              title: 'Hello',
              subtitle: 'Welcome',
            },
            { op: 'broll', start: 7, end: 9, assetVersionId: 'office', sourceIn: 12.5 },
          ],
        },
        snapshot
      )
    ).toEqual([
      { start: 1, end: 2, detail: 'Remove footage' },
      { start: 3, end: 4, detail: 'Keep footage within the marked range' },
      { start: 4, end: 6, detail: 'Brand title: Hello — Welcome' },
      { start: 7, end: 9, detail: 'B-roll: Office tour, from 12.50s; keep speech audio' },
    ]);
    expect(describeCommentPlan(null, null)).toEqual([]);
  });
});
