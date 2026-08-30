import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  collectSyncedMarkerIds,
  commentSentinel,
  commentsRemovedFromTimeline,
  fpsToRational,
  nearestResolveColor,
  parseSentinel,
  parseSyncedMarkerIds,
  reconcile,
  remainingCommentsAfterTimelineResolves,
  secondsToSmpte,
  sequenceOffsetSeconds,
  syncedMarkerStorageKey,
} from '../../../nle/core/src/index';

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

describe('sentinel', () => {
  it('round-trips a comment id', () => {
    expect(parseSentinel(`note\n${commentSentinel('abc123')}`)).toBe('abc123');
    expect(parseSentinel('plain marker')).toBeNull();
  });
});

describe('reconcile', () => {
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

  it('applies a sequence start offset when comparing marker times', () => {
    const plan = reconcile(
      remote,
      [
        {
          id: 'm1',
          commentId: 'c1',
          startSeconds: 3601.5,
          durationSeconds: 0,
          name: 'on timeline',
          comments: commentSentinel('c1'),
        },
      ],
      3600
    );
    expect(plan.add).toEqual([]);
    expect(plan.move).toEqual([]);
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

describe('commentsRemovedFromTimeline', () => {
  const marker = {
    id: 'm1',
    commentId: 'c1',
    startSeconds: 1.5,
    durationSeconds: 0,
    name: 'Fix this',
    comments: commentSentinel('c1'),
  };

  it('does not resolve a comment that has never been synced', () => {
    expect(commentsRemovedFromTimeline(remote, [], [])).toEqual([]);
  });

  it('resolves a previously synced comment whose marker was deleted', () => {
    expect(commentsRemovedFromTimeline(remote, [], ['c1'])).toEqual(['c1']);
  });

  it('leaves a comment alone when its marker is still on the timeline', () => {
    expect(commentsRemovedFromTimeline(remote, [marker], ['c1'])).toEqual([]);
  });

  it('leaves a comment alone when the marker is identified only by sentinel', () => {
    expect(
      commentsRemovedFromTimeline(
        remote,
        [{ ...marker, commentId: null, comments: commentSentinel('c1') }],
        ['c1']
      )
    ).toEqual([]);
  });

  it('does not resolve a comment that the web app already resolved', () => {
    expect(commentsRemovedFromTimeline([{ ...remote[0], isResolved: true }], [], ['c1'])).toEqual(
      []
    );
  });

  it('does not resolve a reply when a marker disappears', () => {
    expect(
      commentsRemovedFromTimeline([{ ...remote[0], id: 'r1', parentId: 'c1' }], [], ['r1'])
    ).toEqual([]);
  });

  it('only resolves ids that were stored from a previous sync', () => {
    const c2 = { ...remote[0], id: 'c2', content: 'Never placed' };
    expect(commentsRemovedFromTimeline([...remote, c2], [], ['c1'])).toEqual(['c1']);
  });

  it('does not put a resolved-from-timeline comment back, and still adds never-synced notes', () => {
    const c2 = { ...remote[0], id: 'c2', content: 'Never placed' };
    const comments = [...remote, c2];
    const toResolve = commentsRemovedFromTimeline(comments, [], ['c1']);
    const remaining = remainingCommentsAfterTimelineResolves(comments, toResolve);
    expect(reconcile(remaining, []).add.map((row) => row.id)).toEqual(['c2']);
  });
});

describe('collectSyncedMarkerIds', () => {
  it('reads the sentinel when commentId is not set on the marker', () => {
    expect(
      collectSyncedMarkerIds([
        {
          id: 'm1',
          commentId: null,
          startSeconds: 1,
          durationSeconds: 0,
          name: 'note',
          comments: commentSentinel('c1'),
        },
      ])
    ).toEqual(['c1']);
  });
});

describe('syncedMarkerStorageKey', () => {
  it('scopes stored ids to the version', () => {
    expect(syncedMarkerStorageKey('clabc123')).toBe('of-synced-markers:clabc123');
  });
});

describe('parseSyncedMarkerIds', () => {
  it('reads a JSON array of ids', () => {
    expect(parseSyncedMarkerIds('["c1","c2"]')).toEqual(['c1', 'c2']);
  });

  it('returns an empty list for missing or malformed storage', () => {
    expect(parseSyncedMarkerIds(null)).toEqual([]);
    expect(parseSyncedMarkerIds('not json')).toEqual([]);
    expect(parseSyncedMarkerIds('{"c1":true}')).toEqual([]);
    expect(parseSyncedMarkerIds('[1, "c1"]')).toEqual(['c1']);
    expect(parseSyncedMarkerIds('["c1",""]')).toEqual(['c1']);
    expect(parseSyncedMarkerIds(undefined)).toEqual([]);
  });
});

describe('sequenceOffsetSeconds', () => {
  it('turns a one-hour start into 3600 seconds at 24fps', () => {
    expect(sequenceOffsetSeconds('01:00:00:00', 24)).toBe(3600);
  });
});

describe('fpsToRational', () => {
  it('maps 24 to 24/1', () => {
    expect(fpsToRational(24)).toEqual({ num: 24, den: 1 });
  });

  it('maps 29.97 to 30000/1001', () => {
    expect(fpsToRational(29.97)).toEqual({ num: 30000, den: 1001 });
  });
});

describe('secondsToSmpte', () => {
  it('formats a one-hour offset at 24fps', () => {
    expect(secondsToSmpte(3600, 24, false)).toBe('01:00:00:00');
  });
});

describe('nle-core.cjs UMD', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const corePath = join(here, '../../../nle/core/nle-core.cjs');
  const premierePath = join(here, '../../../nle/premiere/nle-core.cjs');

  it('matches the TypeScript mapping for sentinels, two-way resolve, and offset', () => {
    const require = createRequire(import.meta.url);
    const umd = require(corePath) as {
      commentSentinel: (id: string) => string;
      parseSentinel: (text: string) => string | null;
      reconcile: typeof reconcile;
      commentsRemovedFromTimeline: typeof commentsRemovedFromTimeline;
      remainingCommentsAfterTimelineResolves: typeof remainingCommentsAfterTimelineResolves;
      parseSyncedMarkerIds: typeof parseSyncedMarkerIds;
      collectSyncedMarkerIds: typeof collectSyncedMarkerIds;
      syncedMarkerStorageKey: typeof syncedMarkerStorageKey;
      fpsToRational: typeof fpsToRational;
      secondsToSmpte: typeof secondsToSmpte;
    };
    expect(umd.commentSentinel('abc123')).toBe(commentSentinel('abc123'));
    expect(umd.parseSentinel(`note\n${commentSentinel('abc123')}`)).toBe('abc123');
    expect(umd.reconcile(remote, [], 0)).toEqual(reconcile(remote, [], 0));
    expect(umd.commentsRemovedFromTimeline(remote, [], [])).toEqual([]);
    expect(umd.commentsRemovedFromTimeline(remote, [], ['c1'])).toEqual(['c1']);
    expect(
      umd.commentsRemovedFromTimeline([{ ...remote[0], id: 'r1', parentId: 'c1' }], [], ['r1'])
    ).toEqual([]);
    const c2 = { ...remote[0], id: 'c2', content: 'Never placed' };
    expect(umd.commentsRemovedFromTimeline([...remote, c2], [], ['c1'])).toEqual(['c1']);
    const remaining = umd.remainingCommentsAfterTimelineResolves([...remote, c2], ['c1']);
    expect(umd.reconcile(remaining, [], 0).add.map((row) => row.id)).toEqual(['c2']);
    expect(umd.parseSyncedMarkerIds('["c1"]')).toEqual(['c1']);
    expect(umd.parseSyncedMarkerIds('not json')).toEqual([]);
    expect(
      umd.collectSyncedMarkerIds([
        {
          id: 'm1',
          commentId: null,
          startSeconds: 1,
          durationSeconds: 0,
          name: 'note',
          comments: commentSentinel('c1'),
        },
      ])
    ).toEqual(['c1']);
    expect(umd.syncedMarkerStorageKey('clabc123')).toBe('of-synced-markers:clabc123');
    expect(umd.fpsToRational(29.97)).toEqual({ num: 30000, den: 1001 });
    expect(umd.secondsToSmpte(3600, 24, false)).toBe('01:00:00:00');
  });

  it('vendors the same file into the Premiere plugin folder', () => {
    expect(readFileSync(premierePath, 'utf8')).toBe(readFileSync(corePath, 'utf8'));
  });

  it('keeps the Resolve panel on the same localStorage key prefix', () => {
    const html = readFileSync(join(here, '../../../nle/resolve/index.html'), 'utf8');
    expect(html).toContain("'of-synced-markers:' + versionId");
  });
});
