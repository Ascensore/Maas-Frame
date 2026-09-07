# AI editing from timeline feedback

AI editing executes cuts, trims, motion graphics and B-roll from timeline comments on rendered
OpenFrame rough cuts. Queued comments can also share a single draft. Each execution creates a separate draft video. The original reviewed
video, its versions, and its rough-cut overrides remain intact.

## Using it

1. Open a rendered rough cut as a project editor and mark an In/Out range.
2. Write text feedback describing a cut, trim, graphic or B-roll overlay.
3. In the comment composer, choose **Leave for human editor**, **Run with AI after posting**,
   or **Queue for AI later**. Existing comments expose the same run/queue controls.
4. A queued task starts only when an editor clicks **Run with AI**. A running task reports
   planning and rendering progress on the comment.
5. **Preview draft** plays the exact generated version inline. **Accept & resolve** accepts
   that draft and resolves the original comment. **Open draft** opens its video for further
   review and editing. If that video is subsequently re-rendered, the inline preview remains
   pinned to the version produced by this task.
6. **Hand to editor** returns feedback to human assignment and reopens a resolved comment.
   Previously generated drafts remain available in the project. A running task must finish
   before assignment can change.

## Review, adjust, and undo

**What changed** lists the executed cuts, keeps, graphics and B-roll with times on the original
reviewed video. **Adjust draft** accepts up to 2,000 characters of follow-up feedback and
generates a complete replacement plan against that same original source map. It does not
apply a second set of cuts to already shortened footage. The original comment stays intact;
up to ten successive adjustments retain their ordered feedback and the previous edit plan.

An adjustment reopens the comment, including one that was already accepted. For shared drafts,
it reopens the whole batch and rebuilds one shared draft, while reusing the unchanged members'
plans exactly. Changed comment text or ranges, missing previous plans, unavailable outputs,
stale draft IDs and overlapping incompatible edits are refused. Retrying a failed adjustment
preserves the adjustment and retries the whole shared batch.

**Earlier drafts** shows the 20 most recently archived attempts, including after human handoff
or a failed revision. Previews remain pinned to the output versions that were actually
reviewed. Deleted or moved outputs are unavailable from the history; attempts are retained
until their comment is deleted. Older drafts created before this feature are archived when
they are next replaced or handed off; already overwritten task associations cannot be recovered.

**Undo acceptance** reopens the comment (or every member of a shared batch) and returns the
same draft to review without starting a render. Acceptance never replaces the original video.
The web controls identify the draft being accepted; accepting from a stale browser view is
refused if a newer run has replaced it.

## Roadmap status

The web workflow now includes immediate/deferred AI execution, human handoff, cut/trim and
graphics/B-roll rendering, workspace presets and layout previews, visual B-roll samples,
compatible comment batches, per-comment change summaries, adjustments, earlier draft previews
and undoing acceptance.

DaVinci Resolve, Premiere Pro and After Effects development and live validation are excluded
from this roadmap at the user’s request. Editable native motion templates and direct native
timeline execution are therefore not remaining web-editor tasks. Existing native draft import
and editable-title adapters remain experimental and optional. The web feature roadmap is
complete; production rollout is a separate release step described below.

A queued task preserves the text, marked range, reviewed version, and source decisions from
when it was queued. Later edits to the comment do not silently rewrite that instruction.
Acceptance is refused if the comment's instruction or range has changed. Hand it to an editor
and queue it again to use the revised feedback.

## Runtime setup

Apply the `20260909100000_comment_edit_tasks` Prisma migration with the project's deployment
migration process, then generate the Prisma client (`bun run db:generate`). The new schema is
required by both the app and the media worker.

Use the existing agent configuration: `OPENFRAME_ENABLE_AGENTS=true`, a supported
`OPENFRAME_AGENT_MODEL`, and the model provider/gateway credentials. The default `mock` model
is for development and does not execute natural-language feedback. No new AI provider is added.

Run the existing agent worker (`bun run agent-worker`) and media worker with the updated code.
The first produces and validates the plan; the second runs FFmpeg and uploads the draft. Both
must have access to the same database. The media worker needs the existing R2/S3 configuration
and source files.

Older rough-cut outputs need one re-render before AI editing. This establishes an exact link
between the output version and its source map. The migration deliberately does not infer that
link: an active version may be a replacement upload or a reactivated older version.

## Graphics and B-roll

Open **Graphics & B-roll presets** on an existing comment before queueing or running it.
The lower-third and editorial-callout templates animate in and out, with configurable accent
color. Workspace editors can use **Customize workspace presets** to save lower thirds, callouts
and full-frame title cards with a name, font, title/subtitle sizes and three brand colors.
Select a saved preset to restrict the planner to it. Updating increments its revision; archiving
hides it from new requests. The library allows 50 active custom presets. Existing queued tasks
and drafts retain their frozen styles, including after a preset is updated or archived. Specify exact title/subtitle text in the comment. Templates and their version/colors
are frozen when queued. Graphics last up to 30 seconds and stay inside the selected range.
Selected presets and presets being customized include an interactive layout preview with
sample title/subtitle text. Preview text does not become feedback or saved preset content.
Browser font rendering can differ; the rendered draft remains the final check for typography
and entrance/exit motion.

