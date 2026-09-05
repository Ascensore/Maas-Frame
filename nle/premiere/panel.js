/* global require */

function nle() {
  return window.OpenFrameNle;
}

function el(id) {
  return document.getElementById(id);
}

function setStatus(message) {
  el('status').textContent = message;
}

function store() {
  return typeof localStorage !== 'undefined' ? localStorage : null;
}

const SETTINGS_KEY = 'of-panel-settings';

/**
 * Auto-sync has to survive a panel reload without a human retyping a token, so
 * connection details are persisted. Keep this to connection details only.
 */
function loadSettings() {
  const storage = store();
  if (!storage) return;
  try {
    const saved = JSON.parse(storage.getItem(SETTINGS_KEY) || '{}');
    if (typeof saved.baseUrl === 'string' && saved.baseUrl) el('baseUrl').value = saved.baseUrl;
    if (typeof saved.token === 'string' && saved.token) el('token').value = saved.token;
  } catch {
    // Ignore malformed storage and start from the defaults in the markup.
  }
}

function saveSettings() {
  const storage = store();
  if (!storage) return;
  try {
    storage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ baseUrl: el('baseUrl').value.trim(), token: el('token').value.trim() })
    );
  } catch {
    // Storage being unavailable must not stop a sync.
  }
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
  if (!tick) return null;
  if (typeof tick.seconds === 'number') return tick.seconds;
  if (typeof tick.sec === 'number') return tick.sec;
  if (typeof tick.ticks === 'number' && typeof tick.ticksPerSecond === 'number' && tick.ticksPerSecond) {
    return tick.ticks / tick.ticksPerSecond;
  }
  return null;
}

/**
 * `offsetOk` is false when the sequence start time could not be read. Writing
 * markers at a guessed offset of 0 puts every note an hour away from its comment
 * on a sequence starting at 01:00:00:00, so auto-sync refuses instead.
 */
/**
 * The host's own id for this sequence. Duplicating a sequence copies its name
 * and its markers but gets a fresh guid, so this is the only thing that tells an
 * original from a stale duplicate.
 *
 * Validated against an allowlist, not a denylist of known junk. A value that is
 * bogus but *the same for every sequence* -- '[object Promise]' from a
 * promise-valued guid, a stringified accessor, 'true' -- is worse than no id at
 * all: two different sequences would compare equal and the identity check would
 * declare them bound, overriding the marker heuristic that would have refused.
 * Anything not obviously an opaque id returns null and falls back to markers.
 *
 * Only `guid` is read. An ordinal like `sequence.id` would collide across
 * projects, and a collision here is a wrong-sequence write.
 */
function hostSequenceId(sequence) {
  // Only `guid`. An ordinal like `sequence.id` would collide across projects,
  // and a collision here is a wrong-sequence write.
  return nle().normalizeSequenceId(sequence?.guid ?? null);
}

async function sequenceMeta(sequence) {
  let offsetSeconds = 0;
  let offsetOk = false;
  let fps = 24;
  let dropFrame = false;
  let sequenceName = sequence.name || 'Untitled';
  try {
    const settings = await sequence.getSettings?.();
    const start = secondsFromTick(settings?.startTime ?? settings?.zeroPoint ?? null);
    if (start !== null) {
      offsetSeconds = start;
      offsetOk = true;
    }
    const rate = settings?.videoFrameRate;
    if (rate) {
      const frameDur = secondsFromTick(rate);
      if (frameDur !== null && frameDur > 0) fps = 1 / frameDur;
    }
    dropFrame = Boolean(
      settings?.dropFrame || String(settings?.videoDisplayFormat || '').toLowerCase().includes('drop')
    );
    if (typeof settings?.name === 'string' && settings.name.trim()) {
      sequenceName = settings.name.trim();
    }
  } catch {
    // Leave offsetOk false; a manual sync may still proceed at offset 0.
  }
  return {
    offsetSeconds,
    offsetOk,
    fps,
    dropFrame,
    sequenceName,
    sequenceId: hostSequenceId(sequence),
  };
}

