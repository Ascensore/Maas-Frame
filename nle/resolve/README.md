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

It also pauses itself whenever the timeline in front of it holds none of this
version's review markers. Resolve cannot tell the plugin you switched timelines,
so this is what stops an unattended pass from writing to the wrong one. Switch
back, or press **Sync markers** to deliberately sync the timeline you are on.

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

If the timeline start timecode cannot be parsed, auto-sync pauses rather than
placing every marker an hour from its comment; a manual sync still proceeds and
says the offset was assumed.
