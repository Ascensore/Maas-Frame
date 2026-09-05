import { z } from 'zod';
import { folderPath } from '../folders';
import type { LayoutGuess, LayoutGuessReason } from './layout';
import {
  ROUGH_CUT_LAYOUTS,
  ROUGH_CUT_OVERLAP,
  ROUGH_CUT_SYNC,
  type ResolvedRoughCutProfile,
  type RoughCutLayout,
} from './types';

/**
 * The editorial brief: what "good" means for a project type, as policy the
 * assembler applies. Technical knobs (min shot, sync, handles) stay on the
 * RoughCutProfile underneath; the brief may override them sparsely through
 * `technical`, and per-run dialog values override the brief in turn.
 *
 * Merge order, lowest to highest: built-in profile default → workspace default
 * profile → folder profile → `brief.technical` → dialog values.
 *
 * Pure so the media worker can import it (the worker image copies
 * lib/rough-cut wholesale) and so every rule here is a unit test away.
 */

export const EDITORIAL_PROJECT_TYPES = ['ASCENSORE', 'TALKING_HEAD', 'INTERVIEW'] as const;
export type EditorialProjectType = (typeof EDITORIAL_PROJECT_TYPES)[number];

export const SILENCE_AGGRESSIVENESS_LEVELS = ['low', 'medium', 'high'] as const;
export type SilenceAggressiveness = (typeof SILENCE_AGGRESSIVENESS_LEVELS)[number];

export const BRIEF_RANKING_CRITERIA = ['cleanliness', 'energy', 'script_match'] as const;
export type BriefRankingCriterion = (typeof BRIEF_RANKING_CRITERIA)[number];

export const TAKE_GROUPING = ['semantic_beat', 'none'] as const;
export type TakeGrouping = (typeof TAKE_GROUPING)[number];

export type SilencePolicy = {
  /** Pauses up to this long inside a beat stay in the program. */
  maxKeptGapInsideBeatSeconds: number;
  /** Pauses up to this long between beats stay in the program. */
  maxKeptGapBetweenBeatsSeconds: number;
  detectFalseStarts: boolean;
};

/** The numbers behind each aggressiveness level. Without them the templates are not testable. */
export const SILENCE_AGGRESSIVENESS: Record<SilenceAggressiveness, SilencePolicy> = {
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
};

export type EditorialBriefTechnical = {
  /** A profile to use as the technical base, instead of the folder / workspace resolution. */
  roughCutProfileId: string | null;
  minShotSeconds?: number;
  safetyPauseSeconds?: number;
  maxShotSeconds?: number | null;
  overlapBehaviour?: ResolvedRoughCutProfile['overlapBehaviour'];
  syncStrategy?: ResolvedRoughCutProfile['syncStrategy'];
  handleFrames?: number;
};

export type EditorialBrief = {
  version: 1;
  projectType: EditorialProjectType;
  goals: string | null;
  ranking: BriefRankingCriterion[];
  /** Tiebreak for the footage-based layout guess; never forces a layout the footage cannot support. */
  layoutBias: RoughCutLayout | null;
  pacing: { silenceAggressiveness: SilenceAggressiveness };
  cameraGrammar: { followSpeaker: boolean; holdWideOnChaos: boolean };
  markers: { infographicOnJargon: boolean; brollOnIllustration: boolean };
  takeSelection: { enabled: boolean; groupBy: TakeGrouping };
  technical: EditorialBriefTechnical;
};

const GOALS_MAX = 2000;
/** Free text a project attaches to its rough cuts; carried on the snapshot, not interpreted in v1. */
export const PROJECT_GUIDELINES_MAX = 4000;
const NAME_MAX = 80;

export const DEFAULT_BRIEF_RANKING: BriefRankingCriterion[] = ['cleanliness', 'energy'];

