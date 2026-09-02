# Joplin Notes Sync

A Super Productivity plugin that pushes each project's **Notes** into a matching
[Joplin](https://joplinapp.org/) notebook, so you can read and search them
alongside your other Joplin notes. Optionally syncs each task's own Notes field
too.

**Desktop only.** Joplin's REST API only listens on `127.0.0.1`, so the plugin
runs its HTTP calls through Super Productivity's `nodeExecution` capability
(Electron desktop app), which needs a one-time consent prompt.

## Setup

1. In Joplin: **Options → Web Clipper**, enable the service, copy the
   **Authorization token**.
2. In Super Productivity: **Settings → Plugins → Upload Plugin**, pointing at a
   zip of this folder (`manifest.json`, `config-schema.json`, `plugin.js`,
   `index.html`, `icon.svg`). No build step.
3. Open the plugin, paste the token, Save. Grant the Node execution permission
   when prompted.
4. Adjust options under **Settings → Plugins → Joplin Notes Sync** — Joplin URL,
   parent notebook, auto-sync interval, task-note sync, archive-vs-delete, and
   project icon/colour sync.

## Notebook layout

```
Super Productivity/            (parent, configurable)
  └── <project title>/
        ├── <note title>
        ├── Archive/           (if "Archive removed notes" is on)
        └── Tasks/             (if "Sync task notes" is on)
              └── <task title>
```

Note titles come from the first non-empty line of the note (truncated to 80
chars). The plugin fully manages these notebooks — a note removed in Super
Productivity is deleted (or archived) in Joplin on the next sync, so don't put
your own notes in them.

## Sync direction

| Content | Direction | Conflict rule |
|---|---|---|
| Project notes | Super Productivity → Joplin only | n/a — Joplin edits never come back |
| Task notes (default) | two-way | most recently edited side wins, no merge |
| Task notes with **One-way task notes** on | Super Productivity → Joplin only | Super Productivity always wins |
| Task tags (needs task-note sync) | Super Productivity → Joplin only | Super Productivity always wins |

Completed tasks get a `[Done] ` prefix on their Joplin note title.

## Project icons and colours

With **Sync project icons and colours** on, each project's Joplin sub-notebook
gets a custom icon: the project's icon glyph on a tile filled with the project's
theme colour. This is one-way (Super Productivity → Joplin) and best-effort — a
failure to set an icon doesn't fail the note sync.

Joplin notebooks have no colour field, so the colour is baked into the icon
image itself (an SVG data-URL icon, the same slot Joplin's own icon picker
uses). The glyph is an emoji for common Super Productivity icons, or the first
letter of the project title otherwise. Only projects that have at least one note
to sync get an icon. Turning the option off later leaves icons already set in
place.

## Matching

Every synced note gets a hidden `<!-- sp-note-id:<id> -->` marker in its body.
Each sync lists the notebook's notes, matches them by that marker, and only
writes the ones that changed — so the link survives plugin reinstalls with no
local cache.

## Multi-device caveats

- **Two-way task notes** call `PluginAPI.updateTask`, which can race with Super
  Productivity's own cross-device sync. The plugin delays pulls from Joplin for a
  couple of minutes after a task looks freshly changed, but that's a heuristic,
  not a guarantee. If tasks start duplicating, switch to **One-way task notes** —
  it never writes back, so the race can't happen.
- **Duplicate Joplin notes** can appear when two devices each create a note for
  the same source before Joplin's own sync catches up. There's no atomic
  "create if missing" in Joplin's API, but the next sync detects and collapses
  any such group automatically, keeping the newest.
- Only **active projects with at least one note** are synced.

## Changelog

Version history: [CHANGELOG.md](CHANGELOG.md). Full write-ups and downloadable
zips: [Releases](https://github.com/BigWebstas/SuperProd-Joplin-Sync/releases).
