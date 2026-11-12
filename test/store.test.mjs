import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.T3_TASKS_HOME = mkdtempSync(join(tmpdir(), 't3-tasks-'))
const store = await import('../src/store.mjs')

test('agents move status but only the human settles', () => {
  const task = store.createTask({ title: 'Ship it' })
  const staged = store.updateTask(task.id, { status: 'staging', status_note: 'on staging, in testing' }, 'agent')
  assert.equal(staged.status, 'staging')
  assert.equal(staged.events[0].text, 'Moved to Staging: on staging, in testing')
  assert.equal(store.updateTask(task.id, { status: 'done', status_note: 'merged' }, 'agent').status, 'done')
  assert.throws(() => store.updateTask(task.id, { status: 'settled' }, 'agent'), /only the user/)
  assert.equal(store.updateTask(task.id, { status: 'settled' }, 'human').status, 'settled')
  assert.throws(() => store.updateTask(task.id, { status: 'in_progress' }, 'agent'), /settled/)
  assert.throws(() => store.linkSession('s9', task.id), /settled/)
})

test('a session has one task; a task has many sessions', () => {
  const a = store.createTask({ title: 'A' }), b = store.createTask({ title: 'B' })
  store.linkSession('s1', a.id, { title: 'first' })
  store.linkSession('s2', a.id)
  assert.equal(store.getTask(a.id).sessions.length, 2)
  store.linkSession('s1', b.id)
  assert.equal(store.taskForSession('s1').id, b.id)
  assert.equal(store.getTask(a.id).sessions.length, 1)
  assert.equal(store.getTask(b.id).sessions[0].title, 'first')
})

test('third-party tasks are idempotent on (source, external_id)', () => {
  const first = store.createTask({ title: 'From ClickUp', source: 'clickup', external_id: 'abc' })
  const again = store.createTask({ title: 'Renamed', source: 'clickup', external_id: 'abc' })
  assert.equal(again.id, first.id)
  assert.equal(again.title, 'Renamed')
})

test('acceptance criteria gate done for agents, not for the human', () => {
  const task = store.createTask({ title: 'Ticket', acceptance_criteria: ['Tests pass', 'Docs updated'] }, 'agent')
  const [a, b] = task.criteria
  assert.throws(() => store.updateTask(task.id, { status: 'done' }, 'agent'), /2 acceptance criteria are open/)
  store.updateCriterion(a.id, { done: true }, 'agent')
  assert.throws(() => store.updateCriterion(b.id, { text: 'easier' }, 'agent'), /only the user/)
  assert.throws(() => store.updateTask(task.id, { status: 'done' }, 'agent'), /1 acceptance criteria/)
  store.updateCriterion(b.id, { done: true }, 'agent')
  const done = store.updateTask(task.id, { status: 'done', status_note: 'shipped' }, 'agent')
  assert.equal(done.status, 'done')
  assert.match(done.events[0].text, /Moved to Done: shipped/)
  const other = store.createTask({ title: 'Human override', acceptance_criteria: ['x'] })
  assert.equal(store.updateTask(other.id, { status: 'done' }, 'human').status, 'done')
})

test('new tasks go to the top; position reorders', () => {
  const a = store.createTask({ title: 'older' }), b = store.createTask({ title: 'newer' })
  const order = () => store.listTasks().map((t) => t.id)
  assert.ok(order().indexOf(b.id) < order().indexOf(a.id))
  store.updateTask(a.id, { position: b.position - 1 }, 'human')
  assert.ok(order().indexOf(a.id) < order().indexOf(b.id))
})

