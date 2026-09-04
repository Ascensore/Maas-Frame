import { describe, expect, it } from 'vitest';
import {
  applyCameraRole,
  applyClipOrder,
  assemblyFromSnapshot,
  parseCameraRoles,
  parseClipOrder,
  parseWideCameraRole,
  snapshotWithAssembly,
} from '@/lib/rough-cut/assembly';
import { BUILTIN_ROUGH_CUT_PROFILE } from '@/lib/rough-cut/profile';

const ALLOWED = new Set(['a', 'b', 'c']);

describe('parseClipOrder', () => {
  it('returns null for a missing or empty list', () => {
    expect(parseClipOrder(undefined, ALLOWED)).toEqual({ ok: true, value: null });
    expect(parseClipOrder([], ALLOWED)).toEqual({ ok: true, value: null });
  });

  it('appends folder clips that the caller omitted, in allowed-set order', () => {
    const parsed = parseClipOrder(['c', 'a'], ALLOWED);
    expect(parsed).toEqual({ ok: true, value: ['c', 'a', 'b'] });
  });

  it('rejects an unknown id and a duplicate', () => {
    expect(parseClipOrder(['a', 'nope'], ALLOWED).ok).toBe(false);
    expect(parseClipOrder(['a', 'a'], ALLOWED).ok).toBe(false);
    expect(parseClipOrder('a', ALLOWED).ok).toBe(false);
  });
});

describe('parseCameraRoles', () => {
  it('uppercases names and drops an empty object', () => {
    expect(parseCameraRoles({ a: ' wide ' }, ALLOWED)).toEqual({
      ok: true,
      value: { a: 'WIDE' },
    });
    expect(parseCameraRoles({}, ALLOWED)).toEqual({ ok: true, value: null });
  });

  it('rejects a video that is not in the folder', () => {
    expect(parseCameraRoles({ nope: 'A' }, ALLOWED).ok).toBe(false);
    expect(parseCameraRoles({ a: '' }, ALLOWED).ok).toBe(false);
  });
});

describe('parseWideCameraRole', () => {
  it('accepts a named safety camera and nothing else', () => {
    expect(parseWideCameraRole(' wide ')).toEqual({ ok: true, value: 'WIDE' });
    expect(parseWideCameraRole(null)).toEqual({ ok: true, value: null });
    expect(parseWideCameraRole('')).toEqual({ ok: false, error: expect.any(String) });
    expect(parseWideCameraRole(1).ok).toBe(false);
  });
});

describe('applyClipOrder', () => {
  it('reorders known ids and keeps leftovers in their original order', () => {
    const clips = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(applyClipOrder(clips, ['c', 'a']).map((clip) => clip.id)).toEqual(['c', 'a', 'b']);
  });
});

describe('applyCameraRole', () => {
  it('uses the override when present', () => {
    expect(applyCameraRole('a', 'CAM', { a: 'A' })).toBe('A');
    expect(applyCameraRole('a', 'CAM', null)).toBe('CAM');
    expect(applyCameraRole('b', 'CAM', { a: 'A' })).toBe('CAM');
  });
});

describe('snapshotWithAssembly', () => {
  it('stores clip order and camera names next to the profile fields the worker already reads', () => {
    const snapshot = snapshotWithAssembly(BUILTIN_ROUGH_CUT_PROFILE, {
      clipOrder: ['b', 'a'],
      cameraRoles: { a: 'A', b: 'WIDE' },
      wideCameraRole: 'WIDE',
    });
    expect(snapshot.clipOrder).toEqual(['b', 'a']);
    expect(snapshot.cameraRoles).toEqual({ a: 'A', b: 'WIDE' });
    expect(snapshot.wideCameraRole).toBe('WIDE');
    expect(assemblyFromSnapshot(snapshot)).toEqual({
      clipOrder: ['b', 'a'],
      cameraRoles: { a: 'A', b: 'WIDE' },
    });
  });

  it('omits empty overrides so older snapshots stay unchanged', () => {
    const snapshot = snapshotWithAssembly(BUILTIN_ROUGH_CUT_PROFILE, {
      clipOrder: null,
      cameraRoles: null,
      wideCameraRole: null,
    });
    expect(snapshot.clipOrder).toBeUndefined();
    expect(snapshot.cameraRoles).toBeUndefined();
    expect(assemblyFromSnapshot(snapshot)).toEqual({ clipOrder: null, cameraRoles: null });
  });
});
