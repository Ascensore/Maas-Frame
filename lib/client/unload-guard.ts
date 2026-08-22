'use client';

/**
 * Downloads that we pull through fetch() live inside the page: closing the tab
 * (or reloading) throws away every byte received so far and the browser gives no
 * warning, because as far as it knows nothing is downloading. While one of those
 * is in flight we register a beforeunload handler so the user gets the native
 * "leave site?" dialog instead of silently losing the transfer.
 *
 * Plain navigation downloads (the `download` attribute / a redirect to the CDN)
 * are owned by the browser and survive a tab close, so they must NOT be guarded.
 */

let activeCount = 0;

function handleBeforeUnload(event: BeforeUnloadEvent) {
  event.preventDefault();
  // Legacy browsers only show the dialog when returnValue is set; the string
  // itself is ignored, every browser shows its own wording.
  event.returnValue = '';
}

/** Registers the guard and returns a release function. Safe to call again while
 * another download is already guarded — the listener is reference counted and
 * only detaches once the last one releases. Releasing twice is a no-op. */
export function beginUnloadGuard(): () => void {
  if (typeof window === 'undefined') return () => {};

  if (activeCount === 0) {
    window.addEventListener('beforeunload', handleBeforeUnload);
  }
  activeCount += 1;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeCount -= 1;
    if (activeCount === 0) {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    }
  };
}

/** Test helper: number of downloads currently holding the guard. */
export function unloadGuardCount(): number {
  return activeCount;
}
