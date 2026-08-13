# Joplin Notes Sync

Pushes each Super Productivity project's **Notes** into a matching notebook in
[Joplin](https://joplinapp.org/), so you can read/search them alongside your other
Joplin notes.

## Important limitations

- **One-way only** (Super Productivity → Joplin), for both project notes and task
  notes. Project notes are one-way because the plugin API has no way to create,
  update, or delete this kind of note inside Super Productivity at all. Task notes
  *could* technically go both ways (`PluginAPI.updateTask` can write a task's notes
  field), and an earlier version of this plugin did that — but calling it on a
  schedule collided with Super Productivity's own cross-device sync: if you run
  Super Productivity on more than one device, the two syncs would race on the same
  task, and Super Productivity resolved the collision by duplicating the task
  instead of merging it. Treat the notebooks this plugin creates as a mirror, not a
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
task belonging to that project with non-empty notes, done or not, top-level or
subtask. This is separate from, and in addition to, the project's Notes tab,
which is always synced. Task notes are matched back by task id the same way
project notes are matched by note id, so the two never collide.

Editing a task's notes in Joplin has no effect — the next sync doesn't read it,
and won't overwrite your Joplin edit either (it just leaves that note alone
until the Super Productivity side changes again). See
[Important limitations](#important-limitations) for why this stays one-way.

## Packaging

This plugin ships as plain files (no build step). To install it, zip the contents
of this folder (`manifest.json`, `config-schema.json`, `plugin.js`, `index.html`,
`icon.svg`) and upload the zip via **Settings → Plugins → Upload Plugin**.
