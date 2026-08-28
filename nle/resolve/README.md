This is a DaVinci Resolve Studio Workflow Integration plugin.

Free Resolve cannot script from outside the app (locked since 19.1). Free-edition
editors should import the EDL from the review page (Download EDL).

Studio install (macOS example):

1. Copy this folder to:
   `~/Library/Application Support/Blackmagic Design/DaVinci Resolve/Workflow Integration Plugins/OpenFrame`
2. Restart Resolve.
3. Workspace → Workflow Integrations → Review markers.
4. Paste an API token from Settings.

The plugin writes timeline markers with `customData` JSON `{"ofId":"<commentId>"}`
so a second sync is idempotent.
