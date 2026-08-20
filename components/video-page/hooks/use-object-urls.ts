'use client';

import { useEffect, useMemo } from 'react';

/**
 * Blob URLs for a list of staged files, revoked as soon as a file leaves the list.
 *
 * Calling `URL.createObjectURL` inline in the markup mints a new URL on every
 * render and never releases any of them, which a five-screenshot preview grid
 * turns into a steady leak.
 */
export function useObjectUrls(files: File[]): string[] {
  const urls = useMemo(() => files.map((file) => URL.createObjectURL(file)), [files]);

  useEffect(() => {
    return () => {
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [urls]);

  return urls;
}