/** The three v1 templates. Every workspace brief starts as one of these. */
export const BUILTIN_BRIEF_TEMPLATES: Record<EditorialProjectType, EditorialBrief> = {
  ASCENSORE: {
    version: 1,
    projectType: 'ASCENSORE',
    goals: 'Shark Tank–like continuous show take: one take, many people, tight dead air.',
    ranking: ['cleanliness', 'energy'],
    layoutBias: 'MULTICAM',
    pacing: { silenceAggressiveness: 'high' },
    cameraGrammar: { followSpeaker: true, holdWideOnChaos: true },
    markers: { infographicOnJargon: true, brollOnIllustration: true },
    takeSelection: { enabled: false, groupBy: 'none' },
    technical: { roughCutProfileId: null },
  },
  TALKING_HEAD: {
    version: 1,
    projectType: 'TALKING_HEAD',
    goals:
      'Single-speaker content, often recorded in several takes; keep light intentional pauses.',
    ranking: ['cleanliness', 'energy'],
    layoutBias: null,
    pacing: { silenceAggressiveness: 'medium' },
    cameraGrammar: { followSpeaker: false, holdWideOnChaos: false },
    markers: { infographicOnJargon: false, brollOnIllustration: true },
    takeSelection: { enabled: true, groupBy: 'semantic_beat' },
    technical: { roughCutProfileId: null },
  },
  INTERVIEW: {
    version: 1,
    projectType: 'INTERVIEW',
    goals: 'Interviews and multi-person sessions; never cut mid-thought, keep strong reactions.',
    ranking: ['cleanliness', 'energy'],
    layoutBias: null,
    pacing: { silenceAggressiveness: 'medium' },
    cameraGrammar: { followSpeaker: true, holdWideOnChaos: true },
    markers: { infographicOnJargon: false, brollOnIllustration: true },
    takeSelection: { enabled: true, groupBy: 'semantic_beat' },
    technical: { roughCutProfileId: null },
  },
};

export function parseEditorialProjectType(value: unknown): EditorialProjectType | null {
  if (typeof value !== 'string') return null;
  const upper = value.trim().toUpperCase();
  return EDITORIAL_PROJECT_TYPES.includes(upper as EditorialProjectType)
    ? (upper as EditorialProjectType)
    : null;
}

/**
 * When nothing binds a brief and none is requested, the footage picks the
 * template: several synced cameras read as an interview, anything else as a
 * talking head. Ascensore is the house show and is always chosen explicitly.
 */
export function defaultProjectTypeForLayout(layout: RoughCutLayout): EditorialProjectType {
  return layout === 'MULTICAM' ? 'INTERVIEW' : 'TALKING_HEAD';
}

const technicalSchema = z
  .object({
    roughCutProfileId: z.string().trim().min(1).nullable().optional(),
    minShotSeconds: z.number().finite().positive().max(30).optional(),
    safetyPauseSeconds: z.number().finite().nonnegative().max(60).optional(),
    maxShotSeconds: z.number().finite().positive().max(600).nullable().optional(),
    overlapBehaviour: z.enum(ROUGH_CUT_OVERLAP).optional(),
    syncStrategy: z.enum(ROUGH_CUT_SYNC).optional(),
    handleFrames: z.number().int().min(0).max(48).optional(),
  })
  .strict();

/** Every field optional: a patch, or a create body that fills gaps from the template. */
export const editorialBriefConfigPatchSchema = z
  .object({
    version: z.literal(1).optional(),
    projectType: z.enum(EDITORIAL_PROJECT_TYPES).optional(),
    goals: z.string().trim().max(GOALS_MAX).nullable().optional(),
    ranking: z.array(z.enum(BRIEF_RANKING_CRITERIA)).min(1).max(3).optional(),
    layoutBias: z.enum(ROUGH_CUT_LAYOUTS).nullable().optional(),
    pacing: z
      .object({ silenceAggressiveness: z.enum(SILENCE_AGGRESSIVENESS_LEVELS).optional() })
      .strict()
      .optional(),
    cameraGrammar: z
      .object({
        followSpeaker: z.boolean().optional(),
        holdWideOnChaos: z.boolean().optional(),
      })
      .strict()
      .optional(),
    markers: z
      .object({
        infographicOnJargon: z.boolean().optional(),
        brollOnIllustration: z.boolean().optional(),
      })
      .strict()
      .optional(),
    takeSelection: z
      .object({
        enabled: z.boolean().optional(),
        groupBy: z.enum(TAKE_GROUPING).optional(),
      })
      .strict()
      .optional(),
    technical: technicalSchema.optional(),
  })
  .strict();

