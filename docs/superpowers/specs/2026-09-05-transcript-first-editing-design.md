# Transcript-first editing, cut review and burn-in

- **Date:** 2026-09-05
- **Status:** Implemented on `feat/transcript-first-editing` (from `master` `9174c31`)
- **Follows:** `docs/superpowers/specs/2026-09-04-editorial-brief-design.md`, whose phases 1–4
  and 7 shipped first. This note covers what the operator's first real test of the talking-point
  editor turned up, and closes that design's phases 5 and 6.

## Problem

Three observations, all from one session with a talking-point recording:

1. **The same take came out twice.** The assembler fell back to voice-activity detection
   whenever a clip had no transcript, and VAD knows nothing about what was said, so a retake
   was simply more speech to keep. Even with a transcript, take grouping was Jaccard-only:
   a retake that re-said a piece of a longer take scored far below the threshold and the two
   were kept as separate beats.
2. **Transcription had to be started by hand.** Nothing enqueued it when a run was requested,
   so an operator who asked for a rough cut on freshly uploaded footage got the VAD path
   unless they had remembered to transcribe first.
3. **Adding subtitles paid for a second AI transcription.** "Generate with AI" in the player
   went to the transcription provider without checking whether the version already held a
   READY transcript with every word and timing a caption file needs.

Underneath all three: the transcript was treated as an optimisation rather than as the source
of truth for an edit that is entirely about what was said.

## Decisions

| Decision                                                                                               | Where                                                                            |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| With transcription enabled, a transcript is **required**; the assembler fails rather than degrading    | `lib/rough-cut/assemble-job.ts`, `lib/rough-cut/transcript-source.ts`            |
| A run waits up to **two hours** for a pending transcript, then fails with an operator-facing error     | `TRANSCRIPT_REQUIRED_WAIT_LIMIT_SECONDS` in `lib/rough-cut/transcript-source.ts` |
| Transcription is enqueued when the run is **created**, and again by the job if a clip still has none   | `lib/transcription/ensure.ts`, `lib/rough-cut/assemble-job.ts`                   |
| Takes group by Jaccard **or containment**, and partly-overlapping takes are **spliced**, not both kept | `lib/rough-cut/takes.ts`, `containment` in `lib/rough-cut/text.ts`               |
| An optional per-run **script** aligns and ranks takes, with `script_match` ranked first                | `lib/rough-cut/script.ts`                                                        |
| Every render derives the output version's **transcript from the sources and the edit list**            | `lib/rough-cut/derived-transcript.ts`, `lib/rough-cut/materialize-job.ts`        |
| Reviewer overrides are keyed by **island / source range**, so they survive a re-run                    | `lib/rough-cut/overrides.ts`                                                     |
| A re-render is a **new version of the output video**, not a new video                                  | `lib/rough-cut/output-version.ts`                                                |
| Burning in subtitles is a **media job** producing a new version, transcript carried forward            | `lib/rough-cut/burn-in-job.ts`                                                   |

### Transcript required when transcription is on

`isTranscriptionEnvEnabled` in `lib/rough-cut/env.ts` is on unless
`OPENFRAME_ENABLE_TRANSCRIPTION` is literally `false` (any case), mirroring
`isTranscriptionFeatureEnabled` in `lib/feature-flags.ts` for a worker that cannot import the
Next.js module. When it is on, the assembler treats a missing transcript as a failure rather
than a reason to reach for the wav:

- `decideTranscriptSource` takes a `waitLimitSeconds` override. The required path passes
  `TRANSCRIPT_REQUIRED_WAIT_LIMIT_SECONDS` (2 hours) instead of the fallback path's
  `TRANSCRIPT_WAIT_LIMIT_SECONDS` (15 minutes), because a host that has no fallback to degrade
  to cannot afford to give up on a long queue.
