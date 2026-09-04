# Editorial brief–driven rough cuts

- **Date:** 2026-09-04
- **Status:** Reviewed draft (revision 2)
- **Goal:** Get automated edits to ~95% of a professional editor's A-roll result by making
  project-type editorial policy explicit, explainable, and reviewable — then layer B-roll /
  infographics on top later.

Revision 2 folds in a review against the code on `master` (`lib/rough-cut/`,
`lib/rough-cut/assemble-job.ts`, `lib/transcription/`, `prisma/schema.prisma`). Where the
first draft proposed something the repo already has, this revision names the existing piece and
scopes the work to the gap.

## Problem

Today's LINEAR / SEQUENTIAL assembly is effectively silence trimming: keep speech islands, drop
short gaps, concatenate. MULTICAM picks a camera per voice-activity turn by RMS. Neither encodes:

- Project-type intent (Ascensore show vs talking head vs interview)
- Take selection when the same beat was recorded multiple times
- Camera grammar beyond simple overlap rules
- Provenance for why a region was kept or cut
- A review path to see and revert cuts without rebuilding the timeline

The existing `RoughCutProfile` knobs (min/max shot, sync, handles) are necessary technical
defaults, not an editorial rationale.

A second, structural gap: the assembler never reads the transcript. `Transcript` and
`TranscriptSegment` rows already exist per version, with timed words and a speaker column, and
are created on upload. The worker re-derives speech islands from an energy VAD on the wav
instead. Every editorial decision below depends on closing that gap first.

## Decision summary

| Choice             | Decision                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Style system       | Structured editorial brief (workspace templates + folder/project binding), not knobs-only or example-driven learning            |
| Default ranking    | Cleanliness first, energy second, most-recent take as the deterministic tiebreak; optional script-match when the brief needs it |
| v1 Ascensore scope | A-roll + placeholder markers for infographics / B-roll (no real media resolution yet)                                           |
| Transcription      | Reuse the existing per-version `Transcript`; the assembler consumes it and waits for it (bounded)                               |
| Quality loop       | Post-edit Program + cuts view with restore / keep overrides applied in-app, re-materialize only                                 |
| Decision list      | Extend `version: 1` additively (cuts, markers, per-edit reason); no version bump                                                |
| Overrides          | Stored on the `RoughCut` row, keyed by source range, copied forward on regenerate                                               |

## Architecture

One pipeline for all project types; only the brief changes behaviour.

```
Media
  → transcript on upload (existing) (+ speakers via DIARIZE when multi-person)
  → material model (segments, beats, cameras, take groups) derived from transcript + clip metadata
  → editorial brief (project-type template + overrides) merged over the technical profile
  → assembly → program edits (+ reason) + cut islands + markers
  → review UI (show cuts, restore / keep, regenerate with pinned overrides)
  → export (FCP7 XML / OTIO) with markers
```

### Roles

| Piece           | Responsibility                                                                       |
| --------------- | ------------------------------------------------------------------------------------ |
| Editorial brief | Intent and policy — what "good" means for this project                               |
| Material model  | Facts about footage (derived from the canonical transcript + clip metadata)          |
| Assembler       | Applies brief to material → timeline + cut islands + markers + reasons               |
| Overrides       | Human decisions stored explicitly on the run; `applyOverrides` is a pure function    |
| RoughCutProfile | Technical defaults under the brief; the brief's `technical` block overrides sparsely |

## Editorial brief

### Storage and inheritance

- A new `EditorialBrief` row per workspace: `id`, `workspaceId`, `name`, `projectType` (enum
  column, for filtering), `isDefault`, `config` (JSON, carries its own `version`), timestamps.
  Three workspace templates are seeded per project type on first use.
- Binding mirrors the profile pattern and adds the missing project level:
  `Folder.editorialBriefId` (nearest ancestor wins, as `resolveEffectiveProfileId` does today) and
  `Project.editorialBriefId` for cuts at the project root (`folderId` null), which today cannot
  inherit a folder profile at all. Fallback is the workspace default brief for the guessed or
  requested project type, then the built-in template.
