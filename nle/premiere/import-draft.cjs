const native = require('./native-edit.cjs');
const editableGraphics = require('./editable-graphics.cjs');

module.exports = async function importDraft({ ppro, storage, baseUrl, token, commentId, progress, nativeTitles = false }) {
  if (!commentId || !token) throw new Error('Enter a comment ID and API token.');
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error('Open a Premiere project first.');
  const projectId = String(project.guid);
  const response = await native.authorizedFetch(`${baseUrl.replace(/\/$/, '')}/api/v1/comments/${encodeURIComponent(commentId)}/edit-draft`, token);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  const draft = native.validateDraft(payload.data?.draft, commentId);
  const sequences = await project.getSequences();
  if (sequences.some(s => s.name === draft.name)) return 'This AI draft is already imported.';
  const root = await storage.localFileSystem.getFolder();
  if (!root) return 'Import canceled.';
  const directory = await root.createFolder(`openframe-${draft.id}-${Date.now()}`);
  for (const media of draft.media) {
    progress(`Downloading ${media.title}…`);
    const target = await directory.createFile(media.fileName, { overwrite: false });
    await native.downloadChunks(
      (start, end, etag) => native.authorizedFetch(`${baseUrl.replace(/\/$/, '')}${media.downloadPath}`, token, { Range: `bytes=${start}-${end}`, ...(etag ? { 'If-Range': etag } : {}) }),
      (bytes, append) => target.write(bytes, { format: storage.formats.binary, append })
    );
  }
  const file = await directory.createFile('draft.xml', { overwrite: false });
  await file.write(native.relocateXml(draft, directory.nativePath));
  if (String((await ppro.Project.getActiveProject())?.guid) !== projectId) throw new Error('The open project changed during download. Select the original project and import again.');
  const imported = await project.importFiles([file.nativePath], true, await project.getInsertionBin(), false);
  if (!imported) throw new Error(`Premiere could not import the timeline. The package is saved at ${file.nativePath}.`);
  const after = await project.getSequences();
  if (!after.some(s => s.name === draft.name)) throw new Error('Premiere imported the XML but did not create the expected sequence. Check its import report.');
  let titleNote='';
  if(nativeTitles && draft.graphics?.length) {
    try {
      progress('Choose a folder containing OpenFrame MOGRT templates…');
      const folder=await storage.localFileSystem.getFolder();
      if(folder) { await editableGraphics({ppro,project,sequence:after.find(s=>s.name===draft.name),draft,folder}); titleNote=' Editable MOGRT titles added; compare with the reviewed draft.'; }
    } catch(error) { titleNote=' Editable titles failed; rendered graphics retained. '+error.message; }
  }
  return `Imported a new AI draft sequence. Keep the media folder at ${directory.nativePath}.${titleNote}`;
};