test('no two open tasks look alike: new tasks take a distinct color, a close pick is refused', () => {
  const tasks = Array.from({ length: 20 }, (_, i) => store.createTask({ title: `Colored ${i}` }))
  const open = store.listTasks({ includeSettled: false })
  for (const a of open) for (const b of open) {
    if (a.id < b.id) assert.ok(store.colorDistance(a.color, b.color) >= store.MIN_COLOR_DISTANCE, `#${a.id} ${a.color} vs #${b.id} ${b.color}`)
  }
  const [x, y] = tasks
  assert.throws(() => store.updateTask(x.id, { color: y.color }, 'human'), new RegExp(`too close to the color of task #${y.id}`))
  assert.throws(() => store.updateTask(x.id, { color: 'teal' }, 'human'), /hex color/)
  assert.equal(store.updateTask(x.id, { color: x.color.toUpperCase() }, 'human').color, x.color)
  assert.match(store.updateTask(x.id, { color: 'auto' }, 'human').color, /^#[0-9a-f]{6}$/)
  for (const t of tasks) store.deleteTask(t.id)
})

test('concurrent processes create tasks with distinct colors', async (t) => {
  const { spawn } = await import('node:child_process')
  const { once } = await import('node:events')
  const { DatabaseSync } = await import('node:sqlite')
  const dir = mkdtempSync(join(tmpdir(), 't3-tasks-concurrent-'))
  const code = `
    const store = await import('./src/store.mjs');
    process.send('ready');
    process.once('message', () => {
      store.createTask({ title: 'Concurrent' });
      process.disconnect();
    });
  `
  const children = [], exits = []
  t.after(async () => {
    for (const child of children) if (child.exitCode === null) child.kill()
    await Promise.all(exits)
  })
  for (let i = 0; i < 8; i++) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, T3_TASKS_HOME: dir }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    children.push(child)
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const exited = once(child, 'exit').then(([code]) => ({ code, stderr }))
    exits.push(exited)
    await Promise.race([
      once(child, 'message'),
      exited.then(({ stderr }) => { throw new Error(`child exited before ready: ${stderr}`) }),
    ])
  }
  for (const child of children) child.send('create')
  for (const { code, stderr } of await Promise.all(exits)) assert.equal(code, 0, stderr)
  const db = new DatabaseSync(join(dir, 'tasks.db'))
  try {
    const colors = db.prepare('SELECT color FROM tasks').all().map((row) => row.color)
    assert.equal(colors.length, children.length)
    for (let i = 0; i < colors.length; i++) for (let j = i + 1; j < colors.length; j++) {
      assert.ok(store.colorDistance(colors[i], colors[j]) >= store.MIN_COLOR_DISTANCE, `${colors[i]} vs ${colors[j]}`)
    }
  } finally {
    db.close()
  }
})

test('a task remembers its project; both ids go together', () => {
  const task = store.createTask({ title: 'In a project' })
  const set = store.updateTask(task.id, { environment_id: 'env-1', project_id: 'p-1' }, 'human')
  assert.deepEqual([set.environment_id, set.project_id], ['env-1', 'p-1'])
  assert.equal(store.updateTask(task.id, { title: 'Renamed' }, 'human').project_id, 'p-1')
  assert.throws(() => store.updateTask(task.id, { project_id: 'p-2' }, 'human'), /go together/)
  const cleared = store.updateTask(task.id, { environment_id: null, project_id: null }, 'human')
  assert.deepEqual([cleared.environment_id, cleared.project_id], [null, null])
})

test('startup turns named colors into hex; a duplicate open color is replaced', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const dir = mkdtempSync(join(tmpdir(), 't3-tasks-migration-'))
  const db = new DatabaseSync(join(dir, 'tasks.db'))
  db.exec(`
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'todo', status_note TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'manual', external_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      position REAL NOT NULL DEFAULT 0, color TEXT,
      UNIQUE (source, external_id)
    );
    INSERT INTO tasks (id, title, status, created_at, updated_at, color) VALUES
      (1, 'Orange', 'todo', '', '', 'orange'), (2, 'Orange again', 'todo', '', '', 'orange'),
      (3, 'Settled orange', 'settled', '', '', 'orange'), (4, 'None', 'todo', '', '', NULL),
      (5, 'Fuchsia', 'todo', '', '', 'fuchsia');
  `)
  const { spawnSync } = await import('node:child_process')
  let first
  for (let i = 0; i < 2; i++) {
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./src/store.mjs')"], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, T3_TASKS_HOME: dir }, encoding: 'utf8',
    })
    assert.equal(run.status, 0, run.stderr)
    const colors = db.prepare('SELECT color FROM tasks ORDER BY id').all().map((row) => row.color)
    first ??= colors
    assert.deepEqual(colors, first, 'a second start changes nothing')
  }
  assert.equal(first[0], '#f97316')
  assert.equal(first[2], '#f97316')
  assert.equal(first[4], '#d946ef', 'a replacement must not crowd out an unmigrated color')
  assert.ok(first.every((c) => /^#[0-9a-f]{6}$/.test(c)))
  for (const i of [0, 1, 3, 4]) for (const j of [0, 1, 3, 4]) {
    if (i < j) assert.ok(store.colorDistance(first[i], first[j]) >= store.MIN_COLOR_DISTANCE)
  }
  db.close()
})