Choose an uploaded project video as the explicit B-roll source, or allow automatic selection.
For automatic selection, set a video's metadata field **usage** to **broll** and give it a
descriptive title and subject metadata. The AI selects from up to 100 recent eligible tagged
uploads. Use **Analyze selected B-roll** to sample three frames at 10%, 50% and 90% of its
duration. Wait for the analysis to succeed before queueing feedback. The model receives actual
JPEG frames and their source times for up to eight analyzed candidates per comment; remaining
candidates supply metadata only. Sparse frames are evidence of those moments, not a full-video
understanding pass. The configured model must support image inputs. No new provider is added.
An explicit selection restricts the AI to that source. No stock search or invented asset URLs.
The cover preset fills the picture while retaining the original speech audio. Source trims
must fit the uploaded video's duration. Source identity is checked again after planning.

The selected B-roll now shows its three sampled images with source timestamps directly in
OpenFrame. Analysis progress refreshes automatically; failures show their error and offer a
retry. Reanalysis keeps the previous samples visible until the replacement succeeds, and
already queued feedback continues to use its original frozen samples. Frame previews require
project editing permission and are tied to the analysis generation, so an old preview URL
cannot silently display a newer sample. Unavailable images show a refresh hint.

The web workflow—presets, B-roll analysis, AI rendering, preview, acceptance, and human
handoff—runs without a native editor. DaVinci Resolve, Premiere Pro and After Effects are
excluded from this roadmap and are not prerequisites for using these features.

## Coordinated comment batches

Queue between 2 and 20 unresolved comments on the same reviewed version, then choose
**Run queued comments together**. Every comment keeps its original instruction and range.
The batch is validated before creating a render: a failed or unsupported member prevents
any partial draft. All cuts use original reviewed coordinates so later comments do not drift.
Overlapping comment ranges are allowed when their operations are compatible: overlapping cuts
are merged, identical graphics are deduplicated, and separate visual lanes can overlap.
Contradictory keep/cut instructions, cuts through another comment’s requested visual, and
competing graphics or B-roll are refused with the conflicting comment positions. Revise those
instructions or run them separately. Different source maps are still refused; independent
frozen preset revisions and colors are preserved. One shared preview is pinned to all
members. **Accept & resolve** and **Hand to editor** apply to the entire batch. If any comment
changed after queueing, acceptance resolves none of the comments.

## Optional native adapters (excluded from this roadmap)

The editor panels can start a comment with **Run feedback with AI** and read its progress with
**Refresh draft status**. First sync the active native timeline to the reviewed version: the
server requires the requesting user’s own matching sequence link. Execution produces a separate
reviewable draft; it does not rewrite an arbitrary existing native timeline in place.

On a ready draft, expand **Continue in Premiere or Resolve**, copy its comment ID, and paste
it into the updated OpenFrame panel's **AI draft comment ID** field. **Import AI draft**
downloads the exact referenced media into a permanent folder you choose, then creates a new
1080p sequence/timeline. The existing timeline is preserved. Repeating an import recognizes
its named draft in the same project. Imported timelines may be edited independently.

Cuts and B-roll remain source-editable; speech uses the exact reviewed draft audio. Graphics
are rendered composite sections, so text/style changes currently happen in OpenFrame and
need another render in the default import mode. Experimental **Editable Fusion titles** creates
editable text, color, mask and merge nodes on the imported Resolve graphic clips. These are
static editable counterparts; the rendered preview retains the canonical entrance/exit motion.
Experimental **Editable MOGRT titles** binds the frozen text/style settings to explicitly chosen
local templates in Premiere. See the panel README for filenames and required exposed controls.
No MOGRT binary or After Effects authoring environment is bundled. Compare native output with
the reviewed render; fonts, layout and motion can differ between hosts.
The old rough-cut XML/OTIO download refuses graphics-bearing drafts instead of silently
omitting their overlays. The panel downloads a dedicated FCP7 XML package including them.

Both panels include the same bounded media download protocol, validating ranges,
source identities and filenames. A failed download does not invoke the host importer. The
Resolve plugin now includes its registration manifest and initializes the installed Studio
WorkflowIntegration module; follow the updated NLE README for that module's installation.
Native imports and title conversion have automated adapter/protocol/rollback tests. Live
Resolve Studio 18.6 validation in the isolated “OpenFrame native validation 2026-09-06” project
confirmed editable lower-third text and subtitle, transparency, and a 1080p output frame.
Unavailable fonts are refused before replacing any rendered graphics; the font's Bold and
subtitle Regular styles must be installed. Resolve B-roll uses Fill scaling to preserve the
reviewed cover crop with non-16:9 footage. Premiere is not installed locally, and the complete
Workflow Integration panel still needs acceptance testing. These integrations remain experimental.
The full importer replay through Resolve's external Python API stalled after creating the
timeline, on its first item-list query; full import acceptance remains incomplete.

