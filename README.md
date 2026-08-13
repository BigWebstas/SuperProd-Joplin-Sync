# Joplin Notes Sync

Pushes each Super Productivity project's **Notes** into a matching notebook in
[Joplin](https://joplinapp.org/), so you can read/search them alongside your other
Joplin notes.

## Important limitations

- **One-way only** (Super Productivity → Joplin). The plugin API does not allow
  plugins to create, update, or delete notes inside Super Productivity, so nothing
  written in Joplin ever comes back. Treat the target notebooks as a mirror, not a
  place to edit.
- **Desktop only.** Joplin's REST API only listens on `127.0.0.1`, which the browser
  sandbox blocks for regular plugin network calls. This plugin instead runs the HTTP
  calls through Super Productivity's `nodeExecution` capability (Electron desktop
  app only), which requires a one-time consent prompt the first time it runs.
- **The plugin fully manages the target notebooks.** A note deleted in a Super
  Productivity project is deleted from the corresponding Joplin notebook on the next
  sync. Don't keep manually-created notes inside the notebooks this plugin creates.
- Only **active (non-archived) projects that have at least one note** are synced.

## Setup

1. In Joplin: **Options → Web Clipper**, enable the clipper service, and copy the
   **Authorization token**.
2. Install this plugin in Super Productivity (**Settings → Plugins → Upload Plugin**,
   pointing at a zip of this folder), then open it from the app menu.
3. Paste the token under "1. Joplin API token" and save. The token is stored as a
   local secret on this device only (never synced, exported, or backed up).
4. Optionally adjust the Joplin URL, parent notebook name, auto-sync interval, or
   whether task notes are synced, under **Settings → Plugins → Joplin Notes Sync**.
5. Grant the Node execution permission when prompted, either via the "Sync Now"
   button on the plugin page or the header "Joplin Sync" button.

## How matching works

Each pushed note gets a hidden `<!-- sp-note-id:<id> --\>` marker appended to its
body. On every sync, the plugin lists the notes already in the project's Joplin
notebook, matches them back to Super Productivity notes by that marker, and only
creates/updates notes whose content actually changed. This means the link survives
plugin reinstalls and doesn't depend on any local cache.

## Notebook layout

```
<parent notebook, default "Super Productivity">
  └── <project title>
        ├── <note 1 title>
        ├── <note 2 title>
        └── Tasks/                     (only if "Sync task notes" is enabled)
              ├── <task 1 title>
              └── <task 2 title>
```

Note titles are derived from the first non-empty line of the note's markdown
content (headings/list markers stripped, truncated to 80 characters).

### Task notes (optional)

Enabling **Sync task notes** additionally pushes each task's own **Notes** field
(the one you open from the task itself) into a `Tasks` sub-notebook under its
project — one Joplin note per task, titled with the task's own title, for any
task belonging to that project with non-empty notes (done or not, top-level or
subtask). This is separate from, and in addition to, the project's Notes tab,
which is always synced. Task notes are matched back by task id the same way
project notes are matched by note id, so the two never collide.

## Packaging

This plugin ships as plain files (no build step). To install it, zip the contents
of this folder (`manifest.json`, `config-schema.json`, `plugin.js`, `index.html`,
`icon.svg`) and upload the zip via **Settings → Plugins → Upload Plugin**.
