#!/usr/bin/env node
// HTTP server on loopback: the JSON API behind the task board in T3 Code, and
// the connection point for third-party apps (see README).
import { createServer } from 'node:http'
import * as store from './store.mjs'

const HOSTS = [`127.0.0.1:${store.PORT}`, `localhost:${store.PORT}`]
// Pages that may call the API: the T3 Code desktop app (packaged and dev) and
// anything listed in T3_TASKS_ORIGINS (comma separated), e.g. a web dev server.
const ORIGINS = ['t3code://app', 't3code-dev://app', ...HOSTS.map((h) => `http://${h}`),
  ...(process.env.T3_TASKS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)]

const board = () => ({ tasks: store.listTasks() })
const routes = [
  ['GET', /^\/api\/health$/, () => ({ ok: true })],
  ['GET', /^\/api\/tasks$/, board],
  ['POST', /^\/api\/tasks$/, (_, body) => store.createTask(body)],
  ['PATCH', /^\/api\/tasks\/(\d+)$/, ([id], body) => store.updateTask(id, body, 'human')],
  ['DELETE', /^\/api\/tasks\/(\d+)$/, ([id]) => (store.deleteTask(id), { ok: true })],
  ['POST', /^\/api\/tasks\/(\d+)\/criteria$/, ([id], body) => store.addCriterion(id, body.text, 'human')],
  ['PATCH', /^\/api\/criteria\/(\d+)$/, ([id], body) => store.updateCriterion(id, body, 'human')],
  ['DELETE', /^\/api\/criteria\/(\d+)$/, ([id]) => (store.deleteCriterion(id), { ok: true })],
  ['DELETE', /^\/api\/sessions\/([\w:-]+)$/, ([id]) => (store.unlinkSession(id), { ok: true })],
]

const server = createServer(async (req, res) => {
  const origin = req.headers.origin
  const cors = origin ? {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, PATCH, DELETE',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '600',
    vary: 'origin',
  } : {}
  const send = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors })
    res.end(JSON.stringify(body))
  }
  // Only this machine's own programs and the pages listed above may talk to
  // the API: refuse other websites (Origin) and DNS-rebinding hosts (Host).
  if (!HOSTS.includes(req.headers.host) || (origin && !ORIGINS.includes(origin))) return send(403, { error: 'forbidden' })
  if (req.method === 'OPTIONS') return send(204)
  const path = req.url.split('?')[0]
  for (const [method, pattern, run] of routes) {
    const m = req.method === method && path.match(pattern)
    if (!m) continue
    try {
      let raw = ''
      for await (const chunk of req) raw += chunk
      return send(200, run(m.slice(1), raw ? JSON.parse(raw) : {}))
    } catch (e) {
      return send(400, { error: e.message })
    }
  }
  send(404, { error: 'not found' })
})

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') process.exit(0) // another copy already serves the API
  throw e
})
server.listen(store.PORT, '127.0.0.1', () => console.log(`T3 Tasks API: http://127.0.0.1:${store.PORT}/api/tasks`))
