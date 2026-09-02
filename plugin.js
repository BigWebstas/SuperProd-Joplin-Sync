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
const NODE_SYNC_SCRIPT = `
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

// Parses "#rgb", "#rrggbb", "rgb(r,g,b)" or "rgba(r,g,b,a)" into [r,g,b];
// returns null if it can't. Super Productivity stores project.theme.primary
// in any of these forms depending on how the colour was picked.
function parseColor(value) {
  const s = String(value || '').trim().toLowerCase();
  let m = s.match(/^#([0-9a-f]{3})$/);
  if (m) {
    return [
      parseInt(m[1][0] + m[1][0], 16),
      parseInt(m[1][1] + m[1][1], 16),
      parseInt(m[1][2] + m[1][2], 16),
    ];
  }
  m = s.match(/^#([0-9a-f]{6})$/);
  if (m) {
    return [
      parseInt(m[1].slice(0, 2), 16),
      parseInt(m[1].slice(2, 4), 16),
      parseInt(m[1].slice(4, 6), 16),
    ];
  }
  m = s.match(/^rgba?\\(([^)]+)\\)/);
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
// fall back to the first character of the project title.
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
// so this is the only channel for the colour. Returns '' when there's nothing
// worth drawing (colour unparseable and no title to take a letter from).
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
  const dataUrl =
    'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
  return JSON.stringify({ type: 2, emoji: '', name: '', dataUrl: dataUrl });
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

function stripTaskMarker(body) {
  return String(body || '').replace(TASK_MARKER_RE, '').trim();
}

// A task that was touched very recently is more likely to still be mid-
// flight through Super Productivity's own cross-device sync pipeline, which
// plugins can't observe directly (see the file header). Withholding a pull
// (the only action that calls updateTask) until a task has been quiet for
// this long narrows, but can't close, the window where that write could
// land on top of an incoming remote sync for the same task.
const PULL_SETTLE_MS = 2 * 60 * 1000;

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

  const canPull =
    ctx.pullsAllowed && Date.now() - item.spUpdated >= PULL_SETTLE_MS;

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
    taskNotesSynced: {},
    taskNotesPulled: [],
  };
  try {
    const folderId = await findOrCreateFolder(project.title, rootFolderId);
    const existingNotes = await listAll(
      '/folders/' + folderId + '/notes',
      'id,title,body,updated_time',
    );

    const noteDedup = await dedupeByMarker(existingNotes, MARKER_RE, folderId);
    const byNoteId = noteDedup.byId;
    projectResult.archived += noteDedup.archived;
    projectResult.deleted += noteDedup.deleted;

    for (const note of project.notes) {
      const existing = byNoteId.get(note.id);
      if (existing) {
        if (existing.body !== note.body || existing.title !== note.title) {
          await apiRequest('PUT', '/notes/' + existing.id, {
            title: note.title,
            body: note.body,
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
        });
        projectResult.created += 1;
      }
    }

    // A large project can be split across several calls to stay under the
    // command-line size a single executeNodeScript spawn can carry (see
    // MAX_PROJECT_PAYLOAD_CHARS in the outer plugin code) — each call only
    // sees its own slice of project.notes, so only the LAST call for a
    // project carries the full, authoritative set of current note ids
    // (noteValidIds) and actually runs the orphan-deletion sweep. Earlier
    // calls skip it entirely rather than risk deleting notes that simply
    // belong to a different chunk.
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

    // Project icon + colour (opt-in). One-way, best-effort, last chunk only:
    // read the folder's current icon and PUT only when it differs, so a sync
    // that changed nothing here writes nothing. Wrapped in its own try/catch —
    // the icon is cosmetic, so a failure here must not skip the task-note sync
    // below or fail the project. It's recorded on projectResult.iconError.
    if (project.isLastChunk && syncProjectIcons) {
      try {
        const desiredIcon = buildProjectFolderIcon(
          project.icon,
          project.color,
          project.title,
        );
        if (desiredIcon) {
          const current = await apiRequest(
            'GET',
            '/folders/' + folderId + '?fields=id,icon',
          );
          if (!current || current.icon !== desiredIcon) {
            await apiRequest('PUT', '/folders/' + folderId, { icon: desiredIcon });
          }
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

    if (syncTaskNotes) {
      const existingTaskNotes = tasksFolderId
        ? await listAll('/folders/' + tasksFolderId + '/notes', 'id,title,body,updated_time')
        : [];

      const taskDedup = await dedupeByMarker(existingTaskNotes, TASK_MARKER_RE, tasksFolderId);
      const byTaskId = taskDedup.byId;
      projectResult.archived += taskDedup.archived;
      projectResult.deleted += taskDedup.deleted;

      for (const item of taskNotes) {
        const existing = byTaskId.get(item.id) || null;
        const decision = decideTaskAction(item, existing, { pullsAllowed, oneWay: taskNotesOneWay });
        const spContent = stripTaskMarker(item.body);
        // The title (e.g. a "[Done]" prefix toggling when a task is
        // completed) is SP-driven and one-way, independent of the two-way
        // notes-content diff decideTaskAction just made -- if the content
        // decision doesn't already involve writing to Joplin (pull and
        // no-op don't), a stale title still needs fixing up on its own
        // rather than waiting for a future content change to carry it along.
        const titleStale = !!existing && existing.title !== item.title;

        switch (decision.action) {
          case 'create': {
            if (!tasksFolderId) tasksFolderId = await findOrCreateFolder('Tasks', folderId);
            const created = await apiRequest('POST', '/notes', {
              title: item.title,
              body: item.body,
              parent_id: tasksFolderId,
            });
            projectResult.created += 1;
            projectResult.taskNotesSynced[item.id] = spContent;
            if (syncTaskTags) await syncNoteTags(created.id, item.tagTitles || []);
            break;
          }
          case 'update':
            await apiRequest('PUT', '/notes/' + existing.id, {
              title: item.title,
              body: item.body,
            });
            projectResult.updated += 1;
            projectResult.taskNotesSynced[item.id] = spContent;
            if (syncTaskTags) await syncNoteTags(existing.id, item.tagTitles || []);
            break;
          case 'delete': {
            const archived = await removeOrArchive(existing.id, tasksFolderId);
            if (archived) projectResult.archived += 1;
            else projectResult.deleted += 1;
            projectResult.taskNotesSynced[item.id] = '';
            break;
          }
          case 'pull':
            if (titleStale) {
              await apiRequest('PUT', '/notes/' + existing.id, { title: item.title });
              projectResult.updated += 1;
            }
            if (syncTaskTags) await syncNoteTags(existing.id, item.tagTitles || []);
            projectResult.taskNotesPulled.push({ taskId: item.id, content: decision.content });
            break;
          default:
            if (titleStale) {
              await apiRequest('PUT', '/notes/' + existing.id, { title: item.title });
              projectResult.updated += 1;
            } else {
              projectResult.unchanged += 1;
            }
            if (syncTaskTags && existing) await syncNoteTags(existing.id, item.tagTitles || []);
            if (decision.syncedContent !== undefined) {
              projectResult.taskNotesSynced[item.id] = decision.syncedContent;
            }
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
  } catch (e) {
    projectResult.error = e.message;
  }
  results.push(projectResult);
}

return { success: true, results };
`;

