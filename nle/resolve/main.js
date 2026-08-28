const { app } = require('electron');

function nearestResolveColor(hex) {
  const palette = [
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
  const value = hex.replace('#', '');
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  let best = palette[0];
  let bestDist = Infinity;
  for (const color of palette) {
    const dist = (color.r - r) ** 2 + (color.g - g) ** 2 + (color.b - b) ** 2;
    if (dist < bestDist) {
      best = color;
      bestDist = dist;
    }
  }
  return best.name;
}

function parseCustomData(raw) {
  if (!raw || typeof raw !== 'string' || !raw.startsWith('{')) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function sequenceStartSeconds(timeline, fps) {
  try {
    const tc = timeline.GetStartTimecode?.() || timeline.GetSetting?.('timelineStartTimecode');
    if (!tc || typeof tc !== 'string') return 0;
    const match = /^(\d{1,3}):([0-5]\d):([0-5]\d)[:;](\d{1,3})$/.exec(tc.trim());
    if (!match) return 0;
    return (
      Number(match[1]) * 3600 +
      Number(match[2]) * 60 +
      Number(match[3]) +
      Number(match[4]) / Math.max(1, fps)
    );
  } catch {
    return 0;
  }
}

async function createWindow() {
  const { BrowserWindow, ipcMain } = require('electron');
  const path = require('path');
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
    const comments = (payload.data?.comments ?? []).filter(
      (comment) => !comment.parentId && !comment.isResolved
    );

    const fps = Number(timeline.GetSetting('timelineFrameRate')) || 24;
    const offsetSeconds = sequenceStartSeconds(timeline, fps);
    const existing = timeline.GetMarkers() || {};
    const byOfId = new Map();
    for (const [frame, info] of Object.entries(existing)) {
      const parsed = parseCustomData(info.customData);
      if (parsed?.ofId) byOfId.set(parsed.ofId, { frame: Number(frame), info });
    }

    let added = 0;
    let skipped = 0;
    for (const comment of comments) {
      const frame = Math.round((comment.timestamp + offsetSeconds) * fps);
      const duration =
        comment.timestampEnd && comment.timestampEnd > comment.timestamp
          ? Math.max(1, Math.round((comment.timestampEnd - comment.timestamp) * fps))
          : 1;
      const customData = JSON.stringify({ ofId: comment.id, versionId });
      const color = nearestResolveColor(comment.tag?.color);
      const name = (comment.content || 'Note').slice(0, 40);
      const note = comment.content || '';
      if (byOfId.has(comment.id)) {
        skipped += 1;
        continue;
      }
      const lookup = timeline.GetMarkerByCustomData?.(customData);
      if (lookup) {
        skipped += 1;
        continue;
      }
      const ok = timeline.AddMarker(frame, color, name, note, duration, customData);
      if (ok) added += 1;
    }
    return `Synced ${added} new markers (${skipped} already present).`;
  });
}

app.whenReady().then(() => createWindow());
