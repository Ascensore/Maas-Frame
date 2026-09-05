import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  autoSyncMayWrite,
  collectSyncedMarkerIds,
  normalizeSequenceId,
  commentSentinel,
  commentsRemovedFromTimeline,
  describeResolveRefusal,
  fpsToRational,
  resolvableIds,
  sequenceIsBound,
  timelineLooksBound,
  nearestResolveColor,
  nextPollDelayMs,
  parseSentinel,
  parseSseFrames,
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

  it('divides the frame field by the actual frame rate', () => {
    // Only ever asserting at 24fps would let a hardcoded rate survive.
    expect(sequenceOffsetSeconds('00:00:00:05', 25)).toBe(0.2);
    expect(sequenceOffsetSeconds('00:00:10:15', 30)).toBe(10.5);
  });

  it('survives a missing timecode instead of throwing', () => {
    expect(sequenceOffsetSeconds(null as unknown as string, 24)).toBeNull();
    expect(sequenceOffsetSeconds(undefined as unknown as string, 24)).toBeNull();
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
      refusedIds: ['c1', 'c2'],
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
      refusedIds: ['c1', 'c2', 'c3'],
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
      refusedIds: ['c1', 'c2'],
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

  it('refuses a duplicate sequence even though its copied markers look bound', () => {
    const many = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'];
    const local = [marker('c6')];
    // Without the identity this is the documented residual risk: five resolves
    // against a stale duplicate, allowed because a copied marker survived.
    expect(planTimelineResolves(many.map(comment), local, many)).toEqual({
      ok: true,
      ids: ['c1', 'c2', 'c3', 'c4', 'c5'],
    });
    expect(
      planTimelineResolves(many.map(comment), local, many, {
        identity: { hostSequenceId: 'seq-duplicate', linkedSequenceId: 'seq-original' },
      })
    ).toEqual({
      ok: false,
      reason: 'timeline-not-bound',
      refusedIds: ['c1', 'c2', 'c3', 'c4', 'c5'],
      cap: 5,
    });
  });

  it('allows exactly the cap and refuses one more', () => {
    // Pins the boundary: `>` vs `>=` is otherwise invisible.
    const four = [comment('c1'), comment('c2'), comment('c3'), comment('c4')];
    expect(
      planTimelineResolves(four, [marker('c4')], ['c1', 'c2', 'c3', 'c4'], { cap: 3 })
    ).toEqual({ ok: true, ids: ['c1', 'c2', 'c3'] });
    expect(
      planTimelineResolves(four, [marker('c4')], ['c1', 'c2', 'c3', 'c4'], { cap: 2 })
    ).toEqual({ ok: false, reason: 'over-cap', refusedIds: ['c1', 'c2', 'c3'], cap: 2 });
  });

  it('reports an unbound timeline ahead of the cap when both would apply', () => {
    // The unbound message is the actionable one; "too many" would send the
    // editor looking for a deletion they never made.
    const many = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'];
    const decision = planTimelineResolves(many.map(comment), [], many);
    expect(decision).toEqual({
      ok: false,
      reason: 'timeline-not-bound',
      refusedIds: many,
      cap: 5,
    });
  });

  it('stays quiet on an unbound timeline when there is nothing to resolve', () => {
    // Everything already resolved on the web. Without the empty-plan shortcut
    // this refuses, and the panel reports "did not resolve 0 comments".
    const resolved = [{ ...comment('c1'), isResolved: true }];
    expect(planTimelineResolves(resolved, [], ['c1'])).toEqual({ ok: true, ids: [] });
  });

  it('honours a cap of zero rather than falling back to the default', () => {
    expect(planTimelineResolves(comments, [marker('c2')], ['c1', 'c2'], { cap: 0 })).toEqual({
      ok: false,
      reason: 'over-cap',
      refusedIds: ['c1'],
      cap: 0,
    });
  });

  it('never resolves a reply or an already-resolved comment', () => {
    const reply = { ...comment('r1'), parentId: 'c1' };
    const done = { ...comment('c2'), isResolved: true };
    expect(
      planTimelineResolves([comment('c1'), reply, done], [marker('c1')], ['r1', 'c2'])
    ).toEqual({ ok: true, ids: [] });
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
    expect(planTimelineResolves(comments, [plain], ['c1', 'c2'])).toEqual({
      ok: false,
      reason: 'timeline-not-bound',
      refusedIds: ['c1', 'c2'],
      cap: 5,
    });
  });
});

