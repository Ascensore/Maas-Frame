/* global require */

function nle() {
  return window.OpenFrameNle;
}

function setStatus(message) {
  document.getElementById('status').textContent = message;
}

async function api(baseUrl, token, path, init) {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init && init.headers),
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error((body && body.error) || `HTTP ${response.status}`);
  }
  const json = await response.json();
  return json.data;
}

function secondsFromTick(tick) {
  if (!tick) return 0;
  if (typeof tick.seconds === 'number') return tick.seconds;
  if (typeof tick.sec === 'number') return tick.sec;
  if (typeof tick.ticks === 'number' && typeof tick.ticksPerSecond === 'number' && tick.ticksPerSecond) {
    return tick.ticks / tick.ticksPerSecond;
  }
  return 0;
}

async function sequenceMeta(sequence) {
  let offsetSeconds = 0;
  let fps = 24;
  let dropFrame = false;
  let sequenceName = sequence.name || 'Untitled';
  try {
    const settings = await sequence.getSettings?.();
    offsetSeconds = secondsFromTick(settings?.startTime ?? settings?.zeroPoint ?? null);
    const rate = settings?.videoFrameRate;
    if (rate) {
      const frameDur = secondsFromTick(rate);
      if (frameDur > 0) fps = 1 / frameDur;
    }
    dropFrame = Boolean(
      settings?.dropFrame || String(settings?.videoDisplayFormat || '').toLowerCase().includes('drop')
    );
    if (typeof settings?.name === 'string' && settings.name.trim()) {
      sequenceName = settings.name.trim();
    }
  } catch {
    // Keep the defaults and still persist a link so the next sync has an offset.
  }
  return { offsetSeconds, fps, dropFrame, sequenceName };
}

async function persistSequenceLink(baseUrl, token, versionId, meta) {
  const core = nle();
  const rational = core.fpsToRational(meta.fps);
  try {
    await api(baseUrl, token, `/api/v1/versions/${versionId}/sequence-link`, {
      method: 'PUT',
      body: JSON.stringify({
        nle: 'premiere',
        sequenceName: String(meta.sequenceName || 'Untitled').slice(0, 200),
        startTimecode: core.secondsToSmpte(meta.offsetSeconds, meta.fps, meta.dropFrame),
        frameRateNum: rational.num,
        frameRateDen: rational.den,
        dropFrame: meta.dropFrame,
      }),
    });
  } catch (error) {
    setStatus(`Markers will still sync. Sequence link was not saved: ${error.message}`);
  }
}

