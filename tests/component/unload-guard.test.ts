import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { beginUnloadGuard, unloadGuardCount } from '@/lib/client/unload-guard';

let addSpy: MockInstance<typeof window.addEventListener>;
let removeSpy: MockInstance<typeof window.removeEventListener>;

/** True when something cancelled the unload, which is what makes the browser
 * show its "leave site?" dialog. */
function unloadWasBlocked(): boolean {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

function listenerCalls(spy: MockInstance<typeof window.addEventListener>): number {
  return spy.mock.calls.filter(([type]) => type === 'beforeunload').length;
}

beforeEach(() => {
  addSpy = vi.spyOn(window, 'addEventListener');
  removeSpy = vi.spyOn(window, 'removeEventListener');
});

afterEach(() => {
  vi.restoreAllMocks();
  // A leaked guard would block the unload for the rest of the session, so a
  // test that leaves one behind must fail here rather than in the next test.
  expect(unloadGuardCount()).toBe(0);
});

describe('beginUnloadGuard', () => {
  it('cancels the unload while a download holds it', () => {
    const release = beginUnloadGuard();
    const blocked = unloadWasBlocked();
    release();

    expect(blocked).toBe(true);
  });

  it('lets the page go once the download is released', () => {
    beginUnloadGuard()();

    expect(unloadWasBlocked()).toBe(false);
  });

  it('keeps the listener until the last concurrent download releases', () => {
    const releaseA = beginUnloadGuard();
    const releaseB = beginUnloadGuard();
    expect(listenerCalls(addSpy)).toBe(1);

    releaseA();
    const stillBlocked = unloadWasBlocked();
    releaseB();

    expect(stillBlocked).toBe(true);
    expect(listenerCalls(removeSpy)).toBe(1);
    expect(unloadWasBlocked()).toBe(false);
  });

  // The download hook releases from a finally block, and a caller could hold
  // the returned function longer; a double release must not drop a guard
  // another download still holds.
  it('ignores a second release', () => {
    const releaseA = beginUnloadGuard();
    const releaseB = beginUnloadGuard();

    releaseA();
    releaseA();
    const stillBlocked = unloadWasBlocked();
    releaseB();

    expect(stillBlocked).toBe(true);
  });
});