- A `wait` decision defers the job (`deferForTranscript`, `TRANSCRIPT_RETRY_DELAY_SECONDS` =
  60 s) and stores a `waiting-for-transcript` warning on the run so the dialog can say so.
- A `fallback` decision whose reason is `missing` and whose run is still inside the wait limit
  enqueues the transcription itself and waits. Any other reason — `failed`, `timed-out`, or a
  READY transcript with no segment rows (`empty`) — throws `transcriptRequiredError`, which
  names the clip and says what to do ("re-run or upload its transcript, then generate the cut
  again").

Multicam reads one transcript for the whole session, the wide camera's when it has one; linear
layouts read one per clip. The candidate list is built before any media is downloaded, so a run
that has to wait costs one query rather than a camera file across the network.

### Auto-enqueue at run creation

`ensureTranscriptsForVersions` (`lib/transcription/ensure.ts`) runs from
`POST /api/projects/[projectId]/rough-cuts`. It leaves READY and in-progress rows alone and
starts one for a version with no row or only FAILED rows, through the same
`startVersionTranscription` (`lib/media-jobs.ts`) an upload uses — so the EXTRACT_AUDIO and
TRANSCRIBE jobs, the inline runner and the provider choice are shared rather than reimplemented.
This does not make a rough cut possible on a host with no media worker; what it buys is timing.
The jobs are queued from the request, and the run carries its waiting warning immediately rather
than after a round trip through the assembler. For MULTICAM only the wide camera is transcribed.

### Containment grouping and splicing

Jaccard punishes the retake that only re-says part of a longer take, because the longer take's
extra trigrams count against it. `containment` (`lib/rough-cut/text.ts`) measures the share of
the smaller set found in the larger one instead. `groupTakes` runs it only when Jaccard fails,
and only with guards, because a stock phrase sits inside plenty of unrelated beats:

| Constant                      | Value | Meaning                                                         |
| ----------------------------- | ----- | --------------------------------------------------------------- |
| `TAKE_SIMILARITY_THRESHOLD`   | 0.5   | Jaccard overlap that groups two beats                           |
| `TAKE_CONTAINMENT_THRESHOLD`  | 0.6   | Share of the shorter take's trigrams the longer must contain    |
| `TAKE_CONTAINMENT_MIN_TOKENS` | 6     | Content tokens the shorter take needs before containment counts |
| `TAKE_CONTAINMENT_MAX_RATIO`  | 3     | How many times longer the containing take may be                |
| `TAKE_WINDOW_SECONDS`         | 600   | Timeline distance beyond which two beats are not takes          |

Grouping is not enough on its own: two takes that share only their middle used to be kept whole,
which is what the operator saw. `resolveTakes` now splices. The anchor is the largest take, then
the best-ranked; every other member is measured against what the anchor already covers
(`TAKE_COVERED_WHOLE` 0.8, `TAKE_COVERED_NONE` 0.2) and is dropped when the anchor says all of
it, trimmed at its edge when the overlap sits at one end, and kept with a `take-overlap-kept`
warning only when the overlap is in the middle of both. A splice that would leave less than the
run's `minShotSeconds` (default `TAKE_MIN_SURVIVING_SECONDS`, 1.5 s) is refused rather than
producing a fragment the assembler would silently drop.

### Optional original script

`rough_cuts.script` holds the copy the speaker read, up to `SCRIPT_MAX_CHARS` (20 000).
`lib/rough-cut/script.ts` splits it into lines on newlines and sentence ends (sparing common
abbreviations and single-letter initials), keeps lines of at least `SCRIPT_LINE_MIN_TOKENS` (3)
content tokens, and builds trigram shingles per line plus one set for the whole script read end
to end. A beat's alignment carries the lines it covers (`SCRIPT_LINE_COVERAGE` 0.5 of a line's
trigrams) and its on-script score against the whole-script shingles, so a verbatim read of two
consecutive lines scores as fully on script even though the trigrams straddling the break belong
to no single line. Beats covering the same line are grouped as takes of it, and
`rankingWithScript` puts `script_match` in front of whatever the brief ranks by.

