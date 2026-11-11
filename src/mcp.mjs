#!/usr/bin/env node
// MCP server over stdio: the tools agents use to keep the task list current.
// One process per session; it knows its session from T3CODE_THREAD_ID.
import { execFile, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import * as store from './store.mjs'

const threadId = process.env.T3CODE_THREAD_ID || process.env.CLAUDE_CODE_SESSION_ID || ''

// The task page is served by a separate long-lived process; start it if it is not up.
fetch(`http://127.0.0.1:${store.PORT}/api/health`).catch(() => {
  spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url))], { detached: true, stdio: 'ignore' }).unref()
})

// Title and link of this session, from T3 Code. Best effort: outside T3 there is none.
const sessionInfo = () => new Promise((resolve) => {
  const cli = process.env.T3CODE_CLI_PATH
  if (!cli || !process.env.T3CODE_THREAD_ID) return resolve({})
  execFile(cli, ['thread', 'show', threadId, '--json', '--messages', '0'], { timeout: 5000 }, (err, out) => {
    try { const { title, link } = JSON.parse(out).thread; resolve({ title, link }) } catch { resolve({}) }
  })
})

const brief = (t) => ({ id: t.id, title: t.title, status: t.status, status_note: t.status_note, notes: t.notes, sessions: t.sessions.length })
const needSession = () => threadId || (() => { throw new Error('this session has no id; cannot link it') })()

const tools = {
  task_list: {
    description: 'List the open tasks (everything not settled) and the task this session is linked to.',
    properties: {},
    run: () => ({ this_session_task: threadId && store.taskForSession(threadId)?.id || null, tasks: store.listTasks({ includeSettled: false }).map(brief) }),
  },
  task_link: {
    description: 'Link this session to an existing task: this session is now working towards shipping it. A session has one task; linking again moves it.',
    properties: { task_id: { type: 'integer' } },
    required: ['task_id'],
    run: async ({ task_id }) => brief(store.linkSession(needSession(), task_id, await sessionInfo())),
  },
  task_create: {
    description: 'Create a task for the work the user asked this session to do, and link this session to it. Use only when no open task matches. For work that branches off the current task, use task_suggest instead.',
    properties: { title: { type: 'string', description: 'Short outcome, e.g. "Ship Klarna refund fix"' }, notes: { type: 'string' } },
    required: ['title'],
    run: async ({ title, notes }) => {
      const task = store.createTask({ title, notes, source: 'agent' })
      return brief(threadId ? store.linkSession(threadId, task.id, await sessionInfo()) : task)
    },
  },
  task_update: {
    description: 'Update the status of a task (default: the task this session is linked to). in_progress when work starts, blocked when waiting on the user or something external, done when the work is shipped or verified. You cannot set settled: only the user settles.',
    properties: {
      status: { type: 'string', enum: store.STATUSES.filter((s) => s !== 'settled') },
      note: { type: 'string', description: 'One line: where the work stands or what it waits on' },
      task_id: { type: 'integer' },
    },
    required: ['status'],
    run: async ({ status, note, task_id }) => {
      const id = task_id ?? (threadId && store.taskForSession(threadId)?.id)
      if (!id) throw new Error('this session is not linked to a task; call task_link or task_create first')
      const task = store.updateTask(id, { status, status_note: note }, 'agent')
      if (threadId && store.taskForSession(threadId)?.id === task.id) store.linkSession(threadId, task.id, await sessionInfo()) // refresh the session title
      return brief(task)
    },
  },
  task_suggest: {
    description: 'Suggest a new task to the user. Use when the session is drifting away from its task or you found separable work that branches out. The user accepts or dismisses it in the task list; you do not create it.',
    properties: { title: { type: 'string' }, reason: { type: 'string', description: 'Why this is separate work' } },
    required: ['title', 'reason'],
    run: ({ title, reason }) => ({ suggestion_id: store.addSuggestion({ title, reason, thread_id: threadId || null }) }),
  },
}

async function handle({ method, params }) {
  if (method === 'initialize') {
    return { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 't3-tasks', version: '0.1.0' } }
  }
  if (method === 'ping') return {}
  if (method === 'tools/list') {
    return { tools: Object.entries(tools).map(([name, t]) => ({ name, description: t.description, inputSchema: { type: 'object', properties: t.properties, required: t.required || [] } })) }
  }
  if (method === 'tools/call') {
    try {
      const tool = tools[params.name] || (() => { throw new Error(`unknown tool ${params.name}`) })()
      return { content: [{ type: 'text', text: JSON.stringify(await tool.run(params.arguments || {})) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: e.message }], isError: true }
    }
  }
  throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 })
}

// One request at a time, in arrival order: a task_update sent right after a
// task_create must see the link the create made.
let queue = Promise.resolve()
createInterface({ input: process.stdin }).on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.id === undefined) return // a notification: nothing to answer
  queue = queue.then(async () => {
    let reply
    try { reply = { result: await handle(msg) } } catch (e) { reply = { error: { code: e.code || -32603, message: e.message } } }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...reply }) + '\n')
  })
})
