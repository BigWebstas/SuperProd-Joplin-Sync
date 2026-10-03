// Joplin Notes Sync — pushes each project's notes into a matching Joplin
// notebook via Joplin's local Web Clipper REST API.
//
// Project notes are one-way only (Super Productivity -> Joplin): the plugin
// API has no way to write PluginNote content back into Super Productivity.
//
// Task notes (opt-in, see syncTaskNotes) are two-way by default: PluginAPI.
// updateTask can write a task's `notes` field, so edits on either side get
// reconciled. Since neither side is authoritative, a per-task "last synced
// content" baseline (persisted via PluginAPI.persistDataSynced, see
// TASK_SYNC_STATE_KEY) is used to tell which side actually changed since the
// last sync. If both changed, the more recently modified one wins
// (last-write-wins by timestamp) and the loser is silently overwritten —
// there is no merge UI. Setting taskNotesOneWay makes task notes one-way
// (Super Productivity -> Joplin only) instead, same as project notes: Joplin
// edits are never pulled and get overwritten on the next sync.
//
// Task tags (opt-in via syncTaskTags, only takes effect alongside
// syncTaskNotes) are one-way (Super Productivity -> Joplin) only, applied as
// Joplin tags on the same per-task note: there's nowhere in Super
// Productivity to write a Joplin-side tag change back to, so unlike task
// note content there's no pull direction or conflict to resolve here.
//
// Task due dates and done state (opt-in via syncTaskDueDates, only takes
// effect alongside syncTaskNotes) are written onto the task's Joplin note as
// native to-do fields (is_todo/todo_due/todo_completed) rather than into the
// note body — that keeps them out of the two-way notes-content diff entirely.
// Due dates are one-way. Done state follows task notes: two-way by default
// (with its own baseline, TASK_SYNC_STATE_KEY's `done` map), one-way when
// taskNotesOneWay is on.
//
// Every synced note's Joplin created/updated dates (user_created_time/
// user_updated_time) are set from the Super Productivity note or task.
//
// A task's subtask checklist and time estimate/spent (opt-in via
// syncTaskSubtasks/syncTaskTimeStats) are also one-way, appended to the note
// body but inside their own sp-task-meta comment block so the two-way diff's
// stripTaskMarker can strip them back out, same reasoning as the marker
// itself. A per-project task index note (opt-in via syncProjectIndex) is
// likewise one-way and regenerated in full every sync.
//
// Calling updateTask on a schedule can race with Super Productivity's own
// cross-device sync (on a multi-device setup, the two can collide on the
// same task); an earlier version of this plugin reverted to one-way sync
// over that risk. Plugins have no visibility into Super Productivity's own
// sync state (no hook or getter for "sync in progress"), so this can only
// be narrowed heuristically, not eliminated: see PULL_SETTLE_MS and
// noteTaskUpdateForBurstDetection below, both of which only ever gate the
// pull direction (the only one that calls updateTask) and never delay
// pushing to Joplin. If task duplication reappears on a multi-device setup,
// this race is still the first thing to suspect.
//
// Reaching Joplin requires Node's http/https modules, which the browser-side
// PluginAPI.request() cannot use against localhost. This plugin instead runs
// the Joplin API calls through executeNodeScript (desktop/Electron only,
// gated by the user's one-time nodeExecution consent prompt). Task pulls
// (writing Joplin content back into a task) happen in the outer, browser-side
// plugin code afterwards, since executeNodeScript's child process has no
// access to PluginAPI.

// Keep in step with manifest.json/package.json: the plugin can't read its own
// manifest, so this is what the update check compares against.
const PLUGIN_VERSION = '1.12.0';
const RELEASES_API_URL =
  'https://api.github.com/repos/BigWebstas/SuperProd-Joplin-Sync/releases/latest';

const TOKEN_SECRET_KEY = 'joplinApiToken';
const TASK_SYNC_STATE_KEY = 'taskNotesSyncState';
const AUTO_SYNC_DEBOUNCE_MS = 8000;
const MIN_INTERVAL_SEC = 15;

const DEFAULTS = {
  joplinUrl: 'http://127.0.0.1:41184',
  parentNotebookTitle: 'Super Productivity',
  syncIntervalSec: 60,
  syncTaskNotes: false,
  taskNotesOneWay: false,
  syncTaskTags: false,
  archiveRemovedNotes: false,
  syncProjectIcons: false,
  syncTaskDueDates: false,
  syncTaskSubtasks: false,
  syncTaskTimeStats: false,
  syncTaskAttachments: false,
  syncProjectIndex: false,
};

// Matches sp-note-id / sp-task-id markers written into a note body (see
// buildBody/buildTaskBody below). The marker is how a Joplin note is matched
// back to its Super Productivity note or task on the next sync, so no local
// id-mapping cache is needed and the link survives plugin reinstalls. Notes
// and tasks use distinct prefixes so a task note is never matched against a
// project note (their ids are drawn from different, unrelated id spaces).
const MARKER_PREFIX = '<!-- sp-note-id:';
const TASK_MARKER_PREFIX = '<!-- sp-task-id:';
const MARKER_SUFFIX = ' -->';

// Wraps optional decorative content (subtask checklist, time stats — see
// syncTaskSubtasks/syncTaskTimeStats) appended between a task's own notes and
// its sp-task-id marker. Kept in its own delimited block, rather than mixed
// straight into the notes text, so the Node script's stripTaskMarker can strip
// it back out before the two-way notes-content diff runs — without that, an
// edit to a subtask elsewhere would look like the user edited the task's notes
// in Joplin, and a pull would overwrite the notes field with the checklist.
const TASK_META_PREFIX = '<!-- sp-task-meta:start -->';
const TASK_META_SUFFIX = '<!-- sp-task-meta:end -->';

// Calendar-imported tasks (Super Productivity's Google/ICS calendar
// integration) get one task id per event *occurrence*, e.g.
// "cal_<uid>@google.com_2026-08-13T09:30:00" — the trailing timestamp is
// that day's start time, so a daily recurring event mints a brand-new task
// id every day even though it's "the same" task to the user. Keying the
// Joplin note on the raw id would then create a fresh note every occurrence
// instead of updating one. Stripping the trailing occurrence timestamp
// collapses all occurrences of the same calendar event onto a single,
// stable sync key.
const CALENDAR_OCCURRENCE_SUFFIX_RE = /_\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?$/;

function normalizeTaskId(id) {
  return String(id).replace(CALENDAR_OCCURRENCE_SUFFIX_RE, '');
}