async function syncMarkers() {
  const core = nle();
  const baseUrl = document.getElementById('baseUrl').value.trim();
  const token = document.getElementById('token').value.trim();
  const versionId = document.getElementById('version').value;
  if (!token || !versionId) {
    setStatus('Token and version are required.');
    return;
  }

  const ppro = require('premierepro');
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error('No active Premiere project');
  const sequence = await project.getActiveSequence();
  if (!sequence) throw new Error('No active sequence');
  const sequenceMarkers = await ppro.Markers.getMarkers(sequence);
  const existing = await sequenceMarkers.getMarkers();
  const meta = await sequenceMeta(sequence);
  await persistSequenceLink(baseUrl, token, versionId, meta);

  const { comments } = await api(baseUrl, token, `/api/v1/versions/${versionId}/comments`);
  const local = [];
  for (const marker of existing) {
    const commentsText = marker.comments || marker.getComments?.() || '';
    local.push({
      id: String(local.length),
      commentId: core.parseSentinel(commentsText),
      startSeconds: secondsFromTick(marker.start),
      durationSeconds: secondsFromTick(marker.duration),
      name: marker.name || '',
      comments: commentsText,
      _marker: marker,
    });
  }

  const storageKey = core.syncedMarkerStorageKey(versionId);
  const previousIds = core.parseSyncedMarkerIds(
    typeof localStorage !== 'undefined' ? localStorage.getItem(storageKey) : null
  );
  const toResolve = core.commentsRemovedFromTimeline(comments, local, previousIds);
  const resolvedIds = [];
  for (const commentId of toResolve) {
    await api(baseUrl, token, `/api/v1/comments/${commentId}`, {
      method: 'PATCH',
      body: JSON.stringify({ isResolved: true }),
    });
    resolvedIds.push(commentId);
  }
  const remaining = core.remainingCommentsAfterTimelineResolves(comments, resolvedIds);

  const plan = core.reconcile(remaining, local, meta.offsetSeconds);

  let added = 0;
  let moved = 0;
  let removed = 0;

  project.lockedAccess(() => {
    project.executeTransaction((compound) => {
      for (const comment of plan.add) {
        const start = ppro.TickTime.createWithSeconds(comment.timestamp + meta.offsetSeconds);
        const durationSeconds =
          comment.timestampEnd && comment.timestampEnd > comment.timestamp
            ? comment.timestampEnd - comment.timestamp
            : 0;
        const duration =
          durationSeconds > 0
            ? ppro.TickTime.createWithSeconds(durationSeconds)
            : ppro.TickTime.TIME_ZERO;
        compound.addAction(
          sequenceMarkers.createAddMarkerAction(
            core.commentLabel(comment).slice(0, 40),
            ppro.Marker.MARKER_TYPE_COMMENT,
            start,
            duration,
            core.markerCommentBody(comment)
          )
        );
        added += 1;
      }

      for (const { comment, marker } of plan.move) {
        const start = ppro.TickTime.createWithSeconds(comment.timestamp + meta.offsetSeconds);
        compound.addAction(sequenceMarkers.createMoveMarkerAction(marker._marker, start));
        moved += 1;
      }

      for (const marker of plan.remove) {
        compound.addAction(sequenceMarkers.createRemoveMarkerAction(marker._marker));
        removed += 1;
      }
    }, 'Sync review comments');
  });

  const after = await sequenceMarkers.getMarkers();
  const afterLocal = [];
  for (const marker of after) {
    const commentsText = marker.comments || marker.getComments?.() || '';
    afterLocal.push({
      id: String(afterLocal.length),
      commentId: core.parseSentinel(commentsText),
      startSeconds: 0,
      durationSeconds: 0,
      name: marker.name || '',
      comments: commentsText,
    });
  }
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(storageKey, JSON.stringify(core.collectSyncedMarkerIds(afterLocal)));
  }

  setStatus(
    `Synced. Added ${added}, moved ${moved}, removed ${removed}, resolved ${resolvedIds.length}. Offset ${meta.offsetSeconds.toFixed(2)}s.`
  );
}

async function loadProjects() {
  const baseUrl = document.getElementById('baseUrl').value.trim();
  const token = document.getElementById('token').value.trim();
  const { projects } = await api(baseUrl, token, '/api/v1/projects');
  const select = document.getElementById('project');
  select.innerHTML = projects
    .map((project) => `<option value="${project.id}">${project.name}</option>`)
    .join('');
  if (projects[0]) await loadVersions(projects[0].id);
}

async function loadVersions(projectId) {
  const baseUrl = document.getElementById('baseUrl').value.trim();
  const token = document.getElementById('token').value.trim();
  const { videos } = await api(baseUrl, token, `/api/v1/projects/${projectId}/videos`);
  const select = document.getElementById('version');
  const options = [];
  for (const video of videos) {
    for (const version of video.versions) {
      options.push(
        `<option value="${version.id}">${video.title} v${version.versionNumber}</option>`
      );
    }
  }
  select.innerHTML = options.join('') || '<option value="">No versions</option>';
}

document.getElementById('load').addEventListener('click', () => {
  loadProjects().catch((error) => setStatus(error.message));
});
document.getElementById('project').addEventListener('change', (event) => {
  loadVersions(event.target.value).catch((error) => setStatus(error.message));
});
document.getElementById('sync').addEventListener('click', () => {
  syncMarkers().catch((error) => setStatus(error.message));
});
