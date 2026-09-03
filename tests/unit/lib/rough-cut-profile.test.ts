import { describe, expect, it } from 'vitest';
import {
  BUILTIN_ROUGH_CUT_PROFILE,
  isSafeMediaPathPrefix,
  parseRoughCutProfileCreate,
  parseRoughCutProfilePatch,
  profileFromSnapshot,
  resolveEffectiveProfile,
  resolveEffectiveProfileId,
  type FolderProfileLink,
} from '@/lib/rough-cut/profile';
import type { ResolvedRoughCutProfile } from '@/lib/rough-cut/types';

const INTERVIEW: ResolvedRoughCutProfile = {
  ...BUILTIN_ROUGH_CUT_PROFILE,
  id: 'profile-interview',
  name: 'Interview',
  isDefault: false,
};

const PODCAST: ResolvedRoughCutProfile = {
  ...BUILTIN_ROUGH_CUT_PROFILE,
  id: 'profile-podcast',
  name: 'Podcast',
  minShotSeconds: 3,
  isDefault: true,
};

function folders(links: FolderProfileLink[]): FolderProfileLink[] {
  return links;
}

describe('parseRoughCutProfileCreate', () => {
  it('fills defaults for a name-only payload', () => {
    const parsed = parseRoughCutProfileCreate({ name: 'Interview' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.minShotSeconds).toBe(1.5);
    expect(parsed.value.safetyPauseSeconds).toBe(2);
    expect(parsed.value.overlapBehaviour).toBe('WIDE');
    expect(parsed.value.mediaPathPrefix).toBe('./media/');
  });

  it('rejects a mediaPathPrefix that escapes the folder', () => {
    const parsed = parseRoughCutProfileCreate({
      name: 'Bad',
      mediaPathPrefix: '../other',
    });
    expect(parsed.ok).toBe(false);
  });

  it('rejects an empty name', () => {
    expect(parseRoughCutProfileCreate({ name: '  ' }).ok).toBe(false);
  });
});

describe('parseRoughCutProfilePatch', () => {
  it('requires at least one field', () => {
    const parsed = parseRoughCutProfilePatch({});
    expect(parsed.ok).toBe(false);
  });

  it('accepts a single numeric field', () => {
    const parsed = parseRoughCutProfilePatch({ minShotSeconds: 2.5 });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.minShotSeconds).toBe(2.5);
  });
});

describe('isSafeMediaPathPrefix', () => {
  it('allows a relative media folder', () => {
    expect(isSafeMediaPathPrefix('./media/')).toBe(true);
    expect(isSafeMediaPathPrefix('media')).toBe(true);
  });

  it('rejects absolute and parent paths', () => {
    expect(isSafeMediaPathPrefix('/media')).toBe(false);
    expect(isSafeMediaPathPrefix('C:\\media')).toBe(false);
    expect(isSafeMediaPathPrefix('media/../secret')).toBe(false);
  });
});

describe('resolveEffectiveProfileId', () => {
  it('walks from the leaf folder to the nearest ancestor with a profile', () => {
    const tree = folders([
      { id: 'root', parentId: null, name: 'Shoot', roughCutProfileId: INTERVIEW.id },
      { id: 'child', parentId: 'root', name: 'Cameras', roughCutProfileId: null },
      { id: 'leaf', parentId: 'child', name: 'Take 1', roughCutProfileId: null },
    ]);
    expect(resolveEffectiveProfileId('leaf', tree)).toBe(INTERVIEW.id);
  });

  it('prefers the folder’s own profile over an ancestor', () => {
    const tree = folders([
      { id: 'root', parentId: null, name: 'Shoot', roughCutProfileId: INTERVIEW.id },
      { id: 'child', parentId: 'root', name: 'Cameras', roughCutProfileId: PODCAST.id },
    ]);
    expect(resolveEffectiveProfileId('child', tree)).toBe(PODCAST.id);
  });

  it('returns null for the project root', () => {
    expect(resolveEffectiveProfileId(null, [])).toBeNull();
  });
});

describe('resolveEffectiveProfile', () => {
  it('falls back to the workspace default, then the builtin profile', () => {
    const fromDefault = resolveEffectiveProfile({
      folderId: null,
      folders: [],
      profilesById: new Map(),
      workspaceDefault: PODCAST,
    });
    expect(fromDefault.id).toBe(PODCAST.id);

    const fromBuiltin = resolveEffectiveProfile({
      folderId: null,
      folders: [],
      profilesById: new Map(),
      workspaceDefault: null,
    });
    expect(fromBuiltin).toEqual(BUILTIN_ROUGH_CUT_PROFILE);
  });
});

describe('profileFromSnapshot', () => {
  it('returns the builtin profile for garbage JSON', () => {
    expect(profileFromSnapshot(null).name).toBe('Default');
    expect(profileFromSnapshot({ overlapBehaviour: 'NOPE' }).overlapBehaviour).toBe('WIDE');
  });

  it('round-trips a stored snapshot', () => {
    const snapshot: ResolvedRoughCutProfile = {
      ...INTERVIEW,
      minShotSeconds: 2,
      mediaPathPrefix: './dailies/',
    };
    expect(profileFromSnapshot(snapshot).minShotSeconds).toBe(2);
    expect(profileFromSnapshot(snapshot).mediaPathPrefix).toBe('./dailies/');
  });
});
