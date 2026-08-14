# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Super Productivity plugin (`joplin-notes-sync`) that syncs project notes and,
optionally, task notes into a Joplin notebook via Joplin's local Web Clipper REST
API. Plain files, no build step, no dependencies, no test suite.

## Files that make up the plugin

- `manifest.json` — plugin id/version/permissions/hooks declared to Super Productivity.
  Keep `version` here in sync with `package.json`.
- `config-schema.json` — JSON Schema for the non-secret settings shown under
  Settings → Plugins → Joplin Notes Sync (Joplin URL, parent notebook, sync
  interval, task-notes toggle). The API token is deliberately NOT here — it's a
  secret set from the plugin's own page.
- `plugin.js` — all plugin logic (see Architecture below). One file, ~930 lines.
- `index.html` — the plugin's iframe UI (token entry, settings summary, manual
  sync button, status). Communicates with `plugin.js` purely via
  `window.postMessage`/`PluginAPI.onMessage` (see `onMessage` handler in
  `plugin.js` and the `window.addEventListener('message', ...)` in `index.html`);
  there is no shared JS context between them.
- `icon.svg` — header/plugin icon.

## Commands

There is no build, lint, or test tooling in this repo — `npm run build` is a
no-op placeholder. To package a release, zip exactly these five files (flat, no
subfolder) and upload via Super Productivity's **Settings → Plugins → Upload
Plugin**:

```
zip -j joplin-notes-sync.zip manifest.json config-schema.json plugin.js index.html icon.svg
```

Verify changes by loading the plugin in the Super Productivity desktop app —
there's no automated test harness.

## Architecture

### Two execution contexts, one file

`plugin.js` runs in two very different places:

1. **Outer, browser-side plugin code** — has full `PluginAPI` access (get
   projects/tasks, secrets, `persistDataSynced`, `updateTask`, hooks, etc.) but
   *cannot* make raw HTTP calls to `127.0.0.1` (Joplin's Web Clipper API only
   listens on localhost, which the plugin browser sandbox blocks).
2. **`NODE_SYNC_SCRIPT`** — a template-string script (lines ~75-406) executed via
   `PluginAPI.executeNodeScript` (desktop/Electron only, gated by a one-time user
   consent prompt). This runs as a real Node child process with `http`/`https`,
   so it's the only place that can actually talk to Joplin. It has **no**
   `PluginAPI` access — it only sees whatever is passed in via `args`, and
   returns a plain JSON result back to the outer code.

Any change to sync logic that needs both Joplin HTTP calls *and* Super
Productivity state has to be split across this boundary deliberately: gather
data outer → hand a self-contained payload to the Node script → apply the
script's returned result (e.g. task pulls via `PluginAPI.updateTask`) back in
the outer code afterward.

### Sync flow (`performSync` in the outer code)

1. Load config (`loadEffectiveConfig`) and the Joplin token (`PluginAPI.getSecret`).
2. Bail early with a snack/error if no token or if `executeNodeScript` isn't
   available (non-desktop).
3. Pull all non-archived projects + current notes/tasks from `PluginAPI`, and
   build a `payloadProjects` array: each project's notes (from `noteIds`) and,
   if `syncTaskNotes` is on, each task's own notes field, keyed by
   `normalizeTaskId` (see below).
4. For each project, chunk `notes` and `taskNotes` separately via `chunkBySize`
   so no single `executeNodeScript` call's JSON payload exceeds
   `MAX_PROJECT_PAYLOAD_CHARS` (8000 chars) — **one `executeNodeScript` call per
   chunk, at least one per project**. This exists because Super Productivity
   spawns the Node process with the whole script + JSON args as a single
   command-line argument, which has a much lower effective length limit on
   Windows and fails with `ENAMETOOLONG` if exceeded.
5. Only the **last chunk** of a project carries `noteValidIds`/`taskValidIds`
   and triggers the orphan-deletion sweep inside `NODE_SYNC_SCRIPT` — earlier
   chunks only create/update, to avoid deleting notes that just belong to a
   different chunk.
6. After all `executeNodeScript` calls succeed, apply any `taskNotesPulled`
   results back into Super Productivity via `PluginAPI.updateTask`, and persist
   the merged task sync-state baseline via `PluginAPI.persistDataSynced`.

### Matching Super Productivity items to Joplin notes

No local id-mapping cache is kept. Instead, every pushed note body carries a
hidden HTML-comment marker (`buildBody`/`buildTaskBody`):
`<!-- sp-note-id:<id> -->` for project notes, `<!-- sp-task-id:<id> -->` for
task notes. On each sync, `NODE_SYNC_SCRIPT` lists the notes already in the
target Joplin folder and regexes the marker back out (`MARKER_RE`/
`TASK_MARKER_RE`) to rebuild the id → note mapping. This means the link
survives plugin reinstalls. Distinct prefixes keep project notes and task notes
from ever cross-matching.

### One-way vs two-way sync

- **Project notes**: one-way only (SP → Joplin). The plugin API has no way to
  write `PluginNote` content back into Super Productivity, so Joplin-side edits
  are simply overwritten on the next sync.
- **Task notes** (opt-in via `syncTaskNotes`): two-way. Since neither side is
  authoritative, `decideTaskAction` in `NODE_SYNC_SCRIPT` compares each side's
  current content against a persisted "last synced content" baseline
  (`TASK_SYNC_STATE_KEY`, keyed by normalized sync id) to figure out which side
  actually changed. If both changed since the baseline (or there's no
  baseline), the more recently updated side wins and silently overwrites the
  other — no merge, no prompt.
- A task's `[Done] ` title prefix is always SP → Joplin only and is applied
  independently of the content decision above (see the `titleStale` handling in
  `NODE_SYNC_SCRIPT`).

### The multi-device race and its mitigations

`PluginAPI.updateTask` (used only for pulling Joplin content into a task) can
in principle race with Super Productivity's own cross-device sync if this
plugin runs on more than one device — plugins have no visibility into whether
SP's own sync is mid-flight. Two purely heuristic mitigations gate *only* the
pull direction (pushing to Joplin is never delayed):

- **`PULL_SETTLE_MS`** (2 min, inside `NODE_SYNC_SCRIPT`'s `decideTaskAction`):
  withhold a pull until a task has been quiet on the SP side for this long.
- **Burst cooldown** (`noteTaskUpdateForBurstDetection`, outer code): if
  `SYNC_BURST_TASK_COUNT` (5) tasks update within `SYNC_BURST_WINDOW_MS` (2s) —
  a signature of SP's own incoming sync touching many tasks at once, unlike a
  human editing one at a time — pulls are treated as unsafe for
  `PULL_COOLDOWN_MS` (60s).

If task duplication reappears on a multi-device setup, this race is the first
thing to suspect (see the comment block at the top of `plugin.js`).

### Recurring calendar tasks

Google/ICS calendar-imported tasks get a new task id per occurrence (a
trailing `_<ISO timestamp>` suffix). `normalizeTaskId` strips that suffix so
all occurrences of the same recurring event collapse onto one stable sync key
and one Joplin note, instead of minting a new note every day. When multiple
occurrences of the same event coexist, `latestTaskBySyncId` (outer code) picks
the most recently updated occurrence as the one pulls write back onto.

### Plugin ↔ iframe messaging

`index.html` never touches `PluginAPI` directly — it posts
`{ type: 'PLUGIN_MESSAGE', message, messageId }` to the parent window and
awaits a matching response. `plugin.js`'s `PluginAPI.onMessage` handler
switches on `message.type`: `getState`, `saveToken`, `clearToken`, `syncNow`.
Add new UI-triggered actions by extending both sides of this switch.