/** Which version, if any, this sequence was last synced to. */
async function lookupVersionForSequence(baseUrl, token, sequenceId) {
  if (!sequenceId) return { ok: false, link: null };
  try {
    const { link } = await api(
      baseUrl,
      token,
      `/api/v1/sequence-link/lookup?nle=premiere&sequenceId=${encodeURIComponent(sequenceId)}`
    );
    return { ok: true, link };
  } catch {
    return { ok: false, link: null };
  }
}

/**
 * What the server has stored for the version we are syncing.
 *
 * Returns `{ ok: false }` on a failed read. Collapsing that into "no id stored"
 * would silently downgrade the exact identity check to the marker heuristic for
 * that tick -- reinstating the duplicate-sequence bug on any transient blip.
 */
async function storedSequenceId(baseUrl, token, versionId) {
  try {
    const { sequenceLink } = await api(
      baseUrl,
      token,
      `/api/v1/versions/${versionId}/sequence-link?nle=premiere`
    );
    return { ok: true, sequenceId: sequenceLink ? sequenceLink.sequenceId : null };
  } catch {
    return { ok: false, sequenceId: null };
  }
}

async function persistSequenceLink(baseUrl, token, versionId, meta) {
  const core = nle();
  const rational = core.fpsToRational(meta.fps);
  try {
    await api(baseUrl, token, `/api/v1/versions/${versionId}/sequence-link`, {
      method: 'PUT',
      body: JSON.stringify({
        nle: 'premiere',
        sequenceId: meta.sequenceId,
        sequenceName: String(meta.sequenceName || 'Untitled').slice(0, 200),
        startTimecode: core.secondsToSmpte(meta.offsetSeconds, meta.fps, meta.dropFrame),
        frameRateNum: rational.num,
        frameRateDen: rational.den,
        dropFrame: meta.dropFrame,
      }),
    });
    return null;
  } catch (error) {
    return error.message;
  }
}

function readMarkers(markerList) {
  const core = nle();
  const local = [];
  for (const marker of markerList) {
    const commentsText = marker.comments || marker.getComments?.() || '';
    local.push({
      id: String(local.length),
      commentId: core.parseSentinel(commentsText),
      startSeconds: secondsFromTick(marker.start) ?? 0,
      durationSeconds: secondsFromTick(marker.duration) ?? 0,
      name: marker.name || '',
      comments: commentsText,
      _marker: marker,
    });
  }
  return local;
}

/**
 * `auto` runs the read direction only. Putting a comment on the timeline is
 * recoverable; resolving one on the review record is not, so write-back stays a
 * deliberate click.
 */