export type EditorialBriefConfigPatch = z.infer<typeof editorialBriefConfigPatchSchema>;

function uniqueRanking(ranking: BriefRankingCriterion[]): BriefRankingCriterion[] {
  return ranking.filter((criterion, index) => ranking.indexOf(criterion) === index);
}

/** `{ ...base, ...patch }` that ignores keys the patch left undefined. */
function mergeDefined<T extends object>(base: T, patch: Partial<T> | undefined): T {
  const next = { ...base };
  if (!patch) return next;
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) (next as Record<string, unknown>)[key] = value;
  }
  return next;
}

/**
 * Lay a partial config over a complete one. Nested objects merge field by
 * field; `technical` replaces a key only when the patch names it, and a
 * `null` there is a real value (no maximum shot), not an absence.
 */
export function mergeBriefConfig(
  base: EditorialBrief,
  patch: EditorialBriefConfigPatch
): EditorialBrief {
  const technical: EditorialBriefTechnical = { ...base.technical };
  if (patch.technical) {
    for (const [key, value] of Object.entries(patch.technical)) {
      if (value === undefined) continue;
      (technical as Record<string, unknown>)[key] = value;
    }
    if (technical.roughCutProfileId === undefined) technical.roughCutProfileId = null;
  }
  return {
    version: 1,
    projectType: patch.projectType ?? base.projectType,
    goals: patch.goals === undefined ? base.goals : patch.goals,
    ranking: patch.ranking ? uniqueRanking(patch.ranking) : base.ranking,
    layoutBias: patch.layoutBias === undefined ? base.layoutBias : patch.layoutBias,
    pacing: mergeDefined(base.pacing, patch.pacing),
    cameraGrammar: mergeDefined(base.cameraGrammar, patch.cameraGrammar),
    markers: mergeDefined(base.markers, patch.markers),
    takeSelection: mergeDefined(base.takeSelection, patch.takeSelection),
    technical,
  };
}

function zodErrorMessage(error: z.ZodError, fallback: string): string {
  const first = error.issues[0];
  if (!first) return fallback;
  const path = first.path.length > 0 ? `${first.path.join('.')}: ` : '';
  return `${path}${first.message}`;
}

export function parseBriefConfigPatch(
  input: unknown
): { ok: true; value: EditorialBriefConfigPatch } | { ok: false; error: string } {
  const parsed = editorialBriefConfigPatchSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: zodErrorMessage(parsed.error, 'Invalid brief') };
  return { ok: true, value: parsed.data };
}

export const editorialBriefCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(NAME_MAX),
    projectType: z.enum(EDITORIAL_PROJECT_TYPES),
    isDefault: z.boolean().default(false),
    config: editorialBriefConfigPatchSchema.optional(),
  })
  .strict();

export const editorialBriefPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(NAME_MAX).optional(),
    projectType: z.enum(EDITORIAL_PROJECT_TYPES).optional(),
    isDefault: z.boolean().optional(),
    config: editorialBriefConfigPatchSchema.optional(),
  })
  .strict();

export type EditorialBriefCreate = {
  name: string;
  projectType: EditorialProjectType;
  isDefault: boolean;
  config: EditorialBrief;
};

/** A create body becomes a complete brief: the template for its type, with the body's config laid over it. */
export function parseEditorialBriefCreate(
  input: unknown
): { ok: true; value: EditorialBriefCreate } | { ok: false; error: string } {
  const parsed = editorialBriefCreateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: zodErrorMessage(parsed.error, 'Invalid brief') };
  const { name, projectType, isDefault, config } = parsed.data;
  if (config?.projectType && config.projectType !== projectType) {
    return { ok: false, error: 'config.projectType must match projectType' };
  }
  const template = BUILTIN_BRIEF_TEMPLATES[projectType];
  return {
    ok: true,
    value: {
      name,
      projectType,
      isDefault,
      config: mergeBriefConfig(template, { ...(config ?? {}), projectType }),
    },
  };
}

