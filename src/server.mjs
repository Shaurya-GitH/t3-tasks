#!/usr/bin/env node
// HTTP server on loopback: the task page and the JSON API. The API is the
// connection point for third-party apps (see README).
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import * as store from './store.mjs'

const page = new URL('../ui/index.html', import.meta.url)
const HOSTS = [`127.0.0.1:${store.PORT}`, `localhost:${store.PORT}`]

const routes = [
  ['GET', /^\/api\/health$/, () => ({ ok: true })],
  ['GET', /^\/api\/tasks$/, () => ({ tasks: store.listTasks(), suggestions: store.listSuggestions() })],
  ['POST', /^\/api\/tasks$/, (_, body) => store.createTask(body)],
  ['PATCH', /^\/api\/tasks\/(\d+)$/, ([id], body) => store.updateTask(id, body, 'human')],
  ['DELETE', /^\/api\/tasks\/(\d+)$/, ([id]) => (store.deleteTask(id), { ok: true })],
  ['POST', /^\/api\/suggestions\/(\d+)\/accept$/, ([id]) => store.resolveSuggestion(id, true)],
  ['DELETE', /^\/api\/suggestions\/(\d+)$/, ([id]) => (store.resolveSuggestion(id, false), { ok: true })],
]

const server = createServer(async (req, res) => {
  const send = (code, body, type = 'application/json') => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' })
    res.end(type === 'application/json' ? JSON.stringify(body) : body)
  }
  // Only this machine's own pages and programs may talk to the API: refuse
  // other websites (Origin) and DNS-rebinding hosts (Host).
  const origin = req.headers.origin
  if (!HOSTS.includes(req.headers.host) || (origin && !HOSTS.includes(origin.replace(/^https?:\/\//, '')))) {
    return send(403, { error: 'forbidden' })
  }
  const path = req.url.split('?')[0]
  if (req.method === 'GET' && path === '/') return send(200, readFileSync(page), 'text/html; charset=utf-8')
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
  if (e.code === 'EADDRINUSE') process.exit(0) // another copy already serves the page
  throw e
})
server.listen(store.PORT, '127.0.0.1', () => console.log(`T3 Tasks: http://127.0.0.1:${store.PORT}`))
