# AI editing from timeline feedback

The first release executes cuts and trims from individual timeline comments on rendered
OpenFrame rough cuts. Each execution creates a separate draft video. The original reviewed
video, its versions, and its rough-cut overrides remain intact.

## Using it

1. Open a rendered rough cut as a project editor and mark an In/Out range.
2. Write text feedback describing a cut or trim.
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

## Execution contract

- Only users with `checkProjectAccess().canEdit` can read or change editing tasks. Agent
  execution checks that permission before and after the model request.
- New tasks require an active version that exactly matches the rough cut's
  `renderedVersionId`, its persisted `renderedDecisions`, and uploaded R2 sources from the
  same project. A render in progress prevents a new snapshot.
- The model receives only the selected comment as executable feedback, with transcript
  context. Cuts and keeps refer to the immutable reviewed timeline. Keeps apply only within
  the selected range; the rest of the video is preserved.
- Validation rejects empty plans, out-of-range cuts, mixed cut/keep plans, sub-frame changes,
  and deletion of the entire video. Overlapping cuts are merged before applying them.
- Mapping occurs per timeline occurrence, so a repeated use of a source clip is not cut twice.
  Surviving markers move with the footage, and markers inside removed material are dropped.
- A transaction under a per-comment lock creates the task/run. Another transaction atomically
  creates the draft decisions, media job, and successful planning result. Repeated execution
  of the same completed agent run cannot queue another render.
- Planning completion is distinct from render completion. A failed plan or render leaves the
  comment unresolved and supports retry or human handoff. A stopped worker can leave work
  waiting in the existing worker queue; this release does not add a worker watchdog.

## Next capabilities

Motion graphics, B-roll insertion, automatic asset selection, coordinated multi-comment
batches, and native Premiere/Resolve edit execution are not part of this first release.
Unsupported feedback must produce no executable plan; it is shown as needing attention.

The next increment should extend the validated edit operations and renderer with one branded
motion-graphic template and one explicit uploaded B-roll insertion. Presets should define
allowed fields, layout, timing, and asset requirements and retain their version in the task
snapshot.

## Verification

Unit tests exercise timeline/source mapping, overlapping cuts, scoped keeps, frame snapping,
marker mapping, and rejected plans. API tests use PostgreSQL and the real planner orchestration,
permission checks, transactions, renderer database writes, and acceptance workflow; model and
media I/O are stubbed. Component tests exercise comment creation callbacks, task actions,
preview/accept controls, permission gating, and stale-response protection.
