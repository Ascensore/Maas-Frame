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
never touch the dropdown again after the first bind.

**The first bind is always a manual Sync.** Auto-sync writes only to a sequence
the app already has a link for, so an unrecognised sequence pauses it rather than
being synced to whatever was picked last. Pick the version and press Sync markers
once; from then on that sequence is followed automatically.

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
lands within a second rather than on the next poll. The server closes each stream
after about 25 seconds and the panel reconnects, backing off if the server is
unreachable.

The stream is only an accelerator: where the deployment cannot push it says so
when the stream opens, the panel stops reconnecting, and the 10-second poll is
what delivers. Nothing is lost either way.

Sequence start timecode (often `01:00:00:00`) is read once per sync and added to
comment times. Review files are treated as starting at `00:00:00:00`. If the
start timecode cannot be read at all, auto-sync pauses rather than placing every
marker an hour from its comment; a manual sync still proceeds, and says the
offset was assumed.
# AI draft import

The panel can import a ready OpenFrame AI draft as a new 1080p sequence. Copy its comment ID
from **Continue in Premiere or Resolve**, paste it into **AI draft comment ID**, then click
**Import AI draft**. Choose a permanent folder for its media. The plugin downloads media in
bounded chunks and imports the generated XML using Premiere's UXP `Project.importFiles` API.
It checks that the expected sequence was created and does not overwrite the active sequence.

Cuts and B-roll remain source-editable. Speech and graphic composites use the exact reviewed
draft; graphic text/style changes currently require a new render in OpenFrame. Keep the media
folder with your project. Updating the panel requires reloading it in the UXP Developer Tool;
the manifest now requests access to a folder chosen by the user. Automated adapter tests do
not replace a live import check in your Premiere installation.

## Execute feedback and editable titles (experimental)

**Run feedback with AI** starts the selected comment from the panel. Sync the current sequence
first; the server checks its id against your own sequence link. **Refresh draft status** reports
planning/rendering/errors, then **Import AI draft** opens the separate result. Existing sequences
and comment resolution are preserved.

For editable graphics, enable **Editable MOGRT titles** before import. After media downloads,
choose a folder containing `lower-third.mogrt`, `callout.mogrt` and/or `title-card.mogrt` for the
layouts used by the draft. Only explicitly chosen local files are used. Templates must be
video-only and expose these exact controls:

| Control | Value type |
| --- | --- |
| OpenFrame Title | string |
| OpenFrame Subtitle | string |
| OpenFrame Accent | color |
| OpenFrame Foreground | color |
| OpenFrame Background | color |
| OpenFrame Font | string |
| OpenFrame TitleSize | number |
| OpenFrame SubtitleSize | number |

The adapter inserts titles on V4, sets text/styles and duration, then disables the rendered V3
plates only once all titles succeeded. An incomplete title set is disabled and the plates remain
enabled. Inspect the imported sequence if the host reports an error during cleanup. Templates
are not generated or bundled; provide compatible MOGRTs from your design workflow. Native
appearance can differ from the reviewed FFmpeg render. Premiere is not installed in the local
development environment, so live host acceptance remains required.

API references: [SequenceEditor](https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/sequenceeditor),
[ComponentParam](https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/componentparam),
[Project transactions](https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/project).
