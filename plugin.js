// Joplin Notes Sync — pushes each project's notes into a matching Joplin
// notebook via Joplin's local Web Clipper REST API.
//
// Project notes are one-way only (Super Productivity -> Joplin): the plugin
// API has no way to write PluginNote content back into Super Productivity.
//
// Task notes (opt-in, see syncTaskNotes) ARE two-way: PluginAPI.updateTask
// can write a task's `notes` field, so edits on either side get reconciled.
// Since neither side is authoritative, a per-task "last synced content"
// baseline (persisted via PluginAPI.persistDataSynced, see TASK_SYNC_STATE_KEY)
// is used to tell which side actually changed since the last sync. If both
// changed, the more recently modified one wins (last-write-wins by
// timestamp) and the loser is silently overwritten — there is no merge UI.
//
// Calling updateTask on a schedule can race with Super Productivity's own
// cross-device sync (on a multi-device setup, the two can collide on the
// same task); an earlier version of this plugin reverted to one-way sync
// over that risk. It's back on the assumption that this races rarely enough
// in practice to accept — if task duplication reappears on a multi-device
// setup, that's the first thing to suspect.
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

// Decides what to do with one task's note given its current content on both
// sides and the content both sides agreed on last sync (item.lastSynced,
// null if never synced). Only the side that actually moved away from that
// baseline is treated as "changed"; if both moved, the more recently
// modified one wins.
function decideTaskAction(item, existingNote) {
  const spContent = item.content;
  if (!existingNote) {
    return spContent === '' ? { action: 'none' } : { action: 'create' };
  }

  const joplinContent = stripTaskMarker(existingNote.body);
  if (joplinContent === spContent) {
    return { action: 'none', syncedContent: spContent };
  }

  const lastSynced = item.lastSynced;
  const spChanged = lastSynced === null || spContent !== lastSynced;
  const joplinChanged = lastSynced === null || joplinContent !== lastSynced;

  if (spChanged && !joplinChanged) {
    return spContent === '' ? { action: 'delete' } : { action: 'update' };
  }
  if (joplinChanged && !spChanged) {
    return { action: 'pull', content: joplinContent };
  }
  // Conflict (both changed, or no baseline to compare against): last write wins.
  const joplinUpdated = existingNote.updated_time || 0;
  if (joplinUpdated > item.spUpdated) {
    return { action: 'pull', content: joplinContent };
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
    unchanged: 0,
    error: null,
    taskNotesSynced: {},
    taskNotesPulled: [],
  };
  try {
    const folderId = await findOrCreateFolder(project.title, rootFolderId);
    const existingNotes = await listAll('/folders/' + folderId + '/notes', 'id,title,body');

    const byNoteId = new Map();
    for (const jn of existingNotes) {
      const match = jn.body && jn.body.match(MARKER_RE);
      if (match) byNoteId.set(match[1], jn);
    }

    const seen = new Set();
    for (const note of project.notes) {
      seen.add(note.id);
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

    for (const [spNoteId, jn] of byNoteId.entries()) {
      if (!seen.has(spNoteId)) {
        await apiRequest('DELETE', '/notes/' + jn.id);
        projectResult.deleted += 1;
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

      const byTaskId = new Map();
      for (const jn of existingTaskNotes) {
        const match = jn.body && jn.body.match(TASK_MARKER_RE);
        if (match) byTaskId.set(match[1], jn);
      }

      const seenTasks = new Set();
      for (const item of taskNotes) {
        seenTasks.add(item.id);
        const existing = byTaskId.get(item.id) || null;
        const decision = decideTaskAction(item, existing);

        switch (decision.action) {
          case 'create':
            if (!tasksFolderId) tasksFolderId = await findOrCreateFolder('Tasks', folderId);
            await apiRequest('POST', '/notes', {
              title: item.title,
              body: item.body,
              parent_id: tasksFolderId,
            });
            projectResult.created += 1;
            projectResult.taskNotesSynced[item.id] = item.content;
            break;
          case 'update':
            await apiRequest('PUT', '/notes/' + existing.id, {
              title: item.title,
              body: item.body,
            });
            projectResult.updated += 1;
            projectResult.taskNotesSynced[item.id] = item.content;
            break;
          case 'delete':
            await apiRequest('DELETE', '/notes/' + existing.id);
            projectResult.deleted += 1;
            projectResult.taskNotesSynced[item.id] = '';
            break;
          case 'pull':
            projectResult.taskNotesPulled.push({ taskId: item.id, content: decision.content });
            break;
          default:
            projectResult.unchanged += 1;
            if (decision.syncedContent !== undefined) {
              projectResult.taskNotesSynced[item.id] = decision.syncedContent;
            }
        }
      }

      for (const [taskId, jn] of byTaskId.entries()) {
        if (!seenTasks.has(taskId)) {
          await apiRequest('DELETE', '/notes/' + jn.id);
          projectResult.deleted += 1;
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
  const allTasks = Object.values(tasksById);

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
              return {
                id: syncId,
                title: t.title || 'Untitled task',
                content,
                body: buildTaskBody(t, syncId),
                spUpdated: t.updated || t.created || 0,
                lastSynced,
              };
            })
            .filter((item) => item !== null)
        : [];

      return { id: p.id, title: p.title, notes, taskNotes };
    })
    .filter((p) => p.notes.length > 0 || p.taskNotes.length > 0);

  if (payloadProjects.length === 0) {
    lastSyncInfo = { at: Date.now(), trigger, success: true, results: [] };
    return lastSyncInfo;
  }

  if (trigger === 'manual') {
    PluginAPI.showSnack({ msg: 'Syncing notes to Joplin…', type: 'INFO' });
  }

  // One executeNodeScript call per project, not one call for everything.
  // Super Productivity's host runs this via `spawn(node, ['-e', wrappedScript])`
  // with the whole script AND the JSON-stringified args embedded in that single
  // command-line argument (see electron/plugin-node-executor.ts upstream) — on
  // Windows that has a much lower effective length limit than Linux/macOS, and
  // there's no size cap on args there (only the script text is capped at
  // 100KB), so a large combined notes payload fails with "spawn ENAMETOOLONG".
  // Keeping each call to a single project's data keeps every command line
  // small regardless of how much is synced overall.
  const results = [];
  let hardFailure = null;
  for (const project of payloadProjects) {
    let outcome;
    try {
      outcome = await PluginAPI.executeNodeScript({
        script: NODE_SYNC_SCRIPT,
        args: [
          {
            baseUrl: config.joplinUrl,
            token,
            parentNotebookTitle: config.parentNotebookTitle,
            projects: [project],
            syncTaskNotes: config.syncTaskNotes,
          },
        ],
        timeout: 25000,
      });
    } catch (e) {
      hardFailure = e.message || String(e);
      break;
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
      break;
    }

    const scriptResult = outcome.result || {};
    if (!scriptResult.success) {
      hardFailure = scriptResult.error || 'Unknown error';
      break;
    }

    results.push(...(scriptResult.results || []));
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
      if (r.error) acc.errors.push(r.projectTitle + ': ' + r.error);
      return acc;
    },
    { created: 0, updated: 0, deleted: 0, pulled: 0, errors: [] },
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
    } else if (totals.created + totals.updated + totals.deleted + totals.pulled === 0) {
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