- The resolved brief is snapshotted onto the run as `RoughCut.briefSnapshot`, exactly as
  `profileSnapshot` is today. Assembly reads snapshots only.

### Merge order (single source of truth)

Built-in profile default → workspace default profile → folder profile → `brief.technical`
overrides → per-run dialog values (`clipOrder`, `cameraRoles`, `wideCameraRole`). The result is
the `profileSnapshot`; the brief's non-technical fields go to `briefSnapshot`.

### Schema

The first draft repeated the min-shot rule three times (`pacing.minHoldSeconds`,
`cameraGrammar.minSwitchSeconds`, `technical.minShotSeconds`) and mirrored `maxShotSeconds` and
`overlapBehaviour`. Technical values live only in `technical`; the brief keeps intent-level
fields that do not exist today.

```ts
type EditorialBrief = {
  version: 1;
  projectType: 'ASCENSORE' | 'TALKING_HEAD' | 'INTERVIEW';
  goals?: string; // free text for docs / later LLM rationale
  ranking: Array<'cleanliness' | 'energy' | 'script_match'>; // default ['cleanliness','energy']
  layoutBias: 'MULTICAM' | 'SEQUENTIAL' | 'LINEAR' | null; // tiebreak only, see Layout
  pacing: {
    silenceAggressiveness: 'low' | 'medium' | 'high';
  };
  cameraGrammar: {
    followSpeaker: boolean;
    holdWideOnChaos: boolean;
  };
  markers: {
    infographicOnJargon: boolean;
    brollOnIllustration: boolean;
  };
  takeSelection: {
    enabled: boolean; // false for Ascensore one-take shows
    groupBy: 'semantic_beat' | 'none';
  };
  technical: {
    // sparse overrides applied on top of the resolved RoughCutProfile
    roughCutProfileId?: string | null;
    minShotSeconds?: number;
    safetyPauseSeconds?: number;
    maxShotSeconds?: number | null;
    overlapBehaviour?: 'WIDE' | 'HOLD' | 'SPEAKER';
    syncStrategy?: 'AUTO' | 'TIMECODE' | 'WAVEFORM';
    handleFrames?: number;
  };
};
```

### Concrete mappings

`silenceAggressiveness` must be numbers or the templates are not testable:

| Level  | Max kept gap inside a beat | Max kept gap between beats | False-start detection |
| ------ | -------------------------- | -------------------------- | --------------------- |
| low    | 1.5 s                      | 2.5 s                      | off                   |
| medium | 0.8 s                      | 1.5 s                      | on                    |
| high   | 0.4 s                      | 0.8 s                      | on                    |

Gaps longer than the threshold become `DEAD_AIR` cut islands. Gaps shorter are kept so the
program does not sound clipped. `minShotSeconds` still applies after cutting.

`holdWideOnChaos` is true for a window when either holds:

- three or more distinct speakers (transcript speaker labels, or per-camera attribution) start
  a turn inside a 6 s window, or
- more than half of the turns in a 6 s window have attribution confidence below
  `LOW_ATTRIBUTION_CONFIDENCE` (1.2, `lib/rough-cut/attribute.ts`).

The window is held on the wide camera with reason `HOLD_WIDE`.

### Layout precedence

Layout is still guessed from footage (`guessRoughCutLayout`, with a reason code) and the dialog
can override it. `layoutBias` is used only when the guess reason is weak (`default-multicam` or
`distinct-camera-roles`) and never forces MULTICAM on fewer than two file-backed clips. The
winning source (dialog, bias, guess) is recorded in the run's warnings/provenance.

### Project-type templates (v1)

