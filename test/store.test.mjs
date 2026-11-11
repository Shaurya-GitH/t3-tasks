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

test('each new task gets the color fewest open tasks use; only known colors are accepted', () => {
  const open = store.listTasks({ includeSettled: false })
  const counts = new Map(store.COLORS.map((c) => [c, open.filter((t) => t.color === c).length]))
  const least = Math.min(...counts.values())
  const task = store.createTask({ title: 'Colored' })
  assert.equal(counts.get(task.color), least)
  assert.equal(store.updateTask(task.id, { color: 'teal' }, 'human').color, 'teal')
  assert.throws(() => store.updateTask(task.id, { color: 'red' }, 'human'), /color must be/)
})