async function syncMarkers({ auto = false } = {}) {
  const core = nle();
  const baseUrl = el('baseUrl').value.trim();
  const token = el('token').value.trim();
  const versionId = el('version').value;
  if (!token || !versionId) {
    if (!auto) setStatus('Token and version are required.');
    return false;
  }

  const ppro = require('premierepro');
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error('No active Premiere project');
  const sequence = await project.getActiveSequence();
  if (!sequence) throw new Error('No active sequence');
  const sequenceMarkers = await ppro.Markers.getMarkers(sequence);
  const existing = await sequenceMarkers.getMarkers();
  const meta = await sequenceMeta(sequence);

  if (auto && !meta.offsetOk) {
    setStatus(
      'Auto-sync paused: could not read the sequence start timecode. Sync manually to place markers at 00:00:00:00.'
    );
    return false;
  }

  const local = readMarkers(existing);
  const storageKey = core.syncedMarkerStorageKey(versionId);
  const storage = store();
  const previousIds = core.parseSyncedMarkerIds(storage ? storage.getItem(storageKey) : null);

  // Everything below writes: markers onto the sequence, the sequence link on the
  // server, and the record of which comments have markers. None of it may happen
  // unattended against a sequence that is not this version's, so the check comes
  // before the first network call rather than in the middle of the writes.
  const stored = await storedSequenceId(baseUrl, token, versionId);
  if (auto && !stored.ok) {
    // Treating a failed read as "no id stored" would drop us back to the marker
    // heuristic, which cannot tell a duplicate from the original.
    setStatus('Auto-sync paused: could not confirm which sequence this version is synced to.');
    return false;
  }
  const identity = { hostSequenceId: meta.sequenceId, linkedSequenceId: stored.sequenceId };
  if (auto && !core.autoSyncMayWrite(local, previousIds, identity)) {
    setStatus(
      'Auto-sync paused: this sequence is not the one this version is synced to. Press Sync markers to bind the sequence you are on.'
    );
    return false;
  }

  // Auto-sync is read-only, so it neither rebinds the sequence link nor resolves.
  const linkError = auto ? null : await persistSequenceLink(baseUrl, token, versionId, meta);
  const { comments } = await api(baseUrl, token, `/api/v1/versions/${versionId}/comments`);

  const resolvedIds = [];
  let refusal = null;
  if (!auto) {
    const decision = core.planTimelineResolves(comments, local, previousIds, { identity });
    refusal = core.describeResolveRefusal(decision);
    // Read through resolvableIds: a refusal's ids are the set that was refused.
    for (const commentId of core.resolvableIds(decision)) {
      await api(baseUrl, token, `/api/v1/comments/${commentId}`, {
        method: 'PATCH',
        body: JSON.stringify({ isResolved: true }),
      });
      resolvedIds.push(commentId);
    }
  }
  const remaining = core.remainingCommentsAfterTimelineResolves(comments, resolvedIds);
  const plan = core.reconcile(remaining, local, meta.offsetSeconds);

  let added = 0;
  let moved = 0;
  let removed = 0;

  // Every executeTransaction pushes an undo entry. Opening one for an empty plan
  // used to cost the editor a junk undo step per sync, which a poll would make
  // constant.
  if (!core.planIsEmpty(plan)) {
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
  }

  if (storage) {
    const after = await sequenceMarkers.getMarkers();
    storage.setItem(storageKey, JSON.stringify(core.collectSyncedMarkerIds(readMarkers(after))));
  }

  if (auto && added === 0 && moved === 0 && removed === 0) {
    setStatus(`Auto-sync on. No changes at ${new Date().toLocaleTimeString()}.`);
    return true;
  }

  const parts = [`Synced. Added ${added}, moved ${moved}, removed ${removed}.`];
  if (!auto) parts.push(`Resolved ${resolvedIds.length}.`);
  parts.push(`Offset ${meta.offsetSeconds.toFixed(2)}s${meta.offsetOk ? '' : ' (assumed)'}.`);
  if (refusal) parts.push(refusal);
  if (linkError) parts.push(`Sequence link was not saved: ${linkError}`);
  setStatus(parts.join(' '));
  return true;
}

/**
 * Follows the editor: when a different sequence comes to the front, ask the
 * server which version it belongs to and select it, so auto-sync keeps working
 * without anyone touching the dropdown. An unknown sequence selects nothing and
 * the binding gate then pauses, rather than syncing it to whatever was picked
 * last.
 */
let lastBoundSequenceId = null;

async function rebindToActiveSequence() {
  const baseUrl = el('baseUrl').value.trim();
  const token = el('token').value.trim();
  if (!token) return;

  const ppro = require('premierepro');
  const project = await ppro.Project.getActiveProject();
  const sequence = project ? await project.getActiveSequence() : null;
  const sequenceId = sequence ? hostSequenceId(sequence) : null;
  if (!sequenceId || sequenceId === lastBoundSequenceId) return;

  const result = await lookupVersionForSequence(baseUrl, token, sequenceId);
  // Latch only once the server has actually answered. Latching first turns a
  // network blip into "not linked yet" for as long as this sequence stays open.
  if (!result.ok) return;
  lastBoundSequenceId = sequenceId;

  const link = result.link;
  if (!link) {
    setStatus('This sequence is not linked to a version yet. Pick one and press Sync markers.');
    return;
  }
  const select = el('version');
  const previousVersionId = select.value;
  const known = Array.from(select.options).some((option) => option.value === link.versionId);
  if (!known) {
    select.innerHTML += `<option value="${link.versionId}">${link.videoTitle} v${link.versionNumber}</option>`;
  }
  select.value = link.versionId;
  setStatus(`Following ${link.videoTitle} v${link.versionNumber} for this sequence.`);
  // The live stream subscribes to one version, so a rebind has to move it.
  if (previousVersionId !== link.versionId) restartLiveStream();
}