test('the user can add a session to a task from the app; the history says who', () => {
  const task = store.createTask({ title: 'Linked by hand' })
  store.linkSession('s-human', task.id, { title: 'Old chat', link: 'https://app.t3.codes/threads/env/s-human' }, 'human')
  const linked = store.getTask(task.id)
  assert.equal(linked.sessions[0].link, 'https://app.t3.codes/threads/env/s-human')
  assert.equal(linked.events[0].actor, 'human')
  assert.equal(linked.events[0].text, 'Session joined: Old chat')
  store.unlinkSession('s-human')
  assert.equal(store.getTask(task.id).events[0].text, 'Session left: Old chat')
})

test('malformed session links are rejected before adding or moving a session', () => {
  const a = store.createTask({ title: 'Original task' }), b = store.createTask({ title: 'Target task' })
  const link = 'https://app.t3.codes/threads/env/mcp%3Asafe'
  store.linkSession('s-uri', a.id, { title: 'Original session', link }, 'human')
  for (const invalid of ['https://app.t3.codes/threads/%/session-1', 'https://app.t3.codes/threads/env/%FF']) {
    assert.throws(() => store.linkSession('s-new-uri', b.id, { link: invalid }, 'human'), /malformed URI/)
    assert.throws(() => store.linkSession('s-uri', b.id, { link: invalid }, 'human'), /malformed URI/)
  }
  assert.equal(store.taskForSession('s-new-uri'), null)
  assert.equal(store.taskForSession('s-uri').id, a.id)
  assert.equal(store.getTask(a.id).sessions[0].link, link)
  assert.equal(store.getTask(b.id).sessions.length, 0)
  assert.equal(store.getTask(b.id).events.length, 1)
})

test('a task records when it was settled, and forgets it when reopened', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-11T12:00:00.000Z') })
  const task = store.createTask({ title: 'Settle me' })
  assert.equal(task.settled_at, null)
  const settled = store.updateTask(task.id, { status: 'settled' }, 'human')
  assert.ok(Date.parse(settled.settled_at) > 0)
  assert.equal(store.updateTask(task.id, { color: 'auto' }, 'human').settled_at, settled.settled_at)
  assert.equal(store.updateTask(task.id, { status: 'in_progress', status_note: 'Reopened' }, 'human').settled_at, null)
  t.mock.timers.tick(1)
  const resettled = store.updateTask(task.id, { status: 'settled' }, 'human')
  const staleReopen = { status: 'in_progress', expected_settled_at: settled.settled_at }
  assert.throws(() => store.updateTask(task.id, staleReopen, 'human'), /settlement changed/)
  assert.deepEqual(store.getTask(task.id), resettled)
  assert.equal(store.updateTask(task.id, {
    status: 'in_progress', expected_settled_at: resettled.settled_at,
  }, 'human').status, 'in_progress')
  assert.throws(() => store.updateTask(task.id, {
    status: 'in_progress', expected_settled_at: resettled.settled_at,
  }, 'human'), /settlement changed/)
})

test('settling stores each session\'s mark; leaving Settled or moving the session clears it', () => {
  const task = store.createTask({ title: 'Marks' })
  const other = store.createTask({ title: 'Elsewhere' })
  store.linkSession('m1', task.id)
  store.linkSession('m2', task.id)
  store.linkSession('m3', other.id)
  const marks = (id) => store.getTask(id).sessions.map((s) => s.settle_mark)
  assert.throws(() => store.updateTask(task.id, { status: 'settled', session_marks: { m1: 5 } }, 'human'), /session_marks/)
  assert.equal(store.getTask(task.id).status, 'todo')
  store.updateTask(task.id, { status: 'settled', session_marks: { m1: '2026-11-11T10:00:00.000Z', m2: '', m3: 'x' } }, 'human')
  assert.deepEqual(marks(task.id), ['2026-11-11T10:00:00.000Z', ''])
  assert.deepEqual(marks(other.id), [null])
  store.updateTask(task.id, { color: 'auto', session_marks: { m1: 'later' } }, 'human')
  assert.deepEqual(marks(task.id), ['2026-11-11T10:00:00.000Z', ''])
  store.linkSession('m2', other.id)
  assert.deepEqual(marks(other.id), [null, null])
  store.updateTask(task.id, { status: 'in_progress' }, 'human')
  assert.deepEqual(marks(task.id), [null])
})

