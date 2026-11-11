import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.T3_TASKS_HOME = mkdtempSync(join(tmpdir(), 't3-tasks-'))
const store = await import('../src/store.mjs')

test('agents move status but only the human settles', () => {
  const task = store.createTask({ title: 'Ship it' })
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

test('an accepted suggestion becomes a task', () => {
  const id = store.addSuggestion({ title: 'Fix flaky test', reason: 'found while shipping A', thread_id: 's1' })
  const task = store.resolveSuggestion(id, true)
  assert.equal(task.title, 'Fix flaky test')
  assert.equal(store.listSuggestions().length, 0)
})
