// The one place that touches the database. The MCP server (agents) and the
// HTTP server (UI, third-party apps) both go through these functions.
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const STATUSES = ['todo', 'in_progress', 'blocked', 'done', 'settled']
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
  CREATE TABLE IF NOT EXISTS suggestions (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    thread_id TEXT,
    created_at TEXT NOT NULL
  );
`)

const now = () => new Date().toISOString()
const fail = (message) => { throw new Error(message) }
const text = (value, name) => {
  const s = typeof value === 'string' ? value.trim() : ''
  return s || fail(`${name} is required`)
}

export function getTask(id) {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(id))
  if (!task) fail(`no task ${id}`)
  task.sessions = db.prepare('SELECT thread_id, title, link FROM sessions WHERE task_id = ? ORDER BY linked_at').all(task.id)
  return task
}

export function listTasks({ includeSettled = true } = {}) {
  const rows = db.prepare(`SELECT id FROM tasks ${includeSettled ? '' : "WHERE status != 'settled'"} ORDER BY updated_at DESC`).all()
  return rows.map((r) => getTask(r.id))
}

// A task that arrives again with the same (source, external_id) is the same
// task: third-party sync can re-send without making duplicates.
export function createTask({ title, notes = '', source = 'manual', external_id = null }) {
  title = text(title, 'title')
  if (external_id != null) {
    const existing = db.prepare('SELECT id FROM tasks WHERE source = ? AND external_id = ?').get(source, String(external_id))
    if (existing) return updateTask(existing.id, { title, notes }, 'human')
  }
  const t = now()
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO tasks (title, notes, source, external_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(title, String(notes), String(source), external_id == null ? null : String(external_id), t, t)
  return getTask(lastInsertRowid)
}

// actor is 'agent' or 'human'. Settling is the human's call alone, and a
// settled task stays as the human left it.
export function updateTask(id, { title, notes, status, status_note }, actor) {
  const task = getTask(id)
  if (actor === 'agent' && task.status === 'settled') fail(`task ${id} is settled; only the user can reopen it`)
  if (status !== undefined) {
    if (!STATUSES.includes(status)) fail(`status must be one of ${STATUSES.join(', ')}`)
    if (actor === 'agent' && status === 'settled') fail('only the user can settle a task')
  }
  db.prepare('UPDATE tasks SET title = ?, notes = ?, status = ?, status_note = ?, updated_at = ? WHERE id = ?').run(
    title === undefined ? task.title : text(title, 'title'),
    notes === undefined ? task.notes : String(notes),
    status ?? task.status,
    status_note === undefined ? task.status_note : String(status_note),
    now(), task.id
  )
  return getTask(task.id)
}

export function deleteTask(id) {
  db.prepare('DELETE FROM tasks WHERE id = ?').run(Number(id))
}

// A session works on one task at a time; linking again moves it.
export function linkSession(threadId, taskId, { title = '', link = '' } = {}) {
  const task = getTask(taskId)
  if (task.status === 'settled') fail(`task ${taskId} is settled; only the user can reopen it`)
  db.prepare(`
    INSERT INTO sessions (thread_id, task_id, title, link, linked_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (thread_id) DO UPDATE SET task_id = excluded.task_id,
      title = CASE WHEN excluded.title != '' THEN excluded.title ELSE title END,
      link = CASE WHEN excluded.link != '' THEN excluded.link ELSE link END
  `).run(text(threadId, 'thread id'), task.id, title, link, now())
  return getTask(task.id)
}

export function taskForSession(threadId) {
  const row = db.prepare('SELECT task_id FROM sessions WHERE thread_id = ?').get(String(threadId))
  return row ? getTask(row.task_id) : null
}

export function addSuggestion({ title, reason = '', thread_id = null }) {
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO suggestions (title, reason, thread_id, created_at) VALUES (?, ?, ?, ?)'
  ).run(text(title, 'title'), String(reason), thread_id, now())
  return Number(lastInsertRowid)
}

export const listSuggestions = () => db.prepare('SELECT * FROM suggestions ORDER BY id DESC').all()

export function resolveSuggestion(id, accept) {
  const s = db.prepare('SELECT * FROM suggestions WHERE id = ?').get(Number(id))
  if (!s) fail(`no suggestion ${id}`)
  db.prepare('DELETE FROM suggestions WHERE id = ?').run(s.id)
  return accept ? createTask({ title: s.title, notes: s.reason, source: 'suggestion' }) : null
}
