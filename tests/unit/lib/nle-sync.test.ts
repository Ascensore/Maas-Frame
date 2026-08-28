import { describe, expect, it } from 'vitest';
import {
  commentSentinel,
  nearestResolveColor,
  parseSentinel,
  reconcile,
} from '../../../nle/core/src/index';

describe('sentinel', () => {
  it('round-trips a comment id', () => {
    expect(parseSentinel(`note\n${commentSentinel('abc123')}`)).toBe('abc123');
    expect(parseSentinel('plain marker')).toBeNull();
  });
});

describe('reconcile', () => {
  const remote = [
    {
      id: 'c1',
      content: 'Fix this',
      timestamp: 1.5,
      timestampEnd: null,
      timestampFrame: 36,
      isResolved: false,
      parentId: null,
      author: { name: 'Ada' },
      guestName: null,
      tag: null,
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ];

  it('adds a comment that has no marker', () => {
    const plan = reconcile(remote, []);
    expect(plan.add.map((row) => row.id)).toEqual(['c1']);
    expect(plan.move).toEqual([]);
    expect(plan.remove).toEqual([]);
  });

  it('moves a marker that drifted', () => {
    const plan = reconcile(remote, [
      {
        id: 'm1',
        commentId: 'c1',
        startSeconds: 4,
        durationSeconds: 0,
        name: 'old',
        comments: commentSentinel('c1'),
      },
    ]);
    expect(plan.add).toEqual([]);
    expect(plan.move).toHaveLength(1);
  });

  it('removes a marker whose comment is gone', () => {
    const plan = reconcile(
      [],
      [
        {
          id: 'm1',
          commentId: 'gone',
          startSeconds: 1,
          durationSeconds: 0,
          name: 'stale',
          comments: commentSentinel('gone'),
        },
      ]
    );
    expect(plan.remove).toHaveLength(1);
  });

  it('ignores resolved and reply comments', () => {
    const plan = reconcile(
      [
        { ...remote[0], isResolved: true },
        { ...remote[0], id: 'r1', parentId: 'c1' },
      ],
      []
    );
    expect(plan.add).toEqual([]);
  });
});

describe('nearestResolveColor', () => {
  it('maps a blue hex to Blue', () => {
    expect(nearestResolveColor('#3B82F6')).toBe('Blue');
  });

  it('falls back when the value is missing', () => {
    expect(nearestResolveColor(null)).toBe('Blue');
  });
});
