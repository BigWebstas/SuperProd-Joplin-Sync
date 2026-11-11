'use strict';
// Test harness: loads the real plugin.js against a fake Super Productivity
// PluginAPI and an in-memory mock of Joplin's Web Clipper REST API. Node scripts
// the plugin sends through executeNodeScript run for real, in-process, against
// the mock server, the way the desktop host runs them.
const fs = require('fs');
const http = require('http');
const path = require('path');

// PLUGIN_PATH lets a mutated copy be tested to check the tests can fail.
const PLUGIN_PATH = process.env.PLUGIN_PATH || path.join(__dirname, '..', 'plugin.js');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function localDate(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function startMockJoplin() {
  const state = { folders: [], notes: [], faults: [], requests: [], nextId: 1 };
  const newId = () => 'j' + state.nextId++;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const body = raw ? JSON.parse(raw) : {};
      const send = (obj, code = 200) => {
        res.statusCode = code;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(obj));
      };
      const key = req.method + ' ' + url.pathname;
      state.requests.push(key);
      const fault = state.faults.find((f) => f.match.test(key) && f.times > 0);
      if (fault) {
        fault.times -= 1;
        return send({ error: 'injected fault' }, fault.status);
      }
      let m;
      if (key === 'GET /folders') return send({ items: state.folders, has_more: false });
      if (key === 'POST /folders') {
        const f = { id: newId(), parent_id: '', ...body };
        state.folders.push(f);
        return send(f);
      }
      if ((m = url.pathname.match(/^\/folders\/(\w+)$/))) {
        const f = state.folders.find((x) => x.id === m[1]);
        if (req.method === 'PUT') Object.assign(f, body);
        return send(f || {});
      }
      if ((m = url.pathname.match(/^\/folders\/(\w+)\/notes$/)) && req.method === 'GET') {
        return send({ items: state.notes.filter((n) => n.parent_id === m[1]), has_more: false });
      }
      if (key === 'POST /notes') {
        const n = { id: newId(), ...body };
        state.notes.push(n);
        return send(n);
      }
      if ((m = url.pathname.match(/^\/notes\/(\w+)$/))) {
        const n = state.notes.find((x) => x.id === m[1]);
        if (req.method === 'PUT') Object.assign(n, body);
        if (req.method === 'DELETE') state.notes.splice(state.notes.indexOf(n), 1);
        return send(n || {});
      }
      return send({ items: [], has_more: false });
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port })),
  );
}

// opts: config, tasks (array), archived (array), projects (array), spNotes (array),
//       repeatCfgs (object), fastInterval (run auto-sync every second)
async function createEnv(opts = {}) {
  const joplin = await startMockJoplin();
  const now = Date.now();
  const sp = {
    // Tasks last touched an hour ago, so Joplin->SP pulls are past the settle window.
    tasks: Object.fromEntries(
      (opts.tasks || []).map((t) => [
        t.id,
        { tagIds: [], subTaskIds: [], projectId: 'p1', created: now - 7200e3, updated: now - 3600e3, ...t },
      ]),
    ),
    archived: opts.archived || [],
    projects: opts.projects || [{ id: 'p1', title: 'Proj', noteIds: [] }],
    spNotes: Object.fromEntries((opts.spNotes || []).map((n) => [n.id, n])),
    repeatCfgs: opts.repeatCfgs || {},
    synced: {},
    secrets: { joplinApiToken: 'tok' },
    updates: [],
    dialogs: [],
    snacks: [],
    archiveFails: false,
  };
  const handlers = {};
  const config = {
    joplinUrl: `http://127.0.0.1:${joplin.port}`,
    syncIntervalSec: opts.fastInterval ? 1 : 0,
    ...(opts.config || {}),
  };
  global.PluginAPI = {
    Hooks: { PERSISTED_DATA_CHANGED: 'persistedDataChanged', ANY_TASK_UPDATE: 'anyTaskUpdate' },
    registerHook() {},
    onMessage: (fn) => (handlers.message = fn),
    onReady: (fn) => (handlers.ready = fn),
    onUnload: (fn) => (handlers.unload = fn),
    getConfig: async () => config,
    getSecret: async (k) => sp.secrets[k] || null,
    setSecret: async (k, v) => (sp.secrets[k] = v),
    deleteSecret: async (k) => delete sp.secrets[k],
    getAllProjects: async () => sp.projects.map((p) => ({ isArchived: false, theme: { primary: '#336699' }, ...p })),
    getAppState: async () => ({
      tasks: sp.tasks,
      notes: sp.spNotes,
      tags: {},
      projects: Object.fromEntries(sp.projects.map((p) => [p.id, p])),
      taskRepeatCfgs: sp.repeatCfgs,
    }),
    getArchivedTasks: async () => {
      if (sp.archiveFails) throw new Error('archive unavailable');
      return sp.archived;
    },
    getDayContext: async () => ({ todayStr: localDate(Date.now()), startOfNextDayDiffMs: 0 }),
    persistDataSynced: async (s, k) => (sp.synced[k] = s),
    loadSyncedData: async (k) => sp.synced[k] || null,
    updateTask: async (id, u) => {
      sp.updates.push({ id, ...u });
      Object.assign(sp.tasks[id], u);
    },
    showSnack: (s) => sp.snacks.push(s.msg),
    openDialog: async (cfg) => {
      sp.dialogs.push(cfg);
      return 'Close';
    },
    executeNodeScript: async ({ script, args }) => {
      try {
        const result = await new AsyncFunction('args', 'require', script)(args, require);
        return { success: true, result };
      } catch (e) {
        return { success: false, error: { message: e.message } };
      }
    },
  };
  let source = fs.readFileSync(PLUGIN_PATH, 'utf8');
  if (opts.fastInterval) source = source.replace('const MIN_INTERVAL_SEC = 15;', 'const MIN_INTERVAL_SEC = 1;');
  await new AsyncFunction(source)();
  if (handlers.ready) await handlers.ready();

  const send = (message) => handlers.message(message);
  const waitIdle = async () => {
    for (let i = 0; i < 4000; i++) {
      const st = await send({ type: 'getState' });
      if (!st.syncProgress.active) return st;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('sync did not finish');
  };
  return {
    sp,
    joplin: joplin.state,
    send,
    waitIdle,
    // Runs a manual sync and returns the stored result.
    async sync() {
      await send({ type: 'syncNow' });
      return (await waitIdle()).lastSyncInfo;
    },
    notesIn: (title) => {
      const folder = joplin.state.folders.find((f) => f.title === title);
      return folder ? joplin.state.notes.filter((n) => n.parent_id === folder.id) : [];
    },
    async close() {
      if (handlers.unload) handlers.unload();
      await new Promise((r) => joplin.server.close(r));
    },
  };
}

module.exports = { createEnv, localDate };
