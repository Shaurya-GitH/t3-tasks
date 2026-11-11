// The one place that touches the database. The MCP server (agents) and the
// HTTP server (the T3 Code task board, third-party apps) both go through these functions.
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const STATUSES = ['todo', 'in_progress', 'blocked', 'done', 'settled']
// Task colors, kept clear of the colors T3 uses for session status (amber, indigo, sky, green, red).
export const COLORS = ['pink', 'teal', 'purple', 'lime', 'orange', 'fuchsia']
export const PORT = Number(process.env.T3_TASKS_PORT) || 4777

const dir = process.env.T3_TASKS_HOME || join(homedir(), '.t3-tasks')
mkdirSync(dir, { recursive: true })
const db = new DatabaseSync(join(dir, 'tasks.db'))
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 3000;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo',
    status_note TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'manual',
    external_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (source, external_id)
  );
  CREATE TABLE IF NOT EXISTS sessions (
    thread_id TEXT PRIMARY KEY,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT '',
    link TEXT NOT NULL DEFAULT '',
    linked_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS criteria (
    id INTEGER PRIMARY KEY,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    at TEXT NOT NULL,
    actor TEXT NOT NULL,
    text TEXT NOT NULL
  );
`)
// Added after the first release: the card's place in its column (lower is higher up).
try { db.exec('ALTER TABLE tasks ADD COLUMN position REAL NOT NULL DEFAULT 0') } catch {}
try { db.exec('ALTER TABLE tasks ADD COLUMN color TEXT') } catch {}
for (const { id } of db.prepare('SELECT id FROM tasks WHERE color IS NULL ORDER BY id').all()) {
  db.prepare('UPDATE tasks SET color = ? WHERE id = ?').run(COLORS[(id - 1) % COLORS.length], id)
}
// When the task was settled, so the app can tell a session talked to afterwards. Tasks settled
// before this column existed take it from their last move to Settled.
try { db.exec('ALTER TABLE tasks ADD COLUMN settled_at TEXT') } catch {}
db.exec(`UPDATE tasks SET settled_at = COALESCE(
  (SELECT MAX(at) FROM events WHERE events.task_id = tasks.id AND text LIKE 'Moved to Settled%'), updated_at)
  WHERE status = 'settled' AND settled_at IS NULL`)
// Each session's last user message as its own server reported it when the task was settled ('' when
// it had none), so the app can tell a later message without comparing two machines' clocks.
try { db.exec('ALTER TABLE sessions ADD COLUMN settle_mark TEXT') } catch {}

const now = () => new Date().toISOString()
// The color fewest open tasks use, so tasks side by side tell apart.
const nextColor = () => {
  const used = new Map(COLORS.map((c) => [c, 0]))
  for (const { color } of db.prepare("SELECT color FROM tasks WHERE status != 'settled'").all()) {
    if (used.has(color)) used.set(color, used.get(color) + 1)
  }
  return COLORS.reduce((best, c) => (used.get(c) < used.get(best) ? c : best))
}
const fail = (message) => { throw new Error(message) }
const text = (value, name) => {
  const s = typeof value === 'string' ? value.trim() : ''
  return s || fail(`${name} is required`)
}
const LABEL = { todo: 'To do', in_progress: 'In progress', blocked: 'Blocked', done: 'Done', settled: 'Settled' }
const log = (taskId, actor, message) =>
  db.prepare('INSERT INTO events (task_id, at, actor, text) VALUES (?, ?, ?, ?)').run(taskId, now(), actor, message)
const touch = (taskId) => db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(now(), taskId)

export function getTask(id) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(id))
  if (!task) fail(`no task ${id}`)
  task.sessions = db.prepare('SELECT thread_id, title, link, settle_mark FROM sessions WHERE task_id = ? ORDER BY linked_at').all(task.id)
  task.criteria = db.prepare('SELECT id, text, done FROM criteria WHERE task_id = ? ORDER BY id').all(task.id)
    .map((c) => ({ ...c, done: Boolean(c.done) }))
  task.events = db.prepare('SELECT at, actor, text FROM events WHERE task_id = ? ORDER BY id DESC LIMIT 30').all(task.id)
  return task
}

export function listTasks({ includeSettled = true } = {}) {
  const rows = db.prepare(`SELECT id FROM tasks ${includeSettled ? '' : "WHERE status != 'settled'"} ORDER BY position, id DESC`).all()
  return rows.map((r) => getTask(r.id))
}

// A task that arrives again with the same (source, external_id) is the same
// task: third-party sync can re-send without making duplicates.
export function createTask({ title, notes = '', status = 'todo', source = 'manual', external_id = null, acceptance_criteria = [] }, actor = 'human') {
  title = text(title, 'title')
  if (!STATUSES.includes(status) || status === 'settled') fail('a new task cannot start settled')
  if (external_id != null) {
    const existing = db.prepare('SELECT id FROM tasks WHERE source = ? AND external_id = ?').get(source, String(external_id))
    if (existing) return updateTask(existing.id, { title, notes }, 'human')
  }
  const t = now()
  // New cards go to the top of their column.
  const top = db.prepare('SELECT MIN(position) AS p FROM tasks').get().p ?? 0
  const id = Number(db.prepare(
    'INSERT INTO tasks (title, notes, status, source, external_id, position, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(title, String(notes), status, String(source), external_id == null ? null : String(external_id), top - 1, nextColor(), t, t).lastInsertRowid)
  log(id, actor, 'Created the task')
  for (const c of acceptance_criteria) db.prepare('INSERT INTO criteria (task_id, text) VALUES (?, ?)').run(id, text(c, 'criterion'))
  return getTask(id)
}

// actor is 'agent' or 'human'. Settling is the human's call alone, a settled
// task stays as the human left it, and an agent cannot call a task done while
// an acceptance criterion is still open.
export function updateTask(id, { title, notes, status, status_note, position, color, expected_settled_at, session_marks }, actor) {
  const task = getTask(id)
  if (actor === 'agent' && task.status === 'settled') fail(`task ${id} is settled; only the user can reopen it`)
  if (status !== undefined) {
    if (!STATUSES.includes(status)) fail(`status must be one of ${STATUSES.join(', ')}`)
    if (actor === 'agent' && status === 'settled') fail('only the user can settle a task')
    const open = task.criteria.filter((c) => !c.done)
    if (actor === 'agent' && status === 'done' && open.length) {
      fail(`not done yet: ${open.length} acceptance criteria are open (${open.map((c) => `#${c.id} ${c.text}`).join('; ')}). Meet them and check them off with task_check, or set blocked and say why.`)
    }
  }
  if (color !== undefined && !COLORS.includes(color)) fail(`color must be one of ${COLORS.join(', ')}`)
  if (expected_settled_at !== undefined && typeof expected_settled_at !== 'string') fail('expected_settled_at must be a string')
  const marks = Object.entries(session_marks ?? {})
  if (typeof (session_marks ?? {}) !== 'object' || marks.some(([, v]) => typeof v !== 'string')) fail('session_marks must map thread ids to strings')
  const nextStatus = status ?? task.status
  const settledAt = nextStatus !== 'settled' ? null : task.status === 'settled' ? task.settled_at : now()
  const result = db.prepare(`UPDATE tasks SET title = ?, notes = ?, status = ?, status_note = ?, position = ?, color = ?, settled_at = ?, updated_at = ?
    WHERE id = ? AND (? IS NULL OR (status = 'settled' AND settled_at = ?))`).run(
    title === undefined ? task.title : text(title, 'title'),
    notes === undefined ? task.notes : String(notes),
    nextStatus,
    status_note === undefined ? task.status_note : String(status_note),
    typeof position === 'number' ? position : task.position,
    color ?? task.color,
    settledAt,
    now(), task.id, expected_settled_at ?? null, expected_settled_at ?? null
  )
  if (result.changes === 0) fail('task settlement changed; refresh before reopening')
  if (nextStatus !== 'settled') db.prepare('UPDATE sessions SET settle_mark = NULL WHERE task_id = ?').run(task.id)
  else if (task.status !== 'settled') {
    const mark = db.prepare('UPDATE sessions SET settle_mark = ? WHERE thread_id = ? AND task_id = ?')
    for (const [threadId, at] of marks) mark.run(at, threadId, task.id)
  }
  const moved = status !== undefined && status !== task.status
  if (moved || (status_note && status_note !== task.status_note)) {
    log(task.id, actor, [moved && `Moved to ${LABEL[status]}`, status_note].filter(Boolean).join(': '))
  }
  return getTask(task.id)
}

export function deleteTask(id) {
  db.prepare('DELETE FROM tasks WHERE id = ?').run(Number(id))
}

export function addCriterion(taskId, value, actor) {
  const task = getTask(taskId)
  if (actor === 'agent' && task.status === 'settled') fail(`task ${taskId} is settled; only the user can reopen it`)
  db.prepare('INSERT INTO criteria (task_id, text) VALUES (?, ?)').run(task.id, text(value, 'criterion'))
  touch(task.id)
  return getTask(task.id)
}

// Agents check criteria off; only the human rewrites or removes them.
export function updateCriterion(id, { text: value, done }, actor) {
  const c = db.prepare('SELECT * FROM criteria WHERE id = ?').get(Number(id))
  if (!c) fail(`no acceptance criterion ${id}`)
  const task = getTask(c.task_id)
  if (actor === 'agent' && task.status === 'settled') fail(`task ${task.id} is settled; only the user can reopen it`)
  if (actor === 'agent' && value !== undefined) fail('only the user can reword an acceptance criterion')
  db.prepare('UPDATE criteria SET text = ?, done = ? WHERE id = ?').run(
    value === undefined ? c.text : text(value, 'criterion'), done === undefined ? c.done : Number(Boolean(done)), c.id
  )
  if (done !== undefined && Boolean(done) !== Boolean(c.done)) log(task.id, actor, `${done ? 'Checked' : 'Unchecked'}: ${c.text}`)
  touch(task.id)
  return getTask(task.id)
}

export function deleteCriterion(id) {
  const c = db.prepare('SELECT task_id FROM criteria WHERE id = ?').get(Number(id))
  if (!c) return null
  db.prepare('DELETE FROM criteria WHERE id = ?').run(Number(id))
  touch(c.task_id)
  return getTask(c.task_id)
}

// A session works on one task at a time; linking again moves it.
// actor is 'agent' (the session links itself) or 'human' (the user adds it from the app).
export function linkSession(threadId, taskId, { title = '', link = '' } = {}, actor = 'agent') {
  try { decodeURI(link) } catch { fail('link has malformed URI escapes') }
  const task = getTask(taskId)
  if (task.status === 'settled') fail(`task ${taskId} is settled; only the user can reopen it`)
  const before = taskForSession(threadId)
  db.prepare(`
    INSERT INTO sessions (thread_id, task_id, title, link, linked_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (thread_id) DO UPDATE SET task_id = excluded.task_id, settle_mark = NULL,
      title = CASE WHEN excluded.title != '' THEN excluded.title ELSE title END,
      link = CASE WHEN excluded.link != '' THEN excluded.link ELSE link END
  `).run(text(threadId, 'thread id'), task.id, title, link, now())
  if (before?.id !== task.id) log(task.id, actor, `Session joined${title ? `: ${title}` : ''}`)
  return getTask(task.id)
}

export function unlinkSession(threadId, actor = 'human') {
  const row = db.prepare('SELECT task_id, title FROM sessions WHERE thread_id = ?').get(String(threadId))
  if (!row) return
  db.prepare('DELETE FROM sessions WHERE thread_id = ?').run(String(threadId))
  log(row.task_id, actor, `Session left${row.title ? `: ${row.title}` : ''}`)
}

export function taskForSession(threadId) {
  const row = db.prepare('SELECT task_id FROM sessions WHERE thread_id = ?').get(String(threadId))
  return row ? getTask(row.task_id) : null
}
