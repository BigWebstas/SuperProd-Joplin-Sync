'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createEnv, localDate } = require('./harness');

const TASK = { id: 't1', title: 'Task one', notes: 'hello' };
const taskConfig = { syncTaskNotes: true };

async function withEnv(opts, fn) {
  const env = await createEnv(opts);
  try {
    await fn(env);
  } finally {
    await env.close();
  }
}

test('syncs a project note and a task note, then a second sync changes nothing', () =>
  withEnv(
    {
      config: taskConfig,
      tasks: [TASK],
      projects: [{ id: 'p1', title: 'Proj', noteIds: ['n1'] }],
      spNotes: [{ id: 'n1', content: '# Plan\nbody', created: 1, modified: 1 }],
    },
    async (env) => {
      const first = await env.sync();
      assert.equal(first.success, true);
      assert.deepEqual(env.notesIn('Proj').map((n) => n.title), ['Plan']);
      assert.deepEqual(env.notesIn('Tasks').map((n) => n.title), ['Task one']);

      const second = await env.sync();
      assert.equal(second.success, true);
      const t = second.totals;
      assert.equal(t.created + t.updated + t.deleted + t.archived + t.pulled, 0);
    },
  ));

test('two-way: a Joplin edit is pulled back into the task', () =>
  withEnv({ config: taskConfig, tasks: [TASK] }, async (env) => {
    await env.sync();
    const note = env.notesIn('Tasks')[0];
    note.body = note.body.replace('hello', 'hello edited');
    const info = await env.sync();
    assert.equal(info.totals.pulled, 1);
    assert.equal(env.sp.tasks.t1.notes, 'hello edited');
  }));

test('one-way: a Joplin edit is overwritten, never pulled', () =>
  withEnv({ config: { ...taskConfig, taskNotesOneWay: true }, tasks: [TASK] }, async (env) => {
    await env.sync();
    const note = env.notesIn('Tasks')[0];
    note.body = note.body.replace('hello', 'tampered');
    await env.sync();
    assert.equal(env.sp.updates.length, 0);
    assert.match(env.notesIn('Tasks')[0].body, /hello/);
  }));

test('saved sync state stays small: fingerprints, not note text', () =>
  withEnv(
    {
      config: taskConfig,
      tasks: Array.from({ length: 120 }, (_, i) => ({ id: 'b' + i, title: 'Big ' + i, notes: 'x'.repeat(2000) + i })),
    },
    async (env) => {
      await env.sync();
      const state = env.sp.synced.taskNotesSyncState;
      assert.ok(state.length < 20000, `state is ${state.length} bytes`);
      assert.match(JSON.parse(state).tasks.b0, /^h:/);
    },
  ));

test('state saved by older versions (full note text) still works as the two-way baseline', () =>
  withEnv({ config: taskConfig, tasks: [TASK] }, async (env) => {
    await env.sync();
    // Old format: the baseline is the full text. A Joplin-side edit must still be
    // recognised as "only Joplin changed" and pulled, not treated as a conflict.
    env.sp.synced.taskNotesSyncState = JSON.stringify({ tasks: { t1: 'hello' }, done: {} });
    const note = env.notesIn('Tasks')[0];
    note.body = note.body.replace('hello', 'hello edited');
    const info = await env.sync();
    assert.equal(info.totals.pulled, 1);
    assert.equal(env.sp.tasks.t1.notes, 'hello edited');
    assert.match(JSON.parse(env.sp.synced.taskNotesSyncState).tasks.t1, /^h:/);
  }));

test('task note carries subtasks, time, issue and repeat lines when enabled', () =>
  withEnv(
    {
      config: {
        ...taskConfig,
        syncTaskSubtasks: true,
        syncTaskTimeStats: true,
        syncTaskIssueLinks: true,
        syncTaskRepeatInfo: true,
      },
      tasks: [
        { ...TASK, subTaskIds: ['s1'], timeSpent: 3600000, timeEstimate: 7200000, issueId: '42', issueType: 'GITHUB', repeatCfgId: 'r1' },
        { id: 's1', title: 'Sub', projectId: null, parentId: 't1', notes: '' },
      ],
      repeatCfgs: { r1: { repeatCycle: 'WEEKLY', repeatEvery: 2, monday: true, wednesday: true } },
    },
    async (env) => {
      await env.sync();
      const body = env.notesIn('Tasks')[0].body;
      assert.match(body, /- \[ \] Sub/);
      assert.match(body, /1h logged \/ 2h estimated/);
      assert.match(body, /Issue: GITHUB 42/);
      assert.match(body, /Repeats every 2 weeks \(Mon, Wed\)/);
    },
  ));

test('archived tasks keep their Joplin note when the option is on, and lose it when off', async () => {
  const archivedTask = { id: 'a1', title: 'Old task', notes: 'archived text', projectId: 'p1', created: 1, updated: 1, tagIds: [], subTaskIds: [] };
  for (const [keep, expected] of [[true, 1], [false, 0]]) {
    await withEnv({ config: { ...taskConfig, syncArchivedTasks: keep }, tasks: [TASK, { id: 'a1', title: 'Old task', notes: 'archived text' }] }, async (env) => {
      await env.sync();
      assert.equal(env.notesIn('Tasks').length, 2);
      delete env.sp.tasks.a1; // the task gets archived
      env.sp.archived = [archivedTask];
      await env.sync();
      assert.equal(env.notesIn('Tasks').filter((n) => n.title === 'Old task').length, expected);
    });
  }
});

test('an unreadable archive stops the sync instead of cleaning up notes', () =>
  withEnv({ config: { ...taskConfig, syncArchivedTasks: true }, tasks: [TASK] }, async (env) => {
    await env.sync();
    env.sp.archiveFails = true;
    delete env.sp.tasks.t1;
    const info = await env.sync();
    assert.equal(info.success, false);
    assert.match(info.error, /archive/i);
    assert.equal(env.notesIn('Tasks').length, 1);
  }));

