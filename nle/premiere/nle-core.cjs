/* Shared NLE mapping. Loaded by Premiere (script tag) and Resolve (require). */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (typeof root !== 'undefined') {
    root.OpenFrameNle = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var SENTINEL_RE = /\[of:([a-z0-9]+)\]/i;
  var DEFAULT_AUTO_RESOLVE_CAP = 5;
  var AUTO_SYNC_BASE_MS = 10000;
  var AUTO_SYNC_MAX_BACKOFF_MS = 300000;

  function commentSentinel(commentId) {
    return '[of:' + commentId + ']';
  }

  function parseSentinel(text) {
    var match = SENTINEL_RE.exec(text || '');
    return match ? match[1] : null;
  }

  function commentLabel(comment) {
    var author = (comment.author && comment.author.name) || comment.guestName || 'Note';
    var body = String(comment.content || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60);
    return body ? author + ': ' + body : author;
  }

  function markerCommentBody(comment) {
    var lines = [comment.content || '', commentSentinel(comment.id)];
    return lines.filter(Boolean).join('\n');
  }

  function markerCommentId(marker) {
    if (marker.commentId != null && marker.commentId !== '') return marker.commentId;
    return parseSentinel(marker.comments);
  }

  function collectSyncedMarkerIds(local) {
    var ids = [];
    var seen = {};
    (local || []).forEach(function (marker) {
      var id = markerCommentId(marker);
      if (!id || seen[id]) return;
      seen[id] = true;
      ids.push(id);
    });
    return ids;
  }

  function commentsRemovedFromTimeline(remote, local, previouslySyncedIds) {
    var openIds = {};
    (remote || []).forEach(function (comment) {
      if (comment.parentId === null && !comment.isResolved) openIds[comment.id] = true;
    });
    var present = {};
    collectSyncedMarkerIds(local).forEach(function (id) {
      present[id] = true;
    });
    var removed = [];
    (previouslySyncedIds || []).forEach(function (id) {
      if (openIds[id] && !present[id]) removed.push(id);
    });
    return removed;
  }

  function parseSyncedMarkerIds(raw) {
    if (!raw) return [];
    try {
      var parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(function (id) {
        return typeof id === 'string' && id.length > 0;
      });
    } catch (error) {
      return [];
    }
  }

  function syncedMarkerStorageKey(versionId) {
    return 'of-synced-markers:' + versionId;
  }

  function remainingCommentsAfterTimelineResolves(remote, toResolve) {
    var resolved = {};
    (toResolve || []).forEach(function (id) {
      resolved[id] = true;
    });
    return (remote || []).map(function (comment) {
      return resolved[comment.id] ? Object.assign({}, comment, { isResolved: true }) : comment;
    });
  }

  function reconcile(remote, local, offsetSeconds) {
    var offset = typeof offsetSeconds === 'number' ? offsetSeconds : 0;
    var tops = remote.filter(function (comment) {
      return comment.parentId === null && !comment.isResolved;
    });
    var byId = new Map();
    tops.forEach(function (comment) {
      byId.set(comment.id, comment);
    });
    var localByComment = new Map();
    var orphans = [];

    local.forEach(function (marker) {
      var commentId = markerCommentId(marker);
      if (!commentId) return;
      if (!byId.has(commentId)) {
        orphans.push(marker);
        return;
      }
      localByComment.set(commentId, marker);
    });

    var add = [];
    var move = [];
    tops.forEach(function (comment) {
      var existing = localByComment.get(comment.id);
      if (!existing) {
        add.push(comment);
        return;
      }
      if (Math.abs(existing.startSeconds - (comment.timestamp + offset)) > 0.02) {
        move.push({ comment: comment, marker: existing });
      }
    });

    return { add: add, move: move, remove: orphans };
  }

  function nearestResolveColor(hex) {
    var palette = [
      { name: 'Blue', r: 59, g: 130, b: 246 },
      { name: 'Red', r: 239, g: 68, b: 68 },
      { name: 'Green', r: 34, g: 197, b: 94 },
      { name: 'Yellow', r: 234, g: 179, b: 8 },
      { name: 'Cyan', r: 6, g: 182, b: 212 },
      { name: 'Pink', r: 236, g: 72, b: 153 },
      { name: 'Purple', r: 168, g: 85, b: 247 },
      { name: 'Orange', r: 249, g: 115, b: 22 },
    ];
    if (!hex || !/^#?[0-9a-f]{6}$/i.test(hex)) return 'Blue';
    var value = hex.replace('#', '');
    var r = parseInt(value.slice(0, 2), 16);
    var g = parseInt(value.slice(2, 4), 16);
    var b = parseInt(value.slice(4, 6), 16);
    var best = palette[0];
    var bestDist = Infinity;
    palette.forEach(function (color) {
      var dist = (color.r - r) * (color.r - r) + (color.g - g) * (color.g - g) + (color.b - b) * (color.b - b);
      if (dist < bestDist) {
        best = color;
        bestDist = dist;
      }
    });
    return best.name;
  }

  /* Returns null when the timecode does not parse, so callers fail closed
     instead of placing every marker an hour from its comment. */
  function sequenceOffsetSeconds(startTimecode, fps) {
    var match = /^(\d{1,3}):([0-5]\d):([0-5]\d)[:;](\d{1,3})$/.exec(String(startTimecode || '').trim());
    if (!match) return null;
    var rate = Math.max(1, fps);
    return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / rate;
  }

  var KNOWN_RATES = [
    [24000 / 1001, 24000, 1001],
    [24, 24, 1],
    [25, 25, 1],
    [30000 / 1001, 30000, 1001],
    [30, 30, 1],
    [50, 50, 1],
    [60000 / 1001, 60000, 1001],
    [60, 60, 1],
  ];

  function fpsToRational(fps) {
    var n = Number(fps);
    if (!isFinite(n) || n <= 0) return { num: 24, den: 1 };
    for (var i = 0; i < KNOWN_RATES.length; i += 1) {
      if (Math.abs(n - KNOWN_RATES[i][0]) < 0.02) {
        return { num: KNOWN_RATES[i][1], den: KNOWN_RATES[i][2] };
      }
    }
    var rounded = Math.round(n);
    if (Math.abs(n - rounded) < 0.02) return { num: rounded, den: 1 };
    return { num: Math.round(n * 1000), den: 1000 };
  }

  function secondsToSmpte(seconds, fps, dropFrame) {
    var rate = Math.max(1, Math.round(fps));
    var totalFrames = Math.max(0, Math.round(seconds * (isFinite(fps) && fps > 0 ? fps : rate)));
    var hours = Math.floor(totalFrames / (rate * 3600));
    var minutes = Math.floor((totalFrames % (rate * 3600)) / (rate * 60));
    var secs = Math.floor((totalFrames % (rate * 60)) / rate);
    var frames = totalFrames % rate;
    var sep = dropFrame ? ';' : ':';
    function pad(value) {
      return String(value).padStart(2, '0');
    }
    return pad(hours) + ':' + pad(minutes) + ':' + pad(secs) + sep + pad(frames);
  }

  /* At least one marker this version placed is still on the timeline. See
     timelineLooksBound in ../core/src/index.ts. */
  function timelineLooksBound(local, previouslySyncedIds) {
    var previous = previouslySyncedIds || [];
    if (previous.length === 0) return true;
    var presentIds = collectSyncedMarkerIds(local);
    return previous.some(function (id) {
      return presentIds.indexOf(id) !== -1;
    });
  }

  function planIsEmpty(plan) {
    return plan.add.length === 0 && plan.move.length === 0 && plan.remove.length === 0;
  }

  /* See planTimelineResolves in ../core/src/index.ts for why these refusals exist. */
  function planTimelineResolves(remote, local, previouslySyncedIds, options) {
    var cap = (options && typeof options.cap === 'number') ? options.cap : DEFAULT_AUTO_RESOLVE_CAP;
    var previous = previouslySyncedIds || [];
    var ids = commentsRemovedFromTimeline(remote, local, previous);
    if (ids.length === 0) return { ok: true, ids: [] };
    if (!timelineLooksBound(local, previous)) {
      return { ok: false, reason: 'timeline-not-bound', refusedIds: ids, cap: cap };
    }
    if (ids.length > cap) return { ok: false, reason: 'over-cap', refusedIds: ids, cap: cap };
    return { ok: true, ids: ids };
  }

  /* Read a decision through this: a refusal's ids are the refused set. */
  function resolvableIds(decision) {
    return decision.ok ? decision.ids : [];
  }

  function describeResolveRefusal(decision) {
    if (decision.ok) return null;
    var count = decision.refusedIds.length;
    if (decision.reason === 'timeline-not-bound') {
      return 'Did not resolve ' + count + ' comment(s): this timeline has no review markers, so the open sequence may not be the one being synced. Resolve them in the web app if that was intended.';
    }
    return 'Did not resolve ' + count + ' comment(s): more than the ' + decision.cap + ' allowed in one sync. Resolve them in the web app if that was intended.';
  }

  function nextPollDelayMs(consecutiveFailures, baseMs, maxMs) {
    var base = typeof baseMs === 'number' ? baseMs : AUTO_SYNC_BASE_MS;
    var max = typeof maxMs === 'number' ? maxMs : AUTO_SYNC_MAX_BACKOFF_MS;
    if (!isFinite(consecutiveFailures) || consecutiveFailures <= 0) return base;
    var exponent = Math.min(consecutiveFailures, 10);
    return Math.min(max, base * Math.pow(2, exponent));
  }

  function resolveCustomData(commentId, versionId) {
    return JSON.stringify({ ofId: commentId, versionId: versionId });
  }

  return {
    SENTINEL_RE: SENTINEL_RE,
    DEFAULT_AUTO_RESOLVE_CAP: DEFAULT_AUTO_RESOLVE_CAP,
    AUTO_SYNC_BASE_MS: AUTO_SYNC_BASE_MS,
    AUTO_SYNC_MAX_BACKOFF_MS: AUTO_SYNC_MAX_BACKOFF_MS,
    planIsEmpty: planIsEmpty,
    timelineLooksBound: timelineLooksBound,
    resolvableIds: resolvableIds,
    planTimelineResolves: planTimelineResolves,
    describeResolveRefusal: describeResolveRefusal,
    nextPollDelayMs: nextPollDelayMs,
    commentSentinel: commentSentinel,
    parseSentinel: parseSentinel,
    commentLabel: commentLabel,
    markerCommentBody: markerCommentBody,
    markerCommentId: markerCommentId,
    collectSyncedMarkerIds: collectSyncedMarkerIds,
    commentsRemovedFromTimeline: commentsRemovedFromTimeline,
    parseSyncedMarkerIds: parseSyncedMarkerIds,
    syncedMarkerStorageKey: syncedMarkerStorageKey,
    remainingCommentsAfterTimelineResolves: remainingCommentsAfterTimelineResolves,
    reconcile: reconcile,
    nearestResolveColor: nearestResolveColor,
    sequenceOffsetSeconds: sequenceOffsetSeconds,
    fpsToRational: fpsToRational,
    secondsToSmpte: secondsToSmpte,
    resolveCustomData: resolveCustomData,
  };
});
