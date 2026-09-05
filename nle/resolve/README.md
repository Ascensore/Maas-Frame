This is a DaVinci Resolve Studio Workflow Integration plugin.

Free Resolve cannot script from outside the app (locked since 19.1). Free-edition
editors should import the EDL from the review page (Download EDL).

Studio install (macOS example):

1. Copy this folder to:
   `~/Library/Application Support/Blackmagic Design/DaVinci Resolve/Workflow Integration Plugins/OpenFrame`
2. Restart Resolve.
3. Workspace → Workflow Integrations → Review markers.
4. Paste an API token from Settings.

The folder is self-contained — it carries its own `nle-core.cjs`, so copying just
this directory is enough. The app URL, token and version id are remembered.

The plugin writes timeline markers with `customData` JSON `{"ofId":"<commentId>"}`
so a second sync is idempotent.

## Auto-sync

Tick **Auto-sync new comments** and the plugin polls every 10 seconds, backing
off when the server is unreachable, and pausing while the window is hidden.

Auto-sync runs **one direction only**: comments from the web land on the
timeline, and markers for comments resolved on the web are removed. It never
resolves a comment on the web.

It follows you between timelines: bring a different timeline forward and the
plugin asks the app which version it belongs to and fills in the version id, so
you only enter one on the first bind. Resolve has no way to tell the plugin you
switched, so this is checked on each poll.

**The first bind is always a manual Sync.** Auto-sync writes only to a timeline
the app already has a link for, so an unrecognised timeline pauses it rather than
being synced to whatever was entered last. Enter the version id and press Sync
markers once; from then on that timeline is followed automatically.

Timelines are matched on Resolve's own timeline id, not on the name. Duplicating
a timeline copies its markers but gets a fresh id, so a stale duplicate is
recognised as a different timeline rather than synced as the original.

So the resolve gesture stays manual: **delete a review marker and press Sync
markers** to resolve that comment on the web. The plugin will not put that
marker back.

Two refusals protect that gesture, and are reported in the status line:

- If not one of the markers this version placed is still on the timeline, the
  open timeline is probably not the one being synced, so nothing is resolved.
  A timeline holding some *other* version's review markers counts as unbound too.
  Resolve has no way to tell the plugin you switched timelines, so this check is
  what stands between a switched timeline and a mass resolve.
- More than five resolves in one sync is refused as implausible.

## Latency

The panel holds the review app's comment stream open, so a new comment normally
lands within a second rather than on the next poll. The server closes each stream
after about 25 seconds and the panel reconnects, backing off if the server is
unreachable.

The stream is only an accelerator: where the deployment cannot push it says so
when the stream opens, the panel stops reconnecting, and the 10-second poll is
what delivers. Nothing is lost either way.

If the timeline start timecode cannot be parsed, auto-sync pauses rather than
placing every marker an hour from its comment; a manual sync still proceeds and
says the offset was assumed.