test('daily summary: written with charts, idempotent, icon only with project icons on', async () => {
  const now = Date.now();
  const tasks = [
    { id: 'd1', title: 'Finished', projectId: 'p1', isDone: true, doneOn: now, timeSpentOnDay: { [localDate(now)]: 5400000 } },
    { id: 'd2', title: 'Other', projectId: 'p2', timeSpentOnDay: { [localDate(now)]: 1800000 } },
  ];
  const projects = [{ id: 'p1', title: 'Work', noteIds: [] }, { id: 'p2', title: 'Home', noteIds: [] }];
  await withEnv({ config: { syncDailySummary: true, syncProjectIcons: true }, tasks, projects }, async (env) => {
    await env.sync();
    const notes = env.notesIn('Daily summaries');
    assert.equal(notes.length, 1);
    assert.equal(notes[0].title, localDate(now));
    assert.match(notes[0].body, /```mermaid\npie showData title Time by project/);
    assert.match(notes[0].body, /- \[x\] Finished \(Work\)/);
    assert.ok(env.joplin.folders.find((f) => f.title === 'Daily summaries').icon);
    const writes = env.joplin.requests.filter((r) => /^(POST|PUT) \/notes/.test(r)).length;
    await env.sync();
    assert.equal(env.joplin.requests.filter((r) => /^(POST|PUT) \/notes/.test(r)).length, writes);
  });
  await withEnv({ config: { syncDailySummary: true, dailySummaryCharts: false }, tasks, projects }, async (env) => {
    await env.sync();
    assert.doesNotMatch(env.notesIn('Daily summaries')[0].body, /mermaid/);
    assert.equal(env.joplin.folders.find((f) => f.title === 'Daily summaries').icon, undefined);
  });
});

test('a failed manual sync shows a dialog with a hint and stores the error', () =>
  withEnv({ config: { joplinUrl: 'http://127.0.0.1:1' }, tasks: [TASK] }, async (env) => {
    env.sp.projects = [{ id: 'p1', title: 'Proj', noteIds: ['n1'] }];
    env.sp.spNotes = { n1: { id: 'n1', content: 'x', created: 1, modified: 1 } };
    const info = await env.sync();
    assert.equal(info.success, false);
    assert.match(info.error, /Could not reach Joplin/);
    assert.equal(env.sp.dialogs.length, 1);
    assert.match(env.sp.dialogs[0].htmlContent, /Web Clipper/);
    await env.sync();
    assert.equal(env.sp.dialogs.length, 2, 'manual failures always show the dialog');
  }));

test('repeated automatic failures show the dialog once, and again after a success', () =>
  withEnv({ tasks: [TASK], fastInterval: true, projects: [{ id: 'p1', title: 'Proj', noteIds: ['n1'] }], spNotes: [{ id: 'n1', content: 'x', created: 1, modified: 1 }] }, async (env) => {
    delete env.sp.secrets.joplinApiToken; // fails instantly on every tick
    await new Promise((r) => setTimeout(r, 3500));
    assert.equal(env.sp.dialogs.length, 1);
    env.sp.secrets.joplinApiToken = 'tok';
    await new Promise((r) => setTimeout(r, 1800)); // a tick succeeds
    delete env.sp.secrets.joplinApiToken;
    await new Promise((r) => setTimeout(r, 1800));
    assert.equal(env.sp.dialogs.length, 2);
  }));

test('progress is reported while syncing and cleared afterwards', () =>
  withEnv(
    {
      projects: [1, 2, 3].map((i) => ({ id: 'p' + i, title: 'Proj' + i, noteIds: ['n1'] })),
      spNotes: [{ id: 'n1', content: 'note', created: 1, modified: 1 }],
    },
    async (env) => {
      await env.send({ type: 'syncNow' });
      const seen = [];
      for (let i = 0; i < 4000; i++) {
        const st = await env.send({ type: 'getState' });
        if (!st.syncProgress.active) break;
        seen.push(st.syncProgress.percent);
        await new Promise((r) => setTimeout(r, 2));
      }
      assert.ok(seen.length > 0, 'saw progress');
      assert.ok(seen.every((p) => p >= 0 && p <= 99));
      const final = await env.waitIdle();
      assert.equal(final.lastSyncInfo.success, true);
    },
  ));

test('transient Joplin errors are retried', () =>
  withEnv(
    { projects: [{ id: 'p1', title: 'Proj', noteIds: ['n1'] }], spNotes: [{ id: 'n1', content: 'note', created: 1, modified: 1 }] },
    async (env) => {
      env.joplin.faults.push({ match: /^GET \/folders$/, status: 503, times: 2 });
      const info = await env.sync();
      assert.equal(info.success, true);
      assert.equal(env.notesIn('Proj').length, 1);
    },
  ));

test('a persistent Joplin error still fails, with the cause shown', () =>
  withEnv(
    { projects: [{ id: 'p1', title: 'Proj', noteIds: ['n1'] }], spNotes: [{ id: 'n1', content: 'note', created: 1, modified: 1 }] },
    async (env) => {
      env.joplin.faults.push({ match: /^GET \/folders$/, status: 503, times: 99 });
      const info = await env.sync();
      assert.equal(info.success, false);
      assert.match(JSON.stringify(info), /503/);
    },
  ));

test('a missing token is reported, not thrown', () =>
  withEnv({ tasks: [TASK] }, async (env) => {
    delete env.sp.secrets.joplinApiToken;
    const info = await env.sync();
    assert.equal(info.success, false);
    assert.match(info.error, /token/i);
  }));