// Executed inside a plain Node.js process via PluginAPI.executeNodeScript.
// Kept dependency-free (only Node built-ins) since the sandbox only allows
// fs/path/os via `require` for trivial scripts — anything else (like this)
// runs as a full child process instead, which does have full module access.
// Comment lines and indentation are stripped before sending (see
// compactNodeScript), so comments here cost nothing against the size budget.
const NODE_SYNC_SCRIPT = compactNodeScript(`
const http = require('http');
const https = require('https');

const input = args[0] || {};
const baseUrl = String(input.baseUrl || '').replace(/\\/+$/, '');
const token = String(input.token || '');
const parentTitle = String(input.parentNotebookTitle || 'Super Productivity');
const projects = Array.isArray(input.projects) ? input.projects : [];
const syncTaskNotes = input.syncTaskNotes === true;
// When true, task notes behave like project notes: Super Productivity is the
// only source of truth, Joplin-side edits are never pulled, and a content
// mismatch always gets overwritten with the Super Productivity side on the
// next sync (see decideTaskAction below).
const taskNotesOneWay = input.taskNotesOneWay === true;
// One-way (SP -> Joplin) sync of each task's SP tags onto its Joplin note's
// tags, see syncNoteTags below. Only meaningful when syncTaskNotes is also
// on, since that's what creates/matches the per-task Joplin note to tag.
const syncTaskTags = input.syncTaskTags === true && syncTaskNotes;
// Computed in the outer, browser-side plugin code (see performSync and
// noteTaskUpdateForBurstDetection) — false means a pull just isn't safe to
// attempt this round, see decideTaskAction's canPull check below.
const pullsAllowed = input.pullsAllowed !== false;
// When true, a Joplin note that would otherwise be deleted (because its
// source note/task no longer exists, or a task's notes field was cleared) is
// instead moved into an "Archive" sub-notebook alongside its live siblings.
// An archived note is no longer listed under its original folder, so it
// drops out of byNoteId/byTaskId on the next sync and is never reconsidered
// — archiving is a one-way move, not a tracked state.
const archiveRemovedNotes = input.archiveRemovedNotes === true;
// One-way (SP -> Joplin) sync of each project's Super Productivity icon glyph
// and theme colour onto its Joplin sub-notebook's icon. Joplin notebooks have
// no colour field at all, so both are baked into a small SVG image set as the
// folder's data-URL icon (FolderIconType.DataUrl). See buildProjectFolderIcon.
// Applied only on a project's last chunk, alongside the orphan sweeps. Turning
// this off later leaves any icons already set in place (a one-way write, not a
// tracked state) — same as archiveRemovedNotes.
const syncProjectIcons = input.syncProjectIcons === true;
// One-way (SP -> Joplin) sync of each task's due date and done state onto its
// Joplin note's native to-do fields (is_todo/todo_due/todo_completed), rather
// than into the note body — that keeps it clear of the two-way notes-content
// diff in decideTaskAction, which assumes stripTaskMarker(body) is exactly
// item's SP notes content. Only meaningful alongside syncTaskNotes.
const syncTaskDueDates = input.syncTaskDueDates === true && syncTaskNotes;
// Ticking/unticking a task's Joplin to-do is pulled back into the task's done
// state, alongside two-way notes; one-way task notes keep it push-only. Uses its
// own done baseline (item.lastSyncedDone), see decideTaskAction's reasoning.
const twoWayDone = syncTaskDueDates && !taskNotesOneWay;
// One-way (SP -> Joplin), best-effort project-level "table of contents" note
// listing every task note currently in the project's Tasks sub-notebook.
// Rebuilt in full on the project's very last executeNodeScript call (see
// isProjectFinalCall in the outer plugin code) since notes and task notes can
// arrive in separate calls (see MAX_PROJECT_PAYLOAD_CHARS chunking) and only
// the last call is guaranteed to see every note already synced this run.
const syncProjectIndex = input.syncProjectIndex === true && syncTaskNotes;

function apiRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(baseUrl + path);
    } catch (e) {
      reject(new Error('Invalid Joplin URL: ' + baseUrl));
      return;
    }
    url.searchParams.set('token', token);
    const lib = url.protocol === 'https:' ? https : http;
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = lib.request(
      url,
      {
        method,
        headers: payload
          ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload),
            }
          : {},
        timeout: 10000,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          let parsed = null;
          if (raw) {
            try {
              parsed = JSON.parse(raw);
            } catch (e) {
              parsed = raw;
            }
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            const msg =
              parsed && parsed.error ? parsed.error : raw || 'HTTP ' + res.statusCode;
            reject(new Error(method + ' ' + path + ' failed (' + res.statusCode + '): ' + msg));
          }
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Joplin request timed out: ' + method + ' ' + path));
    });
    req.on('error', (err) => reject(new Error('Joplin request error: ' + err.message)));
    if (payload) req.write(payload);
    req.end();
  });
}

async function listAll(path, fields) {
  const items = [];
  let page = 1;
  for (;;) {
    const sep = path.includes('?') ? '&' : '?';
    const res = await apiRequest('GET', path + sep + 'fields=' + fields + '&limit=100&page=' + page);
    const pageItems = (res && res.items) || [];
    items.push(...pageItems);
    if (!res || !res.has_more || page > 20) break;
    page += 1;
  }
  return items;
}

async function findFolder(title, parentId) {
  const existing = await listAll('/folders', 'id,title,parent_id');
  const match = existing.find(
    (f) => f.title === title && (f.parent_id || '') === (parentId || ''),
  );
  return match ? match.id : null;
}

async function findOrCreateFolder(title, parentId) {
  const existingId = await findFolder(title, parentId);
  if (existingId) return existingId;
  const created = await apiRequest('POST', '/folders', {
    title,
    parent_id: parentId || undefined,
  });
  return created.id;
}

// Memoizes the "Archive" folder id per parent within a single script run, so
// several archived notes under the same project/Tasks folder only trigger one
// findOrCreateFolder call instead of one each.
const archiveFolderIdByParent = new Map();
async function getArchiveFolderId(parentId) {
  if (archiveFolderIdByParent.has(parentId)) return archiveFolderIdByParent.get(parentId);
  const id = await findOrCreateFolder('Archive', parentId);
  archiveFolderIdByParent.set(parentId, id);
  return id;
}

// Either deletes a Joplin note or, if archiveRemovedNotes is on, moves it into
// an "Archive" sub-notebook under parentId instead. Returns true if archived,
// false if deleted, so callers can bucket the result into the right counter.
async function removeOrArchive(joplinNoteId, parentId) {
  if (archiveRemovedNotes) {
    const archiveFolderId = await getArchiveFolderId(parentId);
    await apiRequest('PUT', '/notes/' + joplinNoteId, { parent_id: archiveFolderId });
    return true;
  }
  await apiRequest('DELETE', '/notes/' + joplinNoteId);
  return false;
}

// Each device runs this plugin against its own local Joplin instance, and
// Joplin's own sync propagates notes between devices independently of this
// plugin. Two devices can therefore both list a folder, both see no note yet
// for a given sp-note-id/sp-task-id, and both create one; once Joplin's sync
// has propagated both copies everywhere, a later sync here sees two notes
// sharing the same marker. Grouping them with a plain Map (keyed by that id)
// would silently keep only whichever is listed last, leaving the other
// invisible to both the update path and the orphan-deletion sweep below —
// i.e. a permanent duplicate. Grouping explicitly and collapsing any group of
// more than one note (keeping the most recently updated, removing the rest
// via removeOrArchive) makes a race like this heal itself on the very next
// sync instead of leaving Joplin cluttered forever. This can't prevent the
// race itself — Joplin's API has no atomic "create if missing" — only clean
// up after it.
async function dedupeByMarker(notes, markerRe, parentIdForArchive) {
  const groups = new Map();
  for (const jn of notes) {
    const match = jn.body && jn.body.match(markerRe);
    if (!match) continue;
    if (!groups.has(match[1])) groups.set(match[1], []);
    groups.get(match[1]).push(jn);
  }
  const byId = new Map();
  let archived = 0;
  let deleted = 0;
  for (const [id, group] of groups) {
    group.sort((a, b) => (b.updated_time || 0) - (a.updated_time || 0));
    const [keep, ...dupes] = group;
    byId.set(id, keep);
    for (const dupe of dupes) {
      if (await removeOrArchive(dupe.id, parentIdForArchive)) archived += 1;
      else deleted += 1;
    }
  }
  return { byId, archived, deleted };
}

// Memoizes Joplin tag id lookups by title within a single script run, so
// several tasks sharing a tag only trigger one GET /tags (to seed the cache)
// and, for a genuinely new tag, one POST /tags rather than one lookup each.
let tagIdByTitle = null;
async function ensureTagsLoaded() {
  if (tagIdByTitle) return;
  tagIdByTitle = new Map();
  const tags = await listAll('/tags', 'id,title');
  for (const t of tags) tagIdByTitle.set(t.title, t.id);
}

async function findOrCreateTagId(title) {
  await ensureTagsLoaded();
  if (tagIdByTitle.has(title)) return tagIdByTitle.get(title);
  try {
    const created = await apiRequest('POST', '/tags', { title });
    tagIdByTitle.set(title, created.id);
    return created.id;
  } catch (e) {
    // Joplin normalizes/dedupes tag titles (e.g. by case), so the create can
    // fail if a differently-cased match already exists. Refetch once and
    // retry the lookup before giving up.
    tagIdByTitle = null;
    await ensureTagsLoaded();
    const existingId = tagIdByTitle.get(title);
    if (existingId) return existingId;
    throw e;
  }
}

// One-way (Super Productivity -> Joplin) sync of a single note's tag set:
// adds tags present in desiredTitles but missing on the note, removes tags
// present on the note but no longer in desiredTitles. Joplin's Web Clipper
// API has no batch-tagging endpoint, so this costs one GET plus one
// POST/DELETE per tag actually added or removed.
async function syncNoteTags(noteId, desiredTitles) {
  const current = await listAll('/notes/' + noteId + '/tags', 'id,title');
  const currentByTitle = new Map(current.map((t) => [t.title, t.id]));
  const desired = new Set(desiredTitles);
  for (const title of desired) {
    if (!currentByTitle.has(title)) {
      const tagId = await findOrCreateTagId(title);
      await apiRequest('POST', '/tags/' + tagId + '/notes', { id: noteId });
    }
  }
  for (const [title, tagId] of currentByTitle) {
    if (!desired.has(title)) {
      await apiRequest('DELETE', '/tags/' + tagId + '/notes/' + noteId);
    }
  }
}

// Ids are opaque, whitespace-free tokens, so match anything up to the
// trailing space + "-->" rather than an alphanumeric allowlist — calendar-
// imported task ids contain "@" and "." (e.g. "...@google.com"), which an
// [a-zA-Z0-9_-]+ class would silently fail to match at all, making every
// synced note for that task permanently unrecognizable on the next sync.
const MARKER_RE = /<!--\\s*sp-note-id:(\\S+)\\s*-->/;
const TASK_MARKER_RE = /<!--\\s*sp-task-id:(\\S+)\\s*-->/;
// Matches the whole sp-task-meta block (see TASK_META_PREFIX/SUFFIX and
// buildTaskDecoration in the outer plugin code) so it can be stripped out
// before the two-way notes-content diff, same reasoning as TASK_MARKER_RE.
const TASK_META_RE = /<!--\\s*sp-task-meta:start\\s*-->[\\s\\S]*?<!--\\s*sp-task-meta:end\\s*-->/;
const PROJECT_INDEX_MARKER_RE = /<!--\\s*sp-project-index\\s*-->/;
const PROJECT_INDEX_MARKER = '<!-- sp-project-index -->';
const PROJECT_INDEX_TITLE = 'Overview';

function stripTaskMarker(body) {
  return String(body || '')
    .replace(TASK_MARKER_RE, '')
    .replace(TASK_META_RE, '')
    .trim();
}

// A task that was touched very recently is more likely to still be mid-
// flight through Super Productivity's own cross-device sync pipeline, which
// plugins can't observe directly (see the file header). Withholding a pull
// (the only action that calls updateTask) until a task has been quiet for
// this long narrows, but can't close, the window where that write could
// land on top of an incoming remote sync for the same task.
const PULL_SETTLE_MS = 2 * 60 * 1000;

function canPullTask(item) {
  return pullsAllowed && Date.now() - item.spUpdated >= PULL_SETTLE_MS;
}

// Joplin's user-facing created/updated dates, set from the SP item so sorting
// and date search in Joplin reflect the real ages rather than the sync time.
function noteDates(item) {
  const d = {};
  if (item.created) d.user_created_time = item.created;
  if (item.spUpdated) d.user_updated_time = item.spUpdated;
  return d;
}

// Decides what to do with one task's note given its current content on both
// sides and the content both sides agreed on last sync (item.lastSynced,
// null if never synced). Only the side that actually moved away from that
// baseline is treated as "changed"; if both moved, the more recently
// modified one wins.
function decideTaskAction(item, existingNote, ctx) {
  // item.body already carries the marker-stamped content (see buildTaskBody);
  // stripping it back off here avoids also transmitting a separate, fully
  // redundant content field for every task note in the payload.
  const spContent = stripTaskMarker(item.body);
  if (!existingNote) {
    return spContent === '' ? { action: 'none' } : { action: 'create' };
  }

  const joplinContent = stripTaskMarker(existingNote.body);
  if (joplinContent === spContent) {
    return { action: 'none', syncedContent: spContent };
  }

  // One-way: Super Productivity always wins, immediately, regardless of who
  // changed what or when — no baseline comparison, no pull, no conflict
  // resolution, same as how project notes are handled above.
  if (ctx.oneWay) {
    return spContent === '' ? { action: 'delete' } : { action: 'update' };
  }

  const lastSynced = item.lastSynced;
  const spChanged = lastSynced === null || spContent !== lastSynced;
  const joplinChanged = lastSynced === null || joplinContent !== lastSynced;

  const canPull = canPullTask(item);

  if (spChanged && !joplinChanged) {
    return spContent === '' ? { action: 'delete' } : { action: 'update' };
  }
  if (joplinChanged && !spChanged) {
    return canPull ? { action: 'pull', content: joplinContent } : { action: 'none' };
  }
  // Conflict (both changed, or no baseline to compare against): last write wins.
  const joplinUpdated = existingNote.updated_time || 0;
  if (joplinUpdated > item.spUpdated) {
    return canPull ? { action: 'pull', content: joplinContent } : { action: 'none' };
  }
  return spContent === '' ? { action: 'delete' } : { action: 'update' };
}

let rootFolderId;
try {
  rootFolderId = await findOrCreateFolder(parentTitle, '');
} catch (e) {
  return { success: false, error: 'Could not reach Joplin (' + e.message + ')' };
}

const results = [];
for (const project of projects) {
  const projectResult = {
    projectId: project.id,
    projectTitle: project.title,
    created: 0,
    updated: 0,
    deleted: 0,
    archived: 0,
    unchanged: 0,
    error: null,
    iconError: null,
    indexError: null,
    taskNotesSynced: {},
    taskNotesPulled: [],
    taskDoneSynced: {},
    taskDonePulled: [],
  };
  try {
    const folderId = await findOrCreateFolder(project.title, rootFolderId);
    const existingNotes = await listAll(
      '/folders/' + folderId + '/notes',
      'id,title,body,updated_time,user_created_time',
    );

    const noteDedup = await dedupeByMarker(existingNotes, MARKER_RE, folderId);
    const byNoteId = noteDedup.byId;
    projectResult.archived += noteDedup.archived;
    projectResult.deleted += noteDedup.deleted;

    for (const note of project.notes) {
      const existing = byNoteId.get(note.id);
      if (existing) {
        if (
          existing.body !== note.body ||
          existing.title !== note.title ||
          (note.created && existing.user_created_time !== note.created)
        ) {
          await apiRequest('PUT', '/notes/' + existing.id, {
            title: note.title,
            body: note.body,
            ...noteDates(note),
          });
          projectResult.updated += 1;
        } else {
          projectResult.unchanged += 1;
        }
      } else {
        await apiRequest('POST', '/notes', {
          title: note.title,
          body: note.body,
          parent_id: folderId,
          ...noteDates(note),
        });
        projectResult.created += 1;
      }
    }

    // A large project is split across several calls to stay under the
    // command-line size a single executeNodeScript spawn can carry (see
    // MAX_PROJECT_PAYLOAD_CHARS in the outer plugin code) — each call only
    // sees its own slice of project.notes, so only the call carrying the full,
    // authoritative set of current note ids (noteValidIds) runs the
    // orphan-deletion sweep. Earlier calls skip it entirely rather than risk
    // deleting notes that simply belong to a different chunk.
    if (project.isLastChunk && Array.isArray(project.noteValidIds)) {
      const validNoteIds = new Set(project.noteValidIds);
      for (const [spNoteId, jn] of byNoteId.entries()) {
        if (!validNoteIds.has(spNoteId)) {
          const archived = await removeOrArchive(jn.id, folderId);
          if (archived) projectResult.archived += 1;
          else projectResult.deleted += 1;
        }
      }
    }

    // Project icon + colour (opt-in). project.icon arrives already built by the
    // outer plugin code (buildProjectFolderIcon) as a serialized Joplin
    // FolderIcon JSON string — the SVG tile is assembled there, not here, to
    // keep this script's source small (it and the JSON args share one Windows
    // command-line argument, see MAX_PROJECT_PAYLOAD_CHARS). One-way,
    // best-effort, last chunk only: read the folder's current icon and PUT only
    // when it differs. Wrapped in its own try/catch — the icon is cosmetic, so
    // a failure here must not skip the task-note sync below or fail the
    // project. Recorded on projectResult.iconError.
    if (project.isLastChunk && syncProjectIcons && project.icon) {
      try {
        const current = await apiRequest(
          'GET',
          '/folders/' + folderId + '?fields=id,icon',
        );
        if (!current || current.icon !== project.icon) {
          await apiRequest('PUT', '/folders/' + folderId, { icon: project.icon });
        }
      } catch (e) {
        projectResult.iconError = e.message;
      }
    }

    const taskNotes = Array.isArray(project.taskNotes) ? project.taskNotes : [];
    // Always look up (never eagerly create) the Tasks sub-notebook when the
    // feature is on, even if this project's current payload is empty — a
    // task that gets fully deleted from Super Productivity has no payload
    // entry at all (it's just absent from the source tasks), so an orphaned
    // Joplin note for it can only be found by checking the folder itself.
    // Actual creation stays deferred to the first real create, so projects
    // that never use this feature still get no folder.
    let tasksFolderId = syncTaskNotes ? await findFolder('Tasks', folderId) : null;
    // Declared outside the if so syncProjectIndex (below) can still read it on
    // a run where syncTaskNotes is on but this particular call has no Tasks
    // folder yet (an empty Map just means "no task links in the index").
    let byTaskId = new Map();

    if (syncTaskNotes) {
      const existingTaskNotes = tasksFolderId
        ? await listAll(
            '/folders/' + tasksFolderId + '/notes',
            'id,title,body,updated_time,user_created_time,is_todo,todo_due,todo_completed',
          )
        : [];

      const taskDedup = await dedupeByMarker(existingTaskNotes, TASK_MARKER_RE, tasksFolderId);
      byTaskId = taskDedup.byId;
      projectResult.archived += taskDedup.archived;
      projectResult.deleted += taskDedup.deleted;

      for (const item of taskNotes) {
        const existing = byTaskId.get(item.id) || null;
        const decision = decideTaskAction(item, existing, { oneWay: taskNotesOneWay });
        const spContent = stripTaskMarker(item.body);
        // The title (e.g. a "[Done]" prefix toggling when a task is
        // completed) is SP-driven and one-way, independent of the two-way
        // notes-content diff decideTaskAction just made -- if the content
        // decision doesn't already involve writing to Joplin (pull and
        // no-op don't), a stale title still needs fixing up on its own
        // rather than waiting for a future content change to carry it along.
        const titleStale = !!existing && existing.title !== item.title;
        // Same reasoning as the title: due date/done state are SP-driven,
        // one-way, and live in Joplin's own to-do fields rather than the
        // body, so they need fixing up independently of the notes-content
        // decision too (a due date can change with the notes text untouched).
        const desiredTodo = syncTaskDueDates
          ? { is_todo: 1, todo_due: item.todoDue || 0, todo_completed: item.todoCompleted || 0 }
          : null;
        // Done state goes two-way when only the Joplin checkbox moved away from
        // the last agreed value: keep Joplin's value (so the push below doesn't
        // revert it) and pull it once the task has settled. Without a baseline
        // (first sync, or older plugin versions) SP wins, as before.
        let donePull = null;
        let doneDeferred = false;
        if (twoWayDone && desiredTodo && existing && existing.is_todo) {
          const joplinDone = existing.todo_completed > 0;
          const spDone = desiredTodo.todo_completed > 0;
          if (joplinDone !== spDone && item.lastSyncedDone === spDone) {
            desiredTodo.todo_completed = existing.todo_completed;
            if (canPullTask(item)) donePull = joplinDone;
            else doneDeferred = true;
          }
        }
        const createdStale =
          !!existing && !!item.created && existing.user_created_time !== item.created;
        const todoStale =
          !!desiredTodo &&
          !!existing &&
          (existing.is_todo !== desiredTodo.is_todo ||
            existing.todo_due !== desiredTodo.todo_due ||
            existing.todo_completed !== desiredTodo.todo_completed);

        switch (decision.action) {
          case 'create': {
            if (!tasksFolderId) tasksFolderId = await findOrCreateFolder('Tasks', folderId);
            const created = await apiRequest('POST', '/notes', {
              title: item.title,
              body: item.body,
              parent_id: tasksFolderId,
              ...(desiredTodo || {}),
              ...noteDates(item),
            });
            projectResult.created += 1;
            projectResult.taskNotesSynced[item.id] = spContent;
            if (syncTaskTags) await syncNoteTags(created.id, item.tagTitles || []);
            // byTaskId only reflects the folder listing taken at the top of
            // this call, so a note created just now needs adding by hand —
            // syncProjectIndex (built after this loop) reads straight from it.
            byTaskId.set(item.id, Object.assign({ id: created.id, title: item.title, body: item.body }, desiredTodo || {}));
            break;
          }
          case 'update':
            await apiRequest('PUT', '/notes/' + existing.id, {
              title: item.title,
              body: item.body,
              ...(desiredTodo || {}),
              ...noteDates(item),
            });
            projectResult.updated += 1;
            projectResult.taskNotesSynced[item.id] = spContent;
            if (syncTaskTags) await syncNoteTags(existing.id, item.tagTitles || []);
            existing.title = item.title;
            existing.body = item.body;
            if (desiredTodo) Object.assign(existing, desiredTodo);
            break;
          case 'delete': {
            const archived = await removeOrArchive(existing.id, tasksFolderId);
            if (archived) projectResult.archived += 1;
            else projectResult.deleted += 1;
            projectResult.taskNotesSynced[item.id] = '';
            byTaskId.delete(item.id);
            break;
          }
          case 'pull': {
            const patch = {};
            if (titleStale) patch.title = item.title;
            if (todoStale) Object.assign(patch, desiredTodo);
            // Not noteDates: the Joplin edit being pulled is newer than SP's.
            if (createdStale) patch.user_created_time = item.created;
            if (Object.keys(patch).length) {
              await apiRequest('PUT', '/notes/' + existing.id, patch);
              projectResult.updated += 1;
              Object.assign(existing, patch);
            }
            if (syncTaskTags) await syncNoteTags(existing.id, item.tagTitles || []);
            projectResult.taskNotesPulled.push({ taskId: item.id, content: decision.content });
            break;
          }
          default: {
            const patch = {};
            if (titleStale) patch.title = item.title;
            if (todoStale) Object.assign(patch, desiredTodo);
            if (createdStale || Object.keys(patch).length) Object.assign(patch, noteDates(item));
            if (Object.keys(patch).length) {
              await apiRequest('PUT', '/notes/' + existing.id, patch);
              projectResult.updated += 1;
              Object.assign(existing, patch);
            } else {
              projectResult.unchanged += 1;
            }
            if (syncTaskTags && existing) await syncNoteTags(existing.id, item.tagTitles || []);
            if (decision.syncedContent !== undefined) {
              projectResult.taskNotesSynced[item.id] = decision.syncedContent;
            }
          }
        }

        // By now Joplin's checkbox matches desiredTodo (pushed, or already
        // equal), so that's the new baseline — unless it's waiting on a pull.
        if (donePull !== null) {
          projectResult.taskDonePulled.push({ taskId: item.id, isDone: donePull });
        } else if (desiredTodo && !doneDeferred && decision.action !== 'delete') {
          projectResult.taskDoneSynced[item.id] = desiredTodo.todo_completed > 0;
        }
      }

      // Same reasoning as the notes sweep above: only the last chunk for a
      // project carries taskValidIds and runs this.
      if (project.isLastChunk && Array.isArray(project.taskValidIds)) {
        const validTaskIds = new Set(project.taskValidIds);
        for (const [taskId, jn] of byTaskId.entries()) {
          if (!validTaskIds.has(taskId)) {
            const archived = await removeOrArchive(jn.id, tasksFolderId);
            if (archived) projectResult.archived += 1;
            else projectResult.deleted += 1;
          }
        }
      }
    }

    // Project-level "table of contents" note (opt-in, best-effort — a failure
    // here must not fail the note/task sync above). Only meaningful once the
    // project's very last call for this run has landed (see syncProjectIndex
    // above), since byTaskId only reflects the notes this call's earlier
    // findOrCreateFolder/listAll calls know about, and this project may have
    // made a separate earlier call for its notes/other task chunks.
    if (syncProjectIndex && project.isProjectFinalCall) {
      try {
        const taskLinks = Array.from(byTaskId.values())
          .sort((a, b) => String(a.title).localeCompare(String(b.title)))
          .map((jn) => '- [' + jn.title + '](:/' + jn.id + ')');
        const indexBody =
          (taskLinks.length > 0
            ? ['# Tasks', ''].concat(taskLinks).join('\\n')
            : '_No task notes yet._') + '\\n\\n' + PROJECT_INDEX_MARKER;
        const existingIndexNote = existingNotes.find((n) =>
          PROJECT_INDEX_MARKER_RE.test(n.body),
        );
        if (existingIndexNote) {
          if (existingIndexNote.body !== indexBody) {
            await apiRequest('PUT', '/notes/' + existingIndexNote.id, {
              title: PROJECT_INDEX_TITLE,
              body: indexBody,
            });
          }
        } else {
          await apiRequest('POST', '/notes', {
            title: PROJECT_INDEX_TITLE,
            body: indexBody,
            parent_id: folderId,
          });
        }
      } catch (e) {
        projectResult.indexError = e.message;
      }
    }
  } catch (e) {
    projectResult.error = e.message;
  }
  results.push(projectResult);
}

return { success: true, results };
`);