|                 | Ascensore                                  | Talking head                               | Interview / multi-person                        |
| --------------- | ------------------------------------------ | ------------------------------------------ | ----------------------------------------------- |
| Intent          | Shark Tank–like continuous show take       | Single-speaker content, often with retries | Interviews, 24h founder, multi-person sessions  |
| Layout bias     | MULTICAM                                   | null (guess; usually LINEAR / SEQUENTIAL)  | null (guess; MULTICAM or sequential by session) |
| Silence         | high                                       | medium                                     | medium; never cut inside a beat                 |
| Takes           | disabled                                   | enabled, `semantic_beat`                   | enabled, `semantic_beat`; keep strong reactions |
| Camera          | followSpeaker, holdWideOnChaos             | followSpeaker off (A-cam), no chaos rule   | followSpeaker, holdWideOnChaos                  |
| Markers         | jargon → INFOGRAPHIC, illustration → BROLL | occasional BROLL                           | sparse BROLL; no infographic                    |
| Review defaults | show all removed dead-air islands          | show dropped false starts / alt takes      | show trimmed tangents + rejected takes          |

Default ranking for all templates: `['cleanliness', 'energy']`.

Every automated decision stores a reason `{ code, summary }` so review and exports stay
explainable.

## Material model and transcription

### Transcript (existing)

- `Transcript` is already per version with `language`, `provider`, `status`, and
  `TranscriptSegment` rows carrying `startSec`, `endSec`, `speaker`, `text`, `words`.
  `enqueueJobsForNewVersion` creates it on upload; `DIARIZE` fills speakers. Nothing new is
  stored for the transcript itself.
- **Canonical transcript for a run.** Every file-backed upload is transcribed, so a multicam
  folder holds one transcript per camera of the same audio. The assembler picks one: the wide
  camera's READY transcript, else any READY transcript in the folder, else none. Transcript
  timings are file-local; the assembler shifts them by the clip's sync offset, as it already
  does for VAD turns. Reducing transcription cost for secondary cameras is a follow-up, not v1.
- **Waiting rule.** ASSEMBLE_ROUGH_CUT is enqueued at POST time and there is no job dependency.
  While nothing is READY, an in-progress transcript is worth waiting for as long as the run is
  younger than 15 minutes: the job writes warning `waiting-for-transcript` on the run, leaves it
  RUNNING, and inserts a fresh ASSEMBLE_ROUGH_CUT media job with `run_after` set 60 s out, which
  the worker's publish loop skips until due. Past the limit, or when the transcript is FAILED,
  absent, or READY with no segments, it falls back to the VAD path and emits `weak-transcript`.
  The limit is measured from the run's creation, not the transcript's age: the worker running
  this job is the worker that finishes transcripts, so a long queue is not a reason to give up
  early, and a stuck job is caught by the limit. (Implemented in phase 1.)
- **Confidence.** Word JSON carries start, end, text only; providers' per-segment scores are not
  stored. v1 defines "weak transcript" on data that exists: transcript FAILED or absent, words
  per second outside 0.5–6 measured over speech time, or more than 20% of segments empty. A
  weak transcript is still used; the warning tells the reviewer to look closely. Adding an
  optional per-segment `confidence` when a provider exposes it is a follow-up. (Implemented in
  phase 1 as `assessTranscriptQuality` in `lib/rough-cut/transcript-source.ts`.)
- **Language.** The transcript row carries `language`. Filler lists, restart detection and
  false-start matching are language-aware; v1 ships English and Italian tables and treats other
  languages as "no filler list" (cleanliness then scores restarts and internal pauses only).

### Derived units

| Unit       | Meaning                                                                                |
| ---------- | -------------------------------------------------------------------------------------- |
| Clip       | File + camera role + sync offset (existing `CameraClip`)                               |
| Segment    | Timed speech / silence from the transcript (VAD turns when falling back)               |
| Beat       | Editorial unit: a run of segments with no gap above the between-beat threshold         |
| Take group | Beats whose normalized text overlaps (see Take selection); usually empty for Ascensore |
| Coverage   | Which cameras are live over a beat (multicam)                                          |

