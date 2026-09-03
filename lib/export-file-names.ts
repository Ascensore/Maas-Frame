const SAFE_EXTENSION = /^[a-z0-9]{1,10}$/i;

function extensionFromUrl(url: string, fallback: string): string {
  const withoutQuery = url.split('?')[0] ?? url;
  const baseName = withoutQuery.slice(withoutQuery.lastIndexOf('/') + 1);
  const dotIndex = baseName.lastIndexOf('.');
  if (dotIndex <= 0) return fallback;
  const ext = baseName.slice(dotIndex + 1);
  return SAFE_EXTENSION.test(ext) ? `.${ext.toLowerCase()}` : fallback;
}

export function sanitizeDownloadFileName(value: string): string {
  const sanitized = value
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return sanitized.length > 0 ? sanitized : 'file';
}

export function uniqueDownloadFileName(baseName: string, usedNames: Set<string>): string {
  if (!usedNames.has(baseName)) {
    usedNames.add(baseName);
    return baseName;
  }

  const dotIndex = baseName.lastIndexOf('.');
  const stem = dotIndex > 0 ? baseName.slice(0, dotIndex) : baseName;
  const ext = dotIndex > 0 ? baseName.slice(dotIndex) : '';

  let counter = 2;
  while (usedNames.has(`${stem}-${counter}${ext}`)) {
    counter += 1;
  }
  const unique = `${stem}-${counter}${ext}`;
  usedNames.add(unique);
  return unique;
}

export function buildVersionFileName(
  videoIndex: number,
  videoTitle: string,
  version: { versionNumber: number; versionLabel: string | null; originalUrl: string }
): string {
  const label = version.versionLabel?.trim() || `v${version.versionNumber}`;
  const stem = sanitizeDownloadFileName(
    `${String(videoIndex).padStart(2, '0')}-${videoTitle}-${label}`
  );
  const ext = extensionFromUrl(version.originalUrl, '.mp4');
  return `${stem}${ext}`;
}
