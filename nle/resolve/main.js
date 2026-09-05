const { app } = require('electron');
const path = require('path');
const nleCore = require('./nle-core.cjs');

function parseCustomData(raw) {
  if (!raw || typeof raw !== 'string' || !raw.startsWith('{')) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Resolve's own id for the timeline. Duplicating a timeline copies its markers
 * but gets a fresh id, so this is what tells an original from a stale duplicate.
 * Older hosts without GetUniqueId return null and fall back to the marker
 * heuristic.
 */
function hostSequenceId(timeline) {
  return nleCore.normalizeSequenceId(timeline.GetUniqueId?.());
}

/**
 * What the server has stored for the version we are syncing. Returns
 * `{ ok: false }` on a failed read: collapsing that into "no id stored" would
 * downgrade the identity check to the marker heuristic on any transient blip,
 * which is what lets a duplicate timeline through.
 */
async function storedSequenceId(baseUrl, token, versionId) {
  try {
    const response = await fetch(
      `${baseUrl.replace(/\/$/, '')}/api/v1/versions/${versionId}/sequence-link?nle=resolve`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!response.ok) return { ok: false, sequenceId: null };
    const payload = await response.json();
    return { ok: true, sequenceId: payload.data?.sequenceLink?.sequenceId ?? null };
  } catch {
    return { ok: false, sequenceId: null };
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

  // The renderer drives the loop but only the main process can talk to Resolve,
  // so identifying the front timeline has to come back across IPC.
  ipcMain.handle('timeline-identity', async () => {
    const resolve = app.resolve;
    if (!resolve) return null;
    const project = resolve.GetProjectManager()?.GetCurrentProject();
    const timeline = project?.GetCurrentTimeline();
    if (!timeline) return null;
    return { sequenceId: hostSequenceId(timeline), sequenceName: timeline.GetName?.() || 'Untitled' };
  });

  ipcMain.handle('sync', async (_event, { baseUrl, token, versionId, previousIds, auto }) => {
    const resolve = app.resolve;
    if (!resolve) throw new Error('Resolve scripting API is unavailable. Studio is required.');
    const projectManager = resolve.GetProjectManager();
    const project = projectManager.GetCurrentProject();
    if (!project) throw new Error('No project open');
    const timeline = project.GetCurrentTimeline();
    if (!timeline) throw new Error('No timeline open');

    const fps = Number(timeline.GetSetting('timelineFrameRate')) || 24;
    const startTc =
      timeline.GetStartTimecode?.() || timeline.GetSetting?.('timelineStartTimecode') || '00:00:00:00';
    const dropFrame = String(startTc).includes(';');
    const parsedOffset = nleCore.sequenceOffsetSeconds(startTc, fps);
    if (parsedOffset === null && auto) {
      // Guessing 0 here puts every marker an hour from its comment on a
      // timeline starting at 01:00:00:00. A human can still force it.
      return {
        message: `Auto-sync paused: could not read the timeline start timecode (${startTc}). Sync manually to place markers at 00:00:00:00.`,
        syncedIds: previousIds || [],
      };
    }
    const offsetSeconds = parsedOffset === null ? 0 : parsedOffset;
    const sequenceName = timeline.GetName?.() || 'Untitled';
    const sequenceId = hostSequenceId(timeline);
    const rational = nleCore.fpsToRational(fps);

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

    // Everything below writes: markers onto the timeline, the sequence link on
    // the server, and the record of which comments have markers. Resolve cannot
    // tell us the editor switched timelines, so this check is what stops an
    // unattended pass from acting on somebody else's timeline.
    const stored = await storedSequenceId(baseUrl, token, versionId);
    if (auto && !stored.ok) {
      return {
        message: 'Auto-sync paused: could not confirm which timeline this version is synced to.',
        syncedIds: previousIds || [],
      };
    }
    const identity = { hostSequenceId: sequenceId, linkedSequenceId: stored.sequenceId };
    if (auto && !nleCore.autoSyncMayWrite(local, previousIds || [], identity)) {
      return {
        message:
          'Auto-sync paused: this timeline is not the one this version is synced to. Press Sync markers to bind the timeline you are on.',
        syncedIds: previousIds || [],
      };
    }

    // Auto-sync is read-only, so it does not rebind the sequence link.
    const persistError = auto
      ? null
      : await persistSequenceLink(baseUrl, token, versionId, {
          nle: 'resolve',
          sequenceId,
          sequenceName: String(sequenceName).slice(0, 200),
          startTimecode: startTc,
          frameRateNum: rational.num,
          frameRateDen: rational.den,
          dropFrame,
        });

    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/v1/versions/${versionId}/comments`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const comments = payload.data?.comments ?? [];

    // Auto-sync runs the read direction only: putting a comment on the timeline
    // is recoverable, resolving one on the review record is not.
    const decision = auto
      ? { ok: true, ids: [] }
      : nleCore.planTimelineResolves(comments, local, previousIds || [], { identity });
    const refusal = nleCore.describeResolveRefusal(decision);
    const resolvedIds = [];
    // Read through resolvableIds: a refusal's ids are the set that was refused.
    for (const commentId of nleCore.resolvableIds(decision)) {
      const patch = await fetch(`${baseUrl.replace(/\/$/, '')}/api/v1/comments/${commentId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ isResolved: true }),
      });
      if (!patch.ok) {
        const payload = await patch.json().catch(() => null);
        throw new Error((payload && payload.error) || `HTTP ${patch.status}`);
      }
      resolvedIds.push(commentId);
    }
    const remaining = nleCore.remainingCommentsAfterTimelineResolves(comments, resolvedIds);

    const plan = nleCore.reconcile(remaining, local, offsetSeconds);
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

    const after = timeline.GetMarkers() || {};
    const afterLocal = [];
    for (const [frame, info] of Object.entries(after)) {
      const parsed = parseCustomData(info.customData);
      afterLocal.push({
        id: String(frame),
        commentId: parsed?.ofId || nleCore.parseSentinel(info.note || ''),
        startSeconds: 0,
        durationSeconds: 0,
        name: info.name || '',
        comments: info.note || '',
      });
    }

    const syncedIds = nleCore.collectSyncedMarkerIds(afterLocal);
    if (auto && added === 0 && moved === 0 && removed === 0) {
      return { message: `Auto-sync on. No changes at ${new Date().toLocaleTimeString()}.`, syncedIds };
    }
    const parts = [`Synced. Added ${added}, moved ${moved}, removed ${removed}.`];
    if (!auto) parts.push(`Resolved ${resolvedIds.length}.`);
    parts.push(`Offset ${offsetSeconds.toFixed(2)}s${parsedOffset === null ? ' (assumed)' : ''}.`);
    if (refusal) parts.push(refusal);
    if (persistError) parts.push(`Sequence link was not saved: ${persistError}`);
    return { message: parts.join(' '), syncedIds };
  });
}

app.whenReady().then(() => createWindow());