/**
 * Phase 3 accelerator: hold the live stream open and sync the moment a comment
 * changes, instead of waiting out the poll.
 *
 * Read with `fetch` rather than `EventSource` because the endpoint authenticates
 * a Bearer header and EventSource cannot send one; the alternative would put the
 * token in the query string, where it lands in server and proxy logs.
 *
 * EventSource also reconnects for free, and this does not: the route closes
 * every stream at its maxDuration, so a single read loop buys ~25 seconds of
 * acceleration and then goes quiet for the rest of the session. Hence the
 * reconnect loop below.
 *
 * A generation counter, not the AbortController, is what stops it. When the host
 * has no AbortController the controller is null, and `while (liveAbort === controller)`
 * would then be `null === null` -- true forever, with every toggle stacking
 * another live reader.
 */
let liveGeneration = 0;
let liveAbort = null;

function closeLiveStream() {
  liveGeneration += 1;
  if (liveAbort) {
    try {
      liveAbort.abort();
    } catch {
      // Already aborted, or the host has no working AbortController.
    }
  }
  liveAbort = null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One connection. Returns 'ok', 'error', or 'not-listening'. */
async function readLiveStreamOnce(generation, baseUrl, versionId, token) {
  const controller = typeof AbortController === 'undefined' ? null : new AbortController();
  liveAbort = controller;
  try {
    const response = await fetch(`${baseUrl}/api/v1/versions/${versionId}/comments/live`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller ? controller.signal : undefined,
    });
    const reader = response.ok && response.body ? response.body.getReader() : null;
    if (!reader) return 'error';

    const decoder = new TextDecoder();
    let buffer = '';
    while (generation === liveGeneration) {
      const { done, value } = await reader.read();
      if (done) return 'ok';
      buffer += decoder.decode(value, { stream: true });
      const parsed = nle().parseSseFrames(buffer);
      buffer = parsed.rest;
      for (const event of parsed.events) {
        if (event.event === 'ready') {
          // The deployment says it cannot push. Reconnecting would burn a
          // request every 25s to receive nothing; the poll is the delivery
          // mechanism there.
          try {
            if (JSON.parse(event.data).listening === false) {
              await reader.cancel().catch(() => undefined);
              return 'not-listening';
            }
          } catch {
            // Unreadable ready payload: treat the stream as usable.
          }
          continue;
        }
        if (event.event !== 'comments') continue;
        if (!autoSyncEnabled() || syncInFlight) continue;
        scheduleAutoSync(0);
      }
    }
    await reader.cancel().catch(() => undefined);
    return 'ok';
  } catch {
    return 'error';
  } finally {
    if (liveAbort === controller) liveAbort = null;
  }
}

async function openLiveStream() {
  closeLiveStream();
  const generation = liveGeneration;
  const baseUrl = el('baseUrl').value.trim().replace(/\/$/, '');
  const versionId = el('version').value;
  const token = el('token').value.trim();
  if (!versionId || !token) return;

  let failures = 0;
  while (generation === liveGeneration && autoSyncEnabled()) {
    const outcome = await readLiveStreamOnce(generation, baseUrl, versionId, token);
    if (generation !== liveGeneration) return;
    if (outcome === 'not-listening') return;
    failures = outcome === 'ok' ? 0 : failures + 1;
    if (failures > 0) await delay(nle().nextPollDelayMs(failures));
  }
}