The material model is derived on read inside the assemble job and not persisted; the decision
list and reasons are the durable output. Persisting a snapshot is deferred until a second
consumer needs it.

### Assembly steps

1. Transcript → segments (fallback: VAD turns). Until the brief exists, pauses up to 0.8 s (the
   medium inside-a-beat value) are absorbed into one turn; a speaker change is never absorbed.
2. Segments → beats using the between-beat gap threshold
3. When `takeSelection.enabled`: group beats into take groups, score, pick one, record the others
   as `REJECTED_TAKE`
4. When false-start detection is on: a beat shorter than 4 s whose first 3+ words are a prefix of
   the next beat's text becomes `FALSE_START`
5. Choose camera per beat with `cameraGrammar` over coverage (multicam only)
6. Gaps above threshold become `DEAD_AIR` cut islands
7. Attach marker candidates to beats (placeholders only in v1)
8. Apply min/max shot from the technical profile, then pack the timeline

### Take selection

- **Grouping.** Two beats are duplicates when the Jaccard similarity of their word trigrams,
  after lowercasing and stripping fillers, is at least 0.5, and they are within 10 minutes of
  each other in source time. Groups are transitive closures of that relation.
- **Scoring order.** `cleanliness` desc, then `energy` desc, then most recent take wins. The
  recency tiebreak is the editor's convention and makes the choice deterministic.
  - cleanliness = −(fillers per minute) − 2 × (restarts per minute) − (internal pauses > 0.8 s
    per minute). A restart is a repeated word bigram within 3 s.
  - energy = mean RMS of the beat on the canonical audio (`rmsAt` helper already exists).
  - `script_match` is reserved; when present in `ranking` it is ignored in v1 with warning
    `script-match-unavailable`.

### Markers

Jargon and illustration are rule-based in v1, no model call:

- `MARKER_JARGON`: a segment containing an acronym (2–5 uppercase letters), a number with a
  currency symbol or percent, or a capitalized multi-word term not at sentence start.
- `MARKER_ILLUSTRATION`: a segment containing a demonstrative cue from a per-language list
  ("as you can see", "here is", "come vedete", "ecco").

An optional model-backed labeler can later run through the existing `AgentRun` infrastructure
and write the same marker shape; the brief stays structured either way.

## Assembly outputs

The decision list keeps `version: 1` and its `edits`, `clips`, `rate` shape unchanged, because
`parseRoughCutDecisionList` returns null on unknown versions and materialize, both exporters and
the download route all parse it. Three additive fields:

```ts
type EditDecision = {
  // ...existing fields
  reason?: { code: string; summary: string }; // SPEAKER_SWITCH, HOLD_WIDE, MIN_HOLD, MAX_SHOT, KEPT
};

type CutIsland = {
  key: string; // `${sourceVersionId}:${inFrame}-${outFrame}` at the run's frame rate
  sourceVersionId: string;
  inSeconds: number;
  outSeconds: number;
  reason: { code: 'DEAD_AIR' | 'FALSE_START' | 'REJECTED_TAKE'; summary: string };
  transcriptText: string | null;
};

type Marker = {
  key: string;
  kind: 'INFOGRAPHIC' | 'BROLL';
  timelineSeconds: number;
  durationSeconds: number | null;
  title: string;
  reason: { code: 'MARKER_JARGON' | 'MARKER_ILLUSTRATION'; summary: string };
};

type RoughCutDecisionList = {
  version: 1;
  edits: EditDecision[];
  clips: /* unchanged */;
  rate: /* unchanged */;
  cuts?: CutIsland[];
  markers?: Marker[];
};
```

Reasons sit on the edit itself rather than in a parallel array, so an override that splices an
edit cannot desynchronize provenance.

Exports carry program edits and markers: sequence-level `<marker>` elements in FCP7 XML,
track-level markers in OTIO. Cut islands export as a second marker set only with an explicit
`?cuts=1` on the download route.