let intervalHandle = null;
let debounceTimer = null;
let isSyncing = false;
let pendingRerun = false;
let lastSyncInfo = null;

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

function buildTaskBody(task, syncId) {
  return `${String(task.notes || '').trimEnd()}\n\n${TASK_MARKER_PREFIX}${syncId}${MARKER_SUFFIX}`;
}

// Conservative budget for one project chunk's JSON-stringified notes (or
// taskNotes) array, in characters. Super Productivity's executeNodeScript
// spawns Node with the whole script AND the JSON-stringified args embedded
// in one Windows command-line argument (~32K chars, and quoting can inflate
// that further for JSON-heavy text); NODE_SYNC_SCRIPT's own source already
// accounts for a good chunk of that budget on its own. This leaves generous
// headroom rather than trying to compute the limit exactly.
const MAX_PROJECT_PAYLOAD_CHARS = 8000;

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
    return parsed && typeof parsed.tasks === 'object' && parsed.tasks
      ? parsed
      : { tasks: {} };
  } catch (e) {
    return { tasks: {} };
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
    : { tasks: {} };

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
        .map((n) => ({ id: n.id, title: deriveTitle(n.content), body: buildBody(n) }));

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
              return {
                id: syncId,
                title: (t.isDone ? '[Done] ' : '') + (t.title || 'Untitled task'),
                body: buildTaskBody(t, syncId),
                spUpdated: t.updated || t.created || 0,
                lastSynced,
                tagTitles: syncTaskTags
                  ? (t.tagIds || [])
                      .map((tagId) => tagsById[tagId] && tagsById[tagId].title)
                      .filter((title) => !!title)
                  : undefined,
              };
            })
            .filter((item) => item !== null)
        : [];

      return {
        id: p.id,
        title: p.title,
        icon:
          config.syncProjectIcons && typeof p.icon === 'string' ? p.icon : undefined,
        color:
          config.syncProjectIcons && p.theme && typeof p.theme.primary === 'string'
            ? p.theme.primary
            : undefined,
        notes,
        taskNotes,
      };
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
  // combined notes payload fails with "spawn ENAMETOOLONG". Keeping each call
  // small regardless of how much is synced overall takes two things: one
  // call per project (below), and, within a project, chunking its notes and
  // taskNotes arrays so no single call's payload exceeds
  // MAX_PROJECT_PAYLOAD_CHARS regardless of how much content or how many
  // tasks that project has. Only the last chunk for a project carries the
  // full valid-id lists and runs the orphan-deletion sweep (see
  // NODE_SYNC_SCRIPT) — earlier chunks only create/update.
  const results = [];
  let hardFailure = null;
  outer: for (const project of payloadProjects) {
    const noteChunks = chunkBySize(project.notes, MAX_PROJECT_PAYLOAD_CHARS);
    const taskChunks = chunkBySize(project.taskNotes, MAX_PROJECT_PAYLOAD_CHARS);
    const chunkCount = Math.max(noteChunks.length, taskChunks.length);

    for (let i = 0; i < chunkCount; i++) {
      const isLastChunk = i === chunkCount - 1;
      const projectChunk = {
        id: project.id,
        title: project.title,
        icon: isLastChunk ? project.icon : undefined,
        color: isLastChunk ? project.color : undefined,
        notes: noteChunks[i] || [],
        taskNotes: taskChunks[i] || [],
        isLastChunk,
        noteValidIds: isLastChunk ? project.notes.map((n) => n.id) : undefined,
        taskValidIds: isLastChunk ? project.taskNotes.map((t) => t.id) : undefined,
      };

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
    const newState = { tasks: { ...taskSyncState.tasks } };
    for (const r of results) {
      Object.assign(newState.tasks, r.taskNotesSynced || {});
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
    }
    // Drop entries for sync ids that no longer map to any known task, so the
    // synced blob doesn't grow without bound.
    for (const syncId of Object.keys(newState.tasks)) {
      if (!latestTaskBySyncId.has(syncId)) delete newState.tasks[syncId];
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

PluginAPI.registerHeaderButton({
  label: 'Joplin Sync',
  // Header buttons render via <mat-icon>{{icon}}</mat-icon> — only a Material
  // Symbols ligature name from Super Productivity's built-in icon font, no
  // custom SVG. 'refresh' (single rotating arrow) is the closest built-in
  // match to icon.svg's ring; there's no way to also show the "J" here.
  icon: 'refresh',
  onClick: () => {
    runSync('manual');
  },
});

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
        return { success: true, config, hasToken, lastSyncInfo };
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
});

PluginAPI.onUnload?.(() => {
  if (intervalHandle) clearInterval(intervalHandle);
  if (debounceTimer) clearTimeout(debounceTimer);
});
