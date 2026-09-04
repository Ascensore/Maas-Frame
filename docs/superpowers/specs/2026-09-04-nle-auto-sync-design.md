# Automatic delivery of web comments into open Premiere / Resolve projects

Status: investigation. No code changed by this document.

## The short version

Almost everything needed is already built. `nle/premiere` and `nle/resolve`
already read comments over the v1 API, map them onto markers, and reconcile
adds/moves/removes idempotently through `nle/core`. What is missing is not the
transport and not the mapping — it is the **trigger**. Both panels only ever act
when a human clicks *Sync*.

Turning that click into "automatic" is three separate problems, and only the
first is easy:

1. **Trigger** — how the panel learns a comment changed. (Easy. Poll.)
2. **Binding** — how the panel knows the open sequence *is* the version it is
   syncing. Today a human picks it from a dropdown. (Medium.)
3. **Write safety** — what an unattended writer is allowed to do to a project a
   human is actively editing. (Hard, and the reason to be careful.)

Problem 3 is where this feature gets turned off by editors if we get it wrong.
There is a specific failure mode in the current code that mass-resolves comments,
described below, that is harmless in manual mode and severe in automatic mode.

## What already exists

Verified in the tree:

| Piece | Location | State |
| --- | --- | --- |
| Marker mapping, sentinels, reconcile | `nle/core/src/index.ts` | Done, 27 unit tests in `tests/unit/lib/nle-sync.test.ts` |
| UMD copy loaded by the panels | `nle/core/nle-core.cjs`, `nle/premiere/nle-core.cjs` | Byte-parity asserted by test |
| Premiere UXP panel | `nle/premiere/panel.js` | Manual sync |
| Resolve Workflow Integration plugin | `nle/resolve/main.js` | Manual sync |
| Bearer-token API for panels | `app/api/v1/**`, auth in `lib/v1-auth.ts` | Done |
| Sequence ↔ version link | `app/api/v1/versions/[versionId]/sequence-link/route.ts`, `SequenceLink` model | Write-only from panel |
| Change notification fan-out | `lib/comment-live.ts` (`notifyCommentChanged`) | Called at **every** comment mutation site |
| SSE stream for the web client | `app/api/versions/[versionId]/comments/live/route.ts` | Session-cookie auth only |

That last pair matters. `notifyCommentChanged` is already invoked from all six
mutation paths (web create, web patch/delete, v1 create, v1 patch, agent
findings). The publish side of a push architecture is complete. Only the
subscribe side is unavailable to a panel.

## Problem 1: the trigger

### Why the existing SSE route cannot be reused as-is

`app/api/versions/[versionId]/comments/live/route.ts` authenticates with `auth()`
(NextAuth session) or a share-link session. Panels authenticate with a Bearer API
token via `withApiAuth`. A panel cannot open that stream.

Two further constraints on that route are worth knowing before treating SSE as
the answer:

- `maxDuration = 25`. The stream is deliberately short-lived; clients reconnect.
- `shouldListenForCommentLive()` returns `false` when `process.env.VERCEL === '1'`,
  because holding a `LISTEN` connection per open stream exhausted a 15-client
  session pooler. **On Vercel there is no push at all** — the route degrades to
  `ready` plus pings, and the web client's 10s poll is what actually delivers
  comments.

So push is a self-hosted-only accelerator, not a universal mechanism.

### Host capability differences

- **Resolve** plugins are Electron apps (full Chromium). `EventSource` works.
- **Premiere** UXP supports `fetch`, `XMLHttpRequest` and `WebSocket` (client
  only). `EventSource` is not part of the documented UXP surface, so SSE would
  mean either a WebSocket endpoint or hand-parsing a streamed `fetch` body.

Building push means building it twice, differently, for a benefit that is absent
on Vercel deployments.

### Recommendation: poll, and copy the web client's own pattern

`components/video-page/hooks/use-comment-actions.ts` already solves this exact
problem for the browser: a 10-second `setInterval` poll that pauses on
`document.visibilityState`, **plus** an `EventSource` that only ever triggers the
same refetch. SSE is a latency optimisation layered on a poll that works alone.

Panels should do the same, starting with the poll:

- 10s interval, matching the web client.
- Skip a tick while a sync is in flight (the hook's `isMutatingRef` equivalent).
- Pause when the panel is hidden / the host app is not frontmost.
- Exponential backoff on error.

Budget check: `api-v1` rate limit is 120 requests/minute (`lib/rate-limit.ts`). A
10s poll is 6/min per panel, leaving ample headroom.

One caveat on making the poll incremental: `GET /api/v1/versions/[versionId]/comments`
supports `updatedSince`, but comments are **hard-deleted** (`db.comment.delete`
in `app/api/comments/[commentId]/route.ts:505`). A delta response can therefore
never express "this comment is gone", which is exactly the signal the marker
`remove` path needs. Either keep fetching the full list (cheap enough at
`take: 5000`) or add a deletions feed. Do not switch to `updatedSince` naively —
it silently breaks marker removal.

### Optional Phase 3: push

If self-hosted latency matters, add `GET /api/v1/versions/[versionId]/comments/live`
mirroring the existing route but calling `withApiAuth` instead of `auth()`.
Resolve consumes it with `EventSource`; Premiere either gets a WebSocket variant
or keeps polling. Treat it strictly as an accelerator — the poll stays.

## Problem 2: binding the open sequence to a version

Automatic sync must answer "which version does the timeline in front of me
correspond to?" without a dropdown, and must re-answer it whenever the editor
switches sequences.

`SequenceLink` is keyed `@@unique([userId, versionId, nle])` and stores
`sequenceName`, but it is only ever written by the panels and read back by
`versionId` — the direction needed here is the reverse.

Two mechanisms, best combined:

**a. Reverse lookup endpoint.** `GET /api/v1/sequence-link/lookup?nle=premiere&sequenceName=...`
returning candidate versions for the calling user. Needs an index on
`(userId, nle, sequenceName)`. Cheap, but ambiguous when names collide — and
"Untitled" will collide.

**b. Identity stamped into the project itself.** The repo already trusts this
pattern: every marker carries `[of:<commentId>]` and Resolve markers carry
`customData` `{"ofId":...,"versionId":...}`. Extend it one level up to a version
sentinel written at first bind — Premiere project metadata or a hidden marker at
00:00; Resolve timeline setting or an existing marker's `customData`, which
already contains `versionId`. This survives renames and travels with the project
file between machines.

Recommended: keep the dropdown for the **first** bind, stamp the version sentinel
at that moment, then auto-rebind from the sentinel thereafter, falling back to
(a) when no sentinel is found.

Rebinding needs a change signal:

- **Premiere**: `addGlobalEventListener` with `Constants.SequenceEvent`
  (`ACTIVATED`, `CLOSED`) — verify exact constants against the 25.6 reference.
- **Resolve**: no event callbacks exist. Compare `GetCurrentTimeline()` identity
  on each poll tick.

## Problem 3: write safety

These are the findings that most affect whether this ships well. All are benign
under a human-clicked sync and become serious under a loop.

### 3.1 Mass auto-resolve when the wrong timeline is open — the important one

`commentsRemovedFromTimeline(remote, local, previouslySyncedIds)` treats *any*
previously-synced comment that is open remotely but absent from `local` as
"deleted by the editor" and resolves it on the web.

If a sync runs while the bound sequence is *not* the front timeline — a different
sequence, a freshly created one, a project where the markers were never imported —
then `local` is empty, and **every previously-synced comment gets resolved on the
web app** in one pass. There is no confirmation and no undo.

Under manual sync this is unlikely: a human clicks the button while looking at
the timeline they just picked. Under a 10s loop it is a matter of time.

Mitigations, all of which should land before any auto mode:

- Refuse the write-back direction unless the current sequence matches the bound
  version (sentinel, or name + start TC + fps).
- Refuse when `local` contains zero sentinel markers while `previousIds` is
  non-empty — that is the signature of "wrong timeline", not "editor deleted
  everything".
- Cap the number of comments a single sync may auto-resolve, and surface anything
  above the cap for confirmation.

Strongest option, and worth considering on product grounds: **make the direction
asymmetric**. Web → timeline goes automatic; timeline → web (resolve-on-delete)
stays an explicit human action. Automatic writes into someone's editing session
are recoverable; automatic writes into the review record are not.

### 3.2 Undo-stack pollution in Premiere

`nle/premiere/panel.js:139` opens `project.lockedAccess(...)` /
`executeTransaction(...)` unconditionally, before knowing whether the plan is
empty. Each call pushes an undoable entry named "Sync review comments".

Manual: one junk undo entry per click. Automatic at 10s: six per minute, so
Cmd+Z stops undoing the editor's own trim. Guard the transaction on
`plan.add.length + plan.move.length + plan.remove.length > 0`.

Resolve has no equivalent grouping for scripted marker writes at all, which is a
further argument for writing only when there is something to write.

### 3.3 Silent offset failure

`sequenceOffsetSeconds` returns `0` when the start timecode does not parse. A
sequence starting at `01:00:00:00` then places every marker one hour off. Today a
human sees the reported offset in the status line and notices; an unattended loop
does not. Auto mode should refuse to write on an unparseable start timecode
rather than defaulting to zero.

## Suggested phasing

**Phase 0 — prerequisites (small, worth doing regardless).**
Guard the empty transaction (3.2). Guard mass auto-resolve (3.1). Fail closed on
offset parse failure (3.3). Persist base URL and token in panel storage so a
panel can resume unattended after a restart.

**Phase 1 — automatic pull.**
Refactor `syncMarkers` to separate pull from write-back. Add an *Auto-sync*
toggle, off by default, driving a 10s poll with visibility pausing and backoff.
Ship with write-back still manual.

**Phase 2 — automatic binding.**
Version sentinel written at first bind, reverse-lookup endpoint plus index,
rebind on `SequenceEvent.ACTIVATED` (Premiere) and on timeline-identity change
(Resolve).

**Phase 3 — push accelerator, optional.**
v1 live endpoint under `withApiAuth`. Self-hosted only; note the Vercel
limitation in the panel UI rather than pretending latency is uniform.

## Server-side changes this implies

| Change | Needed for | Notes |
| --- | --- | --- |
| Reverse sequence-link lookup + `(userId, nle, sequenceName)` index | Phase 2 | New route + migration |
| Version sentinel persisted per link | Phase 2 | Can reuse `SequenceLink`; no new model required |
| `GET /api/v1/versions/[versionId]/comments/live` | Phase 3 | Mirror existing route, swap `auth()` for `withApiAuth` |
| Deletions feed | Only if incremental polling is adopted | Otherwise keep full fetch |

Phases 0 and 1 need **no server changes at all**.

## Open questions for the team

1. Should timeline → web resolve ever be automatic, or stay an explicit action?
   (Recommendation: stay explicit.)
2. Is the deployment target Vercel or self-hosted? It decides whether Phase 3 is
   worth building.
3. Which edition mix of Resolve is in use? `nle/NLE_DECISION.md` records this as
   still unknown, and free Resolve cannot script from outside the app at all —
   those editors stay on the EDL import path, which no amount of this work
   changes.