**Guidelines are not the script.** `Project.editorialGuidelines` is free text from upstream. Every
run copies it onto the brief snapshot as `projectGuidelines` and **the assembler never reads it**.
What the assembler acts on is the structured editorial brief and, when there is one, this
per-run script. Writing an instruction into the guidelines box will not change a cut, so both
screens now say so: the project settings field describes itself as notes for reviewers that travel
with the run, and the run dialog says under "Original script" that the script — not the guidelines
— is what guides take selection.

### Derived transcript on every render

`deriveProgramTranscript` (`lib/rough-cut/derived-transcript.ts`) takes the source transcripts and
the final edit list and produces the output version's own transcript in program time, provider
`rough-cut` (`DERIVED_TRANSCRIPT_PROVIDER`). Each word belongs to exactly one edit, so a word
never appears twice when two clips overlap in source time; segments break at
`DERIVED_SEGMENT_MAX_WORDS` (18) or `DERIVED_SEGMENT_MAX_SECONDS` (8). `persistDerivedTranscript`
writes the rows and a WebVTT caption track through `upsertCaptionTrack`
(`lib/rough-cut/caption-track.ts`). The only WebVTT serializer in the repo is `serializeWebVtt`
in `lib/subtitle-validation.ts`; the worker image copies that file so both sides emit the same
bytes.

Captions for any version are built from its transcript by
`POST /api/versions/[versionId]/transcript/captions` (`lib/transcript-caption.ts`), and the
player's "Generate with AI" probes for a captionable transcript first (`use-subtitles.ts`), so
the second AI transcription is only paid for when there is genuinely nothing to caption. A probe
that fails to answer is deliberately not treated as "no transcript".

### Overrides keyed by island / source range

`rough_cuts.overrides` holds `{ version: 1, cuts: { [islandKey]: 'restore' | 'keep' }, extraCuts }`
(`lib/rough-cut/overrides.ts`). Island keys are assembly's own keys; extra cuts are source ranges
with a stable `extraCutKey`. Both are addressed in source time rather than program time, so a
second assembly that shifts the timeline does not orphan the reviewer's decisions.
`applyOverrides` / `effectiveDecisions` are pure and are what materialization, the review payload
and the exports all read; `needsRender` compares the saved overrides against
`rendered_overrides` / `rendered_decisions` so the pane can tell a saved change from a rendered
one. Limits: `MAX_EXTRA_CUTS` 200, `MIN_EXTRA_CUT_SECONDS` 0.1, note ≤ 300 characters.

### Re-render as a new version of the output video

`POST /api/rough-cuts/[roughCutId]/render` queues a `MATERIALIZE_ROUGH_CUT` job. `addOutputVersion`
(`lib/rough-cut/output-version.ts`) adds the result as another version of the video that is already
there, labelled `Re-render <n>`, so comments and share links stay where they are. Reading the
highest version number, deactivating the current versions and inserting the new one is one
transaction behind a `FOR UPDATE` on the video. The route checks for a running render and queues
one inside a single transaction held by `lockResourceInTransaction` (`lib/advisory-lock.ts`), keyed
per rough cut, so two clicks a moment apart cannot both see an idle cut.

### Burn-in as a media job into a new version

`BURN_SUBTITLES` renders an ASS document with libass while ffmpeg re-encodes
(`lib/rough-cut/burn-in-job.ts`, `lib/rough-cut/subtitle-style.ts`), and lands the result as a new
version labelled `Subtitled` (or `Subtitled 1.25x`) through the same `addOutputVersion`. The
transcript travels with it, re-timed when the playback rate changed, so the burned copy is
searchable and reviewable without being transcribed again, and a PROBE_MEDIA job is queued for the
new version. Style: font (one of `BURN_IN_FONTS`), size 16–120 at a 1080-high reference, colours,
outline width, box opacity, position, margin, bold, uppercase, words per cue, maximum cue seconds,
and `playbackRate` 0.5–2, which re-times video and audio with `setpts` / `atempo` and divides the
cue times to match.

