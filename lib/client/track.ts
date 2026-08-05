/**
 * Reports a click on a call to action.
 *
 * `sendBeacon` rather than a plain fetch because a CTA click navigates away
 * immediately, and a request still in flight when the page unloads is cancelled.
 *
 * Everything here is best effort. This is the only funnel event that depends on
 * the browser cooperating, which is also why nothing downstream divides by it:
 * the visitor and signup counts either side of it are recorded server-side.
 */
export function trackCtaClick(): void {
  if (typeof navigator === 'undefined') return;

  const payload = JSON.stringify({ name: 'cta_clicked' });

  try {
    if (typeof navigator.sendBeacon === 'function') {
      navigator.sendBeacon('/api/events', new Blob([payload], { type: 'application/json' }));
      return;
    }

    void fetch('/api/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // A click must never fail because measurement did.
  }
}
