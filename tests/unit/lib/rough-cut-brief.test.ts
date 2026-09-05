import { describe, expect, it } from 'vitest';
import {
  applyBriefTechnical,
  applyLayoutBias,
  briefConfigFromStored,
  briefFromSnapshot,
  buildBriefSnapshot,
  BUILTIN_BRIEF_TEMPLATES,
  defaultProjectTypeForLayout,
  mergeBriefConfig,
  parseEditorialBriefCreate,
  parseEditorialBriefPatch,
  parseEditorialProjectType,
  resolveEffectiveBrief,
  resolveEffectiveBriefId,
  SILENCE_AGGRESSIVENESS,
  type EditorialBrief,
  type EditorialProjectType,
  type FolderBriefLink,
  type StoredBrief,
} from '@/lib/rough-cut/brief';
import type { LayoutGuess } from '@/lib/rough-cut/layout';
import { BUILTIN_ROUGH_CUT_PROFILE } from '@/lib/rough-cut/profile';

function stored(
  id: string,
  projectType: EditorialProjectType,
  overrides: Partial<EditorialBrief> = {}
): StoredBrief {
  return { id, projectType, brief: { ...BUILTIN_BRIEF_TEMPLATES[projectType], ...overrides } };
}

function guess(reason: LayoutGuess['reason'], layout: LayoutGuess['layout']): LayoutGuess {
  return { reason, layout, orderedIds: [] };
}

describe('SILENCE_AGGRESSIVENESS', () => {
  it('matches the design table', () => {
    expect(SILENCE_AGGRESSIVENESS).toEqual({
      low: {
        maxKeptGapInsideBeatSeconds: 1.5,
        maxKeptGapBetweenBeatsSeconds: 2.5,
        detectFalseStarts: false,
      },
      medium: {
        maxKeptGapInsideBeatSeconds: 0.8,
        maxKeptGapBetweenBeatsSeconds: 1.5,
        detectFalseStarts: true,
      },
      high: {
        maxKeptGapInsideBeatSeconds: 0.4,
        maxKeptGapBetweenBeatsSeconds: 0.8,
        detectFalseStarts: true,
      },
    });
  });
});

describe('BUILTIN_BRIEF_TEMPLATES', () => {
  it('encodes the three project types from the design', () => {
    expect(BUILTIN_BRIEF_TEMPLATES.ASCENSORE).toMatchObject({
      projectType: 'ASCENSORE',
      layoutBias: 'MULTICAM',
      pacing: { silenceAggressiveness: 'high' },
      cameraGrammar: { followSpeaker: true, holdWideOnChaos: true },
      markers: { infographicOnJargon: true, brollOnIllustration: true },
      takeSelection: { enabled: false, groupBy: 'none' },
    });
    expect(BUILTIN_BRIEF_TEMPLATES.TALKING_HEAD).toMatchObject({
      layoutBias: null,
      pacing: { silenceAggressiveness: 'medium' },
      cameraGrammar: { followSpeaker: false, holdWideOnChaos: false },
      markers: { infographicOnJargon: false, brollOnIllustration: true },
      takeSelection: { enabled: true, groupBy: 'semantic_beat' },
    });
    expect(BUILTIN_BRIEF_TEMPLATES.INTERVIEW).toMatchObject({
      layoutBias: null,
      pacing: { silenceAggressiveness: 'medium' },
      cameraGrammar: { followSpeaker: true, holdWideOnChaos: true },
      markers: { infographicOnJargon: false, brollOnIllustration: true },
      takeSelection: { enabled: true, groupBy: 'semantic_beat' },
    });
    expect(BUILTIN_BRIEF_TEMPLATES.ASCENSORE.ranking).toEqual(['cleanliness', 'energy']);
    expect(BUILTIN_BRIEF_TEMPLATES.TALKING_HEAD.ranking).toEqual(['cleanliness', 'energy']);
    expect(BUILTIN_BRIEF_TEMPLATES.INTERVIEW.ranking).toEqual(['cleanliness', 'energy']);
    expect(BUILTIN_BRIEF_TEMPLATES.ASCENSORE.technical).toEqual({ roughCutProfileId: null });
    expect(BUILTIN_BRIEF_TEMPLATES.TALKING_HEAD.technical).toEqual({ roughCutProfileId: null });
    expect(BUILTIN_BRIEF_TEMPLATES.INTERVIEW.technical).toEqual({ roughCutProfileId: null });
  });
});