## Data model

Migration `prisma/migrations/20260907120000_transcript_first_editing`:

- `MediaJobKind` gains `BURN_SUBTITLES`.
- `rough_cuts.script` (`TEXT`) — the copy the speaker read.
- `rough_cuts.overrides` (`JSONB`) — the reviewer's restore/keep decisions and extra cuts.
- `rough_cuts.rendered_overrides` (`JSONB`) and `rough_cuts.rendered_decisions` (`JSONB`) — what
  the last materialization actually rendered, so the review pane can tell a saved-but-unrendered
  change from a rendered one and map output time back to source time.

No column was removed and no existing shape changed, so the migration is safe to apply ahead of
the deploy.

## API

| Route                                                             | Change                                                                                                                     |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/projects/[projectId]/rough-cuts`                       | Accepts `script`; calls `ensureTranscriptsForVersions` for the source versions (wide only for MULTICAM)                    |
| `GET /api/rough-cuts/[roughCutId]`                                | `?include=review` adds the review payload; the script is returned only to a caller who may edit                            |
| `PUT /api/rough-cuts/[roughCutId]/overrides`                      | Saves the reviewer's overrides, validated against the run's decisions                                                      |
| `POST /api/rough-cuts/[roughCutId]/render`                        | Queues a re-render; 409 while one is already running                                                                       |
| `GET /api/rough-cuts/[roughCutId]/download`                       | Exports the **effective** program; `?cuts=1` marks the cuts that are still cuts, reviewer cuts included                    |
| `GET /api/videos/[videoId]/rough-cut`                             | The run behind a delivered cut; `{ roughCut: null }` for an ordinary video, `review: null` for a commenter                 |
| `POST /api/videos/[videoId]/burn-in`                              | Queues a `BURN_SUBTITLES` job; 409 while one is active for that version                                                    |
| `GET /api/videos/[videoId]/burn-in`                               | The version's burn-in job, ignoring its PROBE_MEDIA row                                                                    |
| `POST /api/versions/[versionId]/transcript/captions`              | Builds the caption track from the version's own transcript, without transcribing again                                     |
| `PATCH /api/versions/[versionId]/transcript/segments/[segmentId]` | Edits one transcript line (text ≤ 2000, speaker ≤ 80), blanks that line's stale translation and rebuilds the caption track |

Burn-in source resolution lives in the route (`resolveSource`), which pins the chosen id into the
job payload; the job re-derives the same rule only for a payload that names no transcript, so the
two rules have to be kept in step by hand. The order: an explicit `subtitleId` wins; otherwise the
READY transcript in the requested `language` (and an explicit language never falls back to a
caption track); otherwise the **newest** READY transcript — the one the pane displays and the one
`POST .../transcript/captions` builds from, so a version carrying two of them burns the words the
operator is reading; otherwise the oldest caption track.

## UI

- **Run dialog** (`components/rough-cut-dialog.tsx`): an "Original script (optional)" textarea
  capped at `SCRIPT_MAX_CHARS`, with copy that changes when the brief keeps a single take and the
  script will only be recorded.
- **Waiting copy**: the dialog and the edit workspace both show "Waiting for the transcript…"
  while a run carries the `waiting-for-transcript` warning (`isWaitingForTranscript` in
  `lib/rough-cut/workspace.ts`).
- **Cuts tab** (`components/video-page/rough-cut-review-pane.tsx`): a third tab on the output
  video beside Comments and Assets, listing every removal with its reason, Restore / Keep per
  island, notes, extra cuts marked on the timeline, Save and Re-render.
  `rough-cut-source-preview.tsx` plays the uncut source range so a reviewer can hear what was
  removed; the state lives in `hooks/use-rough-cut-review.ts`.
- **Transcript line editing** (`components/video-page/transcript-pane.tsx`): a pencil per line
  opening a text and speaker editor, disabled while a translation overlay is shown so an edit
  cannot save the translation over the original. The caption track is rebuilt in place, and the
  pane reports when it was not — separately for a full account, a version already at its track
  limit, and an untimed transcript, since only the first two have anything the operator can do
  about them. The edited line's entry in the transcript's `translatedTexts` array is blanked in
  the same transaction, so the overlay falls back to the corrected original instead of showing a
  translation of the words the line used to say; the rest of the translation is left alone.
- **Captions from the transcript**: "Generate with AI" in the subtitle menu builds from the
  transcript when there is one.
- **Burn-in dialog** (`components/video-page/burn-in-dialog.tsx`): reached from "Burn subtitles
  into a new version" in the subtitle menu, with a live preview (`burn-in-preview.tsx`) of the
  chosen style. `hooks/use-burn-in.ts` polls every 4 s (`BURN_IN_POLL_MS`) and adopts a job that
  is already running when the page loads, so a reload in the middle of a burn does not show an
  idle dialog.

## Warnings

Run warnings the operator can see, all on the `RoughCut.warnings` column:

| Code                     | Meaning                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| `waiting-for-transcript` | The run is deferred until the named clips' transcripts are ready; it continues on its own     |
| `take-overlap-kept`      | A take overlaps material already in the cut in the middle of both, so it could not be trimmed |
| `script-lines-missing`   | Script lines with no matching take among the selected takes, with up to three quoted          |
| `off-script-beats`       | Kept beats scoring below `SCRIPT_OFF_SCRIPT_THRESHOLD` (0.2) against the script               |
| `script-ignored`         | A script was given but the brief does not select takes                                        |
| `script-unreadable`      | The script has no line of three or more words                                                 |

`script-match-unavailable` (the brief ranks by script match and the run has no script) and the
pre-existing `weak-transcript` also still apply.

## Operations

- **`OPENFRAME_ENABLE_TRANSCRIPTION`** — on unless literally `false`. With it on, a rough cut
  waits for its transcripts and fails rather than falling back to voice activity. Turning it off
  restores the old VAD fallback with the 15-minute wait.
- **Wait limits** — `TRANSCRIPT_REQUIRED_WAIT_LIMIT_SECONDS` 2 h (required path),
  `TRANSCRIPT_WAIT_LIMIT_SECONDS` 15 min (fallback path), `TRANSCRIPT_RETRY_DELAY_SECONDS` 60 s
  between attempts. A waiting run is a delayed `media_jobs` row, so it survives a worker restart
  and is visible in the same table as every other job.
- **Worker fonts** — `worker/Dockerfile` installs `fontconfig`, `fonts-dejavu-core`,
  `fonts-liberation2`, `fonts-roboto` and `fonts-open-sans`, and asserts each family in
  `BURN_IN_FONTS` with `fc-match` at build time. libass substitutes a font it cannot find
  silently rather than reporting it, so a missing package would ship as burned-in text in the
  wrong typeface; the assertion fails the build instead. The image also copies
  `lib/subtitle-validation.ts` for the shared WebVTT serializer.
- **Job kinds** — the worker now runs `BURN_SUBTITLES` in addition to `PROBE_MEDIA`,
  `EXTRACT_AUDIO`, `TRANSCRIBE`, `TRANSCODE_PROXY`, `DIARIZE`, `ASSEMBLE_ROUGH_CUT`,
  `IMPORT_DRIVE` and `MATERIALIZE_ROUGH_CUT`.
- **Migration** — apply `20260907120000_transcript_first_editing` with `bun run db:migrate`
  before the deploy.
- **Rebuild the media worker before the app that can queue a burn-in.** The image needs the new
  fonts, the new files under `lib/rough-cut`, and `zod` (now a worker dependency). A worker that
  is behind no longer breaks the pipeline, but it still cannot run the job: `queueForKind` in
  `worker/src/index.ts` raises `UnknownJobKindError`, and `publishClaimedJobs`
  (`lib/media-job-queue.ts`) puts that one row back to `PENDING`, logs it, and **carries on
  publishing the rest of the batch**. The burn-in waits at `PENDING` — claimed and released on
  every tick — until the worker is rebuilt, and everything else queued behind it keeps moving.
  What to grep for in the worker's output: the per-job line naming the job id, the kind and
  `the worker image is out of date`, and, for a genuine queue failure, `worker publish error`.

  This matters because the failure it replaces was silent and total. `claimDueMediaJobs` commits
  the whole batch of up to `MEDIA_JOB_PUBLISH_BATCH` (20) rows as `QUEUED` before any of them is
  published, and nothing anywhere moves a `QUEUED` row back, so the old rethrow stranded every job
  claimed after the burn-in — permanently, and again on every later tick. One un-runnable burn-in
  stopped the probes, transcriptions and proxies behind it. A queue that is genuinely down still
  stops the batch, because there is nowhere to publish the rest to either.

## Known limitations

- **Editing a derived transcript does not survive a re-render.** A line edited on an output
  version's `rough-cut` transcript fixes that version's rows and its caption track, but the next
  render regenerates the derived transcript from the sources. Corrections that must survive
  re-renders belong on the source version's transcript.
- **A near-empty burn looks like a successful one.** Burn-in drops transcript lines that carry no
  timings and draws the rest, so a transcript that timed only a few of its lines renders
  "successfully" with only those few cues on screen. The job logs how many lines it dropped, and
  it refuses outright only when nothing at all was timed. There is nothing in the UI that says a
  burn was mostly blank.
- **A media job stuck at RUNNING has no reaper.** If a worker dies mid-job the row stays RUNNING
  and the 409 guard refuses every later request for that version forever. This is inherited, not
  new: it affects `TRANSCODE_PROXY` and the rough-cut render the same way.
- **Burn-in buffers the whole encode.** The re-encoded master is read into one `Buffer` before
  upload, so peak memory tracks the output file. There is no HDR tonemapping either; both are
  inherited from materialization.
- **Caption-track objects are replaced, not deleted, on the worker path.** `upsertCaptionTrack`
  points the row at a new R2 object and leaves the old one behind. The app-side rebuild
  (`lib/transcript-caption.ts`) does delete the stale object.
- **The Cuts list is not virtualised.** A run with hundreds of removals renders all of them.
- **Marker re-placement after overrides is approximate.** A restored island shifts the program,
  and markers are mapped onto the new axis rather than re-derived from the words.

## Out of scope / follow-ups

- A reaper for media jobs stuck at RUNNING after a worker crash, so a dead job stops blocking the
  version.
- Surfacing a near-empty burn in the UI. The job logs how many untimed lines it skipped, but a
  render that drew three cues over twenty minutes still reports plain success.
- Moving `lib/rough-cut/review.ts` out of `lib/rough-cut/`. It imports through `@/` (as the
  pre-existing `load.ts` and `serialize.ts` do) inside the directory `worker/Dockerfile` copies
  wholesale. Harmless while the worker's import graph never reaches it, and a trap the day
  something in the worker does.
- Trimming the review payload. It ships `effective`, `applied` and `script`, none of which the
  Cuts pane reads.
- Streaming the burn-in upload instead of buffering it, and HDR tonemapping on both render paths.
- Deleting the superseded caption object on the worker path.
- Virtualising the Cuts list.
- Re-deriving markers after overrides rather than re-placing them.
- Per-viewer forensic marks (see INTERNAL.md, "What this deployment will not do").
- Model-backed script alignment, which would beat trigram shingles on paraphrase.
- A cost-shaped rate-limit bucket. Burn-in and render currently share the `mutate` bucket with
  every cheap write, and both cost minutes of worker time.
