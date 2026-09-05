import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  collectSyncedMarkerIds,
  commentSentinel,
  commentsRemovedFromTimeline,
  describeResolveRefusal,
  fpsToRational,
  nearestResolveColor,
  nextPollDelayMs,
  parseSentinel,
  parseSyncedMarkerIds,
  planIsEmpty,
  planTimelineResolves,
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

  it('reads a drop-frame separator', () => {
    expect(sequenceOffsetSeconds('00:00:01;12', 24)).toBe(1.5);
  });

  it('returns null rather than 0 when the timecode does not parse', () => {
    // 0 is a legitimate offset, so a parse failure must not be reported as one:
    // that silently placed every marker an hour off on a 01:00:00:00 sequence.
    expect(sequenceOffsetSeconds('not a timecode', 24)).toBeNull();
    expect(sequenceOffsetSeconds('', 24)).toBeNull();
    expect(sequenceOffsetSeconds('01:00:00', 24)).toBeNull();
    expect(sequenceOffsetSeconds('01:60:00:00', 24)).toBeNull();
  });

  it('still reports a genuine zero offset as 0', () => {
    expect(sequenceOffsetSeconds('00:00:00:00', 24)).toBe(0);
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

function comment(id: string) {
  return { ...remote[0], id, content: `Note ${id}` };
}

function marker(commentId: string) {
  return {
    id: `m-${commentId}`,
    commentId,
    startSeconds: 1.5,
    durationSeconds: 0,
    name: 'note',
    comments: commentSentinel(commentId),
  };
}

describe('planIsEmpty', () => {
  it('is true only when nothing would be written', () => {
    expect(planIsEmpty({ add: [], move: [], remove: [] })).toBe(true);
    expect(planIsEmpty({ add: [comment('c1')], move: [], remove: [] })).toBe(false);
    expect(planIsEmpty({ add: [], move: [], remove: [marker('c1')] })).toBe(false);
    expect(
      planIsEmpty({ add: [], move: [{ comment: comment('c1'), marker: marker('c1') }], remove: [] })
    ).toBe(false);
  });
});

describe('planTimelineResolves', () => {
  const comments = [comment('c1'), comment('c2')];

  it('allows a normal single deletion while other review markers remain', () => {
    const decision = planTimelineResolves(comments, [marker('c2')], ['c1', 'c2']);
    expect(decision).toEqual({ ok: true, ids: ['c1'] });
  });

  it('resolves nothing when every marker is still on the timeline', () => {
    const decision = planTimelineResolves(comments, [marker('c1'), marker('c2')], ['c1', 'c2']);
    expect(decision).toEqual({ ok: true, ids: [] });
  });

  it('refuses when the timeline carries no review markers at all', () => {
    // The wrong-timeline signature. Without this guard both comments would be
    // resolved on the web in a single pass, with no undo.
    const decision = planTimelineResolves(comments, [], ['c1', 'c2']);
    expect(decision.ok).toBe(false);
    expect(decision).toEqual({
      ok: false,
      reason: 'timeline-not-bound',
      ids: ['c1', 'c2'],
      cap: 5,
    });
  });

  it('refuses more resolves in one pass than the cap allows', () => {
    const many = [comment('c1'), comment('c2'), comment('c3'), comment('c4')];
    const decision = planTimelineResolves(many, [marker('c4')], ['c1', 'c2', 'c3', 'c4'], {
      cap: 2,
    });
    expect(decision).toEqual({
      ok: false,
      reason: 'over-cap',
      ids: ['c1', 'c2', 'c3'],
      cap: 2,
    });
  });

  it('stays quiet when nothing was ever synced, even with an empty timeline', () => {
    expect(planTimelineResolves(comments, [], [])).toEqual({ ok: true, ids: [] });
  });

  it('refuses when the timeline holds only another version\u2019s review markers', () => {
    // The timeline is not empty, so a guard that merely counted review markers
    // would pass here and resolve both of this version's comments on the web.
    const decision = planTimelineResolves(comments, [marker('other-version-1')], ['c1', 'c2']);
    expect(decision).toEqual({
      ok: false,
      reason: 'timeline-not-bound',
      ids: ['c1', 'c2'],
      cap: 5,
    });
  });

  it('allows the deletion when at least one of our own markers is still there', () => {
    const decision = planTimelineResolves(
      comments,
      [marker('c2'), marker('other-version-1')],
      ['c1', 'c2']
    );
    expect(decision).toEqual({ ok: true, ids: ['c1'] });
  });

  it('does not count a marker that carries no sentinel as a review marker', () => {
    const plain = {
      id: 'm-plain',
      commentId: null,
      startSeconds: 0,
      durationSeconds: 0,
      name: 'editor note',
      comments: 'just a note',
    };
    expect(planTimelineResolves(comments, [plain], ['c1', 'c2']).ok).toBe(false);
  });
});

describe('describeResolveRefusal', () => {
  it('says nothing when the decision was allowed', () => {
    expect(describeResolveRefusal({ ok: true, ids: ['c1'] })).toBeNull();
  });

  it('names the count for an unbound timeline', () => {
    const message = describeResolveRefusal({
      ok: false,
      reason: 'timeline-not-bound',
      ids: ['c1', 'c2'],
      cap: 5,
    });
    expect(message).toContain('2 comment(s)');
    expect(message).toContain('no review markers');
  });

  it('names the cap when too many resolves were requested', () => {
    const message = describeResolveRefusal({
      ok: false,
      reason: 'over-cap',
      ids: ['c1', 'c2', 'c3'],
      cap: 2,
    });
    expect(message).toContain('3 comment(s)');
    expect(message).toContain('than the 2 allowed');
  });
});

describe('nextPollDelayMs', () => {
  it('polls at the base cadence while healthy', () => {
    expect(nextPollDelayMs(0)).toBe(10000);
    expect(nextPollDelayMs(-1)).toBe(10000);
  });

  it('doubles per consecutive failure', () => {
    expect(nextPollDelayMs(1)).toBe(20000);
    expect(nextPollDelayMs(2)).toBe(40000);
    expect(nextPollDelayMs(3)).toBe(80000);
  });

  it('stops growing at the ceiling', () => {
    expect(nextPollDelayMs(20)).toBe(300000);
    expect(nextPollDelayMs(500)).toBe(300000);
  });

  it('honours explicit base and ceiling', () => {
    expect(nextPollDelayMs(2, 1000, 3000)).toBe(3000);
    expect(nextPollDelayMs(1, 1000, 9000)).toBe(2000);
  });
});

describe('nle-core.cjs UMD', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const corePath = join(here, '../../../nle/core/nle-core.cjs');
  const premierePath = join(here, '../../../nle/premiere/nle-core.cjs');
  const resolvePath = join(here, '../../../nle/resolve/nle-core.cjs');

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
      sequenceOffsetSeconds: typeof sequenceOffsetSeconds;
      planIsEmpty: typeof planIsEmpty;
      planTimelineResolves: typeof planTimelineResolves;
      describeResolveRefusal: typeof describeResolveRefusal;
      nextPollDelayMs: typeof nextPollDelayMs;
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

  it('mirrors the Phase 0 guards, which are the copies the panels actually run', () => {
    const require = createRequire(import.meta.url);
    const umd = require(corePath) as {
      sequenceOffsetSeconds: typeof sequenceOffsetSeconds;
      planIsEmpty: typeof planIsEmpty;
      planTimelineResolves: typeof planTimelineResolves;
      describeResolveRefusal: typeof describeResolveRefusal;
      nextPollDelayMs: typeof nextPollDelayMs;
      DEFAULT_AUTO_RESOLVE_CAP: number;
      AUTO_SYNC_BASE_MS: number;
    };

    expect(umd.sequenceOffsetSeconds('nope', 24)).toBeNull();
    expect(umd.sequenceOffsetSeconds('01:00:00:00', 24)).toBe(3600);
    expect(umd.sequenceOffsetSeconds('00:00:00:00', 24)).toBe(0);

    expect(umd.planIsEmpty({ add: [], move: [], remove: [] })).toBe(true);
    expect(umd.planIsEmpty({ add: [remote[0]], move: [], remove: [] })).toBe(false);

    const two = [remote[0], { ...remote[0], id: 'c2' }];
    const stillThere = {
      id: 'm-c2',
      commentId: 'c2',
      startSeconds: 1.5,
      durationSeconds: 0,
      name: 'note',
      comments: commentSentinel('c2'),
    };
    expect(umd.planTimelineResolves(two, [stillThere], ['c1', 'c2'])).toEqual({
      ok: true,
      ids: ['c1'],
    });
    expect(umd.planTimelineResolves(two, [], ['c1', 'c2'])).toEqual({
      ok: false,
      reason: 'timeline-not-bound',
      ids: ['c1', 'c2'],
      cap: 5,
    });
    const foreign = {
      id: 'm-x1',
      commentId: 'x1',
      startSeconds: 0,
      durationSeconds: 0,
      name: 'other version',
      comments: commentSentinel('x1'),
    };
    expect(umd.planTimelineResolves(two, [foreign], ['c1', 'c2'])).toEqual({
      ok: false,
      reason: 'timeline-not-bound',
      ids: ['c1', 'c2'],
      cap: 5,
    });
    expect(umd.planTimelineResolves(two, [stillThere], ['c1', 'c2'], { cap: 0 })).toEqual({
      ok: false,
      reason: 'over-cap',
      ids: ['c1'],
      cap: 0,
    });

    expect(umd.describeResolveRefusal({ ok: true, ids: [] })).toBeNull();
    expect(
      umd.describeResolveRefusal({
        ok: false,
        reason: 'over-cap',
        ids: ['c1', 'c2'],
        cap: 1,
      })
    ).toContain('than the 1 allowed');

    expect(umd.nextPollDelayMs(0)).toBe(10000);
    expect(umd.nextPollDelayMs(2)).toBe(40000);
    expect(umd.nextPollDelayMs(99)).toBe(300000);

    expect(umd.DEFAULT_AUTO_RESOLVE_CAP).toBe(5);
    expect(umd.AUTO_SYNC_BASE_MS).toBe(10000);
  });

  it('vendors the same file into both plugin folders', () => {
    // Each plugin folder is copied to the host on its own, so it has to carry
    // its own core rather than reaching up into the repo layout.
    expect(readFileSync(premierePath, 'utf8')).toBe(readFileSync(corePath, 'utf8'));
    expect(readFileSync(resolvePath, 'utf8')).toBe(readFileSync(corePath, 'utf8'));
  });

  it('loads core from inside its own folder in both plugins', () => {
    const premiereHtml = readFileSync(join(here, '../../../nle/premiere/index.html'), 'utf8');
    const resolveHtml = readFileSync(join(here, '../../../nle/resolve/index.html'), 'utf8');
    const resolveMain = readFileSync(join(here, '../../../nle/resolve/main.js'), 'utf8');
    expect(premiereHtml).toContain('src="nle-core.cjs"');
    expect(resolveHtml).toContain('src="nle-core.cjs"');
    expect(resolveMain).toContain("require('./nle-core.cjs')");
    expect(resolveHtml).not.toContain('../core/');
    expect(resolveMain).not.toContain('../core/');
  });

  it('keeps the Resolve panel on the same localStorage key prefix', () => {
    const html = readFileSync(join(here, '../../../nle/resolve/index.html'), 'utf8');
    expect(html).toContain("'of-synced-markers:' + versionId");
  });
});