describe('parseEditorialBriefCreate', () => {
  it('starts from the template for the type and lays the body over it', () => {
    const parsed = parseEditorialBriefCreate({
      name: '  Pitch night ',
      projectType: 'ASCENSORE',
      config: { pacing: { silenceAggressiveness: 'low' }, technical: { minShotSeconds: 2 } },
    });

    expect(parsed).toEqual({
      ok: true,
      value: {
        name: 'Pitch night',
        projectType: 'ASCENSORE',
        isDefault: false,
        config: {
          ...BUILTIN_BRIEF_TEMPLATES.ASCENSORE,
          pacing: { silenceAggressiveness: 'low' },
          technical: { roughCutProfileId: null, minShotSeconds: 2 },
        },
      },
    });
  });

  it('rejects a mismatched, unknown or missing project type, an empty name and unknown keys', () => {
    expect(
      parseEditorialBriefCreate({
        name: 'x',
        projectType: 'ASCENSORE',
        config: { projectType: 'INTERVIEW' },
      })
    ).toEqual({ ok: false, error: 'config.projectType must match projectType' });
    expect(parseEditorialBriefCreate({ name: 'x', projectType: 'VLOG' }).ok).toBe(false);
    expect(parseEditorialBriefCreate({ name: 'x' }).ok).toBe(false);
    expect(parseEditorialBriefCreate({ name: '  ', projectType: 'INTERVIEW' }).ok).toBe(false);
    expect(
      parseEditorialBriefCreate({ name: 'x', projectType: 'INTERVIEW', config: { tempo: 1 } }).ok
    ).toBe(false);
    expect(
      parseEditorialBriefCreate({
        name: 'x',
        projectType: 'INTERVIEW',
        config: { pacing: { silenceAggressiveness: 'brutal' } },
      }).ok
    ).toBe(false);
  });
});

describe('parseEditorialBriefPatch', () => {
  it('needs at least one field', () => {
    expect(parseEditorialBriefPatch({})).toEqual({
      ok: false,
      error: 'Provide name, projectType, isDefault and/or config',
    });
    expect(parseEditorialBriefPatch({ name: 'Renamed' })).toEqual({
      ok: true,
      value: { name: 'Renamed' },
    });
    expect(parseEditorialBriefPatch({ isDefault: 'yes' }).ok).toBe(false);
  });
});

describe('mergeBriefConfig', () => {
  const base = BUILTIN_BRIEF_TEMPLATES.TALKING_HEAD;

  it('merges nested objects field by field and ignores undefined', () => {
    const merged = mergeBriefConfig(base, {
      cameraGrammar: { followSpeaker: true, holdWideOnChaos: undefined },
      takeSelection: { enabled: false },
    });

    expect(merged.cameraGrammar).toEqual({ followSpeaker: true, holdWideOnChaos: false });
    expect(merged.takeSelection).toEqual({ enabled: false, groupBy: 'semantic_beat' });
    expect(merged.pacing).toEqual(base.pacing);
  });

  it('treats a null maximum shot as a real override and keeps other technical keys', () => {
    const first = mergeBriefConfig(base, { technical: { minShotSeconds: 2, maxShotSeconds: 30 } });
    const second = mergeBriefConfig(first, { technical: { maxShotSeconds: null } });

    expect(first.technical).toEqual({
      roughCutProfileId: null,
      minShotSeconds: 2,
      maxShotSeconds: 30,
    });
    expect(second.technical).toEqual({
      roughCutProfileId: null,
      minShotSeconds: 2,
      maxShotSeconds: null,
    });
  });

  it('dedupes the ranking and lets goals be cleared', () => {
    const merged = mergeBriefConfig(base, {
      ranking: ['energy', 'cleanliness', 'energy'],
      goals: null,
    });

    expect(merged.ranking).toEqual(['energy', 'cleanliness']);
    expect(merged.goals).toBeNull();
  });
});

describe('applyBriefTechnical', () => {
  it('overrides only the keys the brief names', () => {
    const brief: EditorialBrief = {
      ...BUILTIN_BRIEF_TEMPLATES.INTERVIEW,
      technical: { roughCutProfileId: null, minShotSeconds: 3, maxShotSeconds: null },
    };
    const profile = { ...BUILTIN_ROUGH_CUT_PROFILE, maxShotSeconds: 45, wideCameraRole: 'MASTER' };

    expect(applyBriefTechnical(profile, brief)).toEqual({
      ...profile,
      minShotSeconds: 3,
      maxShotSeconds: null,
    });
    expect(
      applyBriefTechnical(profile, {
        ...brief,
        technical: { roughCutProfileId: null, overlapBehaviour: 'HOLD' },
      })
    ).toMatchObject({ minShotSeconds: 1.5, maxShotSeconds: 45, overlapBehaviour: 'HOLD' });
  });
});

