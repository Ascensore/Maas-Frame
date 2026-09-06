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
color. Specify exact title/subtitle text in the comment. Templates and their version/colors
are frozen when queued. Graphics last up to 30 seconds and stay inside the selected range.

Choose an uploaded project video as the explicit B-roll source, or allow automatic selection.
For automatic selection, set a video's metadata field **usage** to **broll** and give it a
descriptive title and subject metadata. The AI selects from up to 100 recent eligible tagged
uploads using those descriptions; this is metadata-based selection, not visual analysis.
An explicit selection restricts the AI to that source. No stock search or invented asset URLs.
The cover preset fills the picture while retaining the original speech audio. Source trims
must fit the uploaded video's duration. Source identity is checked again after planning.

## Coordinated comment batches

Queue between 2 and 20 unresolved comments on the same reviewed version, then choose
**Run queued comments together**. Every comment keeps its original instruction and range.
The batch is validated before creating a render: a failed or unsupported member prevents
any partial draft. All cuts use original reviewed coordinates so later comments do not drift.
Overlapping comment ranges, differing source maps and differing graphic colors are refused;
narrow the ranges or run those comments separately. One shared preview is pinned to all
members. **Accept & resolve** and **Hand to editor** apply to the entire batch. If any comment
changed after queueing, acceptance resolves none of the comments.

## Premiere and Resolve

On a ready draft, expand **Continue in Premiere or Resolve**, copy its comment ID, and paste
it into the updated OpenFrame panel's **AI draft comment ID** field. **Import AI draft**
downloads the exact referenced media into a permanent folder you choose, then creates a new
1080p sequence/timeline. The existing timeline is preserved. Repeating an import recognizes
its named draft in the same project. Imported timelines may be edited independently.

Cuts and B-roll remain source-editable; speech uses the exact reviewed draft audio. Graphics
are rendered composite sections, so text/style changes currently happen in OpenFrame and
need another render. This is not yet a native MOGRT/Fusion title-template authoring system.
The old rough-cut XML/OTIO download refuses graphics-bearing drafts instead of silently
omitting their overlays. The panel downloads a dedicated FCP7 XML package including them.

Both panels include the same bounded media download protocol, validating ranges,
source identities and filenames. A failed download does not invoke the host importer. The
Resolve plugin now includes its registration manifest and initializes the installed Studio
WorkflowIntegration module; follow the updated NLE README for that module's installation.
Native imports have automated adapter/protocol tests; live Premiere/Resolve acceptance still
needs to be performed in the target editor before calling these integrations production-ready.

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

## Verification

Unit tests exercise timeline/source mapping, overlapping cuts, scoped keeps, frame snapping,
marker mapping, and rejected plans. API tests use PostgreSQL and the real planner orchestration,
permission checks, transactions, renderer database writes, and acceptance workflow; model and
media I/O are stubbed. Component tests exercise comment creation callbacks, task actions,
preview/accept controls, permission gating, and stale-response protection.

A real FFmpeg smoke render combined a silent B-roll upload and animated lower third, retained
the five-second duration, and preserved the original AAC audio packets byte-for-byte. Native
XML tests check source/timeline frame positions, separate visual layers and stereo audio.