// The script text rides in the same Windows command-line argument as the
// payload (see MAX_PROJECT_PAYLOAD_CHARS), and about half of it is comments.
// Drops whole-line // comments, indentation and blank lines; safe because the
// script has no multi-line string literals.
function compactNodeScript(source) {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('//'))
    .join('\n');
}

let intervalHandle = null;
let debounceTimer = null;
let isSyncing = false;
let pendingRerun = false;
let lastSyncInfo = null;
// Set once per app session by checkForUpdate; null until it finds a newer release.
let availableUpdate = null;

// Heuristic detector for "Super Productivity just ran its own cross-device
// sync": an incoming remote change tends to touch many tasks in a tight
// burst, whereas a human editing one task fires ANY_TASK_UPDATE once. On a
// burst, treat pulling Joplin edits into tasks (the only action that calls
// updateTask, see PULL_SETTLE_MS in NODE_SYNC_SCRIPT) as unsafe for a
// cooldown, since that's the highest-risk moment for our write to land on
// top of Super Productivity's own sync for the same task. This is a
// heuristic, not a real signal — Super Productivity doesn't expose sync
// status to plugins — so it narrows the collision window without closing
// it. Pushing to Joplin is unaffected either way; it never touches Super
// Productivity's task store, so it can't itself race with anything.
const SYNC_BURST_WINDOW_MS = 2000;
const SYNC_BURST_TASK_COUNT = 5;
const PULL_COOLDOWN_MS = 60000;
let recentTaskUpdateTimestamps = [];
let pullsUnsafeUntil = 0;