describe('resolvableIds', () => {
  it('yields the ids on an allowed decision', () => {
    expect(resolvableIds({ ok: true, ids: ['c1', 'c2'] })).toEqual(['c1', 'c2']);
  });

  it('yields nothing on a refusal, whichever reason', () => {
    // A refusal's ids are the set that was refused. A caller that resolved them
    // would perform exactly the irreversible write the guard exists to prevent.
    expect(
      resolvableIds({
        ok: false,
        reason: 'timeline-not-bound',
        refusedIds: ['c1', 'c2'],
        cap: 5,
      })
    ).toEqual([]);
    expect(resolvableIds({ ok: false, reason: 'over-cap', refusedIds: ['c1'], cap: 0 })).toEqual(
      []
    );
  });
});

describe('timelineLooksBound', () => {
  it('treats a first sync as bound, since nothing contradicts it', () => {
    expect(timelineLooksBound([], [])).toBe(true);
    expect(timelineLooksBound([marker('c1')], [])).toBe(true);
  });

  it('is bound when one of our own markers survives', () => {
    expect(timelineLooksBound([marker('c2')], ['c1', 'c2'])).toBe(true);
  });

  it('is not bound when the timeline is empty', () => {
    expect(timelineLooksBound([], ['c1'])).toBe(false);
  });

  it('is not bound when only another version\u2019s markers are present', () => {
    expect(timelineLooksBound([marker('x1'), marker('x2')], ['c1', 'c2'])).toBe(false);
  });
});

describe('sequenceIsBound', () => {
  it('trusts matching ids over anything the markers suggest', () => {
    expect(
      sequenceIsBound([], ['c1'], { hostSequenceId: 'seq-1', linkedSequenceId: 'seq-1' })
    ).toBe(true);
  });

  it('rejects a duplicate that carries the original\u2019s markers', () => {
    // Duplicating a sequence copies its markers but gets a fresh id. The marker
    // heuristic says bound; identity says otherwise, and identity is right.
    const local = [marker('c6')];
    expect(timelineLooksBound(local, ['c1', 'c6'])).toBe(true);
    expect(
      sequenceIsBound(local, ['c1', 'c6'], {
        hostSequenceId: 'seq-duplicate',
        linkedSequenceId: 'seq-original',
      })
    ).toBe(false);
  });

  it('falls back to the marker heuristic when either side cannot name the sequence', () => {
    const local = [marker('c2')];
    expect(sequenceIsBound(local, ['c1', 'c2'], { hostSequenceId: 'seq-1' })).toBe(true);
    expect(sequenceIsBound(local, ['c1', 'c2'], { linkedSequenceId: 'seq-1' })).toBe(true);
    expect(sequenceIsBound(local, ['c1', 'c2'], {})).toBe(true);
    expect(sequenceIsBound([], ['c1', 'c2'], { hostSequenceId: 'seq-1' })).toBe(false);
    expect(sequenceIsBound([], ['c1', 'c2'])).toBe(false);
  });

  it('treats an empty-string id as unknown rather than as a match', () => {
    expect(sequenceIsBound([], ['c1'], { hostSequenceId: '', linkedSequenceId: '' })).toBe(false);
  });
});