## Overrides and regeneration

- `RoughCut.overrides` (JSON) holds the reviewer's decisions:
  `{ version: 1, cuts: Record<key, 'restore' | 'keep'>, markers: Record<key, 'dismiss' | 'keep'> }`.
- `applyOverrides(decisions, overrides)` is a pure function in `lib/rough-cut/`. It re-inserts
  restored islands into the program and re-packs timeline offsets (LINEAR/SEQUENTIAL are
  cursor-based; MULTICAM keeps timeline time). The override route stores overrides and enqueues
  MATERIALIZE_ROUGH_CUT only. Restore and keep never re-run assembly, which downloads every wav
  and shells out to Python.
- `RoughCut.basedOnRoughCutId` links a regenerate to its predecessor. POST accepts `basedOn`;
  the new run copies the pinned overrides forward. After assembly, each pinned key is remapped
  to the new island that overlaps it by at least 80% of the shorter range; keys that no longer
  map are reported in warnings as `override-unmapped` and dropped from the new run.
- Keys are derived from source version plus frame-rounded in/out, never from array position.

## Cut-review UI

Default view after assembly: Program + cuts, on the rough cut's output video page (the run
already materializes a `Video` with `outputVideoId` and the review player).

- Timeline shows kept A-roll.
- Cut islands render on a distinct lane; select → reason, transcript snippet, actions Restore /
  Keep cut.
- Markers render as points; select → kind, suggested title, Dismiss / Keep.
- **Scrubbing removed footage.** The materialized output does not contain removed ranges. The
  island card plays the source clip's own review proxy seeked to the island's in/out in an
  inline preview. Materializing a second "with cuts" proxy is deferred.
- Overrides save immediately; a "Re-render" action materializes; "Regenerate" starts a new run
  with pins copied forward.

View modes for v1: Program, Program + cuts. Sources view is deferred.

Success criterion: editors spend time accepting or restoring a few islands, not rebuilding the
timeline. That is the practical bar for "~95% of a pro editor".

## Data model changes

| Change                       | Shape                                                                   |
| ---------------------------- | ----------------------------------------------------------------------- |
| `EditorialBrief` (new)       | workspace-scoped; `projectType` enum column; `config` JSON; `isDefault` |
| `Folder.editorialBriefId`    | nullable, SetNull on delete, same as `roughCutProfileId`                |
| `Project.editorialBriefId`   | nullable, SetNull on delete; covers root-level cuts                     |
| `RoughCut.briefSnapshot`     | JSON, resolved brief at run time                                        |
| `RoughCut.overrides`         | JSON, nullable                                                          |
| `RoughCut.basedOnRoughCutId` | nullable self-relation                                                  |
| Decision list                | additive `cuts`, `markers`, `edits[].reason`; version stays 1           |

No `RoughCutRevision` table: a `RoughCut` row is already one run. No `TranscriptAsset`: the
transcript tables already fill that role. The existing `EditPlan` (`lib/agents/edit-plan.ts`,
cut/keep operations for agent runs) stays as-is for agent-driven edits; it is not the override
format because it has no stable keys.

## Error handling

| Situation                                       | Behaviour                                                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Transcript pending, under 15 min                | requeue with delay; warning `waiting-for-transcript`                                                                |
| Transcript failed / absent / timed out          | VAD fallback; warning `weak-transcript`; review UI shows "review carefully"                                         |
| Sync failure (multicam)                         | existing sync report warnings; camera grammar degrades to wide/hold                                                 |
| Program empty after silence policy              | keep the existing full-clip fallback; warning `empty-program` suggesting lower aggressiveness (do not fail the run) |
| Pinned override no longer maps after regenerate | keep the rest; warning `override-unmapped` listing keys                                                             |
| `script_match` requested                        | ignored; warning `script-match-unavailable`                                                                         |

## Phasing

