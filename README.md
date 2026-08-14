# Joplin Notes Sync

Pushes each Super Productivity project's **Notes** into a matching notebook in
[Joplin](https://joplinapp.org/), so you can read/search them alongside your other
Joplin notes.

## Important limitations

- **Project notes are one-way only** (Super Productivity → Joplin). The plugin API
  does not allow plugins to create, update, or delete this kind of note inside Super
  Productivity, so nothing written in Joplin ever comes back. Treat the notebooks
  these land in as a mirror, not a place to edit.
- **Task notes, if enabled, are two-way** — see [Task notes](#task-notes-optional)
  below for how conflicts are resolved. Two-way sync calls `PluginAPI.updateTask`,
  which can in principle race with Super Productivity's own cross-device sync if you
  run it on more than one device (an earlier version of this plugin reverted to
  one-way over exactly that risk). The plugin withholds a pull for a while after a
  task looks like it just changed, to narrow that window — see
  [Task notes](#task-notes-optional) for how — but Super Productivity doesn't expose
  its own sync status to plugins, so this is a heuristic, not a guarantee. If task
  duplication shows up on a multi-device setup, this race is still the first thing
  to suspect.
- **Desktop only.** Joplin's REST API only listens on `127.0.0.1`, which the browser
  sandbox blocks for regular plugin network calls. This plugin instead runs the HTTP
  calls through Super Productivity's `nodeExecution` capability (Electron desktop
  app only), which requires a one-time consent prompt the first time it runs. That
  capability spawns a Node process by passing the whole script and all its data as a
  single command-line argument, which has a much lower effective length limit on
  Windows than on Linux/macOS — the plugin works around this by syncing one project
  per call, and, within a project, splitting its notes and task notes into further
  calls if there's enough content that even one project's payload would exceed a
  conservative size budget (see `MAX_PROJECT_PAYLOAD_CHARS` and the comment above
  `NODE_SYNC_SCRIPT` in `plugin.js`).
- **The plugin fully manages the target notebooks.** A note deleted in a Super
  Productivity project is deleted from the corresponding Joplin notebook on the next
  sync (or, if **Archive removed notes** is enabled, moved into an `Archive`
  sub-notebook instead — see [Notebook layout](#notebook-layout)). Don't keep
  manually-created notes inside the notebooks this plugin creates.
- Only **active (non-archived) projects that have at least one note** are synced.

## Setup

1. In Joplin: **Options → Web Clipper**, enable the clipper service, and copy the
   **Authorization token**.
2. Install this plugin in Super Productivity (**Settings → Plugins → Upload Plugin**,
   pointing at a zip of this folder), then open it from the app menu.
3. Paste the token under "1. Joplin API token" and save. The token is stored as a
   local secret on this device only (never synced, exported, or backed up).
4. Optionally adjust the Joplin URL, parent notebook name, auto-sync interval,
   whether task notes are synced, or whether removed notes are archived instead of
   deleted, under **Settings → Plugins → Joplin Notes Sync**.
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
        ├── Archive/                   (only if "Archive removed notes" is enabled)
        │     └── <removed note title>
        └── Tasks/                     (only if "Sync task notes" is enabled)
              ├── <task 1 title>
              ├── <task 2 title>
              └── Archive/              (only if "Archive removed notes" is enabled)
                    └── <removed task note title>
```

Note titles are derived from the first non-empty line of the note's markdown
content (headings/list markers stripped, truncated to 80 characters).

### Archiving removed notes (optional)

By default, a note (or task note) whose source no longer exists in Super
Productivity is deleted from Joplin on the next sync. Enabling **Archive removed
notes** moves it into an `Archive` sub-notebook instead (under the project for
project notes, under `Tasks` for task notes) rather than deleting it. This also
applies when a task's notes field is cleared out with two-way task-notes sync on.
An archived note keeps its `sp-note-id`/`sp-task-id` marker but is no longer
matched against Super Productivity on future syncs — if the same note or task
reappears, it gets a brand-new Joplin note rather than reviving the archived one.

### Task notes (optional)

Enabling **Sync task notes** additionally syncs each task's own **Notes** field
(the one you open from the task itself) with a `Tasks` sub-notebook under its
project — one Joplin note per task, titled with the task's own title, for any
task belonging to that project that has (or has ever had) notes, done or not,
top-level or subtask. This is separate from, and in addition to, the project's
Notes tab, which is always one-way. Task notes are matched back by task id the
same way project notes are matched by note id, so the two never collide.

A completed task's Joplin note title gets a `[Done] ` prefix (e.g. `[Done] Buy
groceries`), independently of whether its notes content changed — marking a task
done pushes the title update on its own next sync, and un-marking it removes the
prefix again. This is SP → Joplin only, same direction as the title itself
always syncs; there's no "done" concept on the Joplin side to pull back.

Recurring calendar-imported tasks (Google/ICS) get a new task id per day's
occurrence; the plugin strips that trailing occurrence timestamp before using
the id as the sync key, so a daily recurring event still collapses onto a
single Joplin note instead of spawning a new one every day.

Unlike project notes, **task notes sync both ways**: `PluginAPI.updateTask` can
write back into a task, so an edit made in Joplin gets pulled into the task, and
an edit made in the task gets pushed to Joplin. To tell which side actually
changed, the plugin keeps a per-task "last synced content" baseline (stored via
`persistDataSynced`, so it's shared across your devices, not just this one):

- If only one side moved since that baseline, that side's change wins.
- If **both** sides changed since the last sync (a real conflict), the more
  recently edited one wins and silently overwrites the other — there is no
  merge, and no prompt. If you edit the same task's notes in both apps between
  syncs, expect to lose one of the two edits.
- Deleting a task's notes on one side deletes the Joplin note (rather than
  leaving an empty one); deleting the task entirely removes its Joplin note on
  the next sync.

Pulling Joplin's side into a task (the only direction that writes back into Super
Productivity) is deliberately held back in two situations, both aimed at avoiding
the race described in [Important limitations](#important-limitations):

- **Settle window.** A pull is withheld until the task hasn't changed on the Super
  Productivity side for 2 minutes, since a just-touched task is more likely to
  still be mid-flight through Super Productivity's own sync.
- **Post-burst cooldown.** Super Productivity's own incoming sync tends to touch
  many tasks in a tight burst, unlike a human editing one task at a time. Seeing
  a burst pauses pulls (pushes to Joplin keep working normally) for 60 seconds.

Neither of these is a real signal — Super Productivity doesn't expose sync status
to plugins — so they narrow the collision window without closing it.

## Packaging

This plugin ships as plain files (no build step). To install it, zip the contents
of this folder (`manifest.json`, `config-schema.json`, `plugin.js`, `index.html`,
`icon.svg`) and upload the zip via **Settings → Plugins → Upload Plugin**.