test('settling rolls back status, marks and history if a mark or event write fails', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(process.env.T3_TASKS_HOME, 'tasks.db'))
  try {
    for (const stage of ['mark', 'event']) {
      const task = store.createTask({ title: `Atomic ${stage}` })
      const first = `atomic-${stage}-1`, second = `atomic-${stage}-2`
      store.linkSession(first, task.id)
      store.linkSession(second, task.id)
      const before = store.getTask(task.id)
      db.exec(stage === 'mark'
        ? `CREATE TRIGGER reject_settle BEFORE UPDATE OF settle_mark ON sessions
            WHEN NEW.thread_id = '${second}' AND NEW.settle_mark IS NOT NULL
            BEGIN SELECT RAISE(ABORT, 'injected mark failure'); END`
        : `CREATE TRIGGER reject_settle BEFORE INSERT ON events
            WHEN NEW.task_id = ${task.id}
            BEGIN SELECT RAISE(ABORT, 'injected event failure'); END`)
      const patch = { status: 'settled', session_marks: { [first]: '', [second]: '' } }
      try {
        assert.throws(() => store.updateTask(task.id, patch, 'human'), /injected/)
        assert.deepEqual(store.getTask(task.id), before)
      } finally {
        db.exec('DROP TRIGGER reject_settle')
      }
      const settled = store.updateTask(task.id, patch, 'human')
      assert.equal(settled.status, 'settled')
      assert.deepEqual(settled.sessions.map((s) => s.settle_mark), ['', ''])
      assert.equal(settled.events.length, before.events.length + 1)
    }
  } finally {
    db.close()
  }
})

test('startup gives tasks settled before settled_at existed the time of their last move to Settled', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const dir = mkdtempSync(join(tmpdir(), 't3-tasks-settled-'))
  const db = new DatabaseSync(join(dir, 'tasks.db'))
  db.exec(`
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'todo', status_note TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'manual', external_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      position REAL NOT NULL DEFAULT 0, color TEXT,
      UNIQUE (source, external_id)
    );
    CREATE TABLE events (id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, at TEXT NOT NULL, actor TEXT NOT NULL, text TEXT NOT NULL);
    INSERT INTO tasks (id, title, status, created_at, updated_at, color) VALUES
      (1, 'Settled with history', 'settled', '', '2026-11-11T13:00:00.000Z', 'pink'),
      (2, 'Settled without history', 'settled', '', '2026-11-11T14:00:00.000Z', 'teal'),
      (3, 'Open', 'todo', '', '2026-11-11T15:00:00.000Z', 'lime');
    INSERT INTO events (task_id, at, actor, text) VALUES
      (1, '2026-11-11T11:00:00.000Z', 'human', 'Moved to Settled'),
      (1, '2026-11-11T12:09:23.456Z', 'human', 'Moved to Settled');
  `)
  const { spawnSync } = await import('node:child_process')
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./src/store.mjs')"], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, T3_TASKS_HOME: dir }, encoding: 'utf8',
  })
  assert.equal(run.status, 0, run.stderr)
  assert.deepEqual(db.prepare('SELECT settled_at FROM tasks ORDER BY id').all().map((row) => row.settled_at),
    ['2026-11-11T12:09:23.456Z', '2026-11-11T14:00:00.000Z', null])
  db.close()
})

test('the HTTP API links and unlinks a session whose id needs escaping in the URL', async () => {
  const { spawn } = await import('node:child_process')
  const port = 47000 + Math.floor(Math.random() * 1000)
  const home = mkdtempSync(join(tmpdir(), 't3-tasks-http-'))
  const server = spawn(process.execPath, ['src/server.mjs'], {
    cwd: new URL('..', import.meta.url), env: { ...process.env, T3_TASKS_HOME: home, T3_TASKS_PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'],
  })
  try {
    // Wait for this child to say it listens; if it exits first (port taken), fail rather than talk to another service.
    await new Promise((resolve, reject) => {
      server.stdout.on('data', (chunk) => { if (String(chunk).includes('T3 Tasks API')) resolve() })
      server.once('exit', (code) => reject(new Error(`test server exited early (${code})`)))
    })
    const api = `http://127.0.0.1:${port}/api`
    const call = (method, path, body) => fetch(`${api}${path}`, {
      method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body),
    }).then(async (res) => ({ status: res.status, body: await res.json() }))
    const task = (await call('POST', '/tasks', { title: 'HTTP' })).body
    const threadId = 'thread:project:p1:t1'
    const link = `https://app.t3.codes/threads/env/${encodeURIComponent(threadId)}`
    const linked = await call('POST', '/sessions', { thread_id: threadId, task_id: task.id, title: 'Chat', link })
    assert.equal(linked.status, 200)
    assert.equal(linked.body.sessions[0].thread_id, threadId)
    assert.equal((await call('DELETE', `/sessions/${encodeURIComponent(threadId)}`)).status, 200)
    assert.equal((await call('GET', '/tasks')).body.tasks[0].sessions.length, 0)
    assert.equal((await call('DELETE', '/sessions/%E0%A4%A')).status, 400)
  } finally {
    server.kill()
  }
})
