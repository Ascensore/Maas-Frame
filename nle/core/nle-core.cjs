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
      var commentId = marker.commentId != null ? marker.commentId : parseSentinel(marker.comments);
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

  function sequenceOffsetSeconds(startTimecode, fps) {
    var match = /^(\d{1,3}):([0-5]\d):([0-5]\d)[:;](\d{1,3})$/.exec(String(startTimecode || '').trim());
    if (!match) return 0;
    var rate = Math.max(1, Number(fps) || 24);
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

  function resolveCustomData(commentId, versionId) {
    return JSON.stringify({ ofId: commentId, versionId: versionId });
  }

  return {
    SENTINEL_RE: SENTINEL_RE,
    commentSentinel: commentSentinel,
    parseSentinel: parseSentinel,
    commentLabel: commentLabel,
    markerCommentBody: markerCommentBody,
    reconcile: reconcile,
    nearestResolveColor: nearestResolveColor,
    sequenceOffsetSeconds: sequenceOffsetSeconds,
    fpsToRational: fpsToRational,
    secondsToSmpte: secondsToSmpte,
    resolveCustomData: resolveCustomData,
  };
});