export type EditorialBriefPatch = z.infer<typeof editorialBriefPatchSchema>;

export function parseEditorialBriefPatch(
  input: unknown
): { ok: true; value: EditorialBriefPatch } | { ok: false; error: string } {
  const parsed = editorialBriefPatchSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: zodErrorMessage(parsed.error, 'Invalid brief') };
  if (Object.keys(parsed.data).length === 0) {
    return { ok: false, error: 'Provide name, projectType, isDefault and/or config' };
  }
  return { ok: true, value: parsed.data };
}

/**
 * Read a stored config. A row written by an older schema version, or edited
 * by hand, degrades to the template for its type with whatever fields still
 * parse laid over it, rather than failing the run that reads it.
 */
export function briefConfigFromStored(
  value: unknown,
  projectType: EditorialProjectType
): EditorialBrief {
  const template = BUILTIN_BRIEF_TEMPLATES[projectType];
  const parsed = editorialBriefConfigPatchSchema.safeParse(value);
  if (!parsed.success) return template;
  return mergeBriefConfig(template, { ...parsed.data, projectType });
}

/**
 * The brief's technical block laid over the resolved profile. Only keys the
 * brief names change; `maxShotSeconds: null` is a real override.
 */
export function applyBriefTechnical(
  profile: ResolvedRoughCutProfile,
  brief: EditorialBrief
): ResolvedRoughCutProfile {
  const technical = brief.technical;
  return {
    ...profile,
    minShotSeconds: technical.minShotSeconds ?? profile.minShotSeconds,
    safetyPauseSeconds: technical.safetyPauseSeconds ?? profile.safetyPauseSeconds,
    maxShotSeconds:
      technical.maxShotSeconds === undefined ? profile.maxShotSeconds : technical.maxShotSeconds,
    overlapBehaviour: technical.overlapBehaviour ?? profile.overlapBehaviour,
    syncStrategy: technical.syncStrategy ?? profile.syncStrategy,
    handleFrames: technical.handleFrames ?? profile.handleFrames,
  };
}

export type FolderBriefLink = {
  id: string;
  parentId: string | null;
  name: string;
  editorialBriefId: string | null;
};

/** Nearest ancestor folder with a brief wins, as with profiles. */
export function resolveEffectiveBriefId(
  folderId: string | null,
  folders: FolderBriefLink[]
): string | null {
  if (!folderId) return null;
  const path = folderPath(folderId, folders);
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const crumb = path[index];
    if (!crumb) continue;
    const folder = folders.find((entry) => entry.id === crumb.id);
    if (folder?.editorialBriefId) return folder.editorialBriefId;
  }
  return null;
}

export type BriefSource = 'requested' | 'folder' | 'project' | 'workspace-default' | 'builtin';

export type ResolvedBrief = {
  briefId: string | null;
  brief: EditorialBrief;
  source: BriefSource;
};

export type StoredBrief = { id: string; projectType: EditorialProjectType; brief: EditorialBrief };

/**
 * Which brief a run uses: an explicit request, else the nearest folder, else
 * the project, else the workspace default for the project type, else the
 * built-in template. The project type only matters once nothing is bound.
 */
export function resolveEffectiveBrief(options: {
  requestedBriefId?: string | null;
  folderId: string | null;
  folders: FolderBriefLink[];
  projectBriefId: string | null;
  briefsById: Map<string, StoredBrief>;
  /** The workspace's default brief per project type, when one is marked. */
  defaultsByType: Map<EditorialProjectType, StoredBrief>;
  projectType: EditorialProjectType;
}): ResolvedBrief {
  if (options.requestedBriefId) {
    const requested = options.briefsById.get(options.requestedBriefId);
    if (requested) return { briefId: requested.id, brief: requested.brief, source: 'requested' };
  }
  const folderBriefId = resolveEffectiveBriefId(options.folderId, options.folders);
  if (folderBriefId) {
    const fromFolder = options.briefsById.get(folderBriefId);
    if (fromFolder) return { briefId: fromFolder.id, brief: fromFolder.brief, source: 'folder' };
  }
  if (options.projectBriefId) {
    const fromProject = options.briefsById.get(options.projectBriefId);
    if (fromProject) {
      return { briefId: fromProject.id, brief: fromProject.brief, source: 'project' };
    }
  }
  const workspaceDefault = options.defaultsByType.get(options.projectType);
  if (workspaceDefault) {
    return {
      briefId: workspaceDefault.id,
      brief: workspaceDefault.brief,
      source: 'workspace-default',
    };
  }
  return {
    briefId: null,
    brief: BUILTIN_BRIEF_TEMPLATES[options.projectType],
    source: 'builtin',
  };
}

