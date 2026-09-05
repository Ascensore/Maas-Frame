# Premiere Pro review panel

Requires Premiere Pro 25.6+ (the `Markers` API). Distribute internally by
side-loading this folder with the UXP Developer Tool — no Adobe Exchange review.

1. In the review app, open Settings and create an API token.
2. Load this folder in UXP Developer Tool and run it against Premiere Pro.
3. Paste the app URL and token, load projects, pick a version, Sync markers.

The app URL and token are remembered, so the panel can resume after a reload.

Each marker’s comment ends with `[of:<commentId>]` so a later sync can add,
move, or remove markers as a single undoable transaction. A sync that would
change nothing opens no transaction at all, so it never costs you an undo step.

## Auto-sync

Tick **Auto-sync new comments** and the panel polls every 10 seconds, backing off
when the server is unreachable, and pausing while the panel is hidden.

Auto-sync runs **one direction only**: comments from the web land on the
timeline, and markers for comments resolved on the web are removed. It never
resolves a comment on the web. Putting a note on a timeline is recoverable;
resolving one on the review record is not.

It follows you between sequences: bring a different sequence forward and the
panel asks the app which version that sequence belongs to and selects it, so you
never touch the dropdown again after the first bind. A sequence the app does not
recognise selects nothing and auto-sync pauses, rather than syncing an unknown
sequence to whatever was picked last.

Sequences are matched on Premiere's own sequence guid, not on the name.
Duplicating a sequence copies its name and its markers but gets a fresh guid, so
a stale duplicate is recognised as a different sequence rather than synced as the
original.

So the resolve gesture stays manual: **delete a review marker and press Sync
markers** to resolve that comment on the web. The panel will not put that marker
back. Comments that were never synced still land as new markers.

Two refusals protect that gesture, and are reported in the status line rather
than performed silently:

- If not one of the markers this version placed is still on the timeline, the
  open sequence is probably not the one being synced, so nothing is resolved.
  A timeline holding some *other* version's review markers counts as unbound too.
  Deleting the genuinely last review marker lands here as well — resolve it in
  the web app.
- More than five resolves in one sync is refused as implausible for one editing
  session.

## Latency

The panel holds the review app's comment stream open, so a new comment normally
lands within a second rather than on the next poll. The stream is only an
accelerator: where the deployment cannot push (it says so when it opens), the
10-second poll is what delivers, and nothing is lost.

Sequence start timecode (often `01:00:00:00`) is read once per sync and added to
comment times. Review files are treated as starting at `00:00:00:00`. If the
start timecode cannot be read at all, auto-sync pauses rather than placing every
marker an hour from its comment; a manual sync still proceeds, and says the
offset was assumed.
