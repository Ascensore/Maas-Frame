# NLE panel decision

Shipped first: EDL and FCPXML export from the review page. That puts comments on
the timeline in Premiere, Resolve (including the free edition), Avid, and FCP
with no plugin.

Because the edition mix is still unknown, this fork includes **both** panels as
specified in the plan:

- Premiere Pro 25.6+ UXP panel in `nle/premiere` (side-load with UXP Developer Tool)
- DaVinci Resolve Studio Workflow Integration plugin in `nle/resolve`

Free Resolve keeps using the EDL import path. If the team later confirms a
single NLE, the unused panel can be ignored; both are isolated under `nle/`.

Live two-way sync is a convenience on top of the file-based workflow, not a
replacement for it. Try the EDL first. Adopt the panel if editors want markers
to update without re-importing.

Both panels now offer an opt-in **Auto-sync**, which polls every 10 seconds and
is deliberately one-directional: comments flow onto the timeline unattended,
but resolving a comment on the web still takes a button press. The reasoning,
and the guards that make an unattended writer safe, are in
`docs/superpowers/specs/2026-09-04-nle-auto-sync-design.md`.