/** Guess reasons weak enough for the brief's layout bias to override. */
export const WEAK_LAYOUT_GUESS_REASONS: ReadonlySet<LayoutGuessReason> = new Set([
  'default-multicam',
  'distinct-camera-roles',
]);

export type LayoutSource = 'dialog' | 'brief' | 'guess';

/**
 * Apply the brief's layout bias to the footage guess. The bias only breaks a
 * weak guess, never forces MULTICAM on fewer than two clips, and a single-
 * camera bias resolves to the layout the clip count supports.
 */
export function applyLayoutBias(
  guess: LayoutGuess,
  bias: RoughCutLayout | null,
  fileBackedCount: number
): { layout: RoughCutLayout; source: LayoutSource } {
  if (!bias || !WEAK_LAYOUT_GUESS_REASONS.has(guess.reason)) {
    return { layout: guess.layout, source: 'guess' };
  }
  const resolved: RoughCutLayout =
    bias === 'MULTICAM' ? 'MULTICAM' : fileBackedCount <= 1 ? 'LINEAR' : 'SEQUENTIAL';
  if (resolved === 'MULTICAM' && fileBackedCount < 2) {
    return { layout: guess.layout, source: 'guess' };
  }
  if (resolved === guess.layout) return { layout: guess.layout, source: 'guess' };
  return { layout: resolved, source: 'brief' };
}

/** What a run stores about the brief it used. */
export type BriefSnapshot = {
  version: 1;
  briefId: string | null;
  source: BriefSource;
  layoutSource: LayoutSource;
  brief: EditorialBrief;
  /** The project's free-text guidelines at run time, so a run keeps its own record. */
  projectGuidelines: string | null;
};

export function buildBriefSnapshot(options: {
  resolved: ResolvedBrief;
  layoutSource: LayoutSource;
  projectGuidelines?: string | null;
}): BriefSnapshot {
  return {
    version: 1,
    briefId: options.resolved.briefId,
    source: options.resolved.source,
    layoutSource: options.layoutSource,
    brief: options.resolved.brief,
    projectGuidelines: options.projectGuidelines?.trim() ? options.projectGuidelines : null,
  };
}

const BRIEF_SOURCES: ReadonlySet<string> = new Set([
  'requested',
  'folder',
  'project',
  'workspace-default',
  'builtin',
]);
const LAYOUT_SOURCES: ReadonlySet<string> = new Set(['dialog', 'brief', 'guess']);

/**
 * Read a run's stored snapshot. Runs made before briefs existed have none and
 * get null, so the reader keeps its pre-brief defaults for them.
 */
export function briefFromSnapshot(value: unknown): BriefSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const rawBrief = raw.brief;
  if (!rawBrief || typeof rawBrief !== 'object' || Array.isArray(rawBrief)) return null;
  const projectType = parseEditorialProjectType((rawBrief as Record<string, unknown>).projectType);
  if (!projectType) return null;
  return {
    version: 1,
    briefId: typeof raw.briefId === 'string' && raw.briefId ? raw.briefId : null,
    source: BRIEF_SOURCES.has(String(raw.source)) ? (raw.source as BriefSource) : 'builtin',
    layoutSource: LAYOUT_SOURCES.has(String(raw.layoutSource))
      ? (raw.layoutSource as LayoutSource)
      : 'guess',
    brief: briefConfigFromStored(rawBrief, projectType),
    projectGuidelines:
      typeof raw.projectGuidelines === 'string' && raw.projectGuidelines.trim()
        ? raw.projectGuidelines
        : null,
  };
}
