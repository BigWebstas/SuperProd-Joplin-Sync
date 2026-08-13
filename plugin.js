// Joplin Notes Sync — pushes each project's notes, and optionally each
// task's own notes, into a matching Joplin notebook via Joplin's local Web
// Clipper REST API.
//
// One-way only (Super Productivity -> Joplin). The plugin API has no way to
// write PluginNote content back into Super Productivity, so project notes
// could never be two-way. Task notes technically could (PluginAPI.updateTask
// can write a task's `notes` field) — an earlier version of this plugin did
// exactly that — but calling updateTask on a schedule turned out to collide
// with Super Productivity's own cross-device sync: on a multi-device setup,
// the two would race on the same task and Super Productivity resolved the
// collision by duplicating the task rather than merging it. Since this
// plugin can only ever run on a device with a local Joplin instance anyway
// (Joplin's REST API only listens on 127.0.0.1), staying push-only avoids
// that interaction entirely.
//
// Reaching Joplin requires Node's http/https modules, which the browser-side
// PluginAPI.request() cannot use against localhost. This plugin instead runs
// the Joplin API calls through executeNodeScript (desktop/Electron only,
// gated by the user's one-time nodeExecution consent prompt).

const TOKEN_SECRET_KEY = 'joplinApiToken';
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

const MARKER_RE = /<!--\\s*sp-note-id:([a-zA-Z0-9_-]+)\\s*-->/;
const TASK_MARKER_RE = /<!--\\s*sp-task-id:([a-zA-Z0-9_-]+)\\s*-->/;

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
        ? await listAll('/folders/' + tasksFolderId + '/notes', 'id,title,body')
        : [];

      const byTaskId = new Map();
      for (const jn of existingTaskNotes) {
        const match = jn.body && jn.body.match(TASK_MARKER_RE);
        if (match) byTaskId.set(match[1], jn);
      }

      const seenTasks = new Set();
      for (const note of taskNotes) {
        seenTasks.add(note.id);
        const existing = byTaskId.get(note.id);
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
          if (!tasksFolderId) tasksFolderId = await findOrCreateFolder('Tasks', folderId);
          await apiRequest('POST', '/notes', {
            title: note.title,
            body: note.body,
            parent_id: tasksFolderId,
          });
          projectResult.created += 1;
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

  const payloadProjects = candidateProjects
    .map((p) => {
      const notes = (Array.isArray(p.noteIds) ? p.noteIds : [])
        .map((id) => notesById[id])
        .filter(
          (n) => !!n && typeof n.content === 'string' && n.content.trim().length > 0,
        )
        .map((n) => ({ id: n.id, title: deriveTitle(n.content), body: buildBody(n) }));

      const taskNotes = config.syncTaskNotes
        ? allTasks
            .filter(
              (t) =>
                t.projectId === p.id &&
                typeof t.notes === 'string' &&
                t.notes.trim().length > 0,
            )
            .map((t) => {
              const syncId = normalizeTaskId(t.id);
              return {
                id: syncId,
                title: t.title || 'Untitled task',
                body: buildTaskBody(t, syncId),
              };
            })
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
  const totals = results.reduce(
    (acc, r) => {
      acc.created += r.created || 0;
      acc.updated += r.updated || 0;
      acc.deleted += r.deleted || 0;
      if (r.error) acc.errors.push(r.projectTitle + ': ' + r.error);
      return acc;
    },
    { created: 0, updated: 0, deleted: 0, errors: [] },
  );

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
    } else if (totals.created + totals.updated + totals.deleted === 0) {
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
          ' deleted.',
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
  icon: 'sync',
  onClick: () => {
    runSync('manual');
  },
});

PluginAPI.registerHook(PluginAPI.Hooks.PERSISTED_DATA_CHANGED, () => {
  reloadIntervalFromConfig();
  scheduleSync(AUTO_SYNC_DEBOUNCE_MS);
});

// Push promptly when a task's notes field changes, instead of waiting for
// the next interval tick. Only ever schedules a push (never writes back to
// the task), so this can't collide with Super Productivity's own sync.
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
