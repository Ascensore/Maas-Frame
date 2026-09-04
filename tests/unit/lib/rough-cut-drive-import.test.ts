import { describe, expect, it, vi } from 'vitest';
import {
  classifyDriveImportUrl,
  downloadPublicDriveFile,
  driveImportRefusalMessage,
  extractDriveConfirmToken,
  isDriveVirusScanHtml,
  looksLikeVideoBytes,
} from '@/lib/rough-cut/drive-import';

const FILE_ID = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms';
const FILE_URL = `https://drive.google.com/file/d/${FILE_ID}/view?usp=sharing`;

describe('classifyDriveImportUrl', () => {
  it('accepts a public Drive file link', () => {
    expect(classifyDriveImportUrl(FILE_URL)).toEqual({ ok: true, fileId: FILE_ID });
    expect(classifyDriveImportUrl(`https://drive.google.com/open?id=${FILE_ID}`)).toEqual({
      ok: true,
      fileId: FILE_ID,
    });
  });

  it('rejects empty, non-Drive, folder, and malformed links', () => {
    expect(classifyDriveImportUrl('')).toEqual({ ok: false, reason: 'empty' });
    expect(classifyDriveImportUrl('https://example.com/file.mp4')).toEqual({
      ok: false,
      reason: 'not-drive',
    });
    expect(classifyDriveImportUrl(`https://drive.google.com/drive/folders/${FILE_ID}`)).toEqual({
      ok: false,
      reason: 'folder',
    });
    expect(classifyDriveImportUrl('https://drive.google.com/file/d/short/view')).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(classifyDriveImportUrl('not a url')).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('driveImportRefusalMessage', () => {
  it('tells the caller folders cannot be imported', () => {
    expect(driveImportRefusalMessage('folder')).toContain('folders cannot be imported');
    expect(driveImportRefusalMessage('not-drive')).toContain('Only Google Drive');
  });
});

describe('isDriveVirusScanHtml', () => {
  it('detects the Google interstitial and ignores binary samples', () => {
    expect(isDriveVirusScanHtml('<html><body>Google Drive virus scan warning</body></html>')).toBe(
      true
    );
    expect(isDriveVirusScanHtml('<!doctype html><a class="uc-download-link">Download</a>')).toBe(
      true
    );
    expect(isDriveVirusScanHtml('%PDF-1.4')).toBe(false);
    expect(isDriveVirusScanHtml('ftypisom')).toBe(false);
  });
});

describe('extractDriveConfirmToken', () => {
  it('reads confirm from a query string or a hidden input', () => {
    expect(
      extractDriveConfirmToken('href="https://drive.google.com/uc?export=download&confirm=AbC9"')
    ).toBe('AbC9');
    expect(extractDriveConfirmToken('<input name="confirm" value="Zz11">')).toBe('Zz11');
  });
});

describe('looksLikeVideoBytes', () => {
  it('accepts MP4 ftyp and rejects HTML', () => {
    const mp4 = new Uint8Array([0, 0, 0, 32, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    expect(looksLikeVideoBytes(mp4)).toBe(true);
    expect(looksLikeVideoBytes(new TextEncoder().encode('<html>virus scan</html>'))).toBe(false);
  });
});

describe('downloadPublicDriveFile', () => {
  it('returns the file after a virus-scan HTML page', async () => {
    const html = '<html>virus scan warning confirm=AbC9</html>';
    const bytes = new Uint8Array([0, 0, 0, 32, 0x66, 0x74, 0x79, 0x70]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(html, { headers: { 'content-type': 'text/html' } }))
      .mockResolvedValueOnce(
        new Response(bytes, {
          headers: {
            'content-type': 'video/mp4',
            'content-disposition': 'attachment; filename="clip.mp4"',
          },
        })
      );

    const result = await downloadPublicDriveFile(FILE_ID, fetchImpl);
    expect(result.fileName).toBe('clip.mp4');
    expect(result.contentType).toBe('video/mp4');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain('confirm=AbC9');
  });

  it('throws when Google keeps serving the confirmation page', async () => {
    const html = '<html>virus scan warning download anyway</html>';
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(html, { headers: { 'content-type': 'text/html' } }));

    await expect(downloadPublicDriveFile(FILE_ID, fetchImpl)).rejects.toThrow(
      /confirmation page instead of the file/
    );
  });
});
