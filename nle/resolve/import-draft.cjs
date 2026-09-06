const path = require('path');
const fs = require('fs/promises');
const native = require('./native-edit.cjs');

module.exports = async function importDraft({ resolve, chooseDirectory, baseUrl, token, commentId }) {
  if (!resolve) throw new Error('Resolve scripting is unavailable. Install the WorkflowIntegration module supplied with Resolve Studio.');
  if (!commentId || !token) throw new Error('Enter a comment ID and API token.');
  const manager = resolve.GetProjectManager();
  const project = manager.GetCurrentProject();
  if (!project) throw new Error('Open a Resolve project first.');
  const projectId = project.GetUniqueId();
  const response = await native.authorizedFetch(`${baseUrl.replace(/\/$/, '')}/api/v1/comments/${encodeURIComponent(commentId)}/edit-draft`, token);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  const draft = native.validateDraft(payload.data?.draft, commentId);
  for (let i = 1; i <= project.GetTimelineCount(); i++) {
    if (project.GetTimelineByIndex(i)?.GetName() === draft.name) return { message: 'This AI draft is already imported.' };
  }
  const root = await chooseDirectory();
  if (!root) return { message: 'Import canceled.' };
  const directory = await fs.mkdtemp(path.join(root, `openframe-${draft.id}-`));
  for (const media of draft.media) {
    const target = path.join(directory, media.fileName);
    await native.downloadChunks(
      (start, end, etag) => native.authorizedFetch(`${baseUrl.replace(/\/$/, '')}${media.downloadPath}`, token, { Range: `bytes=${start}-${end}`, ...(etag ? { 'If-Range': etag } : {}) }),
      (bytes, append) => fs.writeFile(target, Buffer.from(bytes), { flag: append ? 'a' : 'w' })
    );
  }
  const filename = path.join(directory, 'draft.xml');
  await fs.writeFile(filename, native.relocateXml(draft, directory), 'utf8');
  if (manager.GetCurrentProject()?.GetUniqueId() !== projectId) throw new Error('The open project changed during download. Select the original project and import again.');
  const timeline = project.GetMediaPool().ImportTimelineFromFile(filename, { timelineName: draft.name, importSourceClips: true, sourceClipsPath: directory });
  if (!timeline) throw new Error(`Resolve could not import the timeline. The package is saved at ${filename}.`);
  project.SetCurrentTimeline(timeline);
  return { message: `Imported a new AI draft timeline. Media: ${directory}\nGraphics are rendered overlays; cuts and B-roll remain editable.` };
};