### v1 — Trustworthy A-roll + audit

1. Assembler reads the canonical transcript with the waiting rule and VAD fallback. **Done.**
   The job moved from `worker/src` to `lib/rough-cut/assemble-job.ts` so it is type-checked,
   linted and unit tested with the app; the worker re-exports it.
2. Brief model, three templates, folder/project binding, merge order, `briefSnapshot`.
3. Assembly: dead air, false starts, take selection (talking head / interview), multicam
   grammar with `holdWideOnChaos`.
4. Additive decision-list fields with reasons; placeholder markers.
5. Overrides route, `applyOverrides`, re-materialize, regenerate with pins.
6. Cut-review UI on the output video page with source-proxy preview.
7. Markers in FCP7 XML / OTIO; cut islands as opt-in marker set.

### v2 — Layered show edit

- Resolve markers to real B-roll / infographic assets
- Alternate A/B coverage as first-class policy
- Model-backed jargon / illustration labeler via `AgentRun`
- Per-segment transcript confidence; skip transcription of secondary cameras
- Stronger Ascensore house-style tuning from real episodes (optional example-driven layer)

### Explicitly out of v1

- Auto-picking B-roll media
- Generating infographic artwork
- Learning style parameters from reference edits as the primary system
- A persisted material model

## Testing strategy

Follows `AGENTS.md`: one layer per change, literals written by hand, and every new API route
classified in `tests/api/auth-matrix.test.ts` or the suite fails.

- **Unit (`tests/unit/lib/`)**: brief parsing and defaults; merge order (a brief technical
  override beats the folder profile, a dialog value beats the brief); aggressiveness mapping
  table; beat grouping and take grouping on small synthetic transcripts, one English and one
  Italian; take scoring order including the recency tiebreak; false-start prefix rule; marker
  rules; `holdWideOnChaos` window rule; cut-island key derivation; `applyOverrides` re-packing;
  override remap at exactly 80% and just under.
- **Unit, exporters**: FCP7 XML and OTIO markers present and absent; cut set only with the flag.
- **API (`tests/api/`)**: brief CRUD and binding routes (unauthenticated, signed-in but
  unauthorized, happy path asserting rows); overrides route asserts the `overrides` column and a
  MATERIALIZE_ROUGH_CUT job row and no ASSEMBLE job; regenerate with `basedOn` copies pins.
- **Worker**: assemble with a READY transcript uses it (no VAD call recorded); PENDING transcript
  under the timeout requeues; past the timeout falls back with `weak-transcript`.
- **Component (`tests/component/`)**: restore / keep interactions and the inline source preview
  seek.
- **Regenerate**: a fixture where the second assembly shifts an island by three frames still
  keeps the pin; a shift past the tolerance reports `override-unmapped`.
- Avoid tests that restate template constants; each test names the assembler mutation it
  would catch.

## Non-goals (this design)

- Replacing the NLE for finishing
- Fully autonomous "ship without review" for Ascensore
- Unified LLM prompt that replaces the structured brief

## Resolved in this revision

- Material model: derive-on-read inside the job, not persisted.
- Decision list: additive fields on version 1; marker mapping per exporter as above.
- Brief UI: a card on the workspace settings page next to rough-cut profiles for templates, plus
  a selector in the rough-cut dialog and folder settings for binding.
- Transcript provider: whatever is configured; diarization stays optional (pyannote when
  enabled, per-camera RMS attribution otherwise). The quality bar is enforced by the weak-
  transcript rule, not by provider choice.

## Open questions for implementation planning

- Whether `Project.editorialBriefId` should also carry a `roughCutProfileId` so root-level cuts
  stop skipping folder profiles entirely (small, related fix).
- ~~Exact pg-boss retry configuration for the waiting rule.~~ Resolved: a delayed `media_jobs`
  row (`run_after`) rather than pg-boss retries, so the wait survives a worker restart and shows
  up in the same table as every other job.
