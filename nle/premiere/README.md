# Premiere Pro review panel

Requires Premiere Pro 25.6+ (the `Markers` API). Distribute internally by
side-loading this folder with the UXP Developer Tool — no Adobe Exchange review.

1. In the review app, open Settings and create an API token.
2. Load this folder in UXP Developer Tool and run it against Premiere Pro.
3. Paste the app URL and token, load projects, pick a version, Sync markers.

Each marker’s comment ends with `[of:<commentId>]` so a later sync can add,
move, or remove markers as a single undoable transaction.

After the first successful sync, **delete a review marker and Sync again** to
resolve that comment on the web. The panel will not put that marker back.
Comments that were never synced still land as new markers.

Sequence start timecode (often `01:00:00:00`) is read once per sync and added to
comment times. Review files are treated as starting at `00:00:00:00`.