describe('resolveEffectiveBriefId', () => {
  const folders: FolderBriefLink[] = [
    { id: 'root', parentId: null, name: 'Season', editorialBriefId: 'brief-season' },
    { id: 'episode', parentId: 'root', name: 'Episode 3', editorialBriefId: null },
    { id: 'pickups', parentId: 'episode', name: 'Pickups', editorialBriefId: null },
    { id: 'promo', parentId: 'root', name: 'Promo', editorialBriefId: 'brief-promo' },
  ];

  it('walks up to the nearest ancestor with a brief', () => {
    expect(resolveEffectiveBriefId('pickups', folders)).toBe('brief-season');
    expect(resolveEffectiveBriefId('promo', folders)).toBe('brief-promo');
    expect(resolveEffectiveBriefId(null, folders)).toBeNull();
    expect(resolveEffectiveBriefId('missing', folders)).toBeNull();
  });
});

describe('resolveEffectiveBrief', () => {
  const folders: FolderBriefLink[] = [
    { id: 'root', parentId: null, name: 'Season', editorialBriefId: 'brief-folder' },
    { id: 'episode', parentId: 'root', name: 'Episode', editorialBriefId: null },
  ];
  const briefsById = new Map<string, StoredBrief>([
    ['brief-requested', stored('brief-requested', 'INTERVIEW')],
    ['brief-folder', stored('brief-folder', 'ASCENSORE')],
    ['brief-project', stored('brief-project', 'TALKING_HEAD')],
    ['brief-default-th', stored('brief-default-th', 'TALKING_HEAD')],
  ]);
  const defaultsByType = new Map<EditorialProjectType, StoredBrief>([
    ['TALKING_HEAD', briefsById.get('brief-default-th')!],
  ]);

  it('prefers request, then folder, then project, then the workspace default, then the template', () => {
    const base = {
      folderId: 'episode',
      folders,
      projectBriefId: 'brief-project',
      briefsById,
      defaultsByType,
      projectType: 'TALKING_HEAD' as const,
    };

    expect(resolveEffectiveBrief({ ...base, requestedBriefId: 'brief-requested' })).toMatchObject({
      briefId: 'brief-requested',
      source: 'requested',
    });
    expect(resolveEffectiveBrief(base)).toMatchObject({
      briefId: 'brief-folder',
      source: 'folder',
    });
    expect(resolveEffectiveBrief({ ...base, folderId: null })).toMatchObject({
      briefId: 'brief-project',
      source: 'project',
    });
    expect(resolveEffectiveBrief({ ...base, folderId: null, projectBriefId: null })).toMatchObject({
      briefId: 'brief-default-th',
      source: 'workspace-default',
    });
    expect(
      resolveEffectiveBrief({
        ...base,
        folderId: null,
        projectBriefId: null,
        projectType: 'INTERVIEW',
      })
    ).toEqual({ briefId: null, brief: BUILTIN_BRIEF_TEMPLATES.INTERVIEW, source: 'builtin' });
  });

  it('ignores a requested or bound id that no longer exists', () => {
    expect(
      resolveEffectiveBrief({
        requestedBriefId: 'brief-gone',
        folderId: 'episode',
        folders,
        projectBriefId: null,
        briefsById,
        defaultsByType,
        projectType: 'TALKING_HEAD',
      })
    ).toMatchObject({ briefId: 'brief-folder', source: 'folder' });
    // A folder still pointing at a deleted brief falls through to the project.
    expect(
      resolveEffectiveBrief({
        folderId: 'episode',
        folders: [{ id: 'episode', parentId: null, name: 'Episode', editorialBriefId: 'gone' }],
        projectBriefId: 'brief-project',
        briefsById,
        defaultsByType,
        projectType: 'TALKING_HEAD',
      })
    ).toMatchObject({ briefId: 'brief-project', source: 'project' });
  });
});

