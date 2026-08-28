/* global require */
const SENTINEL_RE = /\[of:([a-z0-9]+)\]/i;

function commentSentinel(id) {
  return `[of:${id}]`;
}

function parseSentinel(text) {
  const match = SENTINEL_RE.exec(text || '');
  return match ? match[1] : null;
}

function setStatus(message) {
  document.getElementById('status').textContent = message;
}

async function api(baseUrl, token, path) {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error || `HTTP ${response.status}`);
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

async function sequenceStartOffsetSeconds(ppro, sequence) {
  try {
    const settings = await sequence.getSettings?.();
    const start = settings?.startTime ?? settings?.zeroPoint ?? null;
    return secondsFromTick(start);
  } catch {
    return 0;
  }
}

async function syncMarkers() {
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
  const offsetSeconds = await sequenceStartOffsetSeconds(ppro, sequence);

  const { comments } = await api(baseUrl, token, `/api/v1/versions/${versionId}/comments`);
  const remote = comments.filter((comment) => !comment.parentId && !comment.isResolved);

  const localByComment = new Map();
  for (const marker of existing) {
    const commentsText = marker.comments || marker.getComments?.() || '';
    const commentId = parseSentinel(commentsText);
    if (commentId) localByComment.set(commentId, marker);
  }

  let added = 0;
  let moved = 0;
  let removed = 0;

  project.lockedAccess(() => {
    project.executeTransaction((compound) => {
      for (const comment of remote) {
        const start = ppro.TickTime.createWithSeconds(comment.timestamp + offsetSeconds);
        const durationSeconds =
          comment.timestampEnd && comment.timestampEnd > comment.timestamp
            ? comment.timestampEnd - comment.timestamp
            : 0;
        const duration =
          durationSeconds > 0
            ? ppro.TickTime.createWithSeconds(durationSeconds)
            : ppro.TickTime.TIME_ZERO;
        const name = (comment.content || 'Note').slice(0, 40);
        const body = `${comment.content || ''}\n${commentSentinel(comment.id)}`.trim();
        const existingMarker = localByComment.get(comment.id);
        if (!existingMarker) {
          compound.addAction(
            sequenceMarkers.createAddMarkerAction(
              name,
              ppro.Marker.MARKER_TYPE_COMMENT,
              start,
              duration,
              body
            )
          );
          added += 1;
        } else {
          const current = secondsFromTick(existingMarker.start);
          if (Math.abs(current - (comment.timestamp + offsetSeconds)) > 0.02) {
            compound.addAction(sequenceMarkers.createMoveMarkerAction(existingMarker, start));
            moved += 1;
          }
        }
      }

      for (const [commentId, marker] of localByComment) {
        if (!remote.some((comment) => comment.id === commentId)) {
          compound.addAction(sequenceMarkers.createRemoveMarkerAction(marker));
          removed += 1;
        }
      }
    }, 'Sync review comments');
  });

  setStatus(`Synced. Added ${added}, moved ${moved}, removed ${removed}. Offset ${offsetSeconds.toFixed(2)}s.`);
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