describe('normalizeSequenceId', () => {
  it('accepts a guid, with or without braces', () => {
    expect(normalizeSequenceId('a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe(
      'a1b2c3d4-e5f6-7890-abcd-ef1234567890'
    );
    expect(normalizeSequenceId('{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}')).toBe(
      '{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}'
    );
    expect(normalizeSequenceId('  a1b2c3d4e5f6  ')).toBe('a1b2c3d4e5f6');
  });

  it('rejects values that stringify the same for every sequence', () => {
    // The danger is not a junk id, it is a junk id that is IDENTICAL across
    // sequences: two different sequences then compare equal and the identity
    // check declares them bound, overriding the heuristic that would refuse.
    expect(normalizeSequenceId(Promise.resolve('x'))).toBeNull();
    expect(normalizeSequenceId(new (class Guid {})())).toBeNull();
    expect(normalizeSequenceId(function getGuid() {})).toBeNull();
    expect(normalizeSequenceId(true)).toBeNull();
    expect(normalizeSequenceId({})).toBeNull();
  });

  it('rejects a value too short to be an opaque id', () => {
    expect(normalizeSequenceId('42')).toBeNull();
    expect(normalizeSequenceId(42)).toBeNull();
    expect(normalizeSequenceId('short')).toBeNull();
  });

  it('does not throw on an object with no toString', () => {
    // Premiere's guid is read inside sequenceMeta, which has no try/catch here;
    // a throw would escape the whole sync.
    expect(() => normalizeSequenceId(Object.create(null))).not.toThrow();
    expect(normalizeSequenceId(Object.create(null))).toBeNull();
  });

  it('rejects nothing at all', () => {
    expect(normalizeSequenceId(null)).toBeNull();
    expect(normalizeSequenceId(undefined)).toBeNull();
    expect(normalizeSequenceId('')).toBeNull();
  });

  it('accepts an object whose toString is a real id', () => {
    const guid = { toString: () => 'a1b2c3d4-e5f6-7890' };
    expect(normalizeSequenceId(guid)).toBe('a1b2c3d4-e5f6-7890');
  });
});

describe('autoSyncMayWrite', () => {
  it('writes only when the server agrees which sequence this is', () => {
    expect(autoSyncMayWrite([], [], { hostSequenceId: 'seq-1', linkedSequenceId: 'seq-1' })).toBe(
      true
    );
  });

  it('refuses a sequence the server has no link for, however clean the timeline', () => {
    // sequenceIsBound would fall through to the marker heuristic here, and the
    // heuristic says "bound" for any sequence at all when nothing has been
    // synced on this machine. First bind is a deliberate press of Sync.
    expect(sequenceIsBound([], [], { hostSequenceId: 'seq-new', linkedSequenceId: null })).toBe(
      true
    );
    expect(autoSyncMayWrite([], [], { hostSequenceId: 'seq-new', linkedSequenceId: null })).toBe(
      false
    );
  });

  it('refuses when the server names a different sequence', () => {
    expect(
      autoSyncMayWrite([marker('c1')], ['c1'], {
        hostSequenceId: 'seq-duplicate',
        linkedSequenceId: 'seq-original',
      })
    ).toBe(false);
  });

  it('keeps the marker heuristic when the host cannot name its sequences', () => {
    expect(autoSyncMayWrite([marker('c1')], ['c1'], { linkedSequenceId: 'seq-1' })).toBe(true);
    expect(autoSyncMayWrite([], ['c1'], { linkedSequenceId: 'seq-1' })).toBe(false);
    expect(autoSyncMayWrite([], [])).toBe(true);
    expect(autoSyncMayWrite([], ['c1'])).toBe(false);
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
      refusedIds: ['c1', 'c2'],
      cap: 5,
    });
    expect(message).toContain('2 comment(s)');
    expect(message).toContain('not the one this version is synced to');
  });

  it('names the cap when too many resolves were requested', () => {
    const message = describeResolveRefusal({
      ok: false,
      reason: 'over-cap',
      refusedIds: ['c1', 'c2', 'c3'],
      cap: 2,
    });
    expect(message).toContain('3 comment(s)');
    expect(message).toContain('than the 2 allowed');
  });
});