describe('applyLayoutBias', () => {
  it('breaks only a weak guess', () => {
    expect(applyLayoutBias(guess('default-multicam', 'MULTICAM'), 'SEQUENTIAL', 2)).toEqual({
      layout: 'SEQUENTIAL',
      source: 'brief',
    });
    expect(applyLayoutBias(guess('distinct-camera-roles', 'MULTICAM'), 'LINEAR', 3)).toEqual({
      layout: 'SEQUENTIAL',
      source: 'brief',
    });
    expect(applyLayoutBias(guess('overlapping-timecode', 'MULTICAM'), 'SEQUENTIAL', 2)).toEqual({
      layout: 'MULTICAM',
      source: 'guess',
    });
    expect(applyLayoutBias(guess('sequential-filenames', 'SEQUENTIAL'), 'MULTICAM', 2)).toEqual({
      layout: 'SEQUENTIAL',
      source: 'guess',
    });
  });

  it('never forces multicam on one clip and reports a matching bias as the guess', () => {
    // A weak guess would let the bias through; the clip count still refuses it.
    expect(applyLayoutBias(guess('default-multicam', 'LINEAR'), 'MULTICAM', 1)).toEqual({
      layout: 'LINEAR',
      source: 'guess',
    });
    expect(applyLayoutBias(guess('default-multicam', 'MULTICAM'), 'MULTICAM', 2)).toEqual({
      layout: 'MULTICAM',
      source: 'guess',
    });
    expect(applyLayoutBias(guess('default-multicam', 'MULTICAM'), null, 2)).toEqual({
      layout: 'MULTICAM',
      source: 'guess',
    });
  });
});

describe('briefConfigFromStored', () => {
  it('degrades to the template and lays over what still parses', () => {
    expect(briefConfigFromStored('garbage', 'ASCENSORE')).toEqual(
      BUILTIN_BRIEF_TEMPLATES.ASCENSORE
    );
    expect(
      briefConfigFromStored({ pacing: { silenceAggressiveness: 'low' } }, 'ASCENSORE')
    ).toEqual({ ...BUILTIN_BRIEF_TEMPLATES.ASCENSORE, pacing: { silenceAggressiveness: 'low' } });
    expect(
      briefConfigFromStored({ pacing: { silenceAggressiveness: 'brutal' } }, 'ASCENSORE')
    ).toEqual(BUILTIN_BRIEF_TEMPLATES.ASCENSORE);
  });

  it('lets the row’s project type win over a disagreeing stored config', () => {
    expect(briefConfigFromStored({ projectType: 'INTERVIEW' }, 'ASCENSORE')).toMatchObject({
      projectType: 'ASCENSORE',
      layoutBias: 'MULTICAM',
    });
  });
});

describe('briefFromSnapshot', () => {
  it('round-trips a built snapshot and returns null for a run made before briefs existed', () => {
    const snapshot = buildBriefSnapshot({
      resolved: { briefId: 'brief-1', brief: BUILTIN_BRIEF_TEMPLATES.ASCENSORE, source: 'folder' },
      layoutSource: 'brief',
      projectGuidelines: 'Keep the origin story in full.',
    });

    expect(snapshot.projectGuidelines).toBe('Keep the origin story in full.');
    expect(briefFromSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
    // Blank guidelines are stored as none, and a snapshot from before the
    // field existed reads back as none too.
    expect(
      buildBriefSnapshot({
        resolved: { briefId: null, brief: BUILTIN_BRIEF_TEMPLATES.ASCENSORE, source: 'builtin' },
        layoutSource: 'guess',
        projectGuidelines: '   ',
      }).projectGuidelines
    ).toBeNull();
    expect(briefFromSnapshot(null)).toBeNull();
    expect(briefFromSnapshot({ version: 1 })).toBeNull();
    expect(briefFromSnapshot({ brief: { projectType: 'VLOG' } })).toBeNull();
  });

  it('keeps the pacing of a partial stored brief and defaults unknown sources', () => {
    expect(
      briefFromSnapshot({
        source: 'teleported',
        brief: { projectType: 'TALKING_HEAD', pacing: { silenceAggressiveness: 'high' } },
      })
    ).toEqual({
      version: 1,
      briefId: null,
      source: 'builtin',
      layoutSource: 'guess',
      brief: { ...BUILTIN_BRIEF_TEMPLATES.TALKING_HEAD, pacing: { silenceAggressiveness: 'high' } },
      projectGuidelines: null,
    });
  });
});

describe('project type helpers', () => {
  it('reads types case-insensitively and picks a template from the layout', () => {
    expect(parseEditorialProjectType(' interview ')).toBe('INTERVIEW');
    expect(parseEditorialProjectType('VLOG')).toBeNull();
    expect(parseEditorialProjectType(3)).toBeNull();
    expect(defaultProjectTypeForLayout('MULTICAM')).toBe('INTERVIEW');
    expect(defaultProjectTypeForLayout('SEQUENTIAL')).toBe('TALKING_HEAD');
    expect(defaultProjectTypeForLayout('LINEAR')).toBe('TALKING_HEAD');
  });
});
