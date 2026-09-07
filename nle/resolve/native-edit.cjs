/* Shared draft download protocol. Kept byte-identical in both standalone panel folders. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OpenFrameNative = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const CHUNK = 16 * 1024 * 1024;
  function validateDraft(value, commentId) {
    if (!value || value.version !== 1 || !/^[a-zA-Z0-9_-]+$/.test(value.id) || typeof value.xml !== 'string' || !Array.isArray(value.media) || !value.media.length || value.media.length > 200) throw new Error('Invalid editing package');
    const names = new Set();
    for (const media of value.media) {
      if (!/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(media.fileName) || names.has(media.fileName)) throw new Error('Invalid or duplicate media filename');
      names.add(media.fileName);
      if (media.downloadPath !== `/api/v1/comments/${encodeURIComponent(commentId)}/edit-draft?source=${encodeURIComponent(media.versionId)}`) throw new Error('Unexpected media download location');
    }
    return value;
  }
  function relocateXml(draft, directory) {
    const path = directory.replace(/\\/g, '/').replace(/\/$/, '');
    if (!path.startsWith('/') && !/^[A-Za-z]:\//.test(path)) throw new Error('Choose an absolute media folder');
    const encoded = path.split('/').map(encodeURIComponent).join('/').replace(/^([A-Za-z])%3A/, '$1:');
    const prefix = 'file://localhost' + (encoded.startsWith('/') ? '' : '/') + encoded + '/';
    return draft.xml.replace(/file:\/\/localhost\/OPENFRAME_MEDIA\//g, prefix);
  }
  async function downloadChunks(fetchRange, writeChunk) {
    let offset = 0;
    let total = null;
    let etag = null;
    do {
      const response = await fetchRange(offset, offset + CHUNK - 1, etag);
      if (response.status !== 206) throw new Error('The media server must support partial downloads (HTTP ' + response.status + ')');
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
      if (!match || Number(match[1]) !== offset || Number(match[2]) < offset || Number(match[2]) >= Number(match[3]) || Number(match[2]) - offset + 1 > CHUNK) throw new Error('Invalid media download range');
      if (total !== null && total !== Number(match[3])) throw new Error('The source changed during download');
      total = Number(match[3]);
      const nextEtag = response.headers.get('etag');
      if (etag && nextEtag !== etag) throw new Error('The source changed during download');
      etag = nextEtag;
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength !== Number(match[2]) - offset + 1) throw new Error('Incomplete media download');
      await writeChunk(bytes, offset > 0);
      offset += bytes.byteLength;
    } while (offset < total);
    return offset;
  }
  async function authorizedFetch(url, token, headers) {
    for (let retry = 0; retry < 4; retry++) {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, ...headers }, redirect: 'error' });
      if (response.status !== 429 || retry === 3) return response;
      const seconds = Number(response.headers.get('retry-after'));
      await new Promise(resolve => setTimeout(resolve, (Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 60) : 10) * 1000));
    }
  }
  async function runFeedback(baseUrl,token,commentId,nle,sequenceId) {
    if(!commentId || !sequenceId || !token) throw new Error('Enter a comment ID and sync the open timeline first.');
    const response=await fetch(baseUrl.replace(/\/$/,'')+'/api/v1/comments/'+encodeURIComponent(commentId)+'/edit-draft',{
      method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},redirect:'error',body:JSON.stringify({nle,sequenceId})
    });
    const payload=await response.json(); if(!response.ok) throw new Error(payload.error || 'Could not execute feedback');
    return payload.data.task;
  }
  async function feedbackStatus(baseUrl,token,commentId) {
    const response=await authorizedFetch(baseUrl.replace(/\/$/,'')+'/api/v1/comments/'+encodeURIComponent(commentId)+'/edit-draft?status=1',token);
    const payload=await response.json();if(!response.ok) throw new Error(payload.error || 'Could not read draft status');return payload.data.task;
  }
  return { validateDraft, relocateXml, downloadChunks, authorizedFetch, runFeedback, feedbackStatus };
});