describe('parseSseFrames', () => {
  it('reads a complete frame and its event name', () => {
    expect(parseSseFrames('event: comments\ndata: {"versionId":"v1"}\n\n')).toEqual({
      events: [{ event: 'comments', data: '{"versionId":"v1"}' }],
      rest: '',
    });
  });

  it('holds back a partial frame for the next read', () => {
    // The stream arrives in arbitrary chunks; a frame split mid-name must not
    // be dropped or misread as an event called "comm".
    const first = parseSseFrames('event: ready\ndata: {"a":1}\n\nevent: comm');
    expect(first.events).toEqual([{ event: 'ready', data: '{"a":1}' }]);
    expect(first.rest).toBe('event: comm');

    const second = parseSseFrames(`${first.rest}ents\ndata: {"b":2}\n\n`);
    expect(second.events).toEqual([{ event: 'comments', data: '{"b":2}' }]);
    expect(second.rest).toBe('');
  });

  it('reads CRLF framing, which the spec allows and proxies produce', () => {
    // Splitting on '\n\n' alone yields zero events here and a buffer that grows
    // for the life of the connection.
    expect(parseSseFrames('event: comments\r\ndata: {"v":1}\r\n\r\n')).toEqual({
      events: [{ event: 'comments', data: '{"v":1}' }],
      rest: '',
    });
  });

  it('reads bare-CR framing', () => {
    expect(parseSseFrames('event: comments\rdata: {"v":1}\r\r').events).toEqual([
      { event: 'comments', data: '{"v":1}' },
    ]);
  });

  it('ignores keep-alive comments', () => {
    expect(parseSseFrames(': ping\n\n').events).toEqual([]);
  });

  it('reads several frames from one chunk', () => {
    const parsed = parseSseFrames(
      'event: ready\ndata: {}\n\n: ping\n\nevent: comments\ndata: {}\n\n'
    );
    expect(parsed.events.map((event) => event.event)).toEqual(['ready', 'comments']);
  });

  it('joins a multi-line data payload', () => {
    expect(parseSseFrames('event: x\ndata: one\ndata: two\n\n').events).toEqual([
      { event: 'x', data: 'one\ntwo' },
    ]);
  });

  it('returns nothing for an empty or partial buffer', () => {
    expect(parseSseFrames('')).toEqual({ events: [], rest: '' });
    expect(parseSseFrames('event: ready')).toEqual({ events: [], rest: 'event: ready' });
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

  it('treats a non-numeric failure count as healthy', () => {
    expect(nextPollDelayMs(Number.NaN)).toBe(10000);
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

  // These compare the twin against hand-written expectations at sampled inputs.
  // They are not a proof of equivalence with index.ts — nothing generates one
  // from the other — so a behaviour worth relying on needs a case here too.
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
      parseSseFrames: typeof parseSseFrames;
      timelineLooksBound: typeof timelineLooksBound;
      sequenceIsBound: typeof sequenceIsBound;
      autoSyncMayWrite: typeof autoSyncMayWrite;
      normalizeSequenceId: typeof normalizeSequenceId;
      resolvableIds: typeof resolvableIds;
      commentsRemovedFromTimeline: typeof commentsRemovedFromTimeline;
      DEFAULT_AUTO_RESOLVE_CAP: number;
      AUTO_SYNC_BASE_MS: number;
    };

    expect(umd.sequenceOffsetSeconds('nope', 24)).toBeNull();
    expect(umd.sequenceOffsetSeconds('01:00:00:00', 24)).toBe(3600);
    expect(umd.sequenceOffsetSeconds('00:00:00:00', 24)).toBe(0);

    const anyMarker = {
      id: 'm1',
      commentId: 'c1',
      startSeconds: 0,
      durationSeconds: 0,
      name: 'n',
      comments: commentSentinel('c1'),
    };
    expect(umd.planIsEmpty({ add: [], move: [], remove: [] })).toBe(true);
    expect(umd.planIsEmpty({ add: [remote[0]], move: [], remove: [] })).toBe(false);
    expect(umd.planIsEmpty({ add: [], move: [], remove: [anyMarker] })).toBe(false);
    expect(
      umd.planIsEmpty({ add: [], move: [{ comment: remote[0], marker: anyMarker }], remove: [] })
    ).toBe(false);

    // The twin must apply the same open/top-level filter as the source.
    expect(
      umd.commentsRemovedFromTimeline([{ ...remote[0], isResolved: true }], [], ['c1'])
    ).toEqual([]);
    expect(umd.sequenceOffsetSeconds('00:00:00:05', 25)).toBe(0.2);

    expect(umd.timelineLooksBound([], [])).toBe(true);
    expect(umd.timelineLooksBound([], ['c1'])).toBe(false);
    expect(umd.timelineLooksBound([anyMarker], ['c1'])).toBe(true);
    expect(
      umd.timelineLooksBound(
        [{ ...anyMarker, commentId: 'x9', comments: commentSentinel('x9') }],
        ['c1']
      )
    ).toBe(false);

    expect(umd.resolvableIds({ ok: true, ids: ['c1'] })).toEqual(['c1']);
    expect(
      umd.resolvableIds({
        ok: false,
        reason: 'timeline-not-bound',
        refusedIds: ['c1', 'c2'],
        cap: 5,
      })
    ).toEqual([]);

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
      refusedIds: ['c1', 'c2'],
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
      refusedIds: ['c1', 'c2'],
      cap: 5,
    });
    expect(umd.planTimelineResolves(two, [stillThere], ['c1', 'c2'], { cap: 0 })).toEqual({
      ok: false,
      reason: 'over-cap',
      refusedIds: ['c1'],
      cap: 0,
    });
    // Boundary: exactly at the cap is allowed, one more is not. Without both
    // halves the twin could drift to `>=` unnoticed.
    expect(umd.planTimelineResolves(two, [stillThere], ['c1', 'c2'], { cap: 1 })).toEqual({
      ok: true,
      ids: ['c1'],
    });

    // The twin is what the panels load, so every combination the source
    // distinguishes has to be pinned here too. Byte-equality only proves the
    // three .cjs copies match each other, not that they match index.ts.
    const foreignMarker = {
      ...anyMarker,
      commentId: 'x9',
      comments: commentSentinel('x9'),
    };
    expect(umd.sequenceIsBound([], ['c1'], { hostSequenceId: 's', linkedSequenceId: 's' })).toBe(
      true
    );
    expect(
      umd.sequenceIsBound([anyMarker], ['c1'], { hostSequenceId: 'dup', linkedSequenceId: 'orig' })
    ).toBe(false);
    // host-only, linked-only and neither must all fall back to the heuristic.
    expect(umd.sequenceIsBound([anyMarker], ['c1'], { hostSequenceId: 'only' })).toBe(true);
    expect(umd.sequenceIsBound([foreignMarker], ['c1'], { hostSequenceId: 'only' })).toBe(false);
    expect(umd.sequenceIsBound([anyMarker], ['c1'], { linkedSequenceId: 'only' })).toBe(true);
    expect(umd.sequenceIsBound([foreignMarker], ['c1'], { linkedSequenceId: 'only' })).toBe(false);
    expect(umd.sequenceIsBound([anyMarker], ['c1'], {})).toBe(true);

    // The flagship fix of the identity work, pinned in the copy that runs it:
    // planTimelineResolves must honour the identity it is handed.
    expect(
      umd.planTimelineResolves(two, [stillThere], ['c1', 'c2'], {
        identity: { hostSequenceId: 'dup', linkedSequenceId: 'orig' },
      })
    ).toEqual({
      ok: false,
      reason: 'timeline-not-bound',
      refusedIds: ['c1'],
      cap: 5,
    });

    expect(umd.autoSyncMayWrite([], [], { hostSequenceId: 's', linkedSequenceId: 's' })).toBe(true);
    expect(umd.autoSyncMayWrite([], [], { hostSequenceId: 's', linkedSequenceId: null })).toBe(
      false
    );
    expect(umd.autoSyncMayWrite([anyMarker], ['c1'], {})).toBe(true);

    expect(umd.normalizeSequenceId('a1b2c3d4-e5f6-7890')).toBe('a1b2c3d4-e5f6-7890');
    expect(umd.normalizeSequenceId(Promise.resolve('x'))).toBeNull();
    expect(umd.normalizeSequenceId(true)).toBeNull();
    expect(umd.normalizeSequenceId('42')).toBeNull();
    expect(umd.normalizeSequenceId(Object.create(null))).toBeNull();
    expect(umd.autoSyncMayWrite([], ['c1'], {})).toBe(false);

    expect(umd.describeResolveRefusal({ ok: true, ids: [] })).toBeNull();
    expect(
      umd.describeResolveRefusal({
        ok: false,
        reason: 'over-cap',
        refusedIds: ['c1', 'c2'],
        cap: 1,
      })
    ).toContain('than the 1 allowed');

    expect(umd.parseSseFrames('event: comments\ndata: {"v":1}\n\nevent: par')).toEqual({
      events: [{ event: 'comments', data: '{"v":1}' }],
      rest: 'event: par',
    });
    expect(umd.parseSseFrames(': ping\n\n').events).toEqual([]);
    // CRLF too: the twin is what the panels run, and a proxy may rewrite framing.
    expect(umd.parseSseFrames('event: comments\r\ndata: {"v":1}\r\n\r\n')).toEqual({
      events: [{ event: 'comments', data: '{"v":1}' }],
      rest: '',
    });

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