## Execution contract

- Only users with `checkProjectAccess().canEdit` can read or change editing tasks. Agent
  execution checks that permission before and after the model request.
- New tasks require an active version that exactly matches the rough cut's
  `renderedVersionId`, its persisted `renderedDecisions`, and uploaded R2 sources from the
  same project. A render in progress prevents a new snapshot.
- The model receives only the selected comment as executable feedback, with transcript
  context. Cuts and keeps refer to the immutable reviewed timeline. Keeps apply only within
  the selected range; the rest of the video is preserved.
- Validation rejects empty plans, out-of-range operations, mixed cut/keep plans, sub-frame cuts,
  and deletion of the entire video. Overlapping cuts are merged before applying them.
- Mapping occurs per timeline occurrence, so a repeated use of a source clip is not cut twice.
  Surviving markers move with the footage, and markers inside removed material are dropped.
- A transaction under a per-comment lock creates the task/run. Another transaction atomically
  creates the draft decisions, media job, and successful planning result. Repeated execution
  of the same completed agent run cannot queue another render.
- Planning completion is distinct from render completion. A failed plan or render leaves the
  comment unresolved and supports retry or human handoff. A stopped worker can leave work
  waiting in the existing worker queue; this release does not add a worker watchdog.

## Deployment after phase one

Apply migration `20260910100000_comment_edit_batches` and generate the Prisma client.
It replaces the unique run/render indexes with ordinary indexes so comments can share a draft.
Use a coordinated rollout: stop the agent worker, apply the migration, rebuild the media worker,
rebuild the agent worker, and deploy the updated web app. The older renderer cannot process
these effect layers. Both workers must use this code before requesting graphics or batches.
The existing AI Gateway configuration is unchanged.

On the current server the Compose file is `docker-compose.worker.yml`, with `.env.worker`
and `.env.agent`. It is server-owned; do not replace it with the full-stack repo Compose file.

Apply `20260911100000_edit_presets` for workspace presets, sampled-frame evidence and the
`ANALYZE_BROLL` worker job, then regenerate Prisma. This migration is prepared, not applied
to production as part of development. Rebuild both workers and deploy the app together.

Apply `20260912100000_comment_edit_revisions` and regenerate Prisma before deploying revision
history. Stop the agent worker during this rollout and rebuild it with the updated app so
adjustments use the revision-aware planner. This increment does not change media rendering,
but the earlier graphics/B-roll changes in this branch still require the media-worker rebuild.
The new revision migration is prepared and locally validated, not applied to production.

## Verification

Unit tests exercise timeline/source mapping, overlapping cuts, scoped keeps, frame snapping,
marker mapping, and rejected plans. API tests use PostgreSQL and the real planner orchestration,
permission checks, transactions, renderer database writes, and acceptance workflow; model and
media I/O are stubbed. Component tests exercise comment creation callbacks, task actions,
preview/accept controls, permission gating, and stale-response protection.

A real FFmpeg smoke render combined a silent B-roll upload and animated lower third, retained
the five-second duration, and preserved the original AAC audio packets byte-for-byte. Native
XML tests check source/timeline frame positions, separate visual layers and stereo audio.

The new worker image was built and its full entry point bundled successfully. A real FFmpeg
run sampled three JPEG frames at 0.5/2.5/4.5 seconds, rendered a workspace title card and retained
the five-second duration and original AAC audio packets. Tests also cover caller-specific
sequence binding, exact image payloads, stored-preset revision races, partial analysis failures,
retention of queued image evidence and rollback after a second native title fails.

Web B-roll preview tests cover project access, exact frame bytes, stale analysis URLs,
bounded image reads, newest-job selection, source changes during requests, retries, and
retaining previous samples after failed reanalysis.

Revision tests exercise original-coordinate replanning, atomic batch revision and undo,
preserved plans for unchanged members, permission and stale-run refusals, concurrent requests,
failed-batch retries, pinned history and output access after a move. The migration SQL was
executed in an isolated, rolled-back schema, including history retention after output deletion
and cascading history deletion with its task.

The browser acceptance test uses the real app, PostgreSQL and authenticated media playback
through test object storage. Starting from a seeded completed draft, it verifies the change
summary, current and archived video playback, acceptance, undo back into the unresolved list,
adjustment queueing, and pinned history after a reload. It runs in normal and CI modes with
the mock agent configured and no agent worker. It does not claim to validate model quality or
FFmpeg output; those boundaries are covered separately above.

The native importer tests also exercise successful font inventory handoff, missing-font
fallback, and cover scaling on every B-roll clip. Independent mutation review verified that
these tests fail if conversion is skipped, fallback is removed, or the wrong scaling mode or
track is used. Live frame checks caught both the unavailable-font black frame and 4:3 B-roll
side bars; font preflight and explicit Fill scaling address those failures.
