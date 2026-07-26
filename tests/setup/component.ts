// Per-file setup for the `component` Vitest project (jsdom environment).
//
// Two jobs:
//   1. Register the jest-dom matchers (`toBeVisible`, `toHaveAccessibleName`, ...).
//   2. Polyfill the browser APIs jsdom does not implement. Radix and the video
//      player reach for these on mount, so without them a render throws before
//      any assertion runs.
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

/**
 * Testing Library normally registers this itself, but only when it can see a
 * global `afterEach`. This repo runs Vitest without globals (every test file
 * imports what it needs), so the auto-cleanup never installs and each rendered
 * component stays mounted for the rest of the file: its effects keep running,
 * its window/document listeners keep firing and the next test sees them. Do it
 * explicitly here instead of in every test file.
 */
afterEach(() => {
  cleanup();
});

/**
 * jsdom has no CSS media query engine, so `window.matchMedia` is missing
 * entirely. Every query reports as not matching, which keeps components on
 * their desktop / no-preference code path.
 */
function createMediaQueryList(query: string): MediaQueryList {
  return {
    matches: false,
    media: query,
    onchange: null,
    // Deprecated aliases, still used by some libraries.
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  };
}

window.matchMedia = (query: string): MediaQueryList => createMediaQueryList(query);

/**
 * jsdom implements no layout, so it ships no `scrollIntoView`. Radix calls it
 * when it moves focus inside a scrollable list.
 */
Element.prototype.scrollIntoView = () => {};

/**
 * jsdom does not implement ResizeObserver. A stub that never fires is enough:
 * components only need the constructor not to throw, and any size-dependent
 * behaviour belongs in E2E anyway.
 */
class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

globalThis.ResizeObserver = ResizeObserverStub;

/**
 * Pointer capture is unimplemented in jsdom. Radix uses it for its
 * drag-to-select behaviour (Select, Slider, Menu) and throws without it.
 */
Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

/**
 * jsdom raises "Not implemented" for media playback. Resolve instead, so the
 * player hooks can await `play()`.
 */
HTMLMediaElement.prototype.play = () => Promise.resolve();
HTMLMediaElement.prototype.pause = () => {};

/**
 * Object URLs are used by the upload previews. jsdom leaves both of these
 * undefined.
 */
URL.createObjectURL = () => 'blob:openframe-test';
URL.revokeObjectURL = () => {};

/**
 * jsdom does not implement `navigator.sendBeacon`. The watch-progress hook
 * feature-detects it and silently skips its unload flush when it is missing, so
 * without this stub that whole branch would be untestable. Tests spy on it.
 */
Object.defineProperty(navigator, 'sendBeacon', {
  configurable: true,
  writable: true,
  value: () => true,
});

/**
 * `localStorage` goes missing on Node 24 and newer, and only `localStorage`.
 *
 * Node ships its own experimental Web Storage global now, which evaluates to
 * `undefined` unless the process was started with `--localstorage-file`. Vitest
 * leaves an already-present global alone when it copies jsdom's window onto
 * globalThis, so jsdom's implementation never lands and Node's empty one wins.
 * `sessionStorage` has no counterpart in Node and comes through untouched,
 * which is what makes the asymmetry visible.
 *
 * CI pins Node 22 and never sees this; a developer on a current Node does, as
 * every test in guest-gate.test.tsx failing on `localStorage.clear()`. The
 * guard means that when jsdom's own implementation is the one in scope, this
 * leaves it alone.
 */
function createMemoryStorage(): Storage {
  const entries = new Map<string, string>();

  return {
    get length() {
      return entries.size;
    },
    key(index: number) {
      return Array.from(entries.keys())[index] ?? null;
    },
    getItem(key: string) {
      return entries.get(String(key)) ?? null;
    },
    setItem(key: string, value: string) {
      entries.set(String(key), String(value));
    },
    removeItem(key: string) {
      entries.delete(String(key));
    },
    clear() {
      entries.clear();
    },
  };
}

if (typeof localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: createMemoryStorage(),
  });
}