function noteTaskUpdateForBurstDetection() {
  const now = Date.now();
  recentTaskUpdateTimestamps.push(now);
  recentTaskUpdateTimestamps = recentTaskUpdateTimestamps.filter(
    (t) => now - t < SYNC_BURST_WINDOW_MS,
  );
  if (recentTaskUpdateTimestamps.length >= SYNC_BURST_TASK_COUNT) {
    pullsUnsafeUntil = now + PULL_COOLDOWN_MS;
    recentTaskUpdateTimestamps = [];
  }
}

function deriveTitle(markdown) {
  const line = String(markdown || '')
    .split('\n')
    .find((l) => l.trim().length > 0);
  if (!line) return 'Untitled note';
  const cleaned = line
    .replace(/^#+\s*/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/[*_`>#]/g, '')
    .trim();
  return cleaned.slice(0, 80) || 'Untitled note';
}

function buildBody(note) {
  return `${String(note.content || '').trimEnd()}\n\n${MARKER_PREFIX}${note.id}${MARKER_SUFFIX}`;
}

// `decoration`, if given, is a pre-built markdown string (see
// buildTaskDecoration) wrapped in its own TASK_META markers between the
// task's notes and the sp-task-id marker.
function buildTaskBody(task, syncId, decoration) {
  const notes = String(task.notes || '').trimEnd();
  const decoBlock = decoration
    ? `\n\n${TASK_META_PREFIX}\n${decoration}\n${TASK_META_SUFFIX}`
    : '';
  return `${notes}${decoBlock}\n\n${TASK_MARKER_PREFIX}${syncId}${MARKER_SUFFIX}`;
}

// Combines the subtask checklist and time-stats decorations (each opt-in) into
// one markdown block, or '' if both are off/empty. tasksById resolves each
// subtask id to its own task record (subtasks are just tasks with a parentId).
function buildTaskDecoration(task, config, tasksById) {
  const blocks = [];

  if (config.syncTaskSubtasks) {
    const subtasks = (task.subTaskIds || [])
      .map((id) => tasksById[id])
      .filter((st) => !!st);
    if (subtasks.length > 0) {
      const lines = subtasks.map(
        (st) => `- [${st.isDone ? 'x' : ' '}] ${st.title || 'Untitled task'}`,
      );
      blocks.push(['**Subtasks**', ...lines].join('\n'));
    }
  }

  if (config.syncTaskTimeStats && (task.timeEstimate > 0 || task.timeSpent > 0)) {
    blocks.push(
      `⏱ ${formatDuration(task.timeSpent)} logged / ${formatDuration(task.timeEstimate)} estimated`,
    );
  }

  if (config.syncTaskAttachments) {
    const lines = (task.attachments || []).map(attachmentMarkdown).filter((l) => !!l);
    if (lines.length > 0) blocks.push(['**Attachments**', ...lines].join('\n'));
  }

  return blocks.join('\n\n');
}

// One markdown list line per Super Productivity task attachment, or '' for
// types with nothing to link to (COMMAND, NOTE). Links and images are linked
// (web images shown inline); local files become file:// links, which Joplin
// opens with the system's default app. Files aren't copied into Joplin.
function attachmentMarkdown(a) {
  const path = String((a && a.path) || '').trim();
  if (!path || !a || !['LINK', 'IMG', 'FILE'].includes(a.type)) return '';
  const title = String(a.title || path).replace(/[[\]]/g, '');
  let url = path;
  if (a.type === 'FILE' && !/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    url = 'file://' + (path.startsWith('/') ? '' : '/') + path.replace(/\\/g, '/');
  } else if (a.type !== 'FILE' && !/^[a-z][a-z0-9+.-]*:/i.test(path)) {
    url = 'https://' + path;
  }
  const isWebImage = a.type === 'IMG' && /^https?:/i.test(url);
  return `- ${isWebImage ? '!' : ''}[${title}](<${url}>)`;
}

// Renders a duration in ms as e.g. "2h 15m", "45m", or "0m" — good enough for
// a one-line summary, not meant to match Super Productivity's own formatter.
function formatDuration(ms) {
  const totalMinutes = Math.round((ms || 0) / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes}m`;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

// Due date, in ms since epoch, or 0 if the task has none. Super Productivity
// stores a due date+time as `dueWithTime` (ms) and a date-only due day as
// `dueDay` ('YYYY-MM-DD'); a date-only due day is normalized to local
// midnight of that day so Joplin's todo_due (a single timestamp) has
// something sane to show.
function computeTaskDueMs(task) {
  if (typeof task.dueWithTime === 'number' && task.dueWithTime > 0) {
    return task.dueWithTime;
  }
  if (typeof task.dueDay === 'string' && task.dueDay) {
    const ms = new Date(`${task.dueDay}T00:00:00`).getTime();
    return Number.isNaN(ms) ? 0 : ms;
  }
  return 0;
}

// Parses "#rgb", "#rrggbb", "rgb(r,g,b)" or "rgba(r,g,b,a)" into [r,g,b];
// returns null if it can't. Super Productivity stores project.theme.primary in
// any of these forms depending on how the colour was picked.
function parseColor(value) {
  const s = String(value || '').trim().toLowerCase();
  let m = s.match(/^#([0-9a-f]{3})$/);
  if (m) {
    return [0, 1, 2].map((i) => parseInt(m[1][i] + m[1][i], 16));
  }
  m = s.match(/^#([0-9a-f]{6})$/);
  if (m) {
    return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  }
  m = s.match(/^rgba?\(([^)]+)\)/);
  if (m) {
    const parts = m[1].split(',').map((p) => parseFloat(p.trim()));
    if (parts.length >= 3 && parts.slice(0, 3).every((n) => isFinite(n))) {
      return parts.slice(0, 3).map((n) => Math.max(0, Math.min(255, Math.round(n))));
    }
  }
  return null;
}

// A subset of Super Productivity's Material Symbols icon names mapped to one
// emoji, used as the glyph on the generated folder icon. Names not listed here
// fall back to the first character of the project title. Lives in the outer
// (browser-side) plugin code, not NODE_SYNC_SCRIPT, so its bulk doesn't count
// against that script's Windows command-line budget.
const PROJECT_ICON_EMOJI = {
  inbox: '📥', person: '👤', people: '👥', group: '👥', groups: '👥',
  chat: '💬', forum: '💬', mail: '✉️', email: '✉️',
  home: '🏠', family_home: '🏡', cottage: '🏡',
  work: '💼', business_center: '💼', cases: '💼',
  code: '💻', code_blocks: '💻', terminal: '💻', bug_report: '🐛',
  rocket_launch: '🚀', favorite: '❤️', star: '⭐',
  school: '🎓', menu_book: '📖', book: '📖',
  shopping_cart: '🛒', attach_money: '💰', savings: '💰', payments: '💰',
  fitness_center: '🏋️', directions_run: '🏃', self_improvement: '🧘',
  restaurant: '🍽️', local_cafe: '☕',
  flight: '✈️', directions_car: '🚗', pets: '🐾',
  potted_plant: '🪴', yard: '🌱', eco: '🌱', agriculture: '🚜', bucket_check: '🪣',
  movie: '🎬', music_note: '🎵', sports_esports: '🎮', photo_camera: '📷',
  palette: '🎨', build: '🔧', handyman: '🛠️', science: '🔬',
  medical_services: '🩺', event: '📅', calendar_month: '📅',
  checklist: '✅', task_alt: '✅', flag: '🚩', lightbulb: '💡', folder: '📁',
};

function projectIconGlyph(iconName, title) {
  const key = String(iconName || '').trim().toLowerCase();
  if (PROJECT_ICON_EMOJI[key]) return { text: PROJECT_ICON_EMOJI[key], emoji: true };
  const letter = String(title || '').trim().charAt(0).toUpperCase();
  return { text: letter || '•', emoji: false };
}

// Builds the serialized Joplin folder-icon value (a JSON string, the same form
// Joplin's own UI writes) for a project: an SVG tile filled with the project's
// theme colour carrying its icon glyph. Joplin notebooks have no colour field,
// so this is the only channel for the colour. The SVG is embedded as a
// percent-encoded (not base64) data URL — btoa can't take the multi-byte
// emoji glyphs, and this avoids needing Buffer too. Returns '' when there's
// nothing worth drawing (colour unparseable and no title for a letter).
function buildProjectFolderIcon(iconName, color, title) {
  const rgb = parseColor(color);
  const glyph = projectIconGlyph(iconName, title);
  if (!rgb && glyph.text === '•') return '';
  const bg = rgb || [136, 136, 136];
  const luma = (0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2]) / 255;
  const fg = luma > 0.6 ? '#1b1b1b' : '#ffffff';
  const hex = '#' + bg.map((n) => ('0' + n.toString(16)).slice(-2)).join('');
  const size = glyph.emoji ? 38 : 40;
  const escaped = glyph.text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">' +
    '<rect width="64" height="64" rx="13" fill="' + hex + '"/>' +
    '<text x="32" y="34" text-anchor="middle" dominant-baseline="central" ' +
    'font-family="Arial, Helvetica, sans-serif" font-size="' + size + '" ' +
    'font-weight="600" fill="' + fg + '">' + escaped + '</text></svg>';
  const dataUrl = 'data:image/svg+xml,' + encodeURIComponent(svg);
  return JSON.stringify({ type: 2, emoji: '', name: '', dataUrl: dataUrl });
}

// Conservative budget for one project chunk's JSON-stringified notes (or
// taskNotes) array, in characters. Super Productivity's executeNodeScript
// spawns Node with the whole script AND the JSON-stringified args embedded
// in one Windows command-line argument (~32K chars, and quoting can inflate
// that further for JSON-heavy text). NODE_SYNC_SCRIPT's own source is the
// biggest fixed cost, so derive the per-array budget from its actual length
// rather than hardcoding a number: that way growing the script (which is what
// caused a "spawn ENAMETOOLONG" when the project-icon code was first added to
// it inline) automatically tightens the payload budget instead of silently
// blowing the limit. ~12K with the current (compacted) script, floored at 3K.
const MAX_PROJECT_PAYLOAD_CHARS = Math.max(3000, 27000 - NODE_SYNC_SCRIPT.length);

// Greedily packs items into chunks whose combined JSON size stays under
// maxChars, preserving order. A single item larger than maxChars still gets
// its own chunk rather than being dropped or looping forever. Always returns
// at least one (possibly empty) chunk, so callers don't need a special case
// for an empty input array.
function chunkBySize(items, maxChars) {
  const chunks = [];
  let current = [];
  let currentSize = 2; // "[]"
  for (const item of items) {
    const itemSize = JSON.stringify(item).length + 1; // + comma/spacing
    if (current.length > 0 && currentSize + itemSize > maxChars) {
      chunks.push(current);
      current = [];
      currentSize = 2;
    }
    current.push(item);
    currentSize += itemSize;
  }
  chunks.push(current);
  return chunks;
}

// The "last synced content" baseline per task sync id (see normalizeTaskId),
// used to tell which side of a task note actually changed since the last
// sync (see decideTaskAction in NODE_SYNC_SCRIPT). Persisted via
// PluginAPI.persistDataSynced so it stays consistent across devices instead
// of just this one. Keyed by the normalized sync id (not the raw task id) so
// a recurring calendar task's daily-changing id doesn't reset the baseline
// on every occurrence.
async function loadTaskSyncState() {
  try {
    const raw = await PluginAPI.loadSyncedData(TASK_SYNC_STATE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed.tasks !== 'object' || !parsed.tasks) {
      return { tasks: {}, done: {} };
    }
    // `done` (the per-task done-state baseline) was added after `tasks`, so
    // older saved state, or one saved by an older version on another device,
    // lacks it — which just means "no baseline yet".
    return {
      tasks: parsed.tasks,
      done: typeof parsed.done === 'object' && parsed.done ? parsed.done : {},
    };
  } catch (e) {
    return { tasks: {}, done: {} };
  }
}

async function saveTaskSyncState(state) {
  await PluginAPI.persistDataSynced(JSON.stringify(state), TASK_SYNC_STATE_KEY);
}

async function loadEffectiveConfig() {
  const cfg = (await PluginAPI.getConfig()) || {};
  return {
    joplinUrl: (cfg.joplinUrl || DEFAULTS.joplinUrl).trim(),
    parentNotebookTitle: (cfg.parentNotebookTitle || DEFAULTS.parentNotebookTitle).trim(),
    syncIntervalSec: Number.isFinite(cfg.syncIntervalSec)
      ? cfg.syncIntervalSec
      : DEFAULTS.syncIntervalSec,
    syncTaskNotes: cfg.syncTaskNotes === true,
    taskNotesOneWay: cfg.taskNotesOneWay === true,
    syncTaskTags: cfg.syncTaskTags === true,
    archiveRemovedNotes: cfg.archiveRemovedNotes === true,
    syncProjectIcons: cfg.syncProjectIcons === true,
    syncTaskDueDates: cfg.syncTaskDueDates === true,
    syncTaskSubtasks: cfg.syncTaskSubtasks === true,
    syncTaskTimeStats: cfg.syncTaskTimeStats === true,
    syncTaskAttachments: cfg.syncTaskAttachments === true,
    syncProjectIndex: cfg.syncProjectIndex === true,
  };
}

function setupInterval(seconds) {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  if (seconds > 0) {
    const effectiveSeconds = Math.max(seconds, MIN_INTERVAL_SEC);
    intervalHandle = setInterval(() => runSync('interval'), effectiveSeconds * 1000);
  }
}

async function reloadIntervalFromConfig() {
  const config = await loadEffectiveConfig();
  setupInterval(config.syncIntervalSec);
}

function scheduleSync(delayMs) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    runSync('auto');
  }, delayMs);
}

async function performSync(trigger) {
  const config = await loadEffectiveConfig();
  const token = await PluginAPI.getSecret(TOKEN_SECRET_KEY);

  if (!token) {
    lastSyncInfo = {
      at: Date.now(),
      trigger,
      success: false,
      error: 'No Joplin API token set.',
    };
    if (trigger === 'manual') {
      PluginAPI.showSnack({
        msg: 'Joplin Notes Sync: set your API token first (open the plugin page).',
        type: 'WARNING',
      });
    }
    return lastSyncInfo;
  }

  if (!PluginAPI.executeNodeScript) {
    lastSyncInfo = {
      at: Date.now(),
      trigger,
      success: false,
      error: 'Node execution is not available on this platform (desktop only).',
    };
    if (trigger === 'manual') {
      PluginAPI.showSnack({
        msg: 'Joplin sync only works in the desktop app.',
        type: 'ERROR',
      });
    }
    return lastSyncInfo;
  }

  const allProjects = await PluginAPI.getAllProjects();
  const candidateProjects = allProjects.filter((p) => !p.isArchived);

  const appState = await PluginAPI.getAppState();
  const notesById = appState.notes || {};
  const tasksById = appState.tasks || {};
  const tagsById = appState.tags || {};
  const allTasks = Object.values(tasksById);
  const syncTaskTags = config.syncTaskNotes && config.syncTaskTags;

  const taskSyncState = config.syncTaskNotes
    ? await loadTaskSyncState()
    : { tasks: {}, done: {} };

  // Recurring calendar-imported tasks mint a new task id per occurrence
  // (see normalizeTaskId), so several ids can share the same sync id at
  // once (an old occurrence lingering alongside today's). Pick the most
  // recently updated one as the representative so a Joplin pull writes back
  // onto the task the user is actually looking at, and the sync-state
  // baseline stays keyed on a single stable id.
  const latestTaskBySyncId = new Map();
  if (config.syncTaskNotes) {
    for (const t of allTasks) {
      const syncId = normalizeTaskId(t.id);
      const spUpdated = t.updated || t.created || 0;
      const current = latestTaskBySyncId.get(syncId);
      if (!current || spUpdated >= (current.updated || current.created || 0)) {
        latestTaskBySyncId.set(syncId, t);
      }
    }
  }

  const payloadProjects = candidateProjects
    .map((p) => {
      const notes = (Array.isArray(p.noteIds) ? p.noteIds : [])
        .map((id) => notesById[id])
        .filter(
          (n) => !!n && typeof n.content === 'string' && n.content.trim().length > 0,
        )
        .map((n) => ({
          id: n.id,
          title: deriveTitle(n.content),
          body: buildBody(n),
          created: n.created,
          spUpdated: n.modified,
        }));

      const taskNotes = config.syncTaskNotes
        ? Array.from(latestTaskBySyncId.values())
            .filter((t) => t.projectId === p.id)
            .map((t) => {
              const syncId = normalizeTaskId(t.id);
              const content = typeof t.notes === 'string' ? t.notes.trim() : '';
              const lastSynced = Object.prototype.hasOwnProperty.call(
                taskSyncState.tasks,
                syncId,
              )
                ? taskSyncState.tasks[syncId]
                : null;
              // Never-synced task with no current content: nothing on either
              // side could reference it yet (bar someone hand-typing a
              // marker in Joplin, which we don't try to support), so skip it
              // to keep the payload proportional to tasks that matter.
              if (content === '' && lastSynced === null) return null;
              // `content` itself isn't sent — it's fully recoverable from
              // `body` (stripTaskMarker(body) === content) by the Node
              // script, and every duplicated byte here counts against the
              // Windows command-line length that executeNodeScript's spawn
              // call is limited by (see MAX_PROJECT_PAYLOAD_CHARS below).
              // With syncTaskDueDates on, the Joplin note becomes a real to-do
              // (checkbox + due date), which already shows completion, so the
              // "[Done] " title prefix is redundant there and dropped.
              const title = config.syncTaskDueDates
                ? t.title || 'Untitled task'
                : (t.isDone ? '[Done] ' : '') + (t.title || 'Untitled task');
              return {
                id: syncId,
                title,
                body: buildTaskBody(t, syncId, buildTaskDecoration(t, config, tasksById)),
                created: t.created,
                spUpdated: t.updated || t.created || 0,
                lastSynced,
                lastSyncedDone: config.syncTaskDueDates
                  ? taskSyncState.done[syncId] === undefined
                    ? null
                    : taskSyncState.done[syncId]
                  : undefined,
                tagTitles: syncTaskTags
                  ? (t.tagIds || [])
                      .map((tagId) => tagsById[tagId] && tagsById[tagId].title)
                      .filter((title) => !!title)
                  : undefined,
                // Joplin's todo_due/todo_completed are only meaningful once
                // is_todo is set, so both travel together under one flag (see
                // NODE_SYNC_SCRIPT). todo_completed prefers the task's own
                // "marked done at" timestamp (doneOn), falling back to
                // updated/created for older tasks that predate that field.
                todoDue: config.syncTaskDueDates ? computeTaskDueMs(t) : undefined,
                todoCompleted: config.syncTaskDueDates
                  ? (t.isDone ? t.doneOn || t.updated || t.created || Date.now() : 0)
                  : undefined,
              };
            })
            .filter((item) => item !== null)
        : [];

      // The folder-icon JSON is built here (outer code) and passed to the node
      // script ready to use — see buildProjectFolderIcon. '' means "don't touch
      // the folder icon".
      const icon = config.syncProjectIcons
        ? buildProjectFolderIcon(p.icon, p.theme && p.theme.primary, p.title)
        : '';

      return { id: p.id, title: p.title, icon, notes, taskNotes };
    })
    .filter((p) => p.notes.length > 0 || p.taskNotes.length > 0);

  if (payloadProjects.length === 0) {
    lastSyncInfo = { at: Date.now(), trigger, success: true, results: [] };
    return lastSyncInfo;
  }

  if (trigger === 'manual') {
    PluginAPI.showSnack({ msg: 'Syncing notes to Joplin…', type: 'INFO' });
  }

  // See noteTaskUpdateForBurstDetection above: computed once per sync run so
  // every project's node script call agrees on whether a pull is safe.
  const pullsAllowed = Date.now() >= pullsUnsafeUntil;

  // At least one executeNodeScript call per project, not one call for
  // everything. Super Productivity's host runs this via
  // `spawn(node, ['-e', wrappedScript])` with the whole script AND the
  // JSON-stringified args embedded in that single command-line argument (see
  // electron/plugin-node-executor.ts upstream) — on Windows that has a much
  // lower effective length limit than Linux/macOS, and there's no size cap on
  // args there (only the script text is capped at 100KB), so a large enough
  // payload fails with "spawn ENAMETOOLONG". Keeping every call small takes
  // three things: one project per call, notes and task notes in separate
  // calls (so the two can't add up), and chunking each of those arrays so no
  // single call's payload exceeds MAX_PROJECT_PAYLOAD_CHARS. Only the call
  // that carries the full valid-id list runs the orphan-deletion sweep (see
  // NODE_SYNC_SCRIPT) — the rest only create/update.
  const results = [];
  let hardFailure = null;
  outer: for (const project of payloadProjects) {
    // Build the list of executeNodeScript calls for this project. Notes and
    // task notes go in SEPARATE calls, never combined — that's what bounds a
    // single call's args at NODE_SYNC_SCRIPT + one chunk (MAX_PROJECT_PAYLOAD_
    // CHARS) + fixed overhead, safely under the Windows command-line limit,
    // regardless of how big the other array is. The note-orphan sweep rides
    // the last notes call (it carries noteValidIds); the task-orphan sweep
    // rides the last task call (taskValidIds), or — when this run has no task
    // payload at all — piggybacks the last notes call so it still runs without
    // an extra spawn. The project icon rides the project's very last call.
    const projectCalls = [];

    const noteChunks = chunkBySize(project.notes, MAX_PROJECT_PAYLOAD_CHARS);
    noteChunks.forEach((chunk, i) => {
      const last = i === noteChunks.length - 1;
      projectCalls.push({
        id: project.id,
        title: project.title,
        notes: chunk,
        taskNotes: [],
        isLastChunk: last,
        noteValidIds: last ? project.notes.map((n) => n.id) : undefined,
      });
    });

    const taskChunks = chunkBySize(project.taskNotes, MAX_PROJECT_PAYLOAD_CHARS);
    const hasTaskPayload = taskChunks.some((c) => c.length > 0);
    if (hasTaskPayload) {
      const nonEmpty = taskChunks.filter((c) => c.length > 0);
      nonEmpty.forEach((chunk, i) => {
        const last = i === nonEmpty.length - 1;
        projectCalls.push({
          id: project.id,
          title: project.title,
          notes: [],
          taskNotes: chunk,
          isLastChunk: last,
          taskValidIds: last ? project.taskNotes.map((t) => t.id) : undefined,
        });
      });
    } else if (config.syncTaskNotes) {
      // No task-note payload this run, but task sync is on — attach an empty
      // taskValidIds to the last notes call so the orphan sweep for tasks
      // deleted entirely on the SP side still happens.
      projectCalls[projectCalls.length - 1].taskValidIds = project.taskNotes.map(
        (t) => t.id,
      );
    }

    if (project.icon) {
      projectCalls[projectCalls.length - 1].icon = project.icon;
    }

    // Marks the one call, of possibly several, that's truly last for this
    // project this run — notes and task notes can land in separate calls (see
    // above), so only this one is guaranteed to see every note already synced
    // this run when building the project index (see syncProjectIndex).
    projectCalls[projectCalls.length - 1].isProjectFinalCall = true;

    for (const projectChunk of projectCalls) {
      let outcome;
      try {
        outcome = await PluginAPI.executeNodeScript({
          script: NODE_SYNC_SCRIPT,
          args: [
            {
              baseUrl: config.joplinUrl,
              token,
              parentNotebookTitle: config.parentNotebookTitle,
              projects: [projectChunk],
              syncTaskNotes: config.syncTaskNotes,
              taskNotesOneWay: config.taskNotesOneWay,
              syncTaskTags,
              pullsAllowed,
              archiveRemovedNotes: config.archiveRemovedNotes,
              syncProjectIcons: config.syncProjectIcons,
              syncTaskDueDates: config.syncTaskDueDates,
              syncProjectIndex: config.syncProjectIndex,
            },
          ],
          timeout: 25000,
        });
      } catch (e) {
        hardFailure = e.message || String(e);
        break outer;
      }

      if (!outcome || !outcome.success) {
        const errCode =
          outcome && outcome.error && typeof outcome.error === 'object'
            ? outcome.error.code
            : null;
        hardFailure =
          errCode === 'NO_CONSENT' || errCode === 'PERMISSION_DENIED'
            ? 'Node execution permission was not granted. Enable it for this plugin in Settings → Plugins.'
            : (outcome && outcome.error && outcome.error.message) ||
              (outcome && outcome.error) ||
              'Unknown error';
        break outer;
      }

      const scriptResult = outcome.result || {};
      if (!scriptResult.success) {
        hardFailure = scriptResult.error || 'Unknown error';
        break outer;
      }

      results.push(...(scriptResult.results || []));
    }
  }

  if (hardFailure) {
    lastSyncInfo = { at: Date.now(), trigger, success: false, error: hardFailure };
    if (trigger === 'manual') {
      PluginAPI.showSnack({ msg: 'Joplin sync failed: ' + hardFailure, type: 'ERROR' });
    }
    return lastSyncInfo;
  }

  // Apply any Joplin -> Super Productivity pulls (a task's notes field
  // changed on the Joplin side and won the sync), then persist the merged
  // last-synced-content baseline. executeNodeScript's child process has no
  // PluginAPI access, so this — and the state save — only happens here.
  let pulled = 0;
  const pullErrors = [];
  if (config.syncTaskNotes) {
    const newState = {
      tasks: { ...taskSyncState.tasks },
      done: { ...taskSyncState.done },
    };
    for (const r of results) {
      Object.assign(newState.tasks, r.taskNotesSynced || {});
      Object.assign(newState.done, r.taskDoneSynced || {});
    }
    for (const r of results) {
      for (const pull of r.taskNotesPulled || []) {
        const targetTask = latestTaskBySyncId.get(pull.taskId);
        if (!targetTask) continue;
        try {
          await PluginAPI.updateTask(targetTask.id, { notes: pull.content });
          newState.tasks[pull.taskId] = pull.content;
          pulled += 1;
        } catch (e) {
          pullErrors.push(
            r.projectTitle + ': failed to pull a task note (' + (e.message || e) + ')',
          );
        }
      }
      for (const pull of r.taskDonePulled || []) {
        const targetTask = latestTaskBySyncId.get(pull.taskId);
        if (!targetTask) continue;
        try {
          await PluginAPI.updateTask(targetTask.id, { isDone: pull.isDone });
          newState.done[pull.taskId] = pull.isDone;
          pulled += 1;
        } catch (e) {
          pullErrors.push(
            r.projectTitle + ': failed to pull a task\'s done state (' + (e.message || e) + ')',
          );
        }
      }
    }
    // Drop entries for sync ids that no longer map to any known task, so the
    // synced blob doesn't grow without bound.
    for (const map of [newState.tasks, newState.done]) {
      for (const syncId of Object.keys(map)) {
        if (!latestTaskBySyncId.has(syncId)) delete map[syncId];
      }
    }
    await saveTaskSyncState(newState);
  }

  const totals = results.reduce(
    (acc, r) => {
      acc.created += r.created || 0;
      acc.updated += r.updated || 0;
      acc.deleted += r.deleted || 0;
      acc.archived += r.archived || 0;
      if (r.error) acc.errors.push(r.projectTitle + ': ' + r.error);
      if (r.iconError) acc.errors.push(r.projectTitle + ' (icon): ' + r.iconError);
      return acc;
    },
    { created: 0, updated: 0, deleted: 0, archived: 0, pulled: 0, errors: [] },
  );
  totals.pulled = pulled;
  totals.errors.push(...pullErrors);

  lastSyncInfo = {
    at: Date.now(),
    trigger,
    success: totals.errors.length === 0,
    results,
    totals,
  };

  if (trigger === 'manual') {
    if (totals.errors.length > 0) {
      PluginAPI.showSnack({
        msg: 'Joplin sync finished with errors: ' + totals.errors.join('; '),
        type: 'ERROR',
      });
    } else if (
      totals.created + totals.updated + totals.deleted + totals.archived + totals.pulled ===
      0
    ) {
      PluginAPI.showSnack({ msg: 'Joplin sync: already up to date.', type: 'SUCCESS' });
    } else {
      PluginAPI.showSnack({
        msg:
          'Joplin sync: ' +
          totals.created +
          ' created, ' +
          totals.updated +
          ' updated, ' +
          totals.deleted +
          ' deleted' +
          (totals.archived > 0 ? ', ' + totals.archived + ' archived' : '') +
          (totals.pulled > 0 ? ', ' + totals.pulled + ' pulled from Joplin' : '') +
          '.',
        type: 'SUCCESS',
      });
    }
  }

  return lastSyncInfo;
}

// Separate from NODE_SYNC_SCRIPT on purpose: it runs once per session and must
// not add to that script's command-line size budget. Goes through Node because
// PluginAPI.request needs an extra "http" permission and allowedHosts entry,
// while nodeExecution is already granted for the sync itself.
// The require() also matters: the host runs require-free scripts in a bare VM
// sandbox with no network access, and only spawns a real Node process otherwise.
const NODE_LATEST_RELEASE_SCRIPT = `
const https = require('https');
const body = await new Promise((resolve, reject) => {
  const req = https.get(
    args[0],
    { headers: { 'User-Agent': 'joplin-notes-sync', Accept: 'application/vnd.github+json' } },
    (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () =>
        res.statusCode === 200 ? resolve(data) : reject(new Error('GitHub returned ' + res.statusCode)),
      );
    },
  );
  req.on('error', reject);
  req.setTimeout(8000, () => req.destroy(new Error('timed out')));
});
const release = JSON.parse(body);
return { tag: release.tag_name, url: release.html_url };
`;

function isNewerVersion(latest, current) {
  const a = String(latest).replace(/^v/, '').split('.').map(Number);
  const b = String(current).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

// Best effort: offline, rate-limited, or no node consent all just mean no
// update notice this session.
async function checkForUpdate() {
  if (!PluginAPI.executeNodeScript) return;
  try {
    const outcome = await PluginAPI.executeNodeScript({
      script: NODE_LATEST_RELEASE_SCRIPT,
      args: [RELEASES_API_URL],
      timeout: 10000,
    });
    const release = outcome && outcome.success ? outcome.result : null;
    if (!release || !release.tag || !isNewerVersion(release.tag, PLUGIN_VERSION)) return;
    availableUpdate = { version: release.tag.replace(/^v/, ''), url: release.url };
    PluginAPI.showSnack({
      msg: `Joplin Notes Sync ${availableUpdate.version} is available (you have ${PLUGIN_VERSION}).`,
      type: 'INFO',
    });
  } catch (e) {
    console.warn('Joplin Notes Sync: update check failed', e);
  }
}

async function runSync(trigger) {
  if (isSyncing) {
    pendingRerun = true;
    return lastSyncInfo;
  }
  isSyncing = true;
  try {
    return await performSync(trigger);
  } finally {
    isSyncing = false;
    if (pendingRerun) {
      pendingRerun = false;
      scheduleSync(1000);
    }
  }
}

PluginAPI.registerHook(PluginAPI.Hooks.PERSISTED_DATA_CHANGED, () => {
  reloadIntervalFromConfig();
  scheduleSync(AUTO_SYNC_DEBOUNCE_MS);
});

// Push promptly when a task's notes field changes, instead of waiting for
// the next interval tick. Ignores unrelated task edits (e.g. time tracking).
PluginAPI.registerHook(PluginAPI.Hooks.ANY_TASK_UPDATE, (payload) => {
  noteTaskUpdateForBurstDetection();
  if (payload && payload.changes && Object.prototype.hasOwnProperty.call(payload.changes, 'notes')) {
    scheduleSync(AUTO_SYNC_DEBOUNCE_MS);
  }
});

if (PluginAPI.onMessage) {
  PluginAPI.onMessage(async (message) => {
    switch (message && message.type) {
      case 'getState': {
        const config = await loadEffectiveConfig();
        const hasToken = !!(await PluginAPI.getSecret(TOKEN_SECRET_KEY));
        return {
          success: true,
          config,
          hasToken,
          lastSyncInfo,
          version: PLUGIN_VERSION,
          availableUpdate,
        };
      }
      case 'saveToken': {
        const value = String((message && message.token) || '').trim();
        if (value) {
          await PluginAPI.setSecret(TOKEN_SECRET_KEY, value);
        } else {
          await PluginAPI.deleteSecret(TOKEN_SECRET_KEY);
        }
        return { success: true };
      }
      case 'clearToken': {
        await PluginAPI.deleteSecret(TOKEN_SECRET_KEY);
        return { success: true };
      }
      case 'syncNow': {
        const info = await runSync('manual');
        return { success: true, info };
      }
      default:
        return { success: false, error: 'Unknown message type' };
    }
  });
}

PluginAPI.onReady?.(async () => {
  await reloadIntervalFromConfig();
  checkForUpdate();
});

PluginAPI.onUnload?.(() => {
  if (intervalHandle) clearInterval(intervalHandle);
  if (debounceTimer) clearTimeout(debounceTimer);
});