/** The stream is per version, so a rebind has to move it. */
function restartLiveStream() {
  if (!autoSyncEnabled()) return;
  void openLiveStream();
}

let autoTimer = null;
let autoFailures = 0;
let syncInFlight = false;

function autoSyncEnabled() {
  return Boolean(el('auto').checked);
}

function stopAutoSync() {
  if (autoTimer) clearTimeout(autoTimer);
  autoTimer = null;
  autoFailures = 0;
}

function scheduleAutoSync(delayMs) {
  if (autoTimer) clearTimeout(autoTimer);
  if (!autoSyncEnabled()) return;
  autoTimer = setTimeout(runAutoSync, delayMs ?? nle().nextPollDelayMs(autoFailures));
}

async function runAutoSync() {
  if (!autoSyncEnabled()) return;
  // A hidden panel is not worth polling for, and a sync already running must not
  // be re-entered: both halves of a read-then-write would race.
  const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
  if (syncInFlight || hidden) {
    scheduleAutoSync(nle().AUTO_SYNC_BASE_MS);
    return;
  }
  syncInFlight = true;
  try {
    await rebindToActiveSequence().catch(() => undefined);
    // A paused tick is not a success: if a network error preceded it, the
    // backoff it earned has to survive.
    if (await syncMarkers({ auto: true })) autoFailures = 0;
  } catch (error) {
    autoFailures += 1;
    setStatus(`Auto-sync error (retry ${autoFailures}): ${error.message}`);
  } finally {
    syncInFlight = false;
    scheduleAutoSync();
  }
}

async function loadProjects() {
  const baseUrl = el('baseUrl').value.trim();
  const token = el('token').value.trim();
  const { projects } = await api(baseUrl, token, '/api/v1/projects');
  const select = el('project');
  select.innerHTML = projects
    .map((project) => `<option value="${project.id}">${project.name}</option>`)
    .join('');
  if (projects[0]) await loadVersions(projects[0].id);
}

async function loadVersions(projectId) {
  const baseUrl = el('baseUrl').value.trim();
  const token = el('token').value.trim();
  const { videos } = await api(baseUrl, token, `/api/v1/projects/${projectId}/videos`);
  const select = el('version');
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

loadSettings();

for (const id of ['baseUrl', 'token']) {
  el(id).addEventListener('change', saveSettings);
}
el('load').addEventListener('click', () => {
  saveSettings();
  loadProjects().catch((error) => setStatus(error.message));
});
el('version').addEventListener('change', () => {
  restartLiveStream();
});
el('project').addEventListener('change', (event) => {
  loadVersions(event.target.value).catch((error) => setStatus(error.message));
});
el('sync').addEventListener('click', () => {
  if (syncInFlight) return;
  syncInFlight = true;
  saveSettings();
  syncMarkers()
    .catch((error) => setStatus(error.message))
    .finally(() => {
      syncInFlight = false;
    });
});
el('auto').addEventListener('change', () => {
  if (autoSyncEnabled()) {
    saveSettings();
    setStatus('Auto-sync on. Markers follow the web app; resolving stays on Sync markers.');
    void openLiveStream();
    scheduleAutoSync(0);
  } else {
    stopAutoSync();
    closeLiveStream();
    setStatus('Auto-sync off.');
  }
});

// Rebind the moment the editor brings a different sequence forward, rather than
// waiting up to a poll interval to notice.
try {
  const ppro = require('premierepro');
  const events = ppro.EventManager ?? ppro.Constants?.EventManager;
  const activated = ppro.Constants?.SequenceEvent?.ACTIVATED ?? 'activeSequenceChanged';
  if (events?.addGlobalEventListener) {
    events.addGlobalEventListener(activated, () => {
      rebindToActiveSequence().catch(() => undefined);
    });
  }
} catch {
  // No event surface on this host; the poll still rebinds each tick.
}
