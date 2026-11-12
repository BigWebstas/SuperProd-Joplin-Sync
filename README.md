# Joplin Notes Sync

A Super Productivity plugin that pushes each project's **Notes** into a matching
[Joplin](https://joplinapp.org/) notebook, so you can read and search them
alongside your other Joplin notes. Optionally it also syncs each task's own
Notes field (two-way) with extras such as tags, due dates, subtasks and time,
keeps archived tasks, and writes a daily summary note with charts.

**Desktop only.** Joplin's REST API only listens on `127.0.0.1`, so the plugin
runs its HTTP calls through Super Productivity's `nodeExecution` capability
(Electron desktop app), which needs a one-time consent prompt.

## Setup

1. In Joplin: **Options → Web Clipper**, enable the service, copy the
   **Authorization token**.
2. In Super Productivity: **Settings → Plugins → Upload Plugin**, pointing at the
   zip from the [latest release](https://github.com/BigWebstas/SuperProd-Joplin-Sync/releases/latest)
   (`manifest.json`, `config-schema.json`, `plugin.js`, `index.html`, `icon.svg`).
   No build step.
3. Open the plugin, paste the token, Save. Grant the Node execution permission
   when prompted.
4. Adjust options under **Settings → Plugins → Joplin Notes Sync** (see
   [Settings](#settings)), then press **Sync Now** on the plugin page.

**Updating:** upload the new zip the same way. Super Productivity asks for the
Node execution permission again after every re-upload, and the plugin does
nothing until you allow it. Your settings and token carry over.

## Settings

Settings are listed in this order, and each title starts with its category. Every
option is off unless noted.

| Category | Setting | What it does |
|---|---|---|
| General | Joplin Web Clipper URL, Parent notebook, Auto-sync interval | Where Joplin listens, the notebook that holds everything, and how often to sync (0 = manual only, minimum 15 s) |
| General | Archive instead of delete | Move notes removed from Super Productivity into an `Archive` sub-notebook |
| Tasks | Sync task notes | Sync each task's Notes field with a `Tasks` sub-notebook (two-way) |
| Tasks | One-way only | Super Productivity always wins; Joplin edits are never pulled back |
| Tasks | Keep archived tasks | Archived tasks keep their Joplin notes (one-way) |
| Task note extras | Tags, Due date and done state, Subtask checklist, Time spent / estimate, Attachments, Issue reference, Repeat rule | Extra detail on each task note; all need **Sync task notes** |
| Projects | Icons and colours, Task index note | Notebook icons, and an `Overview` note per project |
| Daily summary | Write daily notes, Add charts, Add habits (charts and habits on by default) | One note per day with completed tasks, time per task, habits and pie charts |

The same list, with what is currently on, is shown on the plugin page.

## Notebook layout

```
Super Productivity/            (parent, configurable)
  └── <project title>/
        ├── <note title>
        ├── Archive/           (if "General: Archive instead of delete" is on)
        └── Tasks/             (if "Sync task notes" is on)
              └── <task title>
  └── Daily summaries/         (if "Write daily notes" is on)
        └── <YYYY-MM-DD>
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
| Task notes with **Tasks: One-way only** on | Super Productivity → Joplin only | Super Productivity always wins |
| Task tags (needs task-note sync) | Super Productivity → Joplin only | Super Productivity always wins |
| Task due dates (needs task-note sync) | Super Productivity → Joplin only | Super Productivity always wins |
| Task done state (needs task-note sync) | two-way, or one-way with **Tasks: One-way only** on | Super Productivity wins unless only the Joplin checkbox changed |
| Task subtask checklist (needs task-note sync) | Super Productivity → Joplin only | Super Productivity always wins |
| Task time estimate/spent (needs task-note sync) | Super Productivity → Joplin only | Super Productivity always wins |
| Task attachments (needs task-note sync) | Super Productivity → Joplin only | Super Productivity always wins |
| Task issue reference (needs task-note sync) | Super Productivity → Joplin only | Super Productivity always wins |
| Task repeat rule (needs task-note sync) | Super Productivity → Joplin only | Super Productivity always wins |
| Daily summary notes | Super Productivity → Joplin only | Regenerated every sync |
| Archived tasks (needs task-note sync) | Super Productivity → Joplin only | Super Productivity always wins |
| Project task index note (needs task-note sync) | Super Productivity → Joplin only | Super Productivity always wins |

Completed tasks get a `[Done] ` prefix on their Joplin note title — unless
**Task note extras: Due date and done state** is on, in which case the task's Joplin
note is a real to-do instead (see below) and the prefix is dropped.

## Project icons and colours

With **Projects: Icons and colours** on, each project's Joplin sub-notebook
gets a custom icon: the project's icon glyph on a tile filled with the project's
theme colour. This is one-way (Super Productivity → Joplin) and best-effort — a
failure to set an icon doesn't fail the note sync.

Joplin notebooks have no colour field, so the colour is baked into the icon
image itself (an SVG data-URL icon, the same slot Joplin's own icon picker
uses). The glyph is an emoji for common Super Productivity icons, or the first
letter of the project title otherwise. Only projects that have at least one note
to sync get an icon. Turning the option off later leaves icons already set in
place.

## Task due dates and done state

With **Task note extras: Due date and done state** on (needs task-note sync), each
task's Joplin note becomes a real to-do: Joplin's own checkbox and due-date
field are set from the task, instead of just the `[Done] ` title prefix. A
task's due date+time or due day is written to Joplin's `todo_due`, and its
done state to `todo_completed`/the checkbox (using the task's own "marked done
at" timestamp, falling back to its last-updated time for older tasks that
predate that field).

The due date is one-way (Super Productivity → Joplin). The done state is
two-way, like task notes: ticking or unticking the to-do in Joplin marks the
task done or not done in Super Productivity on the next sync. A tick is only
pulled when the task hasn't changed in Super Productivity since the last sync;
otherwise Super Productivity's state wins. With **Tasks: One-way only** on, the
done state is one-way too and Joplin ticks get reverted.

## Subtasks and time stats

With **Task note extras: Subtask checklist** on (needs task-note sync), each task's
Joplin note gets a markdown checklist of its subtasks appended to the bottom,
with each one's own done state as the checkbox. With **Sync task time
estimate/spent** on, a one-line summary ("2h 15m logged / 4h estimated") is
appended instead/as well. Both are one-way (Super Productivity → Joplin),
regenerated in full on every sync — so edits to either in Joplin don't stick,
and neither is meant to be edited there.

Both live in their own delimited block between the task's own notes and its
hidden `sp-task-id` marker, kept separate from the notes text itself so they
never get mistaken for a Joplin-side edit to the notes (see syncTaskNotes's
two-way diff, above).

## Attachments

With **Task note extras: Attachments** on (needs task-note sync), each task's
Joplin note gets a list of the task's attachments appended to the bottom: links,
images (web images shown inline) and local files as `file://` links. The files
themselves aren't copied into Joplin, so a file link only opens on a computer
that has the file at that path. One-way, in the same block as subtasks and time
stats.

## Issue references

With **Task note extras: Issue reference** on (needs task-note sync), a task imported from an
issue tracker gets a line at the bottom of its Joplin note with the provider and
issue id (for example `🔗 Issue: GITHUB 123`). It is a clickable link only when
the id is itself a web URL: Super Productivity doesn't share its issue-provider
settings (host, repository) with plugins, so URLs can't be built for GitHub,
Jira and similar.

## Repeat rule

With **Task note extras: Repeat rule** on (needs task-note sync), a task created by a
repeating-task setup gets a line at the bottom of its note, for example
`🔁 Repeats every 2 weeks (Mon, Wed)`, with `— paused` if the repeat is paused.

## Daily summary notes

With **Daily summary: Write daily notes** on (doesn't need task-note sync), one note per
day (`YYYY-MM-DD`) is written to a `Daily summaries` notebook under the parent
notebook. It lists the tasks completed that day and the time tracked per task,
using Super Productivity's start-of-next-day setting, and includes archived
tasks. The notebook gets a 📅 icon when **Projects: Icons and colours** is on. The last
7 days are refreshed on every sync; older notes are left alone.
With **Daily summary: Add habits** on (the default), each note also lists the habits
(counters) you logged that day: counts, or time for stopwatch habits. Only enabled
habits with activity that day are shown, because Super Productivity doesn't share
streak targets with plugins.

With **Daily summary: Add charts** on (the default), each note starts with
Mermaid pie charts: time by project, time by task, and completed tasks by project
(a chart with fewer than two slices is left out). Joplin renders these in its
viewer; other markdown apps show the code. The notes are regenerated each time,
so edits to them in Joplin are overwritten.
It is best-effort: a failure is logged and never fails the main sync.

## Archived tasks

By default a task's Joplin note is deleted (or moved to the Archive sub-notebook)
once the task is archived in Super Productivity. With **Keep archived tasks in
Joplin** on (needs task-note sync), archived tasks that have notes, or were
synced before, keep their notes. They are one-way: Joplin edits and done-state
changes are never pulled back into an archived task. If the archive can't be
read, that sync run is skipped instead of cleaning up notes.

## Project task index note

With **Projects: Task index note** on (needs task-note sync), each
project's Joplin sub-notebook gets an "Overview" note listing a link to every
one of its task notes — handy once a project has more than a couple. One-way
(Super Productivity → Joplin), regenerated in full on every sync.

## Note dates

Each synced note's created and updated dates in Joplin are set from the Super
Productivity note or task, so sorting by date in Joplin reflects when you
actually wrote it rather than when the plugin first synced it.

## Matching

Every synced note gets a hidden `<!-- sp-note-id:<id> -->` marker in its body.
Each sync lists the notebook's notes, matches them by that marker, and only
writes the ones that changed — so the link survives plugin reinstalls with no
local cache.

## Progress and errors

While a sync runs, the plugin page shows a progress bar with the percentage, the
current project and the elapsed time. The first sync of a large library can take
minutes; closing the page doesn't stop it.

Transient Joplin errors (connection resets, HTTP 429/502/503/504, timeouts on
repeatable requests) are retried automatically. If a sync still fails, a dialog
shows the error with a hint and a **Retry** button. A manual sync always shows
it; automatic syncs show it once per distinct error and stay quiet until a sync
succeeds again.

## Troubleshooting

| Message | What to do |
|---|---|
| *Node execution permission was not granted* | Allow Node execution for the plugin in **Settings → Plugins** (re-enable it if disabled). Needed again after every re-upload. |
| *No Joplin API token set* | Paste the Web Clipper token on the plugin page. |
| *Could not reach Joplin* | Start Joplin, enable **Options → Web Clipper**, and check the URL in the settings. |
| *Could not read archived tasks* | Only with **Keep archived tasks** on. The run is skipped on purpose so notes aren't cleaned up; try again. |
| *Plugin data exceeds maximum size of 256KB* | Fixed in 1.14.0 — update the plugin. |

## Multi-device caveats

- **Two-way task notes** call `PluginAPI.updateTask`, which can race with Super
  Productivity's own cross-device sync. The plugin delays pulls from Joplin for a
  couple of minutes after a task looks freshly changed, but that's a heuristic,
  not a guarantee. If tasks start duplicating, switch to **Tasks: One-way only** —
  it never writes back, so the race can't happen.
- **Duplicate Joplin notes** can appear when two devices each create a note for
  the same source before Joplin's own sync catches up. There's no atomic
  "create if missing" in Joplin's API, but the next sync detects and collapses
  any such group automatically, keeping the newest.
- Only **active projects with at least one note** are synced.

## Development

`npm test` runs the test suite (Node 20+, no dependencies). It loads the real
`plugin.js` against a fake Super Productivity API and an in-memory mock of
Joplin's Web Clipper API: sync, two-way pulls, saved-state size, archived tasks,
daily summaries, the failure dialog, progress and retries. `scripts/community-entry.py`
builds the release zip and prints the Super Productivity community-list entry.

## Changelog

Version history: [CHANGELOG.md](CHANGELOG.md). Full write-ups and downloadable
zips: [Releases](https://github.com/BigWebstas/SuperProd-Joplin-Sync/releases).
