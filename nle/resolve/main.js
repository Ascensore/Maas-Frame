const { app } = require('electron');
const path = require('path');
const nleCore = require('../core/nle-core.cjs');

function parseCustomData(raw) {
  if (!raw || typeof raw !== 'string' || !raw.startsWith('{')) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function persistSequenceLink(baseUrl, token, versionId, body) {
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/v1/versions/${versionId}/sequence-link`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error((payload && payload.error) || `HTTP ${response.status}`);
    }
  } catch (error) {
    return error.message;
  }
  return null;
}

async function createWindow() {
  const { BrowserWindow, ipcMain } = require('electron');
  const win = new BrowserWindow({
    width: 420,
    height: 640,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  await win.loadFile(path.join(__dirname, 'index.html'));

  ipcMain.handle('sync', async (_event, { baseUrl, token, versionId }) => {
    const resolve = app.resolve;
    if (!resolve) throw new Error('Resolve scripting API is unavailable. Studio is required.');
    const projectManager = resolve.GetProjectManager();
    const project = projectManager.GetCurrentProject();
    if (!project) throw new Error('No project open');
    const timeline = project.GetCurrentTimeline();
    if (!timeline) throw new Error('No timeline open');

    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/v1/versions/${versionId}/comments`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const comments = payload.data?.comments ?? [];

    const fps = Number(timeline.GetSetting('timelineFrameRate')) || 24;
    const startTc =
      timeline.GetStartTimecode?.() || timeline.GetSetting?.('timelineStartTimecode') || '00:00:00:00';
    const dropFrame = String(startTc).includes(';');
    const offsetSeconds = nleCore.sequenceOffsetSeconds(startTc, fps);
    const sequenceName = timeline.GetName?.() || 'Untitled';
    const rational = nleCore.fpsToRational(fps);
    const persistError = await persistSequenceLink(baseUrl, token, versionId, {
      nle: 'resolve',
      sequenceName: String(sequenceName).slice(0, 200),
      startTimecode: startTc,
      frameRateNum: rational.num,
      frameRateDen: rational.den,
      dropFrame,
    });

    const existing = timeline.GetMarkers() || {};
    const local = [];
    for (const [frame, info] of Object.entries(existing)) {
      const parsed = parseCustomData(info.customData);
      const commentId = parsed?.ofId || nleCore.parseSentinel(info.note || '');
      local.push({
        id: String(frame),
        commentId,
        startSeconds: Number(frame) / fps,
        durationSeconds: Number(info.duration || 0) / fps,
        name: info.name || '',
        comments: info.note || '',
        customData: info.customData,
        frame: Number(frame),
      });
    }

    const plan = nleCore.reconcile(comments, local, offsetSeconds);
    let added = 0;
    let moved = 0;
    let removed = 0;

    const deleteMarker = (marker) => {
      const customData =
        marker.customData || (marker.commentId ? nleCore.resolveCustomData(marker.commentId, versionId) : null);
      if (customData && timeline.DeleteMarkerByCustomData?.(customData)) return true;
      if (typeof marker.frame === 'number' && timeline.DeleteMarkerAtFrame?.(marker.frame)) return true;
      return false;
    };

    const addMarker = (comment) => {
      const frame = Math.round((comment.timestamp + offsetSeconds) * fps);
      const duration =
        comment.timestampEnd && comment.timestampEnd > comment.timestamp
          ? Math.max(1, Math.round((comment.timestampEnd - comment.timestamp) * fps))
          : 1;
      const customData = nleCore.resolveCustomData(comment.id, versionId);
      const existingByData = timeline.GetMarkerByCustomData?.(customData);
      if (existingByData) return false;
      return Boolean(
        timeline.AddMarker(
          frame,
          nleCore.nearestResolveColor(comment.tag && comment.tag.color),
          nleCore.commentLabel(comment).slice(0, 40),
          comment.content || '',
          duration,
          customData
        )
      );
    };

    for (const marker of plan.remove) {
      if (deleteMarker(marker)) removed += 1;
    }
    for (const { comment, marker } of plan.move) {
      deleteMarker(marker);
      if (addMarker(comment)) moved += 1;
    }
    for (const comment of plan.add) {
      if (addMarker(comment)) added += 1;
    }

    const summary = `Synced. Added ${added}, moved ${moved}, removed ${removed}. Offset ${offsetSeconds.toFixed(2)}s.`;
    return persistError ? `${summary} Sequence link was not saved: ${persistError}` : summary;
  });
}

app.whenReady().then(() => createWindow());
