# Changelog

All notable changes to **Joplin Notes Sync**. Each version links to its
[GitHub release](https://github.com/BigWebstas/SuperProd-Joplin-Sync/releases),
which carries the full write-up and the installable zip.

The format loosely follows [Keep a Changelog](https://keepachangelog.com/).
Every user-visible change bumps `version` in both `manifest.json` and
`package.json`.

## [1.8.1] - 2026-09-02

### Fixed
- `spawn ENAMETOOLONG`: 1.8.0 built the project-icon SVG (colour parser, emoji
  map, SVG assembly) inside `NODE_SYNC_SCRIPT`, growing it enough that the
  script plus a project's note payload overflowed the single Windows
  command-line argument `executeNodeScript` spawns Node with.

### Changed
- Icon building moved to the browser-side plugin code. The Node script only
  reads the finished `FolderIcon` value and writes it; the SVG is a
  percent-encoded data URL (no `Buffer`/`btoa`).
- Notes and task notes now sync in **separate** `executeNodeScript` calls, so
  one call's args are bounded by the script size plus a single chunk plus fixed
  overhead regardless of the other array. The common case (no task notes) still
  makes one call per project.
- `MAX_PROJECT_PAYLOAD_CHARS` is derived from `NODE_SYNC_SCRIPT.length`, so
  future script growth tightens the payload budget instead of silently blowing
  the limit again.

## [1.8.0] - 2026-09-02 — broken, use 1.8.1

> Fails with `spawn ENAMETOOLONG` on any sync large enough to hit the Windows
> command-line limit. Superseded by [1.8.1](#181---2026-09-02), which ships the
> same feature fixed.

### Added
- **Sync project icons and colours** setting (`syncProjectIcons`, off by
  default). Each project's Joplin sub-notebook gets a custom icon: the
  project's icon glyph on a tile filled with the project's theme colour.
  Joplin notebooks have no colour field, so the colour is carried inside an
  SVG data-URL icon. The glyph is an emoji for common Super Productivity icon
  names, else the project title's first letter. One-way (SP → Joplin),
  best-effort — a failed icon write is reported but never blocks the note sync.
  Only projects with at least one synced note get an icon.

## [1.7.0] - 2026-08-27

### Fixed
- Duplicate Joplin notes from multi-device races: two devices could each create
  a note for the same source before Joplin's own sync propagated the other.
  A sync on either device now detects any group of notes sharing one
  `sp-note-id`/`sp-task-id` marker and collapses it, keeping the most recently
  updated one and removing (or archiving) the rest.

## [1.6.0] - 2026-08-21

### Added
- **Sync task tags** setting (off by default, only with **Sync task notes**).
  Sets each task's Joplin note to carry the same Joplin tags as the task's
  Super Productivity tags, creating any missing Joplin tag by title. Always
  one-way (SP → Joplin), independent of **One-way task notes**.

## [1.5.0] - 2026-08-18

### Added
- **One-way task notes (Super Productivity → Joplin)** setting (off by
  default). Makes task notes behave like project notes: SP is always the
  source of truth, Joplin edits are never pulled, and `updateTask` is never
  called for task notes — so the multi-device pull race can't happen.

## [1.4.0] - 2026-08-14

### Added
- **Archive removed notes instead of deleting** setting (off by default). A
  Joplin note whose source note/task no longer exists on the SP side is moved
  into an `Archive` sub-notebook instead of being deleted. Also covers a task's
  notes being cleared to empty. Archived notes drop out of future matching.

## [1.3.0] - 2026-08-13

### Added
- With **Sync task notes** on, a completed task's Joplin note title gets a
  `[Done] ` prefix, removed again when the task is un-completed. Pushes on the
  done-state change alone, not only on a notes-content edit. One-way.

## [1.2.2] - 2026-08-13

### Fixed
- `spawn ENAMETOOLONG` recurring on Windows: two-way task notes had eaten the
  per-project headroom from 1.1.2.
  - Dropped the redundant `content` field from the payload (recoverable from
    `body` via `stripTaskMarker`).
  - A project's notes and task notes are now chunked across as many
    `executeNodeScript` calls as needed to stay under a size budget.
    Orphan-deletion only runs on the last chunk, against the full id list.

## [1.2.1] - 2026-08-13

### Changed
- **Two-way task notes sync is back** (opt-in), after the 1.1.1 revert. Edits
  on either side reconcile against a persisted per-task "last synced" baseline
  (`persistDataSynced`); real conflicts resolve last-write-wins. Requires
  re-granting `updateTask`, `persistDataSynced`, `loadSyncedData` on upgrade.
- The sync-state baseline is keyed on the normalized calendar-occurrence id, so
  a recurring event's baseline survives across daily occurrences.

### Added
- Heuristic multi-device race mitigation: a pull into a task is withheld for
  2 minutes after the task last changed on the SP side, and for 60 seconds
  after a burst of task updates that looks like an incoming remote sync.
  Pushing to Joplin is never gated. This narrows, not closes, the window —
  plugins have no visibility into Super Productivity's own sync state.
- New plugin icon (rotating sync arrow with a "J"). The header sync button uses
  the built-in `refresh` icon.

## [1.1.5] - 2026-08-13

### Fixed
- Duplicate task notes for recurring calendar-imported tasks (Google/ICS).
  - The per-occurrence task id (with the day's start time baked in) was used
    as the sync key, so every occurrence looked new. The trailing occurrence
    timestamp is now stripped first.
  - `MARKER_RE`/`TASK_MARKER_RE` only matched `[a-zA-Z0-9_-]+`, so calendar
    ids containing `@` and `.` never matched existing notes. The regex now
    matches any non-whitespace id.

## [1.1.3] - 2026-08-13

### Changed
- Repo housekeeping only: added a root `.gitignore` for `.idea/`. No functional
  plugin change from 1.1.2.

## [1.1.2] - 2026-08-13

### Fixed
- `spawn ENAMETOOLONG` on Windows: the plugin now makes one `executeNodeScript`
  call per project instead of one call for everything, keeping each command
  line short regardless of total notes volume.

## [1.1.1] - 2026-08-13

### Changed
- Task notes reverted to one-way (SP → Joplin) after 1.1.0's two-way sync
  caused Super Productivity to duplicate tasks on multi-device setups (a
  scheduled `updateTask` racing with SP's own cross-device sync). `updateTask`,
  `persistDataSynced`, `loadSyncedData` dropped from the manifest.
- Installing 1.1.1 stops new duplicates; existing duplicate tasks and their
  Joplin notes must be cleaned up by hand.

## [1.1.0] - 2026-08-13

### Added
- **Sync task notes** setting (off by default). Syncs each task's own Notes
  field with a `Tasks` sub-notebook per project. Two-way, last-write-wins by
  timestamp, no merge UI. Adds `updateTask`, `persistDataSynced`,
  `loadSyncedData` to the manifest — re-grant on upgrade.

## [1.0.0] - 2026-08-13

### Added
- One-way sync of Super Productivity project notes into Joplin notebooks via
  Joplin's local Web Clipper API. Desktop only.

[1.8.1]: https://github.com/BigWebstas/SuperProd-Joplin-Sync/releases/tag/v1.8.1
[1.8.0]: https://github.com/BigWebstas/SuperProd-Joplin-Sync/releases/tag/v1.8.0
[1.7.0]: https://github.com/BigWebstas/SuperProd-Joplin-Sync/releases/tag/v1.7.0
[1.6.0]: https://github.com/BigWebstas/SuperProd-Joplin-Sync/releases/tag/v1.6.0
[1.5.0]: https://github.com/BigWebstas/SuperProd-Joplin-Sync/releases/tag/v1.5.0
[1.4.0]: https://github.com/BigWebstas/SuperProd-Joplin-Sync/releases/tag/v1.4.0
[1.3.0]: https://github.com/BigWebstas/SuperProd-Joplin-Sync/releases/tag/v1.3.0
[1.2.2]: https://github.com/BigWebstas/SuperProd-Joplin-Sync/releases/tag/v1.2.2
[1.2.1]: https://github.com/BigWebstas/SuperProd-Joplin-Sync/releases/tag/v1.2.1
[1.1.5]: https://github.com/BigWebstas/SuperProd-Joplin-Sync/releases/tag/v1.1.5
[1.1.3]: https://github.com/BigWebstas/SuperProd-Joplin-Sync/releases/tag/v1.1.3
[1.1.2]: https://github.com/BigWebstas/SuperProd-Joplin-Sync/releases/tag/v1.1.2
[1.1.1]: https://github.com/BigWebstas/SuperProd-Joplin-Sync/releases/tag/v1.1.1
[1.1.0]: https://github.com/BigWebstas/SuperProd-Joplin-Sync/releases/tag/v1.1.0
[1.0.0]: https://github.com/BigWebstas/SuperProd-Joplin-Sync/releases/tag/v1.0.0
