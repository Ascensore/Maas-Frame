import { describe, expect, it } from 'vitest';
import {
  applyCameraRole,
  applyClipOrder,
  assemblyFromSnapshot,
  orderClipsForLinearLayout,
  parseCameraRoles,
  parseClipOrder,
  parseWideCameraRole,
  snapshotWithAssembly,
} from '@/lib/rough-cut/assembly';
import { BUILTIN_ROUGH_CUT_PROFILE, snapshotFromProfile } from '@/lib/rough-cut/profile';

const ALLOWED = new Set(['a', 'b', 'c']);

describe('parseClipOrder', () => {
  it('returns null for a missing or empty list', () => {
    expect(parseClipOrder(undefined, ALLOWED)).toEqual({ ok: true, value: null });
    expect(parseClipOrder([], ALLOWED)).toEqual({ ok: true, value: null });
  });

  it('appends omitted clips in allowed-set insertion order, not sorted order', () => {
    const mixed = new Set(['z', 'a', 'm']);
    expect(parseClipOrder(['m'], mixed)).toEqual({ ok: true, value: ['m', 'z', 'a'] });
  });

  it('rejects an unknown id and a duplicate', () => {
    expect(parseClipOrder(['a', 'nope'], ALLOWED)).toEqual({
      ok: false,
      error: 'clipOrder includes a video that is not in this folder',
    });
    expect(parseClipOrder(['a', 'a'], ALLOWED)).toEqual({
      ok: false,
      error: 'clipOrder must not repeat a video id',
    });
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
    expect(parseCameraRoles({ nope: 'A' }, ALLOWED)).toEqual({
      ok: false,
      error: 'cameraRoles includes a video that is not in this folder',
    });
  });

  it('rejects an empty camera name', () => {
    expect(parseCameraRoles({ a: '' }, ALLOWED).ok).toBe(false);
  });
});

describe('parseWideCameraRole', () => {
  it('accepts a named safety camera and nothing else', () => {
    expect(parseWideCameraRole(' interview ')).toEqual({ ok: true, value: 'INTERVIEW' });
    expect(parseWideCameraRole(null)).toEqual({ ok: true, value: null });
    expect(parseWideCameraRole('')).toEqual({
      ok: false,
      error: 'wideCameraRole must be 1-40 characters',
    });
    expect(parseWideCameraRole(1).ok).toBe(false);
  });
});

describe('applyClipOrder', () => {
  it('reorders known ids and keeps leftovers in their original order', () => {
    const clips = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(applyClipOrder(clips, ['c', 'a']).map((clip) => clip.id)).toEqual(['c', 'a', 'b']);
  });
});

describe('orderClipsForLinearLayout', () => {
  it('uses clipOrder when present and otherwise calls chronological sort', () => {
    const clips = [{ id: 'late' }, { id: 'early' }];
    const chronological = (entries: typeof clips) => [...entries].reverse();
    expect(
      orderClipsForLinearLayout(clips, ['late', 'early'], chronological).map((clip) => clip.id)
    ).toEqual(['late', 'early']);
    expect(orderClipsForLinearLayout(clips, null, chronological).map((clip) => clip.id)).toEqual([
      'early',
      'late',
    ]);
  });
});

describe('applyCameraRole', () => {
  it('uses the override when present and uppercases it', () => {
    expect(applyCameraRole('a', 'CAM', { a: 'wide' })).toBe('WIDE');
    expect(applyCameraRole('a', 'CAM', null)).toBe('CAM');
    expect(applyCameraRole('b', 'CAM', { a: 'A' })).toBe('CAM');
  });
});

describe('snapshotWithAssembly', () => {
  it('stores clip order and camera names next to the profile fields the worker already reads', () => {
    const snapshot = snapshotWithAssembly(BUILTIN_ROUGH_CUT_PROFILE, {
      clipOrder: ['b', 'a'],
      cameraRoles: { a: 'A', b: 'WIDE' },
      wideCameraRole: 'INTERVIEW',
    });
    expect(snapshot.clipOrder).toEqual(['b', 'a']);
    expect(snapshot.cameraRoles).toEqual({ a: 'A', b: 'WIDE' });
    expect(snapshot.wideCameraRole).toBe('INTERVIEW');
    expect(snapshot.minShotSeconds).toBe(BUILTIN_ROUGH_CUT_PROFILE.minShotSeconds);
    expect(snapshot.syncStrategy).toBe(BUILTIN_ROUGH_CUT_PROFILE.syncStrategy);
    expect(snapshot.mediaPathPrefix).toBe(BUILTIN_ROUGH_CUT_PROFILE.mediaPathPrefix);
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
    expect(snapshot).toEqual(snapshotFromProfile(BUILTIN_ROUGH_CUT_PROFILE));
    expect(snapshot.wideCameraRole).toBe('WIDE');
    expect(assemblyFromSnapshot(snapshot)).toEqual({ clipOrder: null, cameraRoles: null });
  });
});
